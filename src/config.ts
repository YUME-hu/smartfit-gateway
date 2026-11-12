/**
 * 网关配置
 *
 * Supabase 的 URL / anon key 从 .env 读取（见 .env.example），
 * 这样 GitHub Actions 可以在构建时用 repository secret 注入，
 * 不必把密钥提交进仓库。
 *
 * ⚠️ 只会注入 VITE_ 前缀的变量；它们会被打进 APK，属于公开信息。
 *    绝不能在这里放 service_role key。
 *
 * 缺变量时不抛异常（否则 App 一启动就白屏），而是收集起来由页面顶部
 * 显示红色提示 —— 让人一眼看出是配置问题，而不是"蓝牙又连不上了"。
 */

import { DEFAULT_CONFIG, type GatewayConfig } from './gateway/types'
import { readEnv } from './env'

const missing: string[] = []

function required(name: string, fallback: string): string {
  const value = readEnv(name)
  if (!value) {
    missing.push(name)
    return fallback
  }
  return value
}

export const gatewayConfig: GatewayConfig = {
  ...DEFAULT_CONFIG,

  supabaseUrl: required('VITE_SUPABASE_URL', 'https://placeholder.supabase.co'),
  supabaseAnonKey: required('VITE_SUPABASE_ANON_KEY', 'placeholder-anon-key'),
  deviceId: readEnv('VITE_DEVICE_ID') ?? DEFAULT_CONFIG.deviceId,

  // 15 分钟批量同步（需求第 3 条）
  syncIntervalMs: 15 * 60 * 1000,
  // 单请求 500 行；5s/包时 15 分钟只有 180 行，一请求即可
  batchSize: 500,
}

/** 缺失的环境变量名列表，页面据此显示配置错误提示 */
export const missingEnv: string[] = missing
