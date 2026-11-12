/**
 * 订阅 device_latest 的实时变化
 *
 * 数据流：App 每收到手表一包 → upsert device_latest → Realtime 推事件 → 这里
 *
 * 三个必须处理的现实问题：
 *  1. **重复投递**：Realtime 断线重连后可能重发同一行。用 recorded_at 单调递增
 *     做去重，否则会话累计步数会翻倍。
 *  2. **首帧**：订阅建立到第一包之间有空白期，所以进页面先 select 一次当前值。
 *  3. **UPDATE 收不到**：表必须 `replica identity full`，否则订阅成功但不推
 *     UPDATE 事件（服务端静默丢弃）。页面上能看到的症状是"数字停在第一帧"。
 */

import { onUnmounted, ref } from 'vue'
import { createClient } from '@supabase/supabase-js'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'

export interface DeviceLatest {
  device_id: string
  recorded_at: string
  x: number
  y: number
  z: number
  steps: number | null
}

export interface ChartPoint {
  /** epoch ms */
  t: number
  /** 合模量 |a| */
  mag: number
  /** 该窗口步数 */
  steps: number
}

export interface UseDeviceLatestOptions {
  supabaseUrl: string
  supabaseAnonKey: string
  deviceId: string
  /** 折线图保留点数，默认 120（5s/包 → 10 分钟） */
  maxPoints?: number
  /** 配置缺失时传 false：不连库、不订阅，界面只显示配置提示 */
  enabled?: boolean
}

export type RealtimeStatus = 'connecting' | 'live' | 'error' | 'closed'

export function useDeviceLatest(opts: UseDeviceLatestOptions) {
  const latest = ref<DeviceLatest | null>(null)
  const points = ref<ChartPoint[]>([])
  const status = ref<RealtimeStatus>('connecting')
  const error = ref<string | null>(null)
  /** 自页面打开起的累计步数（不是全天总计，见 README 说明） */
  const sessionSteps = ref(0)
  /** 最近一次数据时间（epoch ms） */
  const lastAt = ref(0)

  const maxPoints = opts.maxPoints ?? 120
  const client = createClient(opts.supabaseUrl, opts.supabaseAnonKey)
  let channel: RealtimeChannel | null = null

  /** 统一入口：去重 + 更新 + 入图 */
  function ingest(row: DeviceLatest): void {
    const t = Date.parse(row.recorded_at)
    if (!Number.isFinite(t)) return
    // 单调去重：旧数据或重复投递一律忽略
    if (t <= lastAt.value) return

    lastAt.value = t
    latest.value = row
    sessionSteps.value += row.steps ?? 0

    const mag = Math.sqrt(row.x * row.x + row.y * row.y + row.z * row.z)
    points.value.push({ t, mag, steps: row.steps ?? 0 })
    if (points.value.length > maxPoints) {
      points.value.splice(0, points.value.length - maxPoints)
    }
  }

  async function fetchInitial(): Promise<void> {
    const { data, error: err } = await client
      .from('device_latest')
      .select('*')
      .eq('device_id', opts.deviceId)
      .maybeSingle()

    if (err) {
      error.value = err.message
      return
    }
    if (data) ingest(data as DeviceLatest)
  }

  function subscribe(): void {
    channel = client
      .channel(`device-latest-${opts.deviceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'device_latest',
          filter: `device_id=eq.${opts.deviceId}`,
        },
        (payload: RealtimePostgresChangesPayload<DeviceLatest>) => {
          const row = payload.new as DeviceLatest | undefined
          if (row && typeof row.recorded_at === 'string') ingest(row)
        },
      )
      .subscribe((s: string) => {
        if (s === 'SUBSCRIBED') {
          status.value = 'live'
          error.value = null
          // 重连后补一次当前值，避免断线期间丢帧导致图上有洞
          void fetchInitial()
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          status.value = 'error'
          error.value = 'Realtime 订阅异常：检查表是否在 publication、RLS 是否允许 select'
        } else if (s === 'CLOSED') {
          status.value = 'closed'
        } else {
          status.value = 'connecting'
        }
      })
  }

  /** 手动重连（界面上给个按钮，比刷新页面友好） */
  async function reconnect(): Promise<void> {
    error.value = null
    status.value = 'connecting'
    if (channel) {
      await client.removeChannel(channel)
      channel = null
    }
    subscribe()
    await fetchInitial()
  }

  // 配置缺失时（enabled=false）完全不连库，避免控制台刷一堆无意义的连接错误
  if (opts.enabled === false) {
    status.value = 'closed'
  } else {
    void fetchInitial()
    subscribe()
    onUnmounted(() => {
      if (channel) void client.removeChannel(channel)
    })
  }

  return { latest, points, status, error, sessionSteps, lastAt, reconnect }
}