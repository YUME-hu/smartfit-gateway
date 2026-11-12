-- ============================================================================
-- 20261112150000_pet_state.sql
--
-- 宠物养成：服务端权威状态 + 触发器累加 + 聚合 RPC
--
-- 设计要点（对应之前定的三个决策）：
--   1. 经验持久化在 pet_state，刷新/换设备都不丢
--   2. exp 是**生成列**，由 steps_total / reps_total 算出来
--   3. 前端不直接写表，只调 RPC；写操作全部在 SECURITY DEFINER 里
--
-- 为什么 exp 必须是生成列：
--   "每 100 步给 10 经验" 不是可加量（floor(total/100) ≠ Σ floor(step_i/100)）。
--   如果按"插入一行加一次"来做，步数被拆成多包入库时经验会算多。
--   把累计量存下来、exp 由它派生，就从根本上避免了这个问题 ——
--   重复投递、批同步拆包、重放，都不会让经验膨胀。
-- ============================================================================

-- ---------------------------------------------------------------- 表

create table if not exists public.pet_state (
  device_id   text primary key,
  -- 累计量（触发器维护）
  steps_total integer      not null default 0 check (steps_total >= 0),
  reps_total  integer      not null default 0 check (reps_total >= 0),
  -- 手动奖励经验（调试/成就，直接加）
  bonus_exp   integer      not null default 0 check (bonus_exp >= 0),
  food_used   integer      not null default 0 check (food_used >= 0),

  -- 饥饿度锚点：hunger 是 hunger_at 时刻的值，读取时按时间衰减
  hunger      numeric(5, 2) not null default 80 check (hunger >= 0 and hunger <= 100),
  hunger_at   timestamptz  not null default now(),
  last_fed_at timestamptz,
  updated_at  timestamptz  not null default now(),

  -- 派生列：整数除法即 floor，与 petRules.ts 的换算保持一致
  --   exp         = 步数/100*10 + 深蹲/10*15 + bonus
  --   food_earned = 步数/100*1  + 深蹲/10*2
  exp         integer generated always as ((steps_total / 100) * 10 + (reps_total / 10) * 15 + bonus_exp) stored,
  food_earned integer generated always as ((steps_total / 100) + (reps_total / 10) * 2) stored
);

comment on table public.pet_state is '数字生命养成状态，每设备一行；exp 由累计步数/深蹲派生';
comment on column public.pet_state.hunger is 'hunger_at 时刻的饱食度，读取时按每小时 -2 衰减';
comment on column public.pet_state.exp is '生成列：与前端 petRules.ts 的换算公式必须一致';

-- ---------------------------------------------------------------- reps 归属

-- reps 之前没有 device_id，宠物触发器和按设备聚合都没法归属
alter table public.reps add column if not exists device_id text not null default 'watch-01';
create index if not exists reps_device_idx on public.reps (device_id, recorded_at desc);

-- ---------------------------------------------------------------- 触发器

-- 每插一条样本，把窗口步数累加进 pet_state
create or replace function public.pet_bump_steps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pet_state as ps (device_id, steps_total)
  values (new.device_id, coalesce(new.steps, 0))
  on conflict (device_id) do update
    set steps_total = ps.steps_total + excluded.steps_total,
        updated_at  = now();
  return new;
end;
$$;

drop trigger if exists trg_pet_bump_steps on public.imu_samples;
create trigger trg_pet_bump_steps
  after insert on public.imu_samples
  for each row execute function public.pet_bump_steps();

-- 每记一次动作（深蹲），累加 reps_total
create or replace function public.pet_bump_reps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pet_state as ps (device_id, reps_total)
  values (coalesce(new.device_id, 'watch-01'), 1)
  on conflict (device_id) do update
    set reps_total = ps.reps_total + 1,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_pet_bump_reps on public.reps;
create trigger trg_pet_bump_reps
  after insert on public.reps
  for each row execute function public.pet_bump_reps();

-- ---------------------------------------------------------------- 聚合读取

