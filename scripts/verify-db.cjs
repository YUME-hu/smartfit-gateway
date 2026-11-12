/**
 * 验证 Supabase 云端 schema 是否与迁移一致
 *
 * 用法（密码通过环境变量传，绝不写进代码或提交）：
 *   $env:SUPABASE_DB_URL="postgresql://..."; node scripts/verify-db.cjs
 *
 * 检查项：
 *   1. 表与关键列（含 steps）存在
 *   2. RLS 已开启
 *   3. 策略齐全（device_latest 的 insert/update/select；imu_samples 只走 RPC）
 *   4. device_latest 已加入 supabase_realtime publication
 *   5. ingest_samples RPC 存在且是 SECURITY DEFINER
 *   6. RPC 幂等性实测：重复调用返回 0，混合批次只写入新行
 */

const { Client } = require('pg')

const url = process.env.SUPABASE_DB_URL
if (!url) {
  console.error('缺少 SUPABASE_DB_URL 环境变量')
  process.exit(2)
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

function sampleRow(key, steps) {
  return {
    client_key: key,
    device_id: 'verify-probe',
    boot_epoch: 0,
    seq: 0,
    recorded_at: new Date().toISOString(),
    x: 0.1,
    y: 0.2,
    z: 0.98,
    steps,
  }
}

async function main() {
  // 新版 pg 把 sslmode=require 当成 verify-full，会拒绝 Supabase pooler 的证书链；
  // 这里统一剥掉 sslmode，改用下面的 ssl 选项（仅本验证脚本使用）。
  const cleanUrl = url.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]$/, '')
  const client = new Client({ connectionString: cleanUrl, ssl: { rejectUnauthorized: false } })
  await client.connect()

  // 1) 表与列
  const cols = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('imu_samples', 'device_latest')`,
  )
  const set = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`))
  const need = [
    'imu_samples.client_key',
    'imu_samples.device_id',
    'imu_samples.boot_epoch',
    'imu_samples.seq',
    'imu_samples.recorded_at',
    'imu_samples.x',
    'imu_samples.y',
    'imu_samples.z',
    'imu_samples.steps',
    'device_latest.device_id',
    'device_latest.x',
    'device_latest.steps',
    'device_latest.updated_at',
  ]
  const missing = need.filter((n) => !set.has(n))
  check('表与关键列存在（含 steps）', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : `${need.length} 列`)

  // 2) RLS
  const rls = await client.query(
    `select relname, relrowsecurity from pg_class
      where relname in ('imu_samples','device_latest') and relnamespace = 'public'::regnamespace`,
  )
  const rlsMap = Object.fromEntries(rls.rows.map((r) => [r.relname, r.relrowsecurity]))
  check('RLS 已在两张表开启', rlsMap.imu_samples === true && rlsMap.device_latest === true, JSON.stringify(rlsMap))

  // 3) 策略
  const pol = await client.query(
    `select tablename, policyname from pg_policies where schemaname = 'public'`,
  )
  const polNames = pol.rows.map((r) => `${r.tablename}:${r.policyname}`)
  const needPol = [
    'device_latest:gateway insert latest',
    'device_latest:gateway update latest',
    'device_latest:read latest',
  ]
  const missingPol = needPol.filter((p) => !polNames.includes(p))
  check('device_latest 策略齐全', missingPol.length === 0, missingPol.length ? '缺: ' + missingPol.join(' | ') : `${polNames.length} 条`)

  // imu_samples 不该再允许直连 INSERT（写入只能走 RPC）
  const directInsert = polNames.includes('imu_samples:gateway insert samples')
  check('imu_samples 已禁止直连 INSERT（只能走 RPC）', !directInsert,
    directInsert ? '旧策略仍在，可绕过 RPC 灌数据' : 'ok')

  // 4) realtime publication
  const pub = await client.query(
    `select tablename from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'`,
  )
  const pubTables = pub.rows.map((r) => r.tablename)
  check('device_latest 已加入 supabase_realtime', pubTables.includes('device_latest'), pubTables.join(', ') || '(空)')

  // 5) RPC 存在且为 SECURITY DEFINER
  const fn = await client.query(
    `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'ingest_samples'`,
  )
  const f = fn.rows[0]
  check('ingest_samples RPC 存在且 SECURITY DEFINER', !!f && f.prosecdef === true,
    f ? `owner=${f.owner}` : '函数不存在')

  // 6) 幂等性：同一批重复调用应返回 0
  const keyA = `verify-probe:${Date.now()}:a`
  const batch = JSON.stringify([sampleRow(keyA, 5)])
  const r1 = await client.query('select public.ingest_samples($1::jsonb) as n', [batch])
  check('RPC 首次写入 1 行', r1.rows[0].n === 1, `返回 ${r1.rows[0].n}`)

  const r2 = await client.query('select public.ingest_samples($1::jsonb) as n', [batch])
  check('RPC 重复写入返回 0（幂等）', r2.rows[0].n === 0, `返回 ${r2.rows[0].n}`)

  // 7) 混合批次：一条重复 + 一条新，应只写入新的那条（这是纯 INSERT 做不到的）
  const keyB = `verify-probe:${Date.now()}:b`
  const mixed = JSON.stringify([sampleRow(keyA, 5), sampleRow(keyB, 9)])
  const r3 = await client.query('select public.ingest_samples($1::jsonb) as n', [mixed])
  check('混合批次只写入新行（重复的跳过）', r3.rows[0].n === 1, `返回 ${r3.rows[0].n}`)

  // 8) reps 表（Web 端深蹲识别写入）
  const repCols = await client.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='reps'`,
  )
  const repSet = new Set(repCols.rows.map((r) => r.column_name))
  const needRep = ['client_key', 'session_id', 'source', 'rep_index', 'recorded_at', 'min_angle', 'duration_ms']
  const missRep = needRep.filter((c) => !repSet.has(c))
  check('reps 表字段齐全', missRep.length === 0, missRep.length ? '缺 ' + missRep.join(',') : `${needRep.length} 列`)

  const repRls = await client.query(
    `select relrowsecurity from pg_class
      where relname='reps' and relnamespace='public'::regnamespace`,
  )
  check('reps 已开启 RLS', repRls.rows[0]?.relrowsecurity === true)

  const repPol = await client.query(
    `select policyname from pg_policies where schemaname='public' and tablename='reps'`,
  )
  const repPolNames = repPol.rows.map((r) => r.policyname)
  check(
    'reps 策略齐全（anon 可写 / authenticated 可读）',
    repPolNames.includes('gateway insert reps') && repPolNames.includes('authenticated read reps'),
    repPolNames.join(', ') || '(空)',
  )

  // 幂等键：重复 client_key 必须被挡
  const repKey = `verify-probe:${Date.now()}:r1`
  const insRep = `insert into public.reps (client_key, session_id, source, rep_index, recorded_at, min_angle, duration_ms)
                  values ($1, 'verify-probe-session', 'vision', 1, now(), 95.5, 1600)`
  await client.query(insRep, [repKey])
  let repDupBlocked = false
  try {
    await client.query(insRep, [repKey])
  } catch (e) {
    repDupBlocked = e.code === '23505'
  }
  check('reps 重复 client_key 被拒 (23505)', repDupBlocked)

  // 清理
  const del = await client.query(`delete from public.imu_samples where device_id = 'verify-probe'`)
  const del2 = await client.query(
    `delete from public.device_latest where device_id = 'verify-probe' or device_id like 'rt-probe-%'`,
  )
  const del3 = await client.query(`delete from public.reps where session_id = 'verify-probe-session'`)
  const left = await client.query(
    `select count(*)::int as n from public.imu_samples where device_id = 'verify-probe'`,
  )
  check('探测数据已清理', left.rows[0].n === 0, `样本 ${del.rowCount} 行 / 最新值 ${del2.rowCount} 行`)

  const cnt = await client.query(`select count(*)::int as n from public.imu_samples`)
  const latest = await client.query(`select count(*)::int as n from public.device_latest`)
  console.log(`\n当前数据量：imu_samples=${cnt.rows[0].n} 行, device_latest=${latest.rows[0].n} 行`)

  const hist = await client.query(
    `select version, name from supabase_migrations.schema_migrations order by version`,
  )
  console.log('迁移历史：' + (hist.rows.map((r) => `${r.version}_${r.name}`).join(', ') || '(空)'))

  await client.end()

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length === 0 ? '\nVERIFY: PASS' : `\nVERIFY: FAIL (${failed.length})`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('验证失败：' + e.message)
  process.exit(2)
})
