/**
 * 批量同步引擎
 *
 * 需求落地：
 *   - 每 15 分钟把缓存批量 insert 到 Supabase（timer）
 *   - "立即同步"按钮强制推完当前缓存（manual）
 *   - 网络恢复时自动补推（network）
 *
 * 三条硬约束：
 *   1. 单飞（single-flight）：定时器到点和用户点按钮可能同时发生，
 *      不能让两个 flush 并发取到同一批数据。
 *   2. 先写库、后删缓存：顺序反了会丢数据；重复写由 client_key 唯一约束兜住。
 *   3. 失败必须退避重试，且不能因为一次失败就清空缓存 —— 缓存是唯一的
 *      未上传副本。
 */

import type { SampleCache } from './cache'
import { SupabaseRest, SupabaseError } from './supabaseRest'

export type SyncTrigger = 'timer' | 'manual' | 'network' | 'startup'

export interface SyncOutcome {
  trigger: SyncTrigger
  uploaded: number
  batches: number
  error: string | null
}

export interface SyncOptions {
  intervalMs: number
  batchSize: number
  maxBatchesPerRun: number
}

/** 退避序列（毫秒），最后一档 15 分钟 */
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000]

export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<SyncOutcome> | null = null
  private failures = 0
  private running = false
  private listeners: Array<(o: SyncOutcome) => void> = []

  constructor(
    private cache: SampleCache,
    private api: SupabaseRest,
    private opts: SyncOptions,
  ) {}

  get consecutiveFailures(): number {
    return this.failures
  }

  onResult(fn: (o: SyncOutcome) => void): void {
    this.listeners.push(fn)
  }

  start(): void {
    if (this.running) return
    this.running = true

    // 启动先补推一次：上次进程被杀时可能还有没传完的缓存
    void this.flush('startup')

    this.timer = setInterval(() => {
      void this.flush('timer')
    }, this.opts.intervalMs)
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.cancelRetry()
  }

  /** 手动同步：把缓存尽量推完 */
  syncNow(): Promise<SyncOutcome> {
    return this.flush('manual')
  }

  /** 网络恢复时调用 */
  onNetworkRestored(): void {
    if (!this.running) return
    this.cancelRetry()
    void this.flush('network')
  }

  // ---------------------------------------------------------------- 内部

  private flush(trigger: SyncTrigger): Promise<SyncOutcome> {
    if (this.inFlight) return this.inFlight

    const job = this.run(trigger).finally(() => {
      this.inFlight = null
    })
    this.inFlight = job
    return job
  }

  private async run(trigger: SyncTrigger): Promise<SyncOutcome> {
    let uploaded = 0
    let batches = 0
    let error: string | null = null

    try {
      for (;;) {
        if (batches >= this.opts.maxBatchesPerRun) break

        const batch = this.cache.peek(this.opts.batchSize)
        if (batch.length === 0) break

        await this.api.insertSamples(batch)

        // 先写库成功，再从本地队列删除
        this.cache.remove(batch.map((s) => s.key))
        uploaded += batch.length
        batches++

        // 取不满一批说明队列已经见底
        if (batch.length < this.opts.batchSize) break
      }

      this.failures = 0
      this.cancelRetry()
    } catch (e) {
      this.failures++
      error = e instanceof Error ? e.message : String(e)

      const fatal = e instanceof SupabaseError && !SupabaseRest.isRetryable(e.status)
      if (fatal) {
        // 鉴权/RLS/表结构错误：重试一万次也没用，直接暴露给用户
        error = `${error}（不可重试，请检查配置）`
      } else {
        this.scheduleRetry()
      }
    }

    const outcome: SyncOutcome = { trigger, uploaded, batches, error }
    for (const fn of this.listeners) fn(outcome)
    return outcome
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer !== null) return
    const idx = Math.min(this.failures - 1, BACKOFF_MS.length - 1)
    const delay = BACKOFF_MS[Math.max(0, idx)]

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush('timer')
    }, delay)
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
