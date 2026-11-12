/**
 * Vue3 Web 端：订阅"最新值"（实时看板）
 *
 * 这就是需求第 4 条在 Web 侧的落点。
 * App 端写 `device_latest` 一行 → Supabase Realtime 用 WebSocket 推给浏览器。
 * 对页面来说和"手机直接推 WebSocket"没区别，但不需要手机有公网 IP。
 *
 * 注意：
 *   - Realtime 的订阅受 RLS 约束，`device_latest` 必须对 anon 开放 select，
 *     且该表要加入 supabase_realtime publication，否则收不到任何事件。
 *   - 首次进页面先 select 一次拿当前值，避免"等到下一包才显示"。
 */

import { onUnmounted, ref } from 'vue'
import { createClient } from '@supabase/supabase-js'

export interface DeviceLatest {
  device_id: string
  recorded_at: string
  x: number
  y: number
  z: number
  /** 该 5 秒窗口内的步数 */
  steps: number | null
}

export interface UseDeviceLatestOptions {
  supabaseUrl: string
  supabaseAnonKey: string
  deviceId: string
}

export function useDeviceLatest(opts: UseDeviceLatestOptions) {
  const latest = ref<DeviceLatest | null>(null)
  const realtimeStatus = ref<'connecting' | 'live' | 'error'>('connecting')
  const error = ref<string | null>(null)

  const client = createClient(opts.supabaseUrl, opts.supabaseAnonKey)

  // 先取一次当前值
  void (async () => {
    const { data, error: err } = await client
      .from('device_latest')
      .select('*')
      .eq('device_id', opts.deviceId)
      .maybeSingle()

    if (err) {
      error.value = err.message
    } else if (data) {
      latest.value = data as DeviceLatest
    }
  })()

  const channel = client
    .channel(`device-latest-${opts.deviceId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'device_latest',
        filter: `device_id=eq.${opts.deviceId}`,
      },
      (payload: any) => {
        if (payload?.new) latest.value = payload.new as DeviceLatest
      },
    )
    .subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        realtimeStatus.value = 'live'
        error.value = null
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        realtimeStatus.value = 'error'
        error.value = 'Realtime 订阅失败：检查表是否加入 publication、RLS 是否允许 select'
      } else {
        realtimeStatus.value = 'connecting'
      }
    })

  onUnmounted(() => {
    void client.removeChannel(channel)
  })

  return { latest, realtimeStatus, error }
}
