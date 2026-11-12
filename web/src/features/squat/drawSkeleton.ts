/**
 * 骨架绘制
 *
 * 只画驱动判定用的那条链（肩-髋-膝-踝）+ 躯干，避免画面太乱。
 * 关键点低于可见度阈值就不画，免得出现"线连到画面外面"的怪东西。
 */

import type { LandmarkPoint } from './types'
import { POSE } from './poseMath'

const CONNECTIONS: Array<[number, number]> = [
  [POSE.leftShoulder, POSE.rightShoulder],
  [POSE.leftShoulder, POSE.leftHip],
  [POSE.rightShoulder, POSE.rightHip],
  [POSE.leftHip, POSE.rightHip],
  [POSE.leftHip, POSE.leftKnee],
  [POSE.leftKnee, POSE.leftAnkle],
  [POSE.rightHip, POSE.rightKnee],
  [POSE.rightKnee, POSE.rightAnkle],
]

/** 这些关节画大一点并高亮，答辩时一眼能看出在看膝盖 */
const HIGHLIGHT = [POSE.leftKnee, POSE.rightKnee, POSE.leftHip, POSE.rightHip]

export interface DrawOptions {
  color?: string
  highlightColor?: string
  minVisibility?: number
}

/** 取景状态：good = 全身入画，bad = 需要调整，idle = 还没检测到人 */
export type FramingState = 'idle' | 'bad' | 'good'

const GUIDE_COLORS: Record<FramingState, { stroke: string; fill: string; label: string }> = {
  idle: { stroke: 'rgba(255,255,255,0.45)', fill: 'rgba(255,255,255,0.05)', label: '站进引导框内' },
  bad: { stroke: 'rgba(255,176,32,0.85)', fill: 'rgba(255,176,32,0.08)', label: '调整位置：脚踝到头顶都要在框内' },
  good: { stroke: 'rgba(61,220,132,0.95)', fill: 'rgba(61,220,132,0.10)', label: '取景完美 ✓' },
}

/**
 * 人体引导框（答辩加分项）
 *
 * 画在视频同款 canvas 上，所以和画面 letterbox 完全对齐 —— 引导框的位置
 * 就是"人应该站的位置"，人站进去、关键点齐全后整框变绿。
 *
 * 轮廓按归一化坐标写死（0..1），换分辨率不用改：
 *   头(0.5,0.13) · 肩(0.42~0.58, 0.22) · 髋(0.44~0.56, 0.52) · 脚(0.42/0.58, 0.86)
 */
export function drawFramingGuide(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  state: FramingState,
): void {
  const c = GUIDE_COLORS[state]
  const X = (n: number) => n * width
  const Y = (n: number) => n * height

  ctx.save()
  ctx.lineWidth = Math.max(2, width * 0.0035)
  ctx.strokeStyle = c.stroke
  ctx.fillStyle = c.fill

  // 虚线描边，避免和骨架（实线）混淆
  ctx.setLineDash([Math.max(6, width * 0.012), Math.max(5, width * 0.01)])

  // 头部
  const headR = width * 0.045
  ctx.beginPath()
  ctx.arc(X(0.5), Y(0.13), headR, 0, Math.PI * 2)
  ctx.stroke()
  ctx.fill()

  // 躯干（肩宽 → 髋宽）
  ctx.beginPath()
  ctx.moveTo(X(0.42), Y(0.21))
  ctx.lineTo(X(0.58), Y(0.21))
  ctx.lineTo(X(0.56), Y(0.52))
  ctx.lineTo(X(0.44), Y(0.52))
  ctx.closePath()
  ctx.stroke()
  ctx.fill()

  // 双腿
  ctx.beginPath()
  ctx.moveTo(X(0.44), Y(0.52))
  ctx.lineTo(X(0.42), Y(0.86))
  ctx.moveTo(X(0.56), Y(0.52))
  ctx.lineTo(X(0.58), Y(0.86))
  ctx.stroke()

  // 脚
  ctx.beginPath()
  ctx.moveTo(X(0.42), Y(0.86))
  ctx.lineTo(X(0.38), Y(0.88))
  ctx.moveTo(X(0.58), Y(0.86))
  ctx.lineTo(X(0.62), Y(0.88))
  ctx.stroke()

  ctx.restore()
}

/** 引导文案，给 UI 直接显示 */
export function framingLabel(state: FramingState): string {
  return GUIDE_COLORS[state].label
}

export function drawSkeleton(  ctx: CanvasRenderingContext2D,
  landmarks: LandmarkPoint[],
  width: number,
  height: number,
  opts: DrawOptions = {},
): void {
  const color = opts.color ?? 'rgba(61,126,255,0.9)'
  const highlight = opts.highlightColor ?? 'rgba(61,220,132,0.95)'
  const minVis = opts.minVisibility ?? 0.4

  const ok = (i: number): boolean => {
    const lm = landmarks[i]
    if (!lm) return false
    const v = lm.visibility === undefined ? 1 : lm.visibility
    return v >= minVis
  }

  ctx.lineWidth = Math.max(2, width * 0.004)
  ctx.lineCap = 'round'

  ctx.strokeStyle = color
  for (const [a, b] of CONNECTIONS) {
    if (!ok(a) || !ok(b)) continue
    ctx.beginPath()
    ctx.moveTo(landmarks[a].x * width, landmarks[a].y * height)
    ctx.lineTo(landmarks[b].x * width, landmarks[b].y * height)
    ctx.stroke()
  }

  for (let i = 0; i < landmarks.length; i++) {
    if (!ok(i)) continue
    const isKey = HIGHLIGHT.includes(i as (typeof HIGHLIGHT)[number])
    if (!isKey) continue
    const r = Math.max(4, width * 0.009)
    ctx.fillStyle = highlight
    ctx.beginPath()
    ctx.arc(landmarks[i].x * width, landmarks[i].y * height, r, 0, Math.PI * 2)
    ctx.fill()
  }
}
