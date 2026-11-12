/**
 * 本地持久化队列
 *
 * 需求："收到数据后在本地内存/本地存储缓存，不直接实时写 Supabase"
 *
 * 为什么按"块"存而不是一个大数组：
 *   5 秒一包 ≈ 每天 17280 条。如果每次追加都把整个数组 JSON 序列化写回，
 *   一天的缓存就是 2MB 级别，每 5 秒序列化一次纯属给手机烧电。
 *   按块（默认 180 条 = 15 分钟）分键存储后，追加只重写当前尾块（约 14KB）。
 *
 * 为什么幂等键存在样本里：
 *   上传成功后要按 key 删除，失败重试时同一批 key 会被 Supabase 唯一约束挡掉，
 *   所以"删除"和"重试"都只需要 key 集合。
 */

import type { KeyValueStore } from './storage'
import type { ImuSample } from './types'

interface CacheMeta {
  /** 最旧块下标 */
  head: number
  /** 当前写入块下标 */
  tail: number
  /** 总条数 */
  count: number
  /** 因容量上限被丢弃的条数（要报给用户，不能悄悄丢） */
  dropped: number
}

const META_KEY = 'imu.meta'
const CHUNK_PREFIX = 'imu.c.'

/** 每块条数：5s/包 → 180 条 = 15 分钟，正好对上同步周期 */
const DEFAULT_CHUNK_ROWS = 180
/** 容量上限 ≈ 3.5 天离线数据 */
const DEFAULT_MAX_ROWS = 60000

export class SampleCache {
  private meta: CacheMeta
  private loaded = new Map<number, ImuSample[]>()

  constructor(
    private store: KeyValueStore,
    private chunkRows: number = DEFAULT_CHUNK_ROWS,
    private maxRows: number = DEFAULT_MAX_ROWS,
  ) {
    this.meta = this.loadMeta()
  }

  get pending(): number {
    return this.meta.count
  }

  get dropped(): number {
    return this.meta.dropped
  }

  /** 追加一条；同步落盘，进程被杀也不丢 */
  append(sample: ImuSample): void {
    const chunk = this.loadChunk(this.meta.tail)
    chunk.push(sample)
    this.meta.count++
    this.saveChunk(this.meta.tail, chunk)

    if (chunk.length >= this.chunkRows) {
      this.meta.tail++
      this.saveChunk(this.meta.tail, [])
    }

    this.enforceCap()
    this.saveMeta()
  }

  /** 取最旧的 limit 条（不删除）。空队列返回 [] */
  peek(limit: number): ImuSample[] {
    const out: ImuSample[] = []
    for (let i = this.meta.head; i <= this.meta.tail && out.length < limit; i++) {
      const chunk = this.loadChunk(i)
      for (const s of chunk) {
        if (out.length >= limit) break
        out.push(s)
      }
    }
    return out
  }

  /** 上传成功后按 key 删除 */
  remove(keys: string[]): void {
    if (keys.length === 0) return
    const target = new Set(keys)

    for (let i = this.meta.head; i <= this.meta.tail; i++) {
      const chunk = this.loadChunk(i)
      if (chunk.length === 0) continue

      const kept = chunk.filter((s) => !target.has(s.key))
      if (kept.length === chunk.length) continue

      this.meta.count -= chunk.length - kept.length
      this.saveChunk(i, kept)
    }

    this.reclaimHead()
    this.saveMeta()
  }

  /** 清空（调试/重置用） */
  clear(): void {
    for (let i = this.meta.head; i <= this.meta.tail; i++) {
      this.store.remove(CHUNK_PREFIX + i)
    }
    this.loaded.clear()
    this.meta = { head: 0, tail: 0, count: 0, dropped: this.meta.dropped }
    this.saveMeta()
  }

  // ---------------------------------------------------------------- 内部

  private enforceCap(): void {
    while (this.meta.count > this.maxRows && this.meta.head <= this.meta.tail) {
      const chunk = this.loadChunk(this.meta.head)
      if (chunk.length === 0) {
        // 空块直接回收，避免死循环
        if (this.meta.head === this.meta.tail) break
        this.store.remove(CHUNK_PREFIX + this.meta.head)
        this.loaded.delete(this.meta.head)
        this.meta.head++
        continue
      }
      this.meta.dropped += chunk.length
      this.meta.count -= chunk.length
      this.store.remove(CHUNK_PREFIX + this.meta.head)
      this.loaded.delete(this.meta.head)
      this.meta.head++
    }
  }

  /** 回收头部的空块 */
  private reclaimHead(): void {
    while (this.meta.head < this.meta.tail && this.loadChunk(this.meta.head).length === 0) {
      this.store.remove(CHUNK_PREFIX + this.meta.head)
      this.loaded.delete(this.meta.head)
      this.meta.head++
    }
  }

  private loadChunk(index: number): ImuSample[] {
    const cached = this.loaded.get(index)
    if (cached) return cached

    const raw = this.store.get(CHUNK_PREFIX + index)
    let chunk: ImuSample[] = []
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) chunk = parsed as ImuSample[]
      } catch {
        // 单块损坏就丢弃该块，不能让整个队列起不来
        chunk = []
      }
    }
    this.loaded.set(index, chunk)
    return chunk
  }

  private saveChunk(index: number, chunk: ImuSample[]): void {
    this.loaded.set(index, chunk)
    this.store.set(CHUNK_PREFIX + index, JSON.stringify(chunk))
  }

  private loadMeta(): CacheMeta {
    const raw = this.store.get(META_KEY)
    if (raw) {
      try {
        const m = JSON.parse(raw) as Partial<CacheMeta>
        if (
          Number.isInteger(m.head) &&
          Number.isInteger(m.tail) &&
          Number.isInteger(m.count)
        ) {
          return {
            head: m.head as number,
            tail: m.tail as number,
            count: m.count as number,
            dropped: Number.isInteger(m.dropped) ? (m.dropped as number) : 0,
          }
        }
      } catch {
        // 元数据损坏：从零开始，宁可丢缓存也不要启动即崩
      }
    }
    return { head: 0, tail: 0, count: 0, dropped: 0 }
  }

  private saveMeta(): void {
    this.store.set(META_KEY, JSON.stringify(this.meta))
  }
}
