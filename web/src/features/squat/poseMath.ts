/**
 * 姿态数学：关键点索引 + 关节角计算 + 左右侧选择
 *
 * 纯函数，不依赖 DOM / MediaPipe 运行时，可被单元测试直接覆盖。
 */

import type { LandmarkPoint } from './types'

/** MediaPipe Pose 的 33 点里我们关心的下标 */
export const POSE = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const

/**
 * 三点夹角（度）：以 b 为顶点，返回 ∠abc
 *
 * 用点积 + acos，值域 0..180。0° = 完全折叠，180° = 完全伸直。
 * 任何一点退化（长度为 0）时返回 NaN —— 调用方应视为"本帧无效"，
 * 而不是拿 NaN 去喂状态机。
 */
export function angleAt(a: LandmarkPoint, b: LandmarkPoint, c: LandmarkPoint): number {
  const abx = a.x - b.x
  const aby = a.y - b.y
  const cbx = c.x - b.x
  const cby = c.y - b.y

  const m1 = Math.hypot(abx, aby)
  const m2 = Math.hypot(cbx, cby)
  if (m1 < 1e-6 || m2 < 1e-6) return Number.NaN

  const cos = (abx * cbx + aby * cby) / (m1 * m2)
  // 浮点误差可能让 cos 略超 ±1，acos 会返回 NaN
  const clamped = Math.min(1, Math.max(-1, cos))
  return (Math.acos(clamped) * 180) / Math.PI
}

export interface KneeAngleResult {
  /** 膝关节角（度）；无可信侧时为 null */
  angle: number | null
  /** 采用了哪一侧（两侧都可信时取平均） */
  side: 'left' | 'right' | 'both' | null
}

function visible(lm: LandmarkPoint | undefined, minVisibility: number): boolean {
  if (!lm) return false
  // MediaPipe 有时不给 visibility（例如手动构造的测试数据），默认视为可见
  const v = lm.visibility === undefined ? 1 : lm.visibility
  return v >= minVisibility
}

/**
 * 从一帧关键点算出膝关节角
 *
 * 只采用"髋-膝-踝三点都足够可见"的那一侧：
 *   - 两侧都可用 → 取平均（视角正面时更稳）
 *   - 只有一侧可用 → 用那一侧（侧身拍摄的常见情况）
 *   - 都不可用 → null，**不要拿残缺数据去计数**
 */
export function kneeAngleFromPose(
  landmarks: LandmarkPoint[],
  minVisibility = 0.5,
): KneeAngleResult {
  const lh = landmarks[POSE.leftHip]
  const lk = landmarks[POSE.leftKnee]
  const la = landmarks[POSE.leftAnkle]
  const rh = landmarks[POSE.rightHip]
  const rk = landmarks[POSE.rightKnee]
  const ra = landmarks[POSE.rightAnkle]

  const leftOk = visible(lh, minVisibility) && visible(lk, minVisibility) && visible(la, minVisibility)
  const rightOk = visible(rh, minVisibility) && visible(rk, minVisibility) && visible(ra, minVisibility)

  const leftAngle = leftOk ? angleAt(lh, lk, la) : Number.NaN
  const rightAngle = rightOk ? angleAt(rh, rk, ra) : Number.NaN

  const hasLeft = Number.isFinite(leftAngle)
  const hasRight = Number.isFinite(rightAngle)

  if (hasLeft && hasRight) {
    return { angle: (leftAngle + rightAngle) / 2, side: 'both' }
  }
  if (hasLeft) return { angle: leftAngle, side: 'left' }
  if (hasRight) return { angle: rightAngle, side: 'right' }
  return { angle: null, side: null }
}
