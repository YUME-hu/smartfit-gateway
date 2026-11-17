/**
 * 验证 Realtime 是否真的推事件（不是"配了但收不到"）
 *
 * 很多人的坑：表建好了、RLS 也写了，但忘了把表加入
 * supabase_realtime publication，订阅端不报错、也永远收不到事件。
 * 这个脚本订阅 device_latest，然后写一行，看能不能在 10 秒内收到。
 *
 * T1.2b-2 起：device_latest 的 anon 直写权限已收回，写入必须走
 * update_device_latest(p_device_id, p_token, p_row) —— 所以本脚本额外需要
 * DEVICE_ID + DEVICE_TOKEN（token 用 scripts/issue-device-token.cjs 签发给同一台设备）。
 *
 * 用法：
 *   $env:SUPABASE_URL="https://xxx.supabase.co"
 *   $env:SUPABASE_KEY="sb_publishable_..."        # 订阅用，只需 SELECT
 *   $env:DEVICE_ID="verify-probe"                  # 独立探针设备
 *   $env:DEVICE_TOKEN="<给 verify-probe 签发的 token>"
 *   node scripts/verify-realtime.cjs
 *
 * ⚠️ DEVICE_ID 别指向 watch-01 —— 会覆盖真实设备的最新值。
 */

const { createClient } = require('@supabase/supabase-js')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_KEY
const deviceId = process.env.DEVICE_ID || 'verify-probe'
const token = process.env.DEVICE_TOKEN

if (!url || !key) {
  console.error('缺少 SUPABASE_URL / SUPABASE_KEY')
  process.exit(2)
}
if (!token) {
  console.error('缺少 DEVICE_TOKEN —— device_latest 的 anon 直写已收回，必须带 token')
  console.error('  签发：node scripts/issue-device-token.cjs --device-id ' + deviceId + ' --label diag')
  process.exit(2)
}

const DEVICE = deviceId
const client = createClient(url, key)

async function main() {
  let received = null
  let subscribed = false

  const channel = client
    .channel('verify-latest')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'device_latest', filter: `device_id=eq.${DEVICE}` },
      (payload) => {
        received = payload.new
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') subscribed = true
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.log('FAIL  订阅失败: ' + status)
        process.exit(1)
      }
    })

  // 等订阅建立
  const t0 = Date.now()
  while (!subscribed && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`${subscribed ? 'PASS' : 'FAIL'}  Realtime 订阅建立`)

  // 通过 RPC（App 用的同一段路）写一行最新值
  const { error } = await client.rpc('update_device_latest', {
    p_device_id: DEVICE,
    p_token: token,
    p_row: { recorded_at: new Date().toISOString(), x: 0.11, y: 0.22, z: 0.99, steps: 7 },
  })
  if (error) {
    console.log('FAIL  update_device_latest: ' + error.message)
    process.exit(1)
  }
  console.log('PASS  RPC update_device_latest')

  // 等事件
  const t1 = Date.now()
  while (!received && Date.now() - t1 < 10000) {
    await new Promise((r) => setTimeout(r, 100))
  }

  if (received) {
    console.log('PASS  收到 Realtime 事件（Web 端就是这样拿到最新值的）')
    console.log('      载荷: ' + JSON.stringify(received))
  } else {
    console.log('FAIL  10 秒内没收到事件 —— 检查 device_latest 是否在 supabase_realtime publication 里')
  }

  await client.removeChannel(channel)
  process.exit(received ? 0 : 1)
}

main().catch((e) => {
  console.error('异常: ' + e.message)
  process.exit(2)
})
