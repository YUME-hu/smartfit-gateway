/**
 * Supabase 写入（REST，不用 supabase-js）
 *
 * 为什么不用 supabase-js：
 *   supabase-js 依赖 fetch / WebSocket 全局对象。uni-app 的 App 端（plus 运行时）
 *   默认没有 fetch，得额外打 polyfill，容易在真机上翻车。
 *   App 端只需要"POST 一批行"，直接用 uni.request 打 PostgREST 最简单可靠；
 *   Web 端（Vue3）本身跑在浏览器里，那边用 supabase-js 订阅 Realtime 毫无问题。
 *
 * 关键：批量写入用 upsert（on_conflict=client_key + merge-duplicates），
 *      网络超时导致的"其实写成功了但我以为失败"重试时不会产生重复行。
 */

import type { ImuSample } from './types'
import { getDeviceToken } from './tokenStore'

export interface SampleRow {
  client_key: string
  device_id: string
  boot_epoch: number
  seq: number | null
  recorded_at: string
  x: number
  y: number
  z: number
  /** 该 5 秒窗口内的步数（老固件为 null） */
  steps: number | null
  /**
   * 手表侧时间（ISO 字符串）。老固件为 null。
   * 当前 RPC（v2）忽略这个字段；M2 的 ingest_samples_v3 才会落库。
   */
  device_ts?: string | null
}

export interface LatestRow {
  device_id: string
  recorded_at: string
  x: number
  y: number
  z: number
  steps: number | null
}

export interface SupabaseOptions {
  url: string
  anonKey: string
  sampleTable: string
  latestTable: string
  /** 批量写入函数名，默认 ingest_samples_v2（带设备 token 校验） */
  sampleRpc: string
  timeoutMs?: number
}

interface HttpResult {
  status: number
  body: string
}

export class SupabaseRest {
  private timeoutMs: number

  constructor(private opts: SupabaseOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15000
  }

  /** 4xx 重试没意义（除非 408/429），5xx 和网络错误才值得退避重试 */
  static isRetryable(status: number): boolean {
    return status === 0 || status === 408 || status === 429 || status >= 500
  }

  toRow(s: ImuSample): SampleRow {
    return {
      client_key: s.key,
      device_id: s.deviceId,
      boot_epoch: s.bootEpoch,
      seq: s.seq,
      recorded_at: new Date(s.ts).toISOString(),
      x: s.x,
      y: s.y,
      z: s.z,
      steps: s.stepsInWindow,
      // 老固件没有表侧时间；有则转成 ISO（v2 忽略此键，v3 才落库）
      device_ts: s.deviceTs === null ? null : new Date(s.deviceTs * 1000).toISOString(),
    }
  }

  /**
   * 批量写入样本
   *
   * **不用** PostgREST 的 `Prefer: resolution=...`：实测它会被翻译成
   * `ON CONFLICT DO UPDATE`，而 DO UPDATE 要求调用者有 UPDATE 策略；
   * 给 anon 开 UPDATE 等于允许篡改历史样本，不可接受。
   * 退化成纯 INSERT 又会让"一行重复 → 整批回滚"，App 重装后撞键就静默丢数据。
   *
   * 所以走 SECURITY DEFINER 的 RPC：逐行 ON CONFLICT DO NOTHING，
   * 重复跳过、新行照写，且 anon 只需 EXECUTE 权限。
   *
   * T1.2b-1 起改调 ingest_samples_v2，多带 p_device_id + p_token：
   * 服务端先用 verify_device_token 校验，失败 raise 28000。
   * token 缺失时**照样发请求** —— 让服务端给出明确的 28000，而不是前端静默跳过。
   */
  async insertSamples(samples: ImuSample[]): Promise<void> {
    if (samples.length === 0) return

    const rows = samples.map((s) => this.toRow(s))
    // 一批必然来自同一台设备（key 由 SessionTracker 用配置里的 deviceId 生成），
    // 取首行作为本次调用的主体，token 也按它校验。
    const deviceId = rows[0].device_id

    let token = ''
    try {
      token = getDeviceToken() ?? ''
    } catch (e) {
      // 存储读失败不阻断请求：带空 token 让服务端返回 28000，比前端静默跳过好排查
      console.warn('[ingest] 读取 device token 失败：' + (e instanceof Error ? e.message : String(e)))
    }
    if (!token) {
      console.warn('[ingest] device token 未配置，ingest 将失败（服务端返回 28000 invalid device token）')
    }

    const res = await this.post(
      `/rest/v1/rpc/${this.opts.sampleRpc}`,
      { p_device_id: deviceId, p_token: token, p_samples: rows },
      ['return=minimal'],
    )

    if (res.status < 200 || res.status >= 300) {
      throw new SupabaseError(res.status, this.describe(res))
    }
  }

