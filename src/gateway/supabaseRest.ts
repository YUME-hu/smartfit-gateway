/**
 * Supabase 写入（REST，不用 supabase-js）
 *
 * 为什么不用 supabase-js：
 *   supabase-js 依赖 fetch / WebSocket 全局对象。uni-app 的 App 端（plus 运行时）
 *   默认没有 fetch，得额外打 polyfill，容易在真机上翻车。
 *   App 端只需要"POST 一批行"，直接用 uni.request 打 PostgREST 最简单可靠；
 *   Web 端（Vue3）本身跑在浏览器里，那边用 supabase-js 订阅 Realtime 毫无问题。
 *
 * 关键：批量写入用 upsert（on_conflict=client_key + merge-duplicates），
 *      网络超时导致的"其实写成功了但我以为失败"重试时不会产生重复行。
 */

import type { ImuSample } from './types'

export interface SampleRow {
  client_key: string
  device_id: string
  boot_epoch: number
  seq: number | null
  recorded_at: string
  x: number
  y: number
  z: number
  /** 该 5 秒窗口内的步数（老固件为 null） */
  steps: number | null
}

export interface LatestRow {
  device_id: string
  recorded_at: string
  x: number
  y: number
  z: number
  steps: number | null
}

export interface SupabaseOptions {
  url: string
  anonKey: string
  sampleTable: string
  latestTable: string
  timeoutMs?: number
}

interface HttpResult {
  status: number
  body: string
}

export class SupabaseRest {
  private timeoutMs: number

  constructor(private opts: SupabaseOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15000
  }

  /** 4xx 重试没意义（除非 408/429），5xx 和网络错误才值得退避重试 */
  static isRetryable(status: number): boolean {
    return status === 0 || status === 408 || status === 429 || status >= 500
  }

  toRow(s: ImuSample): SampleRow {
    return {
      client_key: s.key,
      device_id: s.deviceId,
      boot_epoch: s.bootEpoch,
      seq: s.seq,
      recorded_at: new Date(s.ts).toISOString(),
      x: s.x,
      y: s.y,
      z: s.z,
      steps: s.stepsInWindow,
    }
  }

  /** 批量 upsert 样本 */
  async insertSamples(samples: ImuSample[]): Promise<void> {
    if (samples.length === 0) return

    const rows = samples.map((s) => this.toRow(s))
    const path =
      `/rest/v1/${this.opts.sampleTable}` +
      `?on_conflict=client_key`

    const res = await this.post(path, rows, [
      'resolution=merge-duplicates',
      'return=minimal',
    ])

    // 409/23505：唯一约束冲突，说明这批已经写过了 —— 视为成功
    if (res.status === 409) return
    if (res.status < 200 || res.status >= 300) {
      throw new SupabaseError(res.status, this.describe(res))
    }
  }

  /** 覆写"最新值"单行，供 Web 端 Realtime 订阅 */
  async upsertLatest(latest: LatestRow): Promise<void> {
    const path = `/rest/v1/${this.opts.latestTable}?on_conflict=device_id`
    const res = await this.post(path, latest, ['resolution=merge-duplicates', 'return=minimal'])
    if (res.status === 409) return
    if (res.status < 200 || res.status >= 300) {
      throw new SupabaseError(res.status, this.describe(res))
    }
  }

  private describe(res: HttpResult): string {
    if (res.status === 401 || res.status === 403) {
      return `鉴权失败(${res.status})：检查 anon key 与 RLS 策略。${res.body.slice(0, 200)}`
    }
    return `HTTP ${res.status}: ${res.body.slice(0, 200)}`
  }

  private post(path: string, body: unknown, prefer: string[]): Promise<HttpResult> {
    const url = this.opts.url.replace(/\/+$/, '') + path

    return new Promise<HttpResult>((resolve, reject) => {
      uni.request({
        url,
        method: 'POST',
        timeout: this.timeoutMs,
        header: {
          apikey: this.opts.anonKey,
          Authorization: `Bearer ${this.opts.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: prefer.join(','),
        },
        // 传字符串而不是对象：避免各端对对象的默认序列化行为不一致
        data: JSON.stringify(body),
        success: (res: { statusCode: number; data: unknown }) => {
          resolve({
            status: res.statusCode,
            body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''),
          })
        },
        fail: (err: { errMsg?: string }) => {
          // status 0 = 网络层失败，交给上层退避重试
          reject(new SupabaseError(0, err?.errMsg || '网络请求失败'))
        },
      })
    })
  }
}

export class SupabaseError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SupabaseError'
  }
}
