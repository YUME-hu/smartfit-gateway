/**
 * 网关纯逻辑单元测试（不依赖 uni-app / 真机）
 *
 * 覆盖三处"最容易在手机上悄悄出错、但看不出来"的地方：
 *   1. 缓存队列的块切换与容量上限（离线久了会不会丢数据、丢哪一段）
 *   2. seq 回退判定手表重启（判错会导致幂等键冲突，整段数据被 upsert 覆盖）
 *   3. 同步引擎的失败处理（失败后缓存必须还在，重试要能补上）
 *
 * 运行：npm run build:test && node --test tests/
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { parsePacket, bytesToAscii } = require('../.tmp/js/src/gateway/protocol.js')
const { SampleCache } = require('../.tmp/js/src/gateway/cache.js')
const { MemoryStore } = require('../.tmp/js/src/gateway/storage.js')
const { SessionTracker } = require('../.tmp/js/src/gateway/session.js')
const { SyncEngine } = require('../.tmp/js/src/gateway/syncEngine.js')

const BASE_TS = 1700000000000

function mkSample(i, over = {}) {
  return {
    key: 'd:0:' + i,
    deviceId: 'd',
    bootEpoch: 0,
    seq: i,
    stepsInWindow: i % 3,
    ts: BASE_TS + i * 5000,
    x: 0.01 * i,
    y: 0,
    z: 1,
    ...over,
  }
}

// ---------------------------------------------------------------- 协议

test('protocol: 解析 5 字段负载（含 steps）', () => {
  assert.deepEqual(parsePacket('-0.12,-0.08,-1.11,3,7'), {
    x: -0.12,
    y: -0.08,
    z: -1.11,
    seq: 3,
    steps: 7,
  })
})

test('protocol: 4 字段（上一版固件）steps 为 null', () => {
  const p = parsePacket('-0.12,-0.08,-1.11,3')
  assert.equal(p.seq, 3)
  assert.equal(p.steps, null)
})

test('protocol: 3 字段（更老固件）seq/steps 均为 null', () => {
  const p = parsePacket('0.10,0.20,0.98')
  assert.equal(p.seq, null)
  assert.equal(p.steps, null)
  assert.equal(p.z, 0.98)
})

test('protocol: 坏包与被 MTU 截断的包一律丢弃', () => {
  assert.equal(parsePacket(''), null)
  assert.equal(parsePacket('1,2'), null)
  assert.equal(parsePacket('a,2,3'), null)
  assert.equal(parsePacket('1,2,3,4,5,6'), null, '字段数超过 5 应丢弃')
  assert.equal(parsePacket('99,0,0,1'), null, '超量程')
  assert.equal(parsePacket('1,2,3,-1'), null, 'seq 非法应整包丢，不能只丢字段')
  assert.equal(parsePacket('-0.12,-0.08,-1.11,3,'), null, '末字段为空 = 被截断')
  assert.equal(parsePacket('-0.12,-0.08,-1.'), null, '小数被截断')
  assert.equal(parsePacket('0.1,0.2,0.3,4,999'), null, '5 秒不可能 999 步')
})

test('protocol: ArrayBuffer 按 ASCII 解出', () => {
  const buf = new Uint8Array([45, 48, 46, 49]).buffer // "-0.1"
  assert.equal(bytesToAscii(buf), '-0.1')
})

// ---------------------------------------------------------------- 缓存

test('cache: 追加 / 取批 / 按 key 删除', () => {
  const c = new SampleCache(new MemoryStore(), 3, 100)
  for (let i = 0; i < 5; i++) c.append(mkSample(i))

  assert.equal(c.pending, 5)
  assert.deepEqual(c.peek(10).map((s) => s.seq), [0, 1, 2, 3, 4])
  assert.deepEqual(c.peek(2).map((s) => s.seq), [0, 1], 'peek 必须按最旧优先')

  c.remove(['d:0:0', 'd:0:1'])
  assert.equal(c.pending, 3)
  assert.deepEqual(c.peek(10).map((s) => s.seq), [2, 3, 4])
})

test('cache: 跨块顺序正确（块边界不能乱序或重复）', () => {
  const c = new SampleCache(new MemoryStore(), 4, 1000)
  for (let i = 0; i < 10; i++) c.append(mkSample(i))
  assert.deepEqual(c.peek(100).map((s) => s.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('cache: 容量上限只丢最旧，且丢多少有计数', () => {
  const c = new SampleCache(new MemoryStore(), 2, 5)
  for (let i = 0; i < 12; i++) c.append(mkSample(i))

  assert.ok(c.pending <= 5, '不能超过容量上限')
  assert.ok(c.dropped > 0, '被丢弃的条数必须可观测')

  const seqs = c.peek(100).map((s) => s.seq)
  assert.equal(c.pending + c.dropped, 12, '留下的 + 丢弃的 必须等于写入总数')
  assert.equal(seqs[seqs.length - 1], 11, '保留的必须是最新一段')
  for (let i = 1; i < seqs.length; i++) {
    assert.equal(seqs[i], seqs[i - 1] + 1, '保留段必须连续，中间不能挖洞')
  }
})

test('cache: 重建实例后数据仍在（进程被杀不丢）', () => {
  const store = new MemoryStore()
  const a = new SampleCache(store, 3, 100)
  a.append(mkSample(0))
  a.append(mkSample(1))

  const b = new SampleCache(store, 3, 100)
  assert.equal(b.pending, 2)
  assert.deepEqual(b.peek(10).map((s) => s.seq), [0, 1])
})

test('cache: 全部删完后头部块被回收，不会无限增长', () => {
  const c = new SampleCache(new MemoryStore(), 2, 100)
  for (let i = 0; i < 6; i++) c.append(mkSample(i))
  c.remove(c.peek(100).map((s) => s.key))
  assert.equal(c.pending, 0)
  assert.deepEqual(c.peek(10), [])

  // 继续写入仍然正常
  c.append(mkSample(99))
  assert.deepEqual(c.peek(10).map((s) => s.seq), [99])
})

// ---------------------------------------------------------------- 会话归属

test('session: seq 连续时属于同一会话', () => {
  const t = new SessionTracker(new MemoryStore(), 'd')
  const a = t.attribute({ x: 0, y: 0, z: 1, seq: 0 }, 1000)
  const b = t.attribute({ x: 0, y: 0, z: 1, seq: 1 }, 2000)
  assert.equal(a.bootEpoch, 0)
  assert.equal(b.bootEpoch, 0)
  assert.equal(a.key, 'd:0:0')
  assert.equal(b.key, 'd:0:1')
})

test('session: seq 回退判定手表重启，幂等键进入新会话', () => {
  const t = new SessionTracker(new MemoryStore(), 'd')
  t.attribute({ x: 0, y: 0, z: 1, seq: 5 }, 1000)
  const after = t.attribute({ x: 0, y: 0, z: 1, seq: 0 }, 2000)

  assert.equal(after.bootEpoch, 1)
  assert.equal(after.key, 'd:1:0', '重启后必须换键，否则新数据会被当成旧数据 upsert 覆盖')
})

test('session: 丢包只记录 gap，不误判重启', () => {
  const t = new SessionTracker(new MemoryStore(), 'd')
  t.attribute({ x: 0, y: 0, z: 1, seq: 1 }, 1000)
  const s = t.attribute({ x: 0, y: 0, z: 1, seq: 4 }, 2000)

  assert.equal(s.bootEpoch, 0, 'seq 变大只可能是丢包，不能当重启')
  assert.equal(t.lastGap, 2)
})

test('session: 老固件无 seq 时用接收时间当键', () => {
  const t = new SessionTracker(new MemoryStore(), 'd')
  const s = t.attribute({ x: 0, y: 0, z: 1, seq: null, steps: null }, 777)
  assert.equal(s.seq, null)
  assert.equal(s.stepsInWindow, null)
  assert.equal(s.key, 'd:0:@777')
})

test('session: 步数原样带入样本', () => {
  const t = new SessionTracker(new MemoryStore(), 'd')
  const s = t.attribute({ x: 0, y: 0, z: 1, seq: 1, steps: 42 }, 1000)
  assert.equal(s.stepsInWindow, 42)
})

test('session: 会话状态持久化（App 重启后仍不误判）', () => {
  const store = new MemoryStore()
  const t1 = new SessionTracker(store, 'd')
  t1.attribute({ x: 0, y: 0, z: 1, seq: 3 }, 1000)

  const t2 = new SessionTracker(store, 'd')
  const s = t2.attribute({ x: 0, y: 0, z: 1, seq: 4 }, 2000)
  assert.equal(s.bootEpoch, 0, 'App 重启不能把手表当成重启过')
})

// ---------------------------------------------------------------- 同步引擎

function mkEngine(cache, api, over = {}) {
  return new SyncEngine(cache, api, {
    intervalMs: 15 * 60 * 1000,
    batchSize: 500,
    maxBatchesPerRun: 40,
    ...over,
  })
}

test('sync: 1200 条按 500 分批，上传后清空缓存', async () => {
  const cache = new SampleCache(new MemoryStore(), 200, 100000)
  for (let i = 0; i < 1200; i++) cache.append(mkSample(i))

  const calls = []
  const api = {
    insertSamples: async (rows) => {
      calls.push(rows.length)
    },
  }

  const out = await mkEngine(cache, api).syncNow()
  assert.equal(out.uploaded, 1200)
  assert.equal(out.batches, 3)
  assert.equal(out.error, null)
  assert.equal(cache.pending, 0)
  assert.deepEqual(calls, [500, 500, 200])
})

test('sync: 上传失败时缓存必须原样保留，重试能补上', async () => {
  const cache = new SampleCache(new MemoryStore(), 200, 100000)
  for (let i = 0; i < 10; i++) cache.append(mkSample(i))

  let shouldFail = true
  const api = {
    insertSamples: async () => {
      if (shouldFail) throw new Error('boom')
    },
  }
  const engine = mkEngine(cache, api)

  const out1 = await engine.syncNow()
  assert.equal(out1.uploaded, 0)
  assert.match(String(out1.error), /boom/)
  assert.equal(cache.pending, 10, '失败绝不能删缓存 —— 那是唯一副本')

  shouldFail = false
  const out2 = await engine.syncNow()
  assert.equal(out2.uploaded, 10)
  assert.equal(out2.error, null)
  assert.equal(cache.pending, 0)
})

test('sync: 单飞 —— 并发触发只有一个在跑', async () => {
  const cache = new SampleCache(new MemoryStore(), 200, 100000)
  for (let i = 0; i < 600; i++) cache.append(mkSample(i))

  let concurrent = 0
  let maxConcurrent = 0
  let calls = 0
  const api = {
    insertSamples: async () => {
      calls++
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
    },
  }

  const engine = mkEngine(cache, api)
  const [a, b] = await Promise.all([engine.syncNow(), engine.syncNow()])

  assert.equal(maxConcurrent, 1, '定时器与手动同步不能同时操作同一批数据')
  assert.equal(calls, 2, '600 条 = 500 + 100 两批，不能重复上传')
  assert.equal(a, b, '并发的第二次调用应复用同一次执行')
  assert.equal(cache.pending, 0)
})

test('sync: maxBatchesPerRun 上限生效，不会一次跑到底', async () => {
  const cache = new SampleCache(new MemoryStore(), 200, 100000)
  for (let i = 0; i < 2000; i++) cache.append(mkSample(i))

  const api = { insertSamples: async () => {} }
  const engine = mkEngine(cache, api, { batchSize: 100, maxBatchesPerRun: 3 })

  const out = await engine.syncNow()
  assert.equal(out.batches, 3)
  assert.equal(out.uploaded, 300)
  assert.equal(cache.pending, 1700, '剩下的留到下一轮，不能丢')
})
