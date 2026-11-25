/**
 * 链路健康度（M5）
 *
 * 回答三个"评委一定会问、但界面上看不出来"的问题：
 *   1. 数据到底多新？（同步是 15 分钟一批，所以"最近更新"天然有滞后）
 *   2. 手表时间和手机时间差多少？（device_ts vs recorded_at —— 对时链路是否真的在工作）
 *   3. 这段时间里有没有缺包？（实际行数 vs 按 5 秒一包算的期望行数）
 *
 * 数据源是 imu_samples 而不是 device_latest：
 * device_latest 只有"最新一行"，看不出到达率；而 imu_samples 能按时间窗统计。
 */

import { onUnmounted, ref } from 'vue'
import { createClient } from '@supabase/supabase-js'

export interface LinkHealthSnapshot {
  /** 最近一行的时间（epoch ms） */
  lastSampleAt: number
  /** 窗口内实际行数 */
  rows: number
  /** 窗口期望行数（时长 / 5s） */
  expected: number
  /** 到达率 0~1，null 表示窗口内没有数据 */
  arrivalRate: number | null
  /** |recorded_at - device_ts| 的中位数（毫秒），null 表示没有可信 device_ts */
  clockSkewMs: number | null
  /** 带 device_ts 的行占比 */
  deviceTsRatio: number | null
  /**
   * 按 2 分钟分桶的到达情况（30 桶 = 60 分钟）。
   * 用来把"哪段时间是空的"画出来 —— 汇总到达率看不出空洞发生在什么时候。
   */
  buckets: Bucket[]
}

export interface Bucket {
  /** 桶起点（epoch ms） */
  t: number
  /** 该桶内实际行数 */
  rows: number
  /** 该桶期望行数（桶长 / 5s） */
  expected: number
}

export function useLinkHealth(opts: {
  supabaseUrl: string
  supabaseAnonKey: string
  deviceId: string
  /** 统计窗口（分钟），默认 60 */
  windowMinutes?: number
  enabled?: boolean
}) {
  const snapshot = ref<LinkHealthSnapshot | null>(null)
  const error = ref<string | null>(null)
  const loading = ref(false)

  const client = createClient(opts.supabaseUrl, opts.supabaseAnonKey)
  const windowMinutes = opts.windowMinutes ?? 60
  let timer: ReturnType<typeof setInterval> | null = null

  function median(xs: number[]): number | null {
    if (xs.length === 0) return null
    const s = [...xs].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  const BUCKET_MS = 2 * 60_000

  /** 以"现在"为右端点，向前切 30 个 2 分钟桶 */
  function buildBuckets(times: number[]): Bucket[] {
    const end = Date.now()
    const total = Math.floor((windowMinutes * 60_000) / BUCKET_MS)
    const out: Bucket[] = []
    for (let i = 0; i < total; i++) {
      const t = end - (total - i) * BUCKET_MS
      out.push({ t, rows: 0, expected: BUCKET_MS / 5000 })
    }
    for (const ts of times) {
      const idx = total - 1 - Math.floor((end - ts) / BUCKET_MS)
      if (idx >= 0 && idx < total) out[idx].rows++
    }
    return out
  }

  async function refresh(): Promise<void> {
    if (opts.enabled === false) return
    loading.value = true
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString()

    const { data, error: err } = await client
      .from('imu_samples')
      .select('recorded_at, device_ts')
      .eq('device_id', opts.deviceId)
      .gte('recorded_at', since)
      .order('recorded_at', { ascending: false })
      .limit(2000)

    loading.value = false
    if (err) {
      error.value = err.message
      return
    }
    error.value = null

    const rows = data ?? []
    if (rows.length === 0) {
      snapshot.value = {
        lastSampleAt: 0,
        rows: 0,
        expected: 0,
        arrivalRate: null,
        clockSkewMs: null,
        deviceTsRatio: null,
        buckets: buildBuckets([]),
      }
      return
    }

    const times = rows.map((r) => Date.parse(r.recorded_at as string)).filter(Number.isFinite)
    const first = Math.min(...times)
    const last = Math.max(...times)
    const spanSec = Math.max(1, (last - first) / 1000)
    const expected = Math.max(1, Math.round(spanSec / 5))

    const skews: number[] = []
    let withTs = 0
    for (const r of rows) {
      if (!r.device_ts) continue
      const rec = Date.parse(r.recorded_at as string)
      const dev = Date.parse(r.device_ts as string)
      if (!Number.isFinite(rec) || !Number.isFinite(dev)) continue
      withTs++
      skews.push(Math.abs(rec - dev))
    }

    snapshot.value = {
      lastSampleAt: last,
      rows: rows.length,
      expected,
      arrivalRate: rows.length / expected,
      clockSkewMs: median(skews),
      deviceTsRatio: rows.length ? withTs / rows.length : null,
      buckets: buildBuckets(times),
    }
  }

  function start(): void {
    void refresh()
    timer = setInterval(() => void refresh(), 30_000)
    onUnmounted(() => {
      if (timer) clearInterval(timer)
    })
  }

  if (opts.enabled === false) {
    error.value = null
  } else {
    start()
  }

  return { snapshot, error, loading, refresh }
}
