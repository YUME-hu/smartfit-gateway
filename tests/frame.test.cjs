/**
 * 协议 v2 帧编解码单元测试
 *
 * 这些用例的价值不在"测一遍能不能跑"，而在于：
 *   帧格式是**固件与 App 共同遵守的契约**，任何一侧写错一个字节，
 *   表现都是"数据莫名其妙不对"，极难现场排查。所以要在纯函数层钉死。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FRAME_SIZE,
  FRAME_MAGIC,
  FRAME_TYPE,
  crc16,
  encodeDataFrame,
  encodeAck,
  encodeHello,
  encodeCmd,
  decodeFrame,
  frameToHex,
} = require('../.tmp/js/src/gateway/frame.js')

// ---------------------------------------------------------------- CRC

test('crc16: 标准校验值 "123456789" = 0x29B1（CCITT-FALSE）', () => {
  const bytes = new Uint8Array([...'123456789'].map((c) => c.charCodeAt(0)))
  assert.equal(crc16(bytes), 0x29b1)
})

test('crc16: 空输入 = 0xFFFF（init 值）', () => {
  assert.equal(crc16(new Uint8Array(0)), 0xffff)
})

// ---------------------------------------------------------------- 编码结构

test('frame: 长度固定 18 字节，magic/ver/type 正确', () => {
  const f = encodeDataFrame({ seq: 1, deviceTs: 1795350879, x: 0.02, y: -0.02, z: -1.09, steps: 3 })
  assert.equal(f.length, FRAME_SIZE)
  assert.equal(FRAME_SIZE, 18)
  assert.equal(f[0], FRAME_MAGIC)
  assert.equal(f[1], 2)
  assert.equal(f[2], FRAME_TYPE.data)
})

test('frame: 18 字节能塞进最小 ATT MTU 23 的 20 字节有效负载', () => {
  const f = encodeDataFrame({ seq: 0xffff, deviceTs: 0xffffffff, x: -16, y: 16, z: -0.001, steps: 50 })
  assert.ok(f.length <= 20, '帧不能超过 MTU 23 的 20 字节')
})

// ---------------------------------------------------------------- 往返

test('frame: data 帧往返（含负坐标）', () => {
  const src = { seq: 42, deviceTs: 1795350879, x: 0.02, y: -0.02, z: -1.09, steps: 7 }
  const d = decodeFrame(encodeDataFrame(src))
  assert.deepEqual(d, { type: 'data', ...src })
})

test('frame: deviceTs = 0 表示时间不可信，往返保留 0', () => {
  const d = decodeFrame(encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 0 }))
  assert.equal(d.deviceTs, 0)
})

test('frame: seq 环绕 65535 有效（uint16）', () => {
  const d = decodeFrame(encodeDataFrame({ seq: 65535, deviceTs: 1, x: 0, y: 0, z: 1, steps: 0 }))
  assert.equal(d.seq, 65535)
})

test('frame: milli-g 量化误差 ≤ 1mg', () => {
  const d = decodeFrame(encodeDataFrame({ seq: 1, deviceTs: 0, x: 0.1234, y: -0.5678, z: 0.9999, steps: 0 }))
  assert.ok(Math.abs(d.x - 0.123) < 0.001)
  assert.ok(Math.abs(d.y + 0.568) < 0.001)
  assert.ok(Math.abs(d.z - 1.0) < 0.001)
})

test('frame: 超量程坐标被钳制而不是溢出', () => {
  const d = decodeFrame(encodeDataFrame({ seq: 1, deviceTs: 0, x: 99, y: -99, z: 1, steps: 0 }))
  assert.equal(d.x, 16)
  assert.equal(d.y, -16)
})

// ---------------------------------------------------------------- ack / hello / cmd

test('frame: ack 往返', () => {
  const d = decodeFrame(encodeAck(1234))
  assert.deepEqual(d, { type: 'ack', ackSeq: 1234 })
})

test('frame: hello 往返（协议版本+固件版本打包成一个 u32）', () => {
  const d = decodeFrame(encodeHello(2, 1, 7))
  assert.deepEqual(d, { type: 'hello', protoVer: 2, fwMajor: 1, fwMinor: 7 })
})

test('frame: cmd 往返', () => {
  const d = decodeFrame(encodeCmd(0x01, 1795350879))
  assert.deepEqual(d, { type: 'cmd', cmd: 1, arg: 1795350879 })
})

// ---------------------------------------------------------------- 拒绝坏帧

test('frame: magic 不对 → null', () => {
  const f = encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 0 })
  f[0] = 0x00
  assert.equal(decodeFrame(f), null)
})

test('frame: 版本不匹配 → null（不静默兼容）', () => {
  const f = encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 0 })
  f[1] = 0x01
  assert.equal(decodeFrame(f), null)
})

test('frame: 长度不对 → null（截断/粘连都挡住）', () => {
  const f = encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 0 })
  assert.equal(decodeFrame(f.slice(0, 17)), null)
  assert.equal(decodeFrame(new Uint8Array(19)), null)
})

test('frame: 篡改任意一字节 → CRC 挡住', () => {
  const good = encodeDataFrame({ seq: 1, deviceTs: 1795350879, x: 0.1, y: 0.2, z: 0.9, steps: 5 })
  for (const idx of [3, 5, 9, 15]) {
    const bad = good.slice()
    bad[idx] ^= 0x01
    assert.equal(decodeFrame(bad), null, `篡改第 ${idx} 字节后应被拒`)
  }
})

test('frame: steps 超过 50 → null（5 秒不可能走这么多）', () => {
  const f = encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 5 })
  f[15] = 60
  // 重新算 CRC，模拟"帧本身完整但内容非法"
  const crc = crc16(f, 16)
  f[16] = crc & 0xff
  f[17] = (crc >> 8) & 0xff
  assert.equal(decodeFrame(f), null)
})

test('frame: 文本负载不会被误判成帧', () => {
  const bytes = new Uint8Array([...'-0.12,-0.08,-1.11,42,7'].map((c) => c.charCodeAt(0)))
  assert.equal(decodeFrame(bytes), null)
})

test('frame: 未知 type → null', () => {
  const f = encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 0 })
  f[2] = 0x09
  const crc = crc16(f, 16)
  f[16] = crc & 0xff
  f[17] = (crc >> 8) & 0xff
  assert.equal(decodeFrame(f), null)
})

// ---------------------------------------------------------------- 调试辅助

test('frameToHex 输出 18 组两位十六进制', () => {
  const s = frameToHex(encodeDataFrame({ seq: 1, deviceTs: 0, x: 0, y: 0, z: 1, steps: 0 }))
  assert.equal(s.split(' ').length, 18)
  assert.match(s, /^a7 02 01 /)
})
