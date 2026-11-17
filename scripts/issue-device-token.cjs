#!/usr/bin/env node
/**
 * 签发 / 撤销设备写库 token（T1.2a）
 *
 * 用法：
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/issue-device-token.cjs --device-id watch-01 --label watch-01-primary
 *
 *   node scripts/issue-device-token.cjs --device-id watch-01 --revoke
 *   node scripts/issue-device-token.cjs --help
 *
 * 约定：
 *   · 明文 token 只在签发时打印一次，库里只存 sha256(token)。丢了就重新签发。
 *   · 撤销是软撤销（revoked_at = now()），把该 device_id 下所有未撤销的 token 一起废掉。
 *   · 用 service_role key —— 它绕过 RLS 且对 device_tokens 有读写权限。
 *     ⚠️ 这个 key 只能出现在服务端/本地终端，绝不能打进 APK 或前端 bundle。
 */

const crypto = require('node:crypto')
const { createClient } = require('@supabase/supabase-js')

const TABLE = 'device_tokens'

function usage() {
  console.log(`
签发 / 撤销设备写库 token

  node scripts/issue-device-token.cjs --device-id <id> --label <label>
  node scripts/issue-device-token.cjs --device-id <id> --revoke

环境变量（必需）：
  SUPABASE_URL                项目地址，例如 https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   service_role key（只在服务端用，别进前端）

说明：
  · 明文 token 只打印一次，库里只存 sha256(token)
  · 撤销会把该设备所有未撤销 token 一起标记 revoked_at
`)
}

function parseArgs(argv) {
  const out = { revoke: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--revoke') out.revoke = true
    else if (a === '--device-id') out.deviceId = argv[++i]
    else if (a === '--label') out.label = argv[++i]
    else {
      console.error(`未知参数：${a}（用 --help 看用法）`)
      process.exit(2)
    }
  }
  return out
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const deviceId = (args.deviceId || '').trim()
  if (!deviceId) {
    console.error('缺少 --device-id')
    usage()
    process.exit(2)
  }

  const url = process.env.SUPABASE_URL || ''
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !serviceKey) {
    console.error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
    process.exit(2)
  }
  // service_role key 是 JWT，anon key 也是 JWT —— 用角色字段兜底拦一次误用
  try {
    const payload = JSON.parse(Buffer.from(serviceKey.split('.')[1] || '', 'base64url').toString('utf8'))
    if (payload && payload.role && payload.role !== 'service_role') {
      console.error(`这个 key 的角色是 "${payload.role}"，需要 service_role`)
      process.exit(2)
    }
  } catch {
    // 新版 publishable / secret key 不是 JWT，解析失败就跳过这项检查
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } })

  if (args.revoke) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({ revoked_at: new Date().toISOString() })
      .eq('device_id', deviceId)
      .is('revoked_at', null)
      .select('token_hash, label')

    if (error) {
      console.error(`撤销失败：${error.message}`)
      process.exit(1)
    }
    const rows = data || []
    console.log(`device_id  : ${deviceId}`)
    console.log(`已撤销     : ${rows.length} 个 token`)
    for (const r of rows) {
      console.log(`  · ${r.label || '(无 label)'}  hash=${String(r.token_hash).slice(0, 12)}…`)
    }
    if (rows.length === 0) console.log('  （该设备当前没有未撤销的 token）')
    return
  }

  // ---- 签发 ----
  const token = crypto.randomBytes(32).toString('hex') // 64 字符 hex
  const tokenHash = sha256Hex(token)

  const { data, error } = await supabase
    .from(TABLE)
    .insert({ device_id: deviceId, token_hash: tokenHash, label: args.label || null })
    .select('device_id, label, created_at')
    .single()

  if (error) {
    console.error(`写入失败：${error.message}`)
    process.exit(1)
  }

  console.log('')
  console.log('  device_id  : ' + data.device_id)
  console.log('  token      : ' + token)
  console.log('  label      : ' + (data.label ?? '(无)'))
  console.log('  created_at : ' + data.created_at)
  console.log('')
  console.log('  ⚠️ 明文 token 只显示这一次，库里只存了 sha256。丢了就重新签发。')
  console.log('  ⚠️ 不要把它写进仓库、日志或前端 bundle。')
  console.log('')
}

main().catch((e) => {
  console.error('未捕获错误：' + (e && e.message ? e.message : e))
  process.exit(1)
})
