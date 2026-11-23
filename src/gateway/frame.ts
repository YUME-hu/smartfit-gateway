/**
 * 协议 v2 —— 18 字节定长帧（固件与 App 共用同一份定义）
 *
 * 为什么从文本换成二进制：
 *   文本负载 `-0.12,-0.08,-1.11,42,7` 是 21~23 字节，超过默认 ATT MTU 23 的 20 字节
 *   有效负载，必须靠 App 请求 MTU 185 才能跑。二进制 18 字节**在最小 MTU 下也能一帧装完**。
 *
 * 布局（全部小端）：
 *   0   1  magic  0xA7（文本协议里不会出现的字节）
 *   1   1  ver    0x02
 *   2   1  type   0x01=data 0x02=ack 0x03=cmd 0x04=hello
 *   3   2  seq    data=包序号 / ack=被确认的序号
 *   5   4  payload data=device_ts(UTC 秒) / hello=proto<<16|fwMajor<<8|fwMinor
 *   9   2  x      int16，milli-g
 *   11  2  y
 *   13  2  z
 *   15  1  steps  uint8
 *   16  2  crc16  CCITT-FALSE，覆盖 0..15
 *   = 18 字节
 */

export const FRAME_MAGIC = 0xa7
export const FRAME_VER = 2
export const FRAME_SIZE = 18

export const FRAME_TYPE = {
  data: 0x01,
  ack: 0x02,
  cmd: 0x03,
  hello: 0x04,
} as const

/** milli-g 上限：±16g，与文本协议的量程校验保持一致 */
const MAX_MILLI_G = 16000
/** 5 秒窗口不可能走这么多步（>10 步/秒），与文本协议同上 */
const MAX_STEPS = 50

export type DecodedFrame =
  | {
      type: 'data'
      seq: number
      /** 0 表示手表时间不可信 */
      deviceTs: number
      x: number
      y: number
      z: number
      steps: number
    }
  | { type: 'ack'; ackSeq: number }
  | { type: 'hello'; protoVer: number; fwMajor: number; fwMinor: number }
  | { type: 'cmd'; cmd: number; arg: number }

/** CRC-16/CCITT-FALSE：poly 0x1021, init 0xFFFF, 不反射 */
export function crc16(bytes: Uint8Array, len = bytes.length): number {
  let crc = 0xffff
  for (let i = 0; i < len; i++) {
    crc ^= bytes[i] << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}

function clampMilliG(g: number): number {
  const v = Math.round(g * 1000)
  if (v > MAX_MILLI_G) return MAX_MILLI_G
  if (v < -MAX_MILLI_G) return -MAX_MILLI_G
  return v
}

function writeU16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >> 8) & 0xff
}

function writeU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff
  buf[off + 1] = (v >>> 8) & 0xff
  buf[off + 2] = (v >>> 16) & 0xff
  buf[off + 3] = (v >>> 24) & 0xff
}

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8)
}

function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

function readI16(buf: Uint8Array, off: number): number {
  const v = buf[off] | (buf[off + 1] << 8)
  return v & 0x8000 ? v - 0x10000 : v
}

function finish(buf: Uint8Array): Uint8Array {
  const crc = crc16(buf, FRAME_SIZE - 2)
  writeU16(buf, FRAME_SIZE - 2, crc)
  return buf
}

export interface DataFrameInput {
  seq: number
  deviceTs: number
  x: number
  y: number
  z: number
  steps: number
}

export function encodeDataFrame(p: DataFrameInput): Uint8Array {
  const buf = new Uint8Array(FRAME_SIZE)
  buf[0] = FRAME_MAGIC
  buf[1] = FRAME_VER
  buf[2] = FRAME_TYPE.data
  writeU16(buf, 3, p.seq & 0xffff)
  writeU32(buf, 5, p.deviceTs >>> 0)
  writeU16(buf, 9, clampMilliG(p.x) & 0xffff)
  writeU16(buf, 11, clampMilliG(p.y) & 0xffff)
  writeU16(buf, 13, clampMilliG(p.z) & 0xffff)
  buf[15] = Math.min(Math.max(p.steps, 0), MAX_STEPS)
  return finish(buf)
}

export function encodeAck(ackSeq: number): Uint8Array {
  const buf = new Uint8Array(FRAME_SIZE)
  buf[0] = FRAME_MAGIC
  buf[1] = FRAME_VER
  buf[2] = FRAME_TYPE.ack
  writeU16(buf, 3, ackSeq & 0xffff)
  return finish(buf)
}

export function encodeHello(protoVer: number, fwMajor: number, fwMinor: number): Uint8Array {
  const buf = new Uint8Array(FRAME_SIZE)
  buf[0] = FRAME_MAGIC
  buf[1] = FRAME_VER
  buf[2] = FRAME_TYPE.hello
  writeU32(buf, 5, ((protoVer & 0xff) << 16) | ((fwMajor & 0xff) << 8) | (fwMinor & 0xff))
  return finish(buf)
}

export function encodeCmd(cmd: number, arg = 0): Uint8Array {
  const buf = new Uint8Array(FRAME_SIZE)
  buf[0] = FRAME_MAGIC
  buf[1] = FRAME_VER
  buf[2] = FRAME_TYPE.cmd
  writeU32(buf, 5, arg >>> 0)
  buf[15] = cmd & 0xff
  return finish(buf)
}

/**
 * 解码一帧。任何不合法的帧返回 null —— 网关必须"丢弃坏帧"而不是抛异常，
 * 否则一次 CRC 失败就会打断整条采集链路。
 */
export function decodeFrame(input: ArrayBuffer | Uint8Array): DecodedFrame | null {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (buf.length !== FRAME_SIZE) return null
  if (buf[0] !== FRAME_MAGIC) return null
  if (buf[1] !== FRAME_VER) return null

  const crcGot = readU16(buf, FRAME_SIZE - 2)
  if (crc16(buf, FRAME_SIZE - 2) !== crcGot) return null

  const type = buf[2]
  if (type === FRAME_TYPE.data) {
    const steps = buf[15]
    if (steps > MAX_STEPS) return null
    const x = readI16(buf, 9) / 1000
    const y = readI16(buf, 11) / 1000
    const z = readI16(buf, 13) / 1000
    if (Math.abs(x) > 16 || Math.abs(y) > 16 || Math.abs(z) > 16) return null
    return { type: 'data', seq: readU16(buf, 3), deviceTs: readU32(buf, 5), x, y, z, steps }
  }
  if (type === FRAME_TYPE.ack) {
    return { type: 'ack', ackSeq: readU16(buf, 3) }
  }
  if (type === FRAME_TYPE.hello) {
    const v = readU32(buf, 5)
    return {
      type: 'hello',
      protoVer: (v >>> 16) & 0xff,
      fwMajor: (v >>> 8) & 0xff,
      fwMinor: v & 0xff,
    }
  }
  if (type === FRAME_TYPE.cmd) {
    return { type: 'cmd', cmd: buf[15], arg: readU32(buf, 5) }
  }
  return null
}

/** 调试用：把一帧打印成十六进制 */
export function frameToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}
