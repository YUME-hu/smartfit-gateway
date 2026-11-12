/**
 * 存储抽象
 *
 * 缓存层不直接调用 uni.*，而是面向这个接口 —— 好处：
 *   1. 单元测试可以用 MemoryStore 跑，不依赖 HBuilderX/真机；
 *   2. 以后要换 SQLite（数据量大了以后）只改这一个文件。
 */

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** uni-app 同步存储实现（App / 小程序 / H5 都可用） */
export function uniStore(): KeyValueStore {
  return {
    get(key) {
      const v = uni.getStorageSync(key)
      return typeof v === 'string' && v.length > 0 ? v : null
    },
    set(key, value) {
      uni.setStorageSync(key, value)
    },
    remove(key) {
      uni.removeStorageSync(key)
    },
  }
}

/** 内存实现，用于测试与 H5 调试 */
export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>()

  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  set(key: string, value: string): void {
    this.map.set(key, value)
  }

  remove(key: string): void {
    this.map.delete(key)
  }
}
