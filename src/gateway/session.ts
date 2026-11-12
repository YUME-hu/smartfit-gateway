/**
 * 上电会话归属 & 幂等键生成
 *
 * 问题：手表没有 RTC，也不广播 bootId，但 Supabase 侧需要唯一键来防重复。
 * 解法：手表每次重启，seq 会从 0 重新开始。网关只要发现 "seq 回退"，
 *      就认为手表重启过，把本地 bootEpoch +1。于是
 *      `deviceId:bootEpoch:seq` 在一次上电内唯一，跨上电也不撞。
 *
 * 这个状态必须持久化 —— App 被系统杀掉重启后，lastSeq 丢了的话，
 * 同一个 seq 会被算进新会话，产生重复行。
 */

import type { ParsedPacket } from './protocol'
import type { KeyValueStore } from './storage'
import type { ImuSample } from './types'

interface SessionState {
  bootEpoch: number
  lastSeq: number | null
}

const SESSION_KEY = 'imu.session'

export class SessionTracker {
  private state: SessionState
  /** 本包与上一包之间丢失的包数（仅日志/看板用，不影响入库） */
  lastGap = 0

  constructor(
    private store: KeyValueStore,
    private deviceId: string,
  ) {
    this.state = this.load()
  }

  get bootEpoch(): number {
    return this.state.bootEpoch
  }

  /** 把一包解析结果落成一条带幂等键的样本 */
  attribute(packet: ParsedPacket, ts: number): ImuSample {
    this.lastGap = 0

    if (packet.seq === null) {
      // 老固件（只有 x,y,z）：只能拿接收时间当键
      return {
        key: `${this.deviceId}:${this.state.bootEpoch}:@${ts}`,
        deviceId: this.deviceId,
        bootEpoch: this.state.bootEpoch,
        seq: null,
        stepsInWindow: packet.steps,
        ts,
        x: packet.x,
        y: packet.y,
        z: packet.z,
      }
    }

    const last = this.state.lastSeq
    if (last !== null && packet.seq < last) {
      // seq 回退 → 手表重新上电
      this.state.bootEpoch++
      this.state.lastSeq = packet.seq
      this.save()
    } else if (last !== null && packet.seq > last + 1) {
      // 只是丢包，不换会话
      this.lastGap = packet.seq - last - 1
      this.state.lastSeq = packet.seq
      this.save()
    } else {
      this.state.lastSeq = packet.seq
      this.save()
    }

    return {
      key: `${this.deviceId}:${this.state.bootEpoch}:${packet.seq}`,
      deviceId: this.deviceId,
      bootEpoch: this.state.bootEpoch,
      seq: packet.seq,
      stepsInWindow: packet.steps,
      ts,
      x: packet.x,
      y: packet.y,
      z: packet.z,
    }
  }

  private load(): SessionState {
    const raw = this.store.get(SESSION_KEY)
    if (raw) {
      try {
        const s = JSON.parse(raw) as Partial<SessionState>
        return {
          bootEpoch: Number.isInteger(s.bootEpoch) ? (s.bootEpoch as number) : 0,
          lastSeq: Number.isInteger(s.lastSeq) ? (s.lastSeq as number) : null,
        }
      } catch {
        // 损坏则重新开始，最多丢一次去重能力
      }
    }
    return { bootEpoch: 0, lastSeq: null }
  }

  private save(): void {
    this.store.set(SESSION_KEY, JSON.stringify(this.state))
  }
}
