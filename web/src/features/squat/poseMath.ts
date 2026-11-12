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

/**
 * 腿部是否"完整且可信"地出现在画面里
 *
 * 为什么需要它（这是实测录屏暴露出来的）：
 *   当摄像头只拍到上半身时，MediaPipe **仍然会输出膝/踝关键点**（外推到画外），
 *   visibility 也可能高于 0.5。于是膝角照样算得出来，但那是编的。
 *   实测现象：只拍到腰的人，界面照样显示 87° 并计了数 —— 数据是假的。
 *
 * 这里用三个几何约束做"物理合理性"校验，任何一条不过就视为该侧不可用：
 *   1. 三个点都不能贴画面边缘（贴边通常意味着被裁掉）
 *   2. 膝要在髋与踝之间（y 方向居中），腿不能在解剖上反着长
 *   3. 髋→踝的垂直跨度要够大、且膝是这段的中段（防止三点挤在一起）
 */
export interface LegCheckOptions {
  minVisibility?: number
  /** 距画面边缘小于该比例视为"被裁掉" */
  edgeMargin?: number
  /** 髋→踝的最小垂直跨度（归一化坐标），低于此说明腿没入画 */
  minLegSpan?: number
}

export interface LegCheckResult {
  ok: boolean
  side: 'left' | 'right' | 'both' | null
  /** 不可用时的原因，直接可以提示给用户 */
  reason?: string
}

function usableSide(
  hip: LandmarkPoint | undefined,
  knee: LandmarkPoint | undefined,
  ankle: LandmarkPoint | undefined,
  minVisibility: number,
  edgeMargin: number,
  minLegSpan: number,
): boolean {
  if (!visible(hip, minVisibility) || !visible(knee, minVisibility) || !visible(ankle, minVisibility)) {
    return false
  }

  const points = [hip as LandmarkPoint, knee as LandmarkPoint, ankle as LandmarkPoint]
  for (const p of points) {
    if (p.x < edgeMargin || p.x > 1 - edgeMargin || p.y < edgeMargin || p.y > 1 - edgeMargin) {
      return false // 贴边 = 被裁
    }
  }

  const span = Math.abs((ankle as LandmarkPoint).y - (hip as LandmarkPoint).y)
  if (span < minLegSpan) return false // 腿的长度在画面里太短 = 没拍全

  const kneeY = (knee as LandmarkPoint).y
  const top = Math.min((hip as LandmarkPoint).y, (ankle as LandmarkPoint).y)
  const bottom = Math.max((hip as LandmarkPoint).y, (ankle as LandmarkPoint).y)
  const tolerance = span * 0.15
  if (kneeY < top - tolerance || kneeY > bottom + tolerance) return false // 膝盖跑到髋踝连线之外

  return true
}

export function legLooksComplete(
  landmarks: LandmarkPoint[],
  opts: LegCheckOptions = {},
): LegCheckResult {
  const minVisibility = opts.minVisibility ?? 0.5
  const edgeMargin = opts.edgeMargin ?? 0.02
  const minLegSpan = opts.minLegSpan ?? 0.12

  const leftOk = usableSide(
    landmarks[POSE.leftHip],
    landmarks[POSE.leftKnee],
    landmarks[POSE.leftAnkle],
    minVisibility,
    edgeMargin,
    minLegSpan,
  )
  const rightOk = usableSide(
    landmarks[POSE.rightHip],
    landmarks[POSE.rightKnee],
    landmarks[POSE.rightAnkle],
    minVisibility,
    edgeMargin,
    minLegSpan,
  )

  if (leftOk && rightOk) return { ok: true, side: 'both' }
  if (leftOk) return { ok: true, side: 'left' }
  if (rightOk) return { ok: true, side: 'right' }
  return {
    ok: false,
    side: null,
    reason: '看不到完整的腿（髋/膝/踝）。请后退，让全身进入画面，并尽量侧身站。',
  }
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