  /**
   * 覆写"最新值"单行，供 Web 端 Realtime 订阅
   *
   * T1.2b-2：不再直写表（anon 的 insert/update 权限已收回），改走
   * update_device_latest(p_device_id, p_token, p_row)。服务端做 token 校验
   * 与"防回退"（recorded_at 必须比库里新），返回 boolean。
   */
  async upsertLatest(latest: LatestRow): Promise<void> {
    let token = ''
    try {
      token = getDeviceToken() ?? ''
    } catch (e) {
      console.warn('[latest] 读取 device token 失败：' + (e instanceof Error ? e.message : String(e)))
    }
    if (!token) {
      console.warn('[latest] device token 未配置，实时更新将失败（服务端返回 28000 invalid device token）')
    }

    const res = await this.post(
      '/rest/v1/rpc/update_device_latest',
      {
        p_device_id: latest.device_id,
        p_token: token,
        p_row: {
          recorded_at: latest.recorded_at,
          x: latest.x,
          y: latest.y,
          z: latest.z,
          steps: latest.steps,
        },
      },
      ['return=representation'],
    )

    if (res.status < 200 || res.status >= 300) {
      throw new SupabaseError(res.status, this.describe(res))
    }
    // RPC 返回 boolean：false = 这一行比库里的更旧、被服务端忽略（正常，不是错误）
    if (res.body.trim() === 'false') {
      console.debug('[latest] 该行比库里的更旧，已忽略（recorded_at=' + latest.recorded_at + '）')
    }
  }

  private describe(res: HttpResult): string {
    // T1.2b-1：verify_device_token 失败固定 raise 28000，PostgREST 把它映射成
    // HTTP 403（实测），所以这条必须排在"401/403 = anon key 问题"之前，
    // 否则会把人往"检查 anon key / RLS"的错方向带。
    if (/28000|invalid device token/.test(res.body)) {
      return `设备 token 无效或未配置（28000）：${res.body.slice(0, 200)}`
    }
    if (res.status === 401 || res.status === 403) {
      return `鉴权失败(${res.status})：检查 anon key 与 RLS 策略。${res.body.slice(0, 200)}`
    }
    return `HTTP ${res.status}: ${res.body.slice(0, 200)}`
  }

  private post(path: string, body: unknown, prefer: string[]): Promise<HttpResult> {
    const url = this.opts.url.replace(/\/+$/, '') + path
    const key = this.opts.anonKey

    const header: Record<string, string> = {
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: prefer.join(','),
    }

    // 老式 anon key 是 JWT（eyJ...），放 Authorization 里是标准做法。
    // 新版 publishable key（sb_publishable_...）不是 JWT，部分网关会把
    // 非 JWT 的 Bearer 判成非法 token —— 实测当前项目容错，但这里只对
    // JWT 形态才加 Bearer，避免以后换网关时踩坑。
    if (key.startsWith('eyJ')) {
      header.Authorization = `Bearer ${key}`
    }

    return new Promise<HttpResult>((resolve, reject) => {
      uni.request({
        url,
        method: 'POST',
        timeout: this.timeoutMs,
        header,
        // 传字符串而不是对象：避免各端对对象的默认序列化行为不一致
        data: JSON.stringify(body),
        success: (res: { statusCode: number; data: unknown }) => {
          resolve({
            status: res.statusCode,
            body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? ''),
          })
        },
        fail: (err: { errMsg?: string }) => {
          // status 0 = 网络层失败，交给上层退避重试
          reject(new SupabaseError(0, err?.errMsg || '网络请求失败'))
        },
      })
    })
  }
}

export class SupabaseError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SupabaseError'
  }
}
