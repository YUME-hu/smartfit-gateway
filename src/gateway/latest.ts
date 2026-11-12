/**
 * 最新值发布（实时看板的"WebSocket"那一段）
 *
 * 需求原文是"App 保留一份最新数据，通过 WebSocket 推给 Web 端"。
 * 但手机做不到这件事：
 *   - 手机在运营商/校园网 NAT 后面，没有公网 IP，Web 端连不上；
 *   - 小程序/uni-app 运行时也起不了 WebSocket 服务端；
 *   - 就算能起，Vue 页面在 https 下连 ws://<手机内网IP> 会被混合内容策略拦掉。
 *
 * 所以这里把"推"换成"写一行 + 让别人推"：
 *   App  ---- upsert device_latest ----▶  Supabase
 *                                          │ Realtime(本身就是 WebSocket)
 *   Vue  ◀──── postgres_changes 订阅 ───────┘
 * 对 Web 端的效果完全一致：手机一收到新包，看板立刻更新。
 *
 * 节流：5 秒一包本来就不密，但手表改回高频时这里能兜住，避免把免费额度打满。
 */

import type { ImuSample } from './types'
import type { SupabaseRest } from './supabaseRest'

export class LatestPublisher {
  private lastSentAt = 0
  private pending: ImuSample | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private api: SupabaseRest,
    /** 两次 upsert 的最小间隔，默认 1s */
    private minIntervalMs: number = 1000,
    private onError?: (message: string) => void,
  ) {}

  /** 收到新样本时调用；不阻塞采集 */
  publish(sample: ImuSample): void {
    const now = Date.now()
    const wait = this.minIntervalMs - (now - this.lastSentAt)

    if (wait <= 0) {
      this.send(sample)
      return
    }

    // 节流窗口内的样本只保留最新的那条
    this.pending = sample
    if (this.timer !== null) return

    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.pending
      this.pending = null
      if (next) this.send(next)
    }, wait)
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }

  private send(sample: ImuSample): void {
    this.lastSentAt = Date.now()
    void this.api
      .upsertLatest({
        device_id: sample.deviceId,
        recorded_at: new Date(sample.ts).toISOString(),
        x: sample.x,
        y: sample.y,
        z: sample.z,
        steps: sample.stepsInWindow,
      })
      .catch((e: unknown) => {
        // 最新值只是看板用的，失败绝不能影响主采集链路
        this.onError?.(e instanceof Error ? e.message : String(e))
      })
  }
}
