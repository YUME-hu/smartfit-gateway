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

  // 幂等键：重复 client_key 必须被挡（device_id 显式给探测设备，
  // 否则会默认落到 watch-01，把真实宠物的深蹲数刷上去）
  const repKey = `verify-probe:${Date.now()}:r1`
  const insRep = `insert into public.reps (client_key, session_id, source, rep_index, recorded_at, min_angle, duration_ms, device_id)
                  values ($1, 'verify-probe-session', 'vision', 1, now(), 95.5, 1600, 'verify-probe-pet')`
  await client.query(insRep, [repKey])
  let repDupBlocked = false
  try {
    await client.query(insRep, [repKey])
  } catch (e) {
    repDupBlocked = e.code === '23505'
  }
  check('reps 重复 client_key 被拒 (23505)', repDupBlocked)

  // 9) pet_state：表 / 触发器 / RPC / publication
  const petCols = await client.query(
    `select column_name, is_generated, generation_expression
       from information_schema.columns
      where table_schema='public' and table_name='pet_state'`,
  )
  const petMap = new Map(petCols.rows.map((r) => [r.column_name, r]))
  const needPet = ['device_id', 'steps_total', 'reps_total', 'bonus_exp', 'food_used', 'hunger', 'exp', 'food_earned']
  const missPet = needPet.filter((c) => !petMap.has(c))
  check('pet_state 字段齐全', missPet.length === 0, missPet.length ? '缺 ' + missPet.join(',') : `${needPet.length} 列`)

  const expCol = petMap.get('exp')
  const foodCol = petMap.get('food_earned')
  check(
    'exp / food_earned 是生成列（不是手写值）',
    expCol?.is_generated === 'ALWAYS' && foodCol?.is_generated === 'ALWAYS',
    expCol ? `exp=${expCol.is_generated}, food=${foodCol?.is_generated}` : '缺列',
  )

  const trg = await client.query(
    `select tgname from pg_trigger
      where not tgisinternal and tgrelid in ('public.imu_samples'::regclass, 'public.reps'::regclass)`,
  )
  const trgNames = trg.rows.map((r) => r.tgname)
  check(
    '步数/深蹲触发器已挂上',
    trgNames.includes('trg_pet_bump_steps') && trgNames.includes('trg_pet_bump_reps'),
    trgNames.join(', ') || '(无)',
  )

  const fns = await client.query(
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and proname in ('get_pet_summary','feed_pet','add_bonus_exp')`,
  )
  const fnNames = fns.rows.map((r) => r.proname)
  check('宠物 RPC 齐全', fnNames.length === 3, fnNames.join(', ') || '(无)')

  const petPub = await client.query(
    `select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename='pet_state'`,
  )
  check('pet_state 已加入 supabase_realtime', petPub.rowCount === 1)

  // 功能级：插一条 250 步的样本，exp 应为 (250/100)*10 = 20
  const petDev = 'verify-probe-pet'
  const m = Date.now()
  await client.query(
    `insert into public.imu_samples (client_key, device_id, boot_epoch, seq, recorded_at, x, y, z, steps)
     values ($1, $2, 0, 0, now(), 0, 0, 1, 250)`,
    [`${petDev}:${m}`, petDev],
  )
  const s1 = await client.query('select public.get_pet_summary($1) as s', [petDev])
  const sum1 = s1.rows[0].s
  check(
    '样本触发器累加步数并派生经验',
    sum1.steps_total === 250 && sum1.exp === 20 && sum1.food_earned === 2,
    `steps=${sum1.steps_total} exp=${sum1.exp} food=${sum1.food_earned}`,
  )

  // 再插一条 60 步的：累计 310 → exp 应为 30（而不是 20 + 0）
  await client.query(
    `insert into public.imu_samples (client_key, device_id, boot_epoch, seq, recorded_at, x, y, z, steps)
     values ($1, $2, 0, 1, now(), 0, 0, 1, 60)`,
    [`${petDev}:${m}b`, petDev],
  )
  const s2 = await client.query('select public.get_pet_summary($1) as s', [petDev])
  check(
    '经验按累计量派生（310 步 = 30 经验，不是每包累加）',
    s2.rows[0].s.exp === 30,
    `exp=${s2.rows[0].s.exp}`,
  )

  // 深蹲触发器：用"相对增量"断言，不依赖此前已插入多少行
  const beforeRep = await client.query('select public.get_pet_summary($1) as s', [petDev])
  const beforeReps = beforeRep.rows[0].s.reps_total

  await client.query(
    `insert into public.reps (client_key, session_id, source, rep_index, recorded_at, min_angle, duration_ms, device_id)
     values ($1, 'verify-pet', 'vision', 1, now(), 95, 1500, $2)`,
    [`${petDev}:r1`, petDev],
  )
  const s3 = await client.query('select public.get_pet_summary($1) as s', [petDev])
  const petAfter = s3.rows[0].s
  check(
    '深蹲触发器累加 reps_total（+1）',
    petAfter.reps_total === beforeReps + 1 && petAfter.reps_live === petAfter.reps_total,
    `before=${beforeReps} after=${petAfter.reps_total} live=${petAfter.reps_live}`,
  )

  // 喂食
  const feed = await client.query('select public.feed_pet($1) as s', [petDev])
  const fed = feed.rows[0].s
  check(
    'feed_pet 消耗食物且恢复饱食度',
    fed.ok === true && fed.food_used === 1 && fed.hunger > 79,
    `ok=${fed.ok} used=${fed.food_used} hunger=${fed.hunger}`,
  )

  // 奖励经验
  const bonus = await client.query('select public.add_bonus_exp($1, 100) as s', [petDev])
  check('add_bonus_exp 只加 bonus_exp', bonus.rows[0].s.exp === 130 && bonus.rows[0].s.steps_total === 310,
    `exp=${bonus.rows[0].s.exp} steps=${bonus.rows[0].s.steps_total}`)

  // 9.1 对账：pet_state 的累计量必须等于源表重算结果
  //     （实测踩过：db push 回填时 reps 里还有测试行，回填把 1 算进了 reps_total，
  //      之后测试行被清掉，pet_state 却停在了 1 —— 这类漂移必须能被检查出来）
  const drift = await client.query(`
    select ps.device_id,
           ps.steps_total,
           coalesce((select sum(steps) from public.imu_samples i where i.device_id = ps.device_id), 0)::bigint as src_steps,
           ps.reps_total,
           coalesce((select count(*) from public.reps r where r.device_id = ps.device_id), 0)::bigint as src_reps
      from public.pet_state ps
  `)
  const drifted = drift.rows.filter(
    (r) => Number(r.steps_total) !== Number(r.src_steps) || Number(r.reps_total) !== Number(r.src_reps),
  )
  check(
    'pet_state 与源表对账一致',
    drifted.length === 0,
    drifted.length ? JSON.stringify(drifted) : `${drift.rowCount} 台设备`,
  )

  // 清理
  const del = await client.query(`delete from public.imu_samples where device_id = 'verify-probe'`)
  const del2 = await client.query(
    `delete from public.device_latest where device_id = 'verify-probe' or device_id like 'rt-probe-%'`,
  )
  const del3 = await client.query(`delete from public.reps where session_id = 'verify-probe-session'`)
  const del4 = await client.query(`delete from public.reps where device_id = 'verify-probe-pet'`)
  const del5 = await client.query(`delete from public.imu_samples where device_id = 'verify-probe-pet'`)
  const del6 = await client.query(`delete from public.pet_state where device_id = 'verify-probe-pet'`)

  // 清理源数据后必须对账，否则 pet_state 会留下增量残值
  // （这是计数器表的通病：源表删了，累计量不会自己回退）
  await client.query(`
    delete from public.pet_state ps
     where ps.device_id like 'verify-probe%'
       and not exists (select 1 from public.imu_samples i where i.device_id = ps.device_id)
       and not exists (select 1 from public.reps r where r.device_id = ps.device_id)`)
  await client.query(`
    update public.pet_state ps
       set steps_total = coalesce((select sum(steps) from public.imu_samples i where i.device_id = ps.device_id), 0),
           reps_total  = coalesce((select count(*)  from public.reps r where r.device_id = ps.device_id), 0),
           updated_at  = now()
     where ps.device_id not like 'verify-probe%'`)
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
