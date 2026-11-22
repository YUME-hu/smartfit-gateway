-- ============================================================================
-- 20261122140000_device_ts_v3.sql
--
-- M2：样本表新增「手表侧时间」与「训练会话」两列，并新建 ingest_samples_v3。
--
-- 为什么新建 v3 而不是改 v2：
--   v2 的 insert 用的是**固定列清单**，不改函数体新列永远是 null；
--   而 v2 仍在被已安装的 APK 调用，直接改它会同时影响新旧两端。
--   所以：v2 保持原样（旧 APK 继续可用）→ 新 App 走 v3 → T1.1 时一次性删 v1+v2。
--
-- 语义边界（重要）：
--   recorded_at 仍是**手机收包时间**，是唯一的主时间轴；
--   device_ts 是**手表 RTC 时间**，只做审计/分析，不参与排序与幂等键。
--   板载无 RTC 备份电源，未对过时的 device_ts 不可信 —— 所以固件只在"时间可信"
--   时才上报该字段，App 侧也允许为 null。
-- ============================================================================

-- ---------------------------------------------------------------- 新列
alter table public.imu_samples
  add column if not exists device_ts timestamptz;

alter table public.imu_samples
  add column if not exists session_id text;

comment on column public.imu_samples.device_ts is
  '手表 RTC 给出的窗口起始时间（UTC）。可空：老固件不带 / 未对时时不上报。仅作审计与分析，不接替 recorded_at';
comment on column public.imu_samples.session_id is
  '训练会话标识，与 reps.session_id 同源同值；M5 的训练页接入后才会填，当前为 null';

-- 按表侧时间查某次训练（分析用，不用于主排序）
create index if not exists imu_samples_device_ts_idx
  on public.imu_samples (device_id, device_ts desc)
  where device_ts is not null;

-- ---------------------------------------------------------------- v3 RPC
create or replace function public.ingest_samples_v3(
  p_device_id text,
  p_token     text,
  p_samples   jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  inserted integer;
  n        integer;
begin
  -- ① token 校验：必须在任何写入动作之前（与 v2 一致）
  if not public.verify_device_token(p_device_id, p_token) then
    raise exception 'invalid device token' using errcode = '28000';
  end if;

  -- ② 数组契约 + 长度上限（与 v2 一致）
  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    raise exception 'p_samples 必须是 jsonb 数组';
  end if;

  n := jsonb_array_length(p_samples);
  if n = 0 then
    return 0;
  end if;
  if n > 500 then
    raise exception 'p_samples 一次最多 500 条，收到 % 条', n using errcode = '22023';
  end if;

  -- ③ 相比 v2 只多两列：device_ts / session_id，都允许缺省
  insert into public.imu_samples
    (client_key, device_id, boot_epoch, seq, recorded_at, device_ts, session_id, x, y, z, steps)
  select
    r ->> 'client_key',
    r ->> 'device_id',
    coalesce((r ->> 'boot_epoch')::integer, 0),
    nullif(r ->> 'seq', '')::integer,
    (r ->> 'recorded_at')::timestamptz,
    nullif(r ->> 'device_ts', '')::timestamptz,
    nullif(r ->> 'session_id', '')::text,
    (r ->> 'x')::real,
    (r ->> 'y')::real,
    (r ->> 'z')::real,
    nullif(r ->> 'steps', '')::integer
  from jsonb_array_elements(p_samples) as r
  on conflict (client_key) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

comment on function public.ingest_samples_v3(text, text, jsonb) is
  'M2：带 device_ts / session_id 的批量样本写入。其余契约与 v2 相同；'
  'v1/v2 的权限收口（T1.1）在协议 v2 里程碑里一次性完成。';

revoke all on function public.ingest_samples_v3(text, text, jsonb) from public;
grant execute on function public.ingest_samples_v3(text, text, jsonb)
  to anon, authenticated, service_role;
