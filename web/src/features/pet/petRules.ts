/**
 * 宠物养成规则（纯函数，可单测）
 *
 * 设计原则：**经验只由"累计量"决定，不由事件次数决定**。
 * 这样前端重复收到同一条数据、或者页面刷新重放，都不会多算经验
 * （expFromSteps(累计步数) 是幂等的，而不是"每来一包 +10"）。
 */

export type PetStage = 1 | 2 | 3
export type PetMood = 'idle' | 'happy' | 'hungry' | 'exercise' | 'sleep' | 'dizzy'

/** 每级所需累计经验；索引即 level-1 */
export const LEVEL_THRESHOLDS = [0, 100, 300, 700, 1500] as const

export const MAX_LEVEL = LEVEL_THRESHOLDS.length

/** 每 100 步 → 10 经验 / 1 食物 */
export const STEPS_PER_EXP_TICK = 100
export const EXP_PER_STEP_TICK = 10
export const FOOD_PER_STEP_TICK = 1

/** 每 10 个深蹲 → 15 经验 / 2 食物 */
export const REPS_PER_EXP_TICK = 10
export const EXP_PER_REP_TICK = 15
export const FOOD_PER_REP_TICK = 2

/** 饥饿度每小时衰减 */
export const HUNGER_DECAY_PER_HOUR = 2

export function levelFromExp(exp: number): number {
  const safe = Number.isFinite(exp) ? Math.max(0, exp) : 0
  let level = 1
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (safe >= LEVEL_THRESHOLDS[i]) level = i + 1
  }
  return Math.min(level, MAX_LEVEL)
}

export interface PetProgress {
  level: number
  /** 当前等级内已获得的经验 */
  expIntoLevel: number
  /** 当前等级所需经验跨度；满级为 0 */
  expForLevel: number
  /** 0~1，用于进度条 */
  ratio: number
  /** 升到下一级所需的累计经验；满级为 null */
  nextAt: number | null
}

export function progressOf(exp: number): PetProgress {
  const safe = Number.isFinite(exp) ? Math.max(0, exp) : 0
  const level = levelFromExp(safe)
  const base = LEVEL_THRESHOLDS[level - 1]

  if (level >= MAX_LEVEL) {
    return { level, expIntoLevel: safe - base, expForLevel: 0, ratio: 1, nextAt: null }
  }

  const next = LEVEL_THRESHOLDS[level]
  const span = next - base
  return {
    level,
    expIntoLevel: safe - base,
    expForLevel: span,
    ratio: span > 0 ? Math.min(1, (safe - base) / span) : 1,
    nextAt: next,
  }
}

/** Lv1 幼体 / Lv2-3 少年 / Lv4-5 成熟 */
export function stageFromLevel(level: number): PetStage {
  if (level >= 4) return 3
  if (level >= 2) return 2
  return 1
}

export function expFromSteps(totalSteps: number): number {
  const safe = Number.isFinite(totalSteps) ? Math.max(0, totalSteps) : 0
  return Math.floor(safe / STEPS_PER_EXP_TICK) * EXP_PER_STEP_TICK
}

export function foodFromSteps(totalSteps: number): number {
  const safe = Number.isFinite(totalSteps) ? Math.max(0, totalSteps) : 0
  return Math.floor(safe / STEPS_PER_EXP_TICK) * FOOD_PER_STEP_TICK
}

export function expFromReps(totalReps: number): number {
  const safe = Number.isFinite(totalReps) ? Math.max(0, totalReps) : 0
  return Math.floor(safe / REPS_PER_EXP_TICK) * EXP_PER_REP_TICK
}

export function foodFromReps(totalReps: number): number {
  const safe = Number.isFinite(totalReps) ? Math.max(0, totalReps) : 0
  return Math.floor(safe / REPS_PER_EXP_TICK) * FOOD_PER_REP_TICK
}

/** 饥饿度随时间衰减，钳制在 0~100 */
export function decayHunger(hunger: number, elapsedMs: number): number {
  const h = Number.isFinite(hunger) ? hunger : 0
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const drop = (ms / 3_600_000) * HUNGER_DECAY_PER_HOUR
  return Math.max(0, Math.min(100, h - drop))
}

/**
 * 心情判定，优先级从高到低：
 *   饿坏了 > 正在运动 > 犯困 > 普通待机
 */
export function moodOf(hunger: number, active: boolean, dizzy = false): PetMood {
  if (dizzy) return 'dizzy'
  if (hunger < 25) return 'hungry'
  if (active) return 'exercise'
  if (hunger < 50) return 'sleep'
  return 'idle'
}
