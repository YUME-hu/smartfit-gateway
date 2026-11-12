/**
 * 验证 Realtime 是否真的推事件（不是"配了但收不到"）
 *
 * 很多人的坑：表建好了、RLS 也写了，但忘了把表加入
 * supabase_realtime publication，订阅端不报错、也永远收不到事件。
 * 这个脚本订阅 device_latest，然后写一行，看能不能在 10 秒内收到。
 *
 * 用法：
 *   $env:SUPABASE_URL="https://xxx.supabase.co"
 *   $env:SUPABASE_KEY="sb_publishable_..."
 *   node scripts/verify-realtime.cjs
 */

const { createClient } = require('@supabase/supabase-js')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_KEY
if (!url || !key) {
  console.error('缺少 SUPABASE_URL / SUPABASE_KEY')
  process.exit(2)
}

const DEVICE = 'verify-probe'
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

  // 通过 REST（App 用的同一条路）写一行最新值
  const { error } = await client.from('device_latest').upsert(
    {
      device_id: DEVICE,
      recorded_at: new Date().toISOString(),
      x: 0.11,
      y: 0.22,
      z: 0.99,
      steps: 7,
    },
    { onConflict: 'device_id' },
  )
  if (error) {
    console.log('FAIL  写入 device_latest: ' + error.message)
    process.exit(1)
  }
  console.log('PASS  REST upsert device_latest')

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
