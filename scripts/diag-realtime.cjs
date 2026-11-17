/**
 * Realtime 诊断：区分「服务没推」和「推了但客户端没收」
 *
 * 手法：不带 filter 订阅整表，然后对**同一个探针设备**连写两次：
 *   第 1 次 → 该 device_id 第一次出现，产生 INSERT 事件
 *   第 2 次（recorded_at 后移 1 秒）→ 产生 UPDATE 事件（依赖 replica identity full）
 * 于是两种事件都能看到，顺带把 replica identity 的问题一并诊断出来。
 *
 * T1.2b-2 起 device_latest 的 anon 直写已收回，写入只能走
 * update_device_latest(p_device_id, p_token, p_row)，所以需要 DEVICE_ID + DEVICE_TOKEN。
 *
 * 用法：
 *   $env:SUPABASE_URL=...; $env:SUPABASE_KEY=...;
 *   $env:DEVICE_ID="rt-probe"; $env:DEVICE_TOKEN="<给 rt-probe 签发的 token>"
 *   node scripts/diag-realtime.cjs
 */

const { createClient } = require('@supabase/supabase-js')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_KEY
const deviceId = process.env.DEVICE_ID || 'rt-probe'
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

const client = createClient(url, key)

async function writeLatest(recordedAt) {
  return client.rpc('update_device_latest', {
    p_device_id: deviceId,
    p_token: token,
    p_row: { recorded_at: recordedAt, x: 0.5, y: 0.5, z: 0.7, steps: 1 },
  })
}

async function main() {
  const events = []
  let status = 'init'

  const channel = client
    .channel('diag-latest')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_latest' }, (p) => {
      events.push({ eventType: p.eventType, new: p.new })
    })
    .subscribe((s) => {
      status = s
      console.log('subscribe status = ' + s)
    })

  const t0 = Date.now()
  while (status !== 'SUBSCRIBED' && Date.now() - t0 < 10000) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (status !== 'SUBSCRIBED') {
    console.log('FAIL 订阅未建立: ' + status)
    process.exit(1)
  }

  console.log('第 1 次写 device_id=' + deviceId + '（期望 INSERT 事件）')
  const r1 = await writeLatest(new Date(Date.now() - 60000).toISOString())
  if (r1.error) {
    console.log('写入失败: ' + r1.error.message)
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 1500))

  console.log('第 2 次写同一设备、recorded_at 后移（期望 UPDATE 事件）')
  const r2 = await writeLatest(new Date().toISOString())
  if (r2.error) {
    console.log('写入失败: ' + r2.error.message)
    process.exit(1)
  }
  console.log('两次写入完成，等待 15s 观察事件…')

  const t1 = Date.now()
  while (events.length < 2 && Date.now() - t1 < 15000) {
    await new Promise((r) => setTimeout(r, 200))
  }

  console.log('收到事件数 = ' + events.length)
  for (const e of events) console.log('  ' + e.eventType + ' ' + JSON.stringify(e.new))
  console.log(events.length > 0 ? '\nDIAG: 事件能收到' : '\nDIAG: 事件收不到（服务端未推送或 publication 未生效）')

  await client.removeChannel(channel)
  process.exit(events.length > 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('异常: ' + e.message)
  process.exit(2)
})
