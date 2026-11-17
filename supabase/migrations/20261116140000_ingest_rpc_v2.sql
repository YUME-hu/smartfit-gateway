-- ============================================================================
-- 20261116140000_ingest_rpc_v2.sql
--
-- T1.2b-1：ingest 写入路径加设备 token 校验（只加这一条）
--
-- 为什么新建而不是改旧的：
--   旧 public.ingest_samples(jsonb) 仍被已经发出去的 APK 调用，T1.2b-1 不能让它挂。
--   所以新签名 ingest_samples_v2(device_id, token, samples) 与旧签名并存；
--   旧签名保持原样、anon 仍可 EXECUTE，T1.1 再收回并删除。
--
-- 本任务**只**做两件事：
--   1. 第一段调 verify_device_token(p_device_id, p_token)，失败 raise 28000
--   2. 加一个数组长度上限 500（服务端自保：不让一次调用被塞进几十万行）
--   其余业务校验（steps 上限 100 / recorded_at ±24h / device_id 白名单）留给 T1.1。
--
-- ⚠️ 已知残留（T1.1 收口）：插入时仍取**行内** device_id，而不是把 p_device_id
--    钉到每一行。也就是说持有 watch-01 token 的调用方，理论上仍能写
--    device_id=watch-02 的行。这一条与"device_id 白名单"一起在 T1.1 处理。
-- ============================================================================

create or replace function public.ingest_samples_v2(
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
  -- ① token 校验：必须在任何写入动作之前
  if not public.verify_device_token(p_device_id, p_token) then
    raise exception 'invalid device token' using errcode = '28000';
  end if;

  -- ② 数组契约 + 长度上限（本任务只加这两条校验）
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

  -- ③ 插入逻辑与旧 ingest_samples 逐字一致：逐行 ON CONFLICT DO NOTHING
  insert into public.imu_samples
    (client_key, device_id, boot_epoch, seq, recorded_at, x, y, z, steps)
  select
    r ->> 'client_key',
    r ->> 'device_id',
    coalesce((r ->> 'boot_epoch')::integer, 0),
    nullif(r ->> 'seq', '')::integer,
    (r ->> 'recorded_at')::timestamptz,
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

comment on function public.ingest_samples_v2(text, text, jsonb) is
  'T1.2b-1：带设备 token 的批量样本写入。只做 token 校验 + 数组上限 500；'
  'steps 上限 / 时间窗 / device_id 白名单由 T1.1 补，旧签名届时收回。';

-- 只允许通过 RPC 调用；旧签名 ingest_samples(jsonb) 的权限本任务不动
revoke all on function public.ingest_samples_v2(text, text, jsonb) from public;
grant execute on function public.ingest_samples_v2(text, text, jsonb)
  to anon, authenticated, service_role;
