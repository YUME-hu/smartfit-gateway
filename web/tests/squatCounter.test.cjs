/**
 * 深蹲判定算法单元测试
 *
 * 跑的是真实 TS 编译产物（tsc → .tmp/js），不是 JS 复刻。
 * 覆盖的都是"真机上很难复现、但线上一定出问题"的场景：
 *   - 浅蹲不该计数
 *   - 站在阈值附近抖动不该刷数
 *   - 动作过快不该计数
 *   - 关键点缺失时不该拿残缺数据计数
 *
 * 运行：npm test
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createSquatState,
  feedSquatAngle,
  DEFAULT_SQUAT_CONFIG,
  phaseLabel,
} = require('../.tmp/js/features/squat/squatCounter.js')

const { angleAt, kneeAngleFromPose, legLooksComplete, POSE } = require('../.tmp/js/features/squat/poseMath.js')

const cfg = DEFAULT_SQUAT_CONFIG

// ---------------------------------------------------------------- 状态机

test('完整深蹲：站起来 → 蹲到底 → 站直 = 1 次', () => {
  let s = createSquatState()
  let rep = null

  // 站直
  ;({ state: s, rep } = feedSquatAngle(s, 170, 0, cfg))
  assert.equal(s.phase, 'standing')
  assert.equal(rep, null)

  // 下蹲到 90°
  ;({ state: s } = feedSquatAngle(s, 90, 100, cfg))
  assert.equal(s.phase, 'bottom')

  // 站直
  ;({ state: s, rep } = feedSquatAngle(s, 170, 800, cfg))
  assert.equal(s.phase, 'standing')
  assert.equal(s.reps, 1)
  assert.equal(rep.repIndex, 1)
  assert.equal(rep.minAngle, 90)
  assert.equal(rep.durationMs, 700)
})

test('浅蹲（只到 120°，没到蹲底阈值）不计数', () => {
  let s = createSquatState()
  let rep = null

  ;({ state: s } = feedSquatAngle(s, 170, 0, cfg))
  ;({ state: s } = feedSquatAngle(s, 120, 300, cfg))
  assert.equal(s.phase, 'descending')
  ;({ state: s, rep } = feedSquatAngle(s, 170, 900, cfg))

  assert.equal(s.reps, 0, '没到 100° 就不该算一次')
  assert.equal(rep, null)
  assert.equal(s.phase, 'standing')
})

test('在 155°~165° 之间抖动 30 次，不产生任何计数（滞回死区）', () => {
  let s = createSquatState()
  let reps = 0

  for (let i = 0; i < 30; i++) {
    const angle = i % 2 === 0 ? 155 : 165
    const r = feedSquatAngle(s, angle, i * 40, cfg)
    s = r.state
    if (r.rep) reps++
  }

  assert.equal(reps, 0, '站在阈值附近抖动绝不能刷数')
  assert.equal(s.reps, 0)
})

test('动作过快（< 0.6s）不计数', () => {
  let s = createSquatState()
  let rep = null

  ;({ state: s } = feedSquatAngle(s, 170, 0, cfg))
  ;({ state: s } = feedSquatAngle(s, 90, 100, cfg))
  assert.equal(s.phase, 'bottom')
  ;({ state: s, rep } = feedSquatAngle(s, 170, 300, cfg))

  assert.equal(rep, null, '300ms 完成的动作应被冷却时间拦掉')
  assert.equal(s.reps, 0)
  assert.equal(s.phase, 'standing')
})

test('连续两次深蹲：计数 2，repIndex 递增', () => {
  let s = createSquatState()
  const reps = []

  const feed = (angle, t) => {
    const r = feedSquatAngle(s, angle, t, cfg)
    s = r.state
    if (r.rep) reps.push(r.rep)
  }

  feed(170, 0)
  feed(90, 300)
  feed(170, 1100)
  feed(90, 1600)
  feed(175, 2300)

  assert.equal(s.reps, 2)
  assert.deepEqual(reps.map((r) => r.repIndex), [1, 2])
  // 时长从「离开站立」算起，不是从第一个采样算起
  assert.equal(reps[0].durationMs, 800) // 300 → 1100
  assert.equal(reps[1].durationMs, 700) // 1600 → 2300
})

test('恰好 600ms 的动作算数（边界包含）', () => {
  let s = createSquatState()
  let rep = null

  ;({ state: s } = feedSquatAngle(s, 170, 0, cfg))
  ;({ state: s } = feedSquatAngle(s, 90, 100, cfg))
  ;({ state: s, rep } = feedSquatAngle(s, 170, 700, cfg)) // 100 → 700 = 600ms

  assert.notEqual(rep, null, 'minRepMs 是闭区间下界')
  assert.equal(rep.durationMs, 600)
  assert.equal(s.reps, 1)
})

test('动作拖超过 8 秒 → 作废，不计数（人已走开）', () => {
  let s = createSquatState()
  let rep = null

  ;({ state: s } = feedSquatAngle(s, 170, 0, cfg))
  ;({ state: s } = feedSquatAngle(s, 90, 300, cfg))
  // 实测踩过：人走出画面两分钟后回来站直，被算成一次 126 秒的深蹲
  ;({ state: s, rep } = feedSquatAngle(s, 170, 12300, cfg))

  assert.equal(rep, null, '超时的动作必须作废')
  assert.equal(s.reps, 0)
  assert.equal(s.phase, 'standing')
})

test('恰好 8 秒的动作仍算数（maxRepMs 边界）', () => {
  let s = createSquatState()
  let rep = null

  ;({ state: s } = feedSquatAngle(s, 170, 0, cfg))
  ;({ state: s } = feedSquatAngle(s, 90, 1000, cfg))
  ;({ state: s, rep } = feedSquatAngle(s, 170, 9000, cfg))

  assert.notEqual(rep, null)
  assert.equal(rep.durationMs, 8000)
})

test('超时作废后，下一次动作仍能正常计数', () => {
  let s = createSquatState()
  let reps = 0

  const feed = (angle, t) => {
    const r = feedSquatAngle(s, angle, t, cfg)
    s = r.state
    if (r.rep) reps++
  }

  feed(170, 0)
  feed(90, 300)
  feed(170, 12300) // 作废这次
  feed(90, 13000)
  feed(170, 14000) // 正常一次

  assert.equal(reps, 1)
  assert.equal(s.reps, 1)
})

test('一帧从 170° 直接跳到 90°，仍能进入蹲底（级联转移）', () => {
  let s = createSquatState()
  ;({ state: s } = feedSquatAngle(s, 170, 0, cfg))
  ;({ state: s } = feedSquatAngle(s, 90, 100, cfg))
  assert.equal(s.phase, 'bottom', '不能因为跳帧就停在 descending')
  assert.equal(s.reachedBottom, true)
})

test('站起一半又蹲回去，算同一次动作（不重复计数）', () => {
  let s = createSquatState()
  let reps = 0

  const feed = (angle, t) => {
    const r = feedSquatAngle(s, angle, t, cfg)
    s = r.state
    if (r.rep) reps++
  }

  feed(170, 0)
  feed(90, 300) // 蹲底
  feed(120, 600) // 起一半
  feed(95, 800) // 又蹲回去
  feed(170, 1500) // 站直

  assert.equal(reps, 1, '中途回蹲不应被拆成两次')
})

test('NaN / Infinity 输入不改变状态', () => {
  let s = createSquatState()
  ;({ state: s } = feedSquatAngle(s, 90, 100, cfg))
  const before = { ...s }

  const r1 = feedSquatAngle(s, Number.NaN, 200, cfg)
  const r2 = feedSquatAngle(s, Number.POSITIVE_INFINITY, 300, cfg)

  assert.deepEqual(r1.state, before)
  assert.deepEqual(r2.state, before)
  assert.equal(r1.rep, null)
})

test('状态机不可变：原 state 对象不被修改', () => {
  const s0 = createSquatState()
  const snapshot = { ...s0 }
  const { state } = feedSquatAngle(s0, 90, 100, cfg)

  assert.deepEqual(s0, snapshot, 'feed 不能就地改传入的 state')
  assert.notEqual(state, s0)
  assert.equal(state.phase, 'bottom')
})

test('phaseLabel 覆盖四个阶段', () => {
  assert.equal(phaseLabel('standing'), '站立')
  assert.equal(phaseLabel('descending'), '下蹲中')
  assert.equal(phaseLabel('bottom'), '蹲底')
  assert.equal(phaseLabel('ascending'), '起身中')
})

// ---------------------------------------------------------------- 姿态数学

test('angleAt：直角 90°、伸直 180°、退化输入返回 NaN', () => {
  assert.equal(Math.round(angleAt({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })), 90)
  assert.equal(Math.round(angleAt({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })), 180)
  assert.ok(Number.isNaN(angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })))
})

function makePose(overrides = {}) {
  const lms = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }))
  const put = (i, x, y, visibility = 0.9) => {
    lms[i] = { x, y, visibility }
  }
  // 左腿：完全伸直 = 180°
  put(POSE.leftHip, 0, 0)
  put(POSE.leftKnee, 0, 1)
  put(POSE.leftAnkle, 0, 2)
  // 右腿：膝角 90°
  put(POSE.rightHip, 0, 0)
  put(POSE.rightKnee, 0, 1)
  put(POSE.rightAnkle, 1, 1)

  for (const [i, v] of Object.entries(overrides)) {
    lms[Number(i)] = { ...lms[Number(i)], visibility: v }
  }
  return lms
}

test('kneeAngleFromPose：两侧都可见 → 取平均，side=both', () => {
  const r = kneeAngleFromPose(makePose())
  assert.equal(r.side, 'both')
  assert.equal(Math.round(r.angle), 135) // (180 + 90) / 2
})

test('kneeAngleFromPose：右侧被遮挡 → 只用左侧', () => {
  const pose = makePose({ [POSE.rightAnkle]: 0.1 })
  const r = kneeAngleFromPose(pose)
  assert.equal(r.side, 'left')
  assert.equal(Math.round(r.angle), 180)
})

test('kneeAngleFromPose：两侧都不可见 → null（不能拿残缺数据计数）', () => {
  const pose = makePose({
    [POSE.leftAnkle]: 0.1,
    [POSE.rightAnkle]: 0.1,
  })
  const r = kneeAngleFromPose(pose)
  assert.equal(r.angle, null)
  assert.equal(r.side, null)
})

test('kneeAngleFromPose：缺关键点时安全返回 null（不抛异常）', () => {
  const r = kneeAngleFromPose([])
  assert.equal(r.angle, null)
  assert.equal(r.side, null)
})

// ---------------------------------------------------------------- 取景校验
// 这些用例来自实测录屏：摄像头只拍到上半身时，MediaPipe 仍会外推出膝/踝，
// 于是膝角照样算得出来但完全是假的。legLooksComplete 就是挡这种情况的。

function legPose(hip, knee, ankle, vis = 0.9) {
  const lms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }))
  lms[POSE.leftHip] = { x: hip[0], y: hip[1], visibility: vis }
  lms[POSE.leftKnee] = { x: knee[0], y: knee[1], visibility: vis }
  lms[POSE.leftAnkle] = { x: ankle[0], y: ankle[1], visibility: vis }
  return lms
}

test('legLooksComplete：全身入画 → 判定可用', () => {
  const r = legLooksComplete(legPose([0.5, 0.45], [0.5, 0.65], [0.5, 0.85]))
  assert.equal(r.ok, true)
  assert.equal(r.side, 'left')
})

test('legLooksComplete：脚踝贴画面底边（被裁）→ 不可用', () => {
  const r = legLooksComplete(legPose([0.5, 0.5], [0.5, 0.7], [0.5, 0.995]))
  assert.equal(r.ok, false)
  assert.match(r.reason, /看不到完整的腿/)
})

test('legLooksComplete：膝盖跑到髋上方（解剖上反了）→ 不可用', () => {
  const r = legLooksComplete(legPose([0.5, 0.6], [0.5, 0.3], [0.5, 0.85]))
  assert.equal(r.ok, false)
})

test('legLooksComplete：腿在画面里太短（没拍全）→ 不可用', () => {
  const r = legLooksComplete(legPose([0.5, 0.45], [0.5, 0.48], [0.5, 0.50]))
  assert.equal(r.ok, false)
})

test('legLooksComplete：可见度过低 → 不可用', () => {
  const r = legLooksComplete(legPose([0.5, 0.45], [0.5, 0.65], [0.5, 0.85], 0.2))
  assert.equal(r.ok, false)
})

test('legLooksComplete：两条腿都完整 → side=both', () => {
  const lms = legPose([0.5, 0.45], [0.5, 0.65], [0.5, 0.85])
  lms[POSE.rightHip] = { x: 0.45, y: 0.45, visibility: 0.9 }
  lms[POSE.rightKnee] = { x: 0.45, y: 0.65, visibility: 0.9 }
  lms[POSE.rightAnkle] = { x: 0.45, y: 0.85, visibility: 0.9 }
  const r = legLooksComplete(lms)
  assert.equal(r.ok, true)
  assert.equal(r.side, 'both')
})
