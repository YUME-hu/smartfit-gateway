-- ============================================================================
-- 20261112140000_reps.sql
--
-- 动作计数表：目前由 Web 端的 MediaPipe 深蹲识别写入（source='vision'）。
-- 手表侧的计步如果以后也要落明细，可用 source='imu' 复用同一张表。
--
-- 为什么单独一张表而不是塞进 imu_samples：
--   imu_samples 是"传感器采样"（每 5 秒一行、连续时间序列），
--   reps 是"动作事件"（一次一行、离散、带判定参数）。两者查询模式完全不同：
--   前者按时间段扫描，后者按会话聚合，混在一起会让两边都难写。
--
-- 字段说明：
--   client_key  幂等键（session_id:rep_index），唯一约束挡重复写入
--   session_id  一次训练会话 id，由前端生成；可与同时段手表数据按时间对齐
--   source      'vision' = 视觉识别，'imu' = 手表侧
--   rep_index   本次会话内的第几次（从 1 开始）
--   recorded_at 完成时刻（对应需求里的 ts）
--   min_angle   动作最深关节角（度），深蹲质量指标
--   duration_ms 动作时长（ms）
-- ============================================================================

create table if not exists public.reps (
  id          bigint generated always as identity primary key,
  client_key  text        not null unique,
  session_id  text        not null,
  source      text        not null default 'vision',
  rep_index   integer     not null,
  recorded_at timestamptz not null,
  min_angle   real,
  duration_ms integer,
  created_at  timestamptz not null default now(),
  constraint reps_source_check check (source in ('vision', 'imu')),
  constraint reps_rep_index_check check (rep_index >= 1)
);

create index if not exists reps_session_idx  on public.reps (session_id, recorded_at desc);
create index if not exists reps_recorded_idx on public.reps (recorded_at desc);

comment on table public.reps is '动作计数事件（视觉深蹲 / 手表计步），供宠物养成与训练统计使用';
comment on column public.reps.recorded_at is '动作完成时刻，对应需求里的 ts';
comment on column public.reps.client_key  is '幂等键 session_id:rep_index';

-- ============================================================================
-- RLS
--   写入：anon 可 insert（Web 端带 publishable key 直接写）
--   读取：仅 authenticated（动作数据属于个人记录，不对匿名开放）
-- ============================================================================
alter table public.reps enable row level security;

drop policy if exists "gateway insert reps" on public.reps;
create policy "gateway insert reps" on public.reps
  for insert to anon with check (true);

drop policy if exists "authenticated read reps" on public.reps;
create policy "authenticated read reps" on public.reps
  for select to authenticated using (true);
