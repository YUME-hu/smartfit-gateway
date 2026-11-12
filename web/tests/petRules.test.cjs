/**
 * 宠物规则单测
 *
 * 重点覆盖三类容易出错的地方：
 *   1. 等级边界（99/100、299/300 这种）
 *   2. 经验"幂等性"——用累计量算经验，重复计算不会膨胀
 *   3. 饥饿与心情的钳制与优先级
 *
 * 运行：npm test
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  LEVEL_THRESHOLDS,
  MAX_LEVEL,
  levelFromExp,
  progressOf,
  stageFromLevel,
  expFromSteps,
  foodFromSteps,
  expFromReps,
  foodFromReps,
  decayHunger,
  moodOf,
} = require('../.tmp/js/features/pet/petRules.js')

// ---------------------------------------------------------------- 等级

test('levelFromExp：阈值边界', () => {
  assert.equal(levelFromExp(0), 1)
  assert.equal(levelFromExp(99), 1)
  assert.equal(levelFromExp(100), 2)
  assert.equal(levelFromExp(299), 2)
  assert.equal(levelFromExp(300), 3)
  assert.equal(levelFromExp(699), 3)
  assert.equal(levelFromExp(700), 4)
  assert.equal(levelFromExp(1500), 5)
  assert.equal(levelFromExp(99999), MAX_LEVEL)
})

test('levelFromExp：负数与 NaN 安全归零', () => {
  assert.equal(levelFromExp(-100), 1)
  assert.equal(levelFromExp(Number.NaN), 1)
})

test('progressOf：等级内进度与下一级阈值', () => {
  const p = progressOf(150)
  assert.equal(p.level, 2)
  assert.equal(p.expIntoLevel, 50)
  assert.equal(p.expForLevel, 200) // 100 → 300
  assert.equal(p.ratio, 0.25)
  assert.equal(p.nextAt, 300)
})

test('progressOf：满级时 ratio=1 且没有下一级', () => {
  const p = progressOf(LEVEL_THRESHOLDS[MAX_LEVEL - 1] + 500)
  assert.equal(p.level, MAX_LEVEL)
  assert.equal(p.ratio, 1)
  assert.equal(p.nextAt, null)
})

test('stageFromLevel：1/2/3 三形态映射', () => {
  assert.equal(stageFromLevel(1), 1)
  assert.equal(stageFromLevel(2), 2)
  assert.equal(stageFromLevel(3), 2)
  assert.equal(stageFromLevel(4), 3)
  assert.equal(stageFromLevel(5), 3)
})

// ---------------------------------------------------------------- 经验换算

test('expFromSteps：每满 100 步给 10 经验，不足不计', () => {
  assert.equal(expFromSteps(0), 0)
  assert.equal(expFromSteps(99), 0)
  assert.equal(expFromSteps(100), 10)
  assert.equal(expFromSteps(250), 20)
  assert.equal(expFromSteps(1000), 100)
})

test('expFromSteps 是幂等的：重复调用同样的累计步数不会膨胀', () => {
  const a = expFromSteps(1234)
  const b = expFromSteps(1234)
  assert.equal(a, b)
  // 关键：不是"每来一包 +10"，所以 1234 步永远只值 120 经验
  assert.equal(a, 120)
})

test('foodFromSteps：每满 100 步给 1 食物', () => {
  assert.equal(foodFromSteps(0), 0)
  assert.equal(foodFromSteps(99), 0)
  assert.equal(foodFromSteps(250), 2)
})

test('expFromReps / foodFromReps：每满 10 个深蹲', () => {
  assert.equal(expFromReps(9), 0)
  assert.equal(expFromReps(10), 15)
  assert.equal(expFromReps(25), 30)
  assert.equal(foodFromReps(25), 4)
})

test('换算函数对负数/NaN 安全', () => {
  assert.equal(expFromSteps(-50), 0)
  assert.equal(foodFromReps(Number.NaN), 0)
})

// ---------------------------------------------------------------- 饥饿 / 心情

test('decayHunger：每小时 -2，并钳制在 0~100', () => {
  assert.equal(decayHunger(100, 3_600_000), 98)
  assert.equal(decayHunger(100, 30 * 60_000), 99)
  assert.equal(decayHunger(1, 10 * 3_600_000), 0)
  assert.equal(decayHunger(50, -1000), 50)
})

test('moodOf：优先级 眩晕 > 饿 > 运动 > 犯困 > 待机', () => {
  assert.equal(moodOf(10, true, true), 'dizzy')
  assert.equal(moodOf(10, true), 'hungry')
  assert.equal(moodOf(80, true), 'exercise')
  assert.equal(moodOf(40, false), 'sleep')
  assert.equal(moodOf(80, false), 'idle')
})

test('场景推演：走 1000 步 + 20 个深蹲能升到几级', () => {
  const exp = expFromSteps(1000) + expFromReps(20)
  assert.equal(exp, 100 + 30)
  assert.equal(levelFromExp(exp), 2) // 130 经验 = Lv2，还差 170 到 Lv3
  assert.equal(stageFromLevel(levelFromExp(exp)), 2)
})
