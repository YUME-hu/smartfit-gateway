/**
 * 设备 token 的本地存储（uni-app）
 *
 * 只做读写，不校验格式、不打印内容。key 固定为 smartfit:device-token。
 *
 * 为什么要单独一个文件：
 *   ingest 路径（supabaseRest）不该直接摸 uni.getStorageSync —— 那样单测没法跑、
 *   以后换存储（Keystore / 原生插件）要改的地方也会散开。
 *
 * 行为约定：
 *   · 读不到 = null（未配置），这是正常状态
 *   · 读写**抛异常**时转成 DeviceTokenError 往上抛，不静默返回 null
 *     —— 否则"存储坏了"会伪装成"没配置 token"，排查时会往错的方向找
 */

import { uniStore } from './storage'

export const DEVICE_TOKEN_STORAGE_KEY = 'smartfit:device-token'

export class DeviceTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceTokenError'
  }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 读当前设备 token；未配置返回 null */
export function getDeviceToken(): string | null {
  let raw: string | null
  try {
    raw = uniStore().get(DEVICE_TOKEN_STORAGE_KEY)
  } catch (e) {
    throw new DeviceTokenError('读取 device token 失败：' + reason(e))
  }
  if (raw === null) return null
  const token = raw.trim()
  return token.length > 0 ? token : null
}

/** 写入（覆盖）设备 token */
export function setDeviceToken(token: string): void {
  const value = (token || '').trim()
  if (!value) {
    throw new DeviceTokenError('device token 不能为空；要清除请用 clearDeviceToken()')
  }
  try {
    uniStore().set(DEVICE_TOKEN_STORAGE_KEY, value)
  } catch (e) {
    throw new DeviceTokenError('写入 device token 失败：' + reason(e))
  }
}

/** 清除设备 token */
export function clearDeviceToken(): void {
  try {
    uniStore().remove(DEVICE_TOKEN_STORAGE_KEY)
  } catch (e) {
    throw new DeviceTokenError('清除 device token 失败：' + reason(e))
  }
}
