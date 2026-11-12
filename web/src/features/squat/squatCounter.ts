/**
 * 深蹲计数状态机（纯函数）
 *
 * 判定逻辑：用膝关节角在 **160°(站立) / 100°(蹲底)** 两个阈值之间走状态机。
 *
 * 为什么必须双阈值（滞回）：
 *   单阈值在"角度正好卡在边界"时会疯狂来回翻转，一个人站着微抖就能刷出几十次。
 *   两个阈值之间留了 60° 的死区，只有真正蹲下去再站起来才算一次。
 *
 * 为什么必须有最短时长：
 *   摄像头抖动、快速抬腿都可能在一帧内穿过死区。要求一次动作 ≥ 0.6 秒，
 *   既过滤误判，也符合真实深蹲节奏（正常 1.5~2 秒一次）。
 *
 * 状态转移：
 *   standing ──(角<160)──▶ descending ──(角≤100)──▶ bottom
 *      ▲                                               │
 *      │                                          (角>100)
 *      └────(角≥160 且 到过蹲底 且 时长≥0.6s)──── ascending
 *
 * 关键安全属性：**没到过蹲底就不计数**（浅蹲/半蹲不算），
 * 避免"站着膝盖微弯"被当成深蹲。
 */

import type { RepEvent, SquatPhase } from './types'

export interface SquatConfig {
  /** 站直判定阈值（度）：≥ 此值视为站起来 */
  standAngle: number
  /** 蹲底判定阈值（度）：≤ 此值视为蹲到底 */
  bottomAngle: number
  /** 一次动作的最短时长（ms），即"冷却时间" */
  minRepMs: number
  /**
   * 一次动作的最长时长（ms）。
   * 实测教训：没有这个上限时，人走出画面、两分钟后回来站直，
   * 会被算成一次"深蹲"，库里出现 duration=126809ms 的假记录。
   */
  maxRepMs: number
}

export const DEFAULT_SQUAT_CONFIG: SquatConfig = {
  standAngle: 160,
  bottomAngle: 100,
  minRepMs: 600,
  maxRepMs: 8000,
}

export interface SquatState {
  phase: SquatPhase
  /** 已完成次数 */
  reps: number
  /** 本次动作中到达的最深角度 */
  minAngleInRep: number
  /** 本次动作开始时间；未开始为 null */
  repStartedAt: number | null
  /** 本次动作是否真的到过蹲底（决定要不要计数） */
  reachedBottom: boolean
}

export function createSquatState(): SquatState {
  return {
    phase: 'standing',
    reps: 0,
    minAngleInRep: 180,
    repStartedAt: null,
    reachedBottom: false,
  }
}

export interface FeedResult {
  state: SquatState
  /** 本次调用完成了一次深蹲时非 null */
  rep: RepEvent | null
}

/**
 * 喂一帧膝角，返回新状态与可能的完成事件。
 *
 * 不可变：返回的是新对象，原 state 不被修改（方便 UI 层 diff 和测试断言）。
 * 允许一帧内级联多次转移（例如 170° → 90° 一帧到位），
 * 否则"跳过 bottom"的快速动作会被漏计。
 */
export function feedSquatAngle(
  state: SquatState,
  angle: number,
  nowMs: number,
  cfg: SquatConfig = DEFAULT_SQUAT_CONFIG,
): FeedResult {
  // 无效帧（NaN / Infinity）直接原样返回，不污染状态
  if (!Number.isFinite(angle)) {
    return { state, rep: null }
  }

  let s: SquatState = state
  let rep: RepEvent | null = null

  // 超时保护：动作拖太久说明人已经不在做动作了（走开/画面丢失），直接作废
  if (s.phase !== 'standing' && s.repStartedAt !== null && nowMs - s.repStartedAt > cfg.maxRepMs) {
    s = { ...s, phase: 'standing', repStartedAt: null, minAngleInRep: 180, reachedBottom: false }
  }

  for (let guard = 0; guard < 4; guard++) {
    const before = s.phase

    if (s.phase === 'standing') {
      if (angle < cfg.standAngle) {
        s = {
          ...s,
          phase: 'descending',
          repStartedAt: nowMs,
          minAngleInRep: angle,
          reachedBottom: false,
        }
      }
    } else if (s.phase === 'descending') {
      s = { ...s, minAngleInRep: Math.min(s.minAngleInRep, angle) }
      if (angle <= cfg.bottomAngle) {
        s = { ...s, phase: 'bottom', reachedBottom: true }
      } else if (angle >= cfg.standAngle) {
        // 浅蹲又站回去了：丢弃这次，不算
        s = { ...s, phase: 'standing', repStartedAt: null, minAngleInRep: 180, reachedBottom: false }
      }
    } else if (s.phase === 'bottom') {
      if (angle > cfg.bottomAngle) {
        s = { ...s, phase: 'ascending' }
      }
    } else {
      // ascending
      s = { ...s, minAngleInRep: Math.min(s.minAngleInRep, angle) }
      if (angle >= cfg.standAngle) {
        const startedAt = s.repStartedAt ?? nowMs
        const duration = nowMs - startedAt
        if (s.reachedBottom && duration >= cfg.minRepMs) {
          rep = {
            repIndex: s.reps + 1,
            minAngle: s.minAngleInRep,
            durationMs: duration,
            finishedAt: nowMs,
          }
          s = {
            ...s,
            reps: s.reps + 1,
            phase: 'standing',
            repStartedAt: null,
            minAngleInRep: 180,
            reachedBottom: false,
          }
        } else {
          s = { ...s, phase: 'standing', repStartedAt: null, minAngleInRep: 180, reachedBottom: false }
        }
      } else if (angle <= cfg.bottomAngle) {
        // 站起来一半又蹲回去，继续算同一次动作
        s = { ...s, phase: 'bottom', reachedBottom: true }
      }
    }

    // 没有发生状态转移就没必要继续级联
    if (s.phase === before) break
  }

  return { state: s, rep }
}

/** 给 UI 用的中文标签 */
export function phaseLabel(phase: SquatPhase): string {
  switch (phase) {
    case 'standing':
      return '站立'
    case 'descending':
      return '下蹲中'
    case 'bottom':
      return '蹲底'
    case 'ascending':
      return '起身中'
  }
}