/**
 * 读取宠物状态（包含按时间衰减后的饱食度、实时深蹲计数）
 *
 * 首次调用会惰性建行，前端不用关心初始化。
 */
create or replace function public.get_pet_summary(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r        public.pet_state;
  v_hunger numeric(5, 2);
begin
  insert into public.pet_state (device_id) values (p_device_id)
  on conflict (device_id) do nothing;

  select * into r from public.pet_state where device_id = p_device_id;

  -- 每小时 -2，钳制到 0；与 HUNGER_DECAY_PER_HOUR 保持一致
  v_hunger := greatest(0, r.hunger - (extract(epoch from (now() - r.hunger_at)) / 3600.0) * 2);

  return jsonb_build_object(
    'device_id',    r.device_id,
    'steps_total',  r.steps_total,
    'reps_total',   r.reps_total,
    -- 与 reps 表实际行数对账用，方便发现触发器漏计
    'reps_live',    (select count(*) from public.reps where device_id = p_device_id),
    'bonus_exp',    r.bonus_exp,
    'exp',          r.exp,
    'food_earned',  r.food_earned,
    'food_used',    r.food_used,
    'food',         greatest(0, r.food_earned - r.food_used),
    'hunger',       round(v_hunger, 1),
    'last_fed_at',  r.last_fed_at,
    'updated_at',   r.updated_at
  );
end;
$$;

/** 喂食：消耗 1 点食物，饱食度 +20；食物不够返回 ok=false */
create or replace function public.feed_pet(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r        public.pet_state;
  v_hunger numeric(5, 2);
  v_food   integer;
begin
  insert into public.pet_state (device_id) values (p_device_id)
  on conflict (device_id) do nothing;

  select * into r from public.pet_state where device_id = p_device_id for update;

  v_hunger := greatest(0, r.hunger - (extract(epoch from (now() - r.hunger_at)) / 3600.0) * 2);
  v_food   := greatest(0, r.food_earned - r.food_used);

  if v_food < 1 then
    return public.get_pet_summary(p_device_id) || jsonb_build_object('ok', false, 'reason', 'no_food');
  end if;

  update public.pet_state
     set food_used   = food_used + 1,
         hunger      = least(100, v_hunger + 20),
         hunger_at   = now(),
         last_fed_at = now(),
         updated_at  = now()
   where device_id = p_device_id;

  return public.get_pet_summary(p_device_id) || jsonb_build_object('ok', true);
end;
$$;

/**
 * 奖励经验（调试/成就用）
 *
 * ⚠️ 只写 bonus_exp，不碰 steps_total —— 否则会让"运动数据"失真。
 *    这个函数对 anon 开放主要是为了答辩演示能手动推进等级，
 *    正式上线应改成需要鉴权的服务端调用。
 */
create or replace function public.add_bonus_exp(p_device_id text, p_delta integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.pet_state (device_id) values (p_device_id)
  on conflict (device_id) do nothing;

  update public.pet_state
     set bonus_exp  = greatest(0, bonus_exp + p_delta),
         updated_at = now()
   where device_id = p_device_id;

  return public.get_pet_summary(p_device_id);
end;
$$;

-- ---------------------------------------------------------------- 权限

revoke all on function public.get_pet_summary(text)               from public;
revoke all on function public.feed_pet(text)                      from public;
revoke all on function public.add_bonus_exp(text, integer)        from public;

grant execute on function public.get_pet_summary(text)            to anon, authenticated;
grant execute on function public.feed_pet(text)                   to anon, authenticated;
grant execute on function public.add_bonus_exp(text, integer)     to anon, authenticated;

-- ---------------------------------------------------------------- RLS

alter table public.pet_state enable row level security;

-- 前端只读；所有写操作走上面的 SECURITY DEFINER 函数
drop policy if exists "read pet state" on public.pet_state;
create policy "read pet state" on public.pet_state
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- Realtime

-- UPDATE 事件必须要有完整旧行，否则订阅端收不到（见 20261112130000 的说明）
alter table public.pet_state replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pet_state'
  ) then
    alter publication supabase_realtime add table public.pet_state;
  end if;
end $$;
