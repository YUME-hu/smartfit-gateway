/**
 * 宠物状态：服务端权威 + Realtime 推送
 *
 * 前端**不直接写 pet_state 表**，所有读写都走 RPC：
 *   get_pet_summary / feed_pet / add_bonus_exp
 * 表只对 anon 开放 SELECT（给 Realtime 订阅用），写入全在 SECURITY DEFINER 里。
 *
 * ⚠️ 刷新要做防抖：手机批同步一次可能插 500 条样本，触发器会让 pet_state
 *    连变 500 次，Realtime 也就可能推 500 个事件。不防抖就是 500 次 RPC。
 */

import { onUnmounted, ref } from 'vue'
import { createClient } from '@supabase/supabase-js'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface PetSummary {
  device_id: string
  steps_total: number
  reps_total: number
  reps_live: number
  bonus_exp: number
  exp: number
  food_earned: number
  food_used: number
  food: number
  hunger: number
  last_fed_at: string | null
  updated_at: string
}

export interface UsePetStateOptions {
  supabaseUrl: string
  supabaseAnonKey: string
  deviceId: string
  /** 配置缺失时传 false：不连库，界面只提示配置 */
  enabled: boolean
}

export function usePetState(opts: UsePetStateOptions) {
  const summary = ref<PetSummary | null>(null)
  const status = ref<'connecting' | 'live' | 'error' | 'closed'>('connecting')
  const error = ref<string | null>(null)
  const busy = ref(false)

  const client = createClient(opts.supabaseUrl || 'https://placeholder.supabase.co', opts.supabaseAnonKey || 'placeholder')
  let channel: RealtimeChannel | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  async function refresh(): Promise<void> {
    const { data, error: err } = await client.rpc('get_pet_summary', {
      p_device_id: opts.deviceId,
    })
    if (err) {
      error.value = err.message
      status.value = 'error'
      return
    }
    summary.value = data as PetSummary
    error.value = null
  }

  /** 防抖：把一批变更折叠成一次读取 */
  function scheduleRefresh(): void {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refresh()
    }, 400)
  }

  async function feed(): Promise<{ ok: boolean; reason?: string }> {
    busy.value = true
    try {
      const { data, error: err } = await client.rpc('feed_pet', { p_device_id: opts.deviceId })
      if (err) {
        error.value = err.message
        return { ok: false, reason: err.message }
      }
      summary.value = data as PetSummary
      const r = data as { ok?: boolean; reason?: string }
      return { ok: r.ok === true, reason: r.reason }
    } finally {
      busy.value = false
    }
  }

  async function addBonusExp(delta: number): Promise<void> {
    const { data, error: err } = await client.rpc('add_bonus_exp', {
      p_device_id: opts.deviceId,
      p_delta: delta,
    })
    if (err) {
      error.value = err.message
      return
    }
    summary.value = data as PetSummary
  }

  /** 写一条深蹲记录，走真实的 anon INSERT → 触发器 → pet_state 链路 */
  async function recordSquat(sessionId: string, repIndex: number): Promise<boolean> {
    const { error: err } = await client.from('reps').insert({
      client_key: `${sessionId}:${repIndex}`,
      session_id: sessionId,
      source: 'vision',
      rep_index: repIndex,
      recorded_at: new Date().toISOString(),
      min_angle: 95,
      duration_ms: 1500,
      device_id: opts.deviceId,
    })
    if (err && err.code !== '23505') {
      error.value = err.message
      return false
    }
    scheduleRefresh()
    return true
  }

  if (opts.enabled) {
    void refresh()
    channel = client
      .channel(`pet-${opts.deviceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pet_state',
          filter: `device_id=eq.${opts.deviceId}`,
        },
        () => {
          status.value = 'live'
          scheduleRefresh()
        },
      )
      .subscribe((s: string) => {
        if (s === 'SUBSCRIBED') {
          status.value = 'live'
          error.value = null
          void refresh()
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          status.value = 'error'
          error.value = 'Realtime 订阅异常：检查 pet_state 是否在 publication 且 replica identity 为 full'
        }
      })

    onUnmounted(() => {
      if (refreshTimer) clearTimeout(refreshTimer)
      if (channel) void client.removeChannel(channel)
    })
  } else {
    status.value = 'closed'
  }

  return { summary, status, error, busy, refresh, feed, addBonusExp, recordSquat }
}
