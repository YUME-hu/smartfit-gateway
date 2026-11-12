/**
 * MediaPipe Pose 关键点与深蹲判定共用的类型
 *
 * 注意：本文件不 import 任何浏览器/MediaPipe 运行时，纯类型，
 * 这样算法模块可以被 node --test 直接测试（见 tests/squatCounter.test.cjs）。
 */

export interface LandmarkPoint {
  /** 归一化坐标 0..1 */
  x: number
  y: number
  z?: number
  /** MediaPipe 给的可见度 0..1 */
  visibility?: number
}

/** 深蹲的四个阶段 */
export type SquatPhase = 'standing' | 'descending' | 'bottom' | 'ascending'

/** 完成一次深蹲时产生的事件 */
export interface RepEvent {
  /** 第几次（从 1 开始） */
  repIndex: number
  /** 本次动作到达的最深膝角（度，越大越直） */
  minAngle: number
  /** 从开始下蹲到最后站直的总时长（ms） */
  durationMs: number
  /** 完成时刻（epoch ms 或 performance.now，由调用方统一） */
  finishedAt: number
}
