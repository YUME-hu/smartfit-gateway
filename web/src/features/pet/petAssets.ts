/**
 * 宠物素材路径映射
 *
 * 单独成一个文件的原因：这里要用 import.meta.env.BASE_URL，
 * 而 petRules.ts 要保持纯函数（要被 node --test 以 CJS 编译跑）。
 * 纯逻辑与资源路径分开，两边都不用妥协。
 *
 * 素材出处见 public/pets/CREDITS.md。
 */

import type { PetMood } from './petRules'

const BASE = import.meta.env.BASE_URL || '/'

const MOOD_IMAGE: Record<PetMood, string> = {
  idle: `${BASE}pets/pet-idle.webp`,
  happy: `${BASE}pets/pet-happy.webp`,
  hungry: `${BASE}pets/pet-hungry.webp`,
  exercise: `${BASE}pets/pet-exercise.webp`,
  sleep: `${BASE}pets/pet-sleep.webp`,
  dizzy: `${BASE}pets/pet-dizzy.webp`,
}

export function imageForMood(mood: PetMood): string {
  return MOOD_IMAGE[mood] ?? MOOD_IMAGE.idle
}

/** 升级/喂食时的庆祝表情 */
export function celebrationImage(): string {
  return `${BASE}pets/pet-praise.webp`
}

/** 素材署名，界面上要显示（答辩时要能说清出处） */
export const PET_CREDIT = {
  text: '形象：社区二创「鲸鱼娘」· 基于 溟月：上善无形 / ZipZipPipe 的设计',
  url: 'https://whaleychan.com/whale',
}
