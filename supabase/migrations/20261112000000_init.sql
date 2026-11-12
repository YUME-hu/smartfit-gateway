-- ============================================================================
-- 20261112000000_init.sql
-- 分层同步策略 —— Supabase 初始迁移
--
-- 用 Supabase CLI 执行：
--   supabase link --project-ref <ref>
--   supabase db push
--
-- 对应三条链路：
--   imu_samples    : 手机端每 15 分钟批量 upsert 的历史样本
--   device_latest  : 手机端每收到一包就覆写的"最新值"，供 Web 实时看板订阅
-- ============================================================================

-- ---------------------------------------------------------------- 历史样本
create table if not exists public.imu_samples (
  id          bigint generated always as identity primary key,
  -- 幂等键：device_id:boot_epoch:seq（App 端生成）
  -- 唯一约束是"重试不写重复行"的唯一保障，不要删
  client_key  text        not null unique,
  device_id   text        not null,
  -- 手表上电会话序号（App 通过 seq 回退判定重启）
  boot_epoch  integer     not null,
  -- 手表侧包序号；老固件不带 seq 时为 null
  seq         integer,
  -- 手机接收时间（手表无 RTC）
  recorded_at timestamptz not null,
  x           real        not null,
  y           real        not null,
  z           real        not null,
  -- 该 5 秒窗口内的步数；老固件不带 steps 时为 null
  steps       integer,
  created_at  timestamptz not null default now()
);

create index if not exists imu_samples_device_time_idx
  on public.imu_samples (device_id, recorded_at desc);

comment on table  public.imu_samples            is 'QMI8658 加速度样本 + 窗口步数，手机网关批量写入';
comment on column public.imu_samples.client_key is '幂等键 device_id:boot_epoch:seq';
comment on column public.imu_samples.steps      is '该 5 秒窗口内计到的步数（手表端窗口聚合）';

-- ---------------------------------------------------------------- 最新值
create table if not exists public.device_latest (
  device_id   text primary key,
  recorded_at timestamptz not null,
  x           real not null,
  y           real not null,
  z           real not null,
  steps       integer,
  updated_at  timestamptz not null default now()
);

comment on table public.device_latest is '每设备一行最新样本，Web 端通过 Realtime 订阅';

-- ============================================================================
-- 行级安全（RLS）
--
-- ⚠️ 安全边界：anon key 会打包进 APK，属于公开信息。
--    下面给 anon 开放 insert，意味着拿到 anon key 的人可以写脏数据。
--    课程演示可接受；加固方案见文件末尾。
-- ============================================================================
alter table public.imu_samples   enable row level security;
alter table public.device_latest enable row level security;

-- 网关写入历史样本
drop policy if exists "gateway insert samples" on public.imu_samples;
create policy "gateway insert samples" on public.imu_samples
  for insert to anon with check (true);

-- 网关覆写最新值（upsert = insert + update，两个都要给）
drop policy if exists "gateway insert latest" on public.device_latest;
create policy "gateway insert latest" on public.device_latest
  for insert to anon with check (true);

drop policy if exists "gateway update latest" on public.device_latest;
create policy "gateway update latest" on public.device_latest
  for update to anon using (true) with check (true);

-- 看板读取最新值（Realtime 推事件也依赖这条 select）
drop policy if exists "read latest" on public.device_latest;
create policy "read latest" on public.device_latest
  for select to anon, authenticated using (true);

-- 历史样本默认不给 anon 读（数据量会长大，且属于隐私数据）
-- 接入 Supabase Auth 后，登录用户可读
drop policy if exists "authenticated read samples" on public.imu_samples;
create policy "authenticated read samples" on public.imu_samples
  for select to authenticated using (true);

-- ============================================================================
-- Realtime：把 device_latest 加入发布
-- 漏掉这一步，Web 端订阅不会报错但也收不到任何事件（很难排查）
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'device_latest'
  ) then
    alter publication supabase_realtime add table public.device_latest;
  end if;
end $$;

-- ============================================================================
-- 加固方案（可选）：要求请求头带固定 token 才允许写
--
-- 1) drop policy "gateway insert samples" on public.imu_samples;
-- 2) App 端 uni.request 的 header 加 x-device-token: <长随机串>
-- 3) 改用下面的策略：
--
-- create policy "gateway insert samples with token" on public.imu_samples
--   for insert to anon
--   with check (
--     (current_setting('request.headers', true)::jsonb ->> 'x-device-token')
--       = 'REPLACE_WITH_A_LONG_RANDOM_TOKEN'
--   );
-- ============================================================================
