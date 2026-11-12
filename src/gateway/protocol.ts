/**
 * BLE 负载解析
 *
 * 固件负载：`x,y,z,seq,steps`
 *   例：`-0.12,-0.08,-1.11,3,7`
 *   x,y,z 是该 5 秒窗口内的三轴均值（g）
 *   seq   是已成功发出的包序号
 *   steps 是该窗口内计到的步数
 *
 * 兼容更老的固件：4 字段（无 steps）、3 字段（无 seq 无 steps）。
 *
 * ⚠️ 关于长度：这一包典型 21~23 字节，已经超过默认 ATT MTU 23 的
 *    20 字节有效负载。App 端必须请求 MTU（见 bleTransport 的 setBLEMTU(185)），
 *    iOS 会自动协商。万一 MTU 协商失败导致截断，包尾会缺字段 ——
 *    所以下面用**严格逐字段正则**校验，任何字段不合规就整包丢弃并计入
 *    badPackets，而不是用 Number('')=0 把半截数据静默入库。
 */

export interface ParsedPacket {
  x: number
  y: number
  z: number
  seq: number | null
  steps: number | null
}

/** 单轴合理上限（±4g 量程，留 3 倍余量用于识别异常包） */
const MAX_ABS_G = 16

/** 十进制数：允许负号与小数，但不接受空串、科学计数法、Infinity */
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/
/** 非负整数 */
const UINT_RE = /^\d+$/

/**
 * ArrayBuffer → ASCII 字符串。
 * 不用 TextDecoder：部分 uni-app App 运行时/老安卓 WebView 没有该全局对象，
 * 而本协议全是 ASCII，逐字节取字符足够且无兼容问题。
 */
export function bytesToAscii(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i])
  }
  return out
}

/**
 * 解析一包负载。任何不合法的包返回 null —— 网关必须"丢弃坏包"而不是抛异常，
 * 否则一条脏数据会打断整条采集链路。
 */
export function parsePacket(raw: string): ParsedPacket | null {
  const text = raw.trim()
  if (!text) return null

  const fields = text.split(',').map((f) => f.trim())
  if (fields.length < 3 || fields.length > 5) return null

  // 逐字段严格校验（被 MTU 截断的包通常表现为末字段为空或半截数字）
  for (const f of fields) {
    if (!DECIMAL_RE.test(f)) return null
  }

  const x = Number(fields[0])
  const y = Number(fields[1])
  const z = Number(fields[2])
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  if (Math.abs(x) > MAX_ABS_G || Math.abs(y) > MAX_ABS_G || Math.abs(z) > MAX_ABS_G) {
    return null
  }

  let seq: number | null = null
  if (fields.length >= 4) {
    if (!UINT_RE.test(fields[3])) return null
    seq = Number(fields[3])
  }

  let steps: number | null = null
  if (fields.length >= 5) {
    if (!UINT_RE.test(fields[4])) return null
    steps = Number(fields[4])
    // 5 秒窗口不可能走出这么多步（>10 步/秒），视为脏包
    if (steps > 50) return null
  }

  return { x, y, z, seq, steps }
}
