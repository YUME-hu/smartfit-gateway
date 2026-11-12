-- ============================================================================
-- 20261112120000_ingest_rpc.sql
--
-- 为什么需要这个 RPC（这是实测踩出来的，不是设计洁癖）：
--
-- 1) App 原本用 PostgREST 的 `Prefer: resolution=merge-duplicates` 做幂等写入，
--    但 PostgREST 会把它翻译成 `ON CONFLICT DO UPDATE`，而 DO UPDATE 分支
--    要求调用者对表有 UPDATE 策略。我们只给 anon 开了 INSERT，于是每次写入
--    都返回 401 / 42501 "new row violates row-level security policy"。
--    实测：resolution=ignore-duplicates 同样失败（只有纯 INSERT 能过）。
--
-- 2) 改用纯 INSERT 能过，但**一行重复会让整批回滚**。App 重装后本地
--    bootEpoch 从 0 重来，seq 会与历史数据撞键，于是这一批的新样本也会一起
--    被拒绝 —— 静默丢数据，最难排查的那种。
--
-- 解法：由 SECURITY DEFINER 函数在所有者权限下执行 INSERT ... ON CONFLICT
--      DO NOTHING。效果：
--        - 重复行被跳过，新行照常写入（逐行容错，不是整批失败）
--        - anon 只需要 EXECUTE，**不需要** UPDATE 策略（拿不到篡改历史的能力）
--        - 返回实际写入条数，便于排查"到底写进去几条"
-- ============================================================================

create or replace function public.ingest_samples(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows 必须是 jsonb 数组';
  end if;

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
  from jsonb_array_elements(p_rows) as r
  on conflict (client_key) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

comment on function public.ingest_samples(jsonb) is
  '手机网关批量写入样本：逐行 ON CONFLICT DO NOTHING，返回实际插入条数';

-- 只允许通过 RPC 写入：收回默认的 PUBLIC 执行权限，只给 anon
revoke all on function public.ingest_samples(jsonb) from public;
grant execute on function public.ingest_samples(jsonb) to anon, authenticated;

-- 既然写入改走 RPC，表级 INSERT 策略可以收紧为"禁止直连写入"，
-- 避免有人绕过 RPC 直接往表里灌数据（RPC 以所有者身份执行，不受此影响）
drop policy if exists "gateway insert samples" on public.imu_samples;
