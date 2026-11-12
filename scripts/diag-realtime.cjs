/**
 * Realtime 诊断：区分「服务没推」和「推了但客户端没收」
 *
 * 手法：不带 filter 订阅整表，然后插入一条**全新的** device_id
 * （用 INSERT 而不是 UPDATE，避开 replica identity 的干扰），
 * 观察 15 秒内是否有任何事件。
 */

const { createClient } = require('@supabase/supabase-js')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_KEY
if (!url || !key) {
  console.error('缺少 SUPABASE_URL / SUPABASE_KEY')
  process.exit(2)
}

const client = createClient(url, key)

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

  const dev = 'rt-probe-' + Date.now()
  console.log('插入新行 device_id=' + dev)
  const { error } = await client.from('device_latest').insert({
    device_id: dev,
    recorded_at: new Date().toISOString(),
    x: 0.5,
    y: 0.5,
    z: 0.7,
    steps: 1,
  })
  if (error) {
    console.log('写入失败: ' + error.message)
    process.exit(1)
  }
  console.log('写入成功，等待 15s 观察事件…')

  const t1 = Date.now()
  while (events.length === 0 && Date.now() - t1 < 15000) {
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
