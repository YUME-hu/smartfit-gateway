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

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
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
