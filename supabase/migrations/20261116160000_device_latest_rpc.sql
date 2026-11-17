-- ============================================================================
-- 20261116160000_device_latest_rpc.sql
--
-- T1.2b-2：device_latest 写入收口到带 token 的窄 RPC（方案 A′）
--
-- 为什么是"窄 RPC"而不是把 latest 塞进 ingest_samples_v2：
--   ingest_samples_v2 是 15 分钟批量同步，而 device_latest 是看板的实时通道
--   （App 每收到一包就写一次，节流 1s）。挪进批量路径等于把看板从 1 秒
--   退化成 15 分钟，而且批量里的样本更旧，会把实时值顶回去。
--   所以实时那一次写单独一条 RPC：token 校验 + 单行 upsert + 防回退。
--
-- 中间态说明（本迁移之后、T1.1 之前）：
--   · device_latest ：**已收口** —— anon 无 insert/update 权限，只能走 update_device_latest
--   · imu_samples   ：新包走 ingest_samples_v2（带 token），旧签名 ingest_samples 仍对 anon 开放
--   · reps          ：仍 anon 直插（T1.3 处理）
--   收口是分三条路径推进的，本文件只动第一条。旧签名 / reps 一行未改。
-- ============================================================================

create or replace function public.update_device_latest(
  p_device_id text,
  p_token     text,
  p_row       jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- ① token 校验：第一段，先于任何读写
  if not public.verify_device_token(p_device_id, p_token) then
    raise exception 'invalid device token' using errcode = '28000';
  end if;

  -- ② p_row 形态 + 必填字段（类型转换失败交给 PG 自然抛 22P02）
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'p_row 必须是 jsonb 对象' using errcode = '22023';
  end if;
  if not (p_row ? 'recorded_at') then
    raise exception 'p_row 缺少字段: recorded_at' using errcode = '22023';
  end if;
  if not (p_row ? 'x') then
    raise exception 'p_row 缺少字段: x' using errcode = '22023';
  end if;
  if not (p_row ? 'y') then
    raise exception 'p_row 缺少字段: y' using errcode = '22023';
  end if;
  if not (p_row ? 'z') then
    raise exception 'p_row 缺少字段: z' using errcode = '22023';
  end if;

  -- ③ 单行 upsert；steps 缺失或空串一律存 null
  insert into public.device_latest (device_id, recorded_at, x, y, z, steps)
  values (
    p_device_id,
    (p_row ->> 'recorded_at')::timestamptz,
    (p_row ->> 'x')::real,
    (p_row ->> 'y')::real,
    (p_row ->> 'z')::real,
    nullif(p_row ->> 'steps', '')::integer
  )
  on conflict (device_id) do update
    set recorded_at = excluded.recorded_at,
        x           = excluded.x,
        y           = excluded.y,
        z           = excluded.z,
        steps       = excluded.steps,
        updated_at  = now()
    -- 防回退：批量补写 / 网络重试 / 乱序到达时，旧样本不许把实时值盖回去
    where excluded.recorded_at > public.device_latest.recorded_at;

  -- 插入或更新成功 → FOUND=true；被 where 挡掉（更旧/相等）→ false
  return found;
end;
$$;

comment on function public.update_device_latest(text, text, jsonb) is
  'T1.2b-2：实时"最新值"写入（token 校验 + 防回退 upsert）。返回 false 表示因 recorded_at 更旧被忽略';

-- ---------------------------------------------------------------- 权限
-- 表：收回 anon/authenticated 的直接写，只留读（看板 SELECT + Realtime 需要）
drop policy if exists "gateway insert latest" on public.device_latest;
drop policy if exists "gateway update latest" on public.device_latest;

revoke insert, update on public.device_latest from anon, authenticated;
grant select on public.device_latest to anon, authenticated;

-- 函数：只允许通过它写
revoke all on function public.update_device_latest(text, text, jsonb) from public;
grant execute on function public.update_device_latest(text, text, jsonb)
  to anon, authenticated, service_role;
