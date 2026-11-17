-- ============================================================================
-- 20261116120000_device_tokens.sql
--
-- T1.2a：设备写库 token —— 只建能力，不改任何现有写入路径
--
-- 现状（只读摸底结论）：
--   ingest_samples / device_latest / reps 都是 anon 可写且零校验。
--   收口顺序：T1.2a 建 token（本文件）→ T1.2b 改造写入路径 → T1.1 收回旧权限。
--   所以本文件**故意不碰**那三张表：中间态要保持现有功能可用，anon 现在仍然能写。
--
-- 设计要点：
--   1. 只存 SHA-256 摘要，不存明文 —— 库被读也不等于 token 泄露
--   2. (device_id, token_hash) 联合主键：同一设备可并存多个 token，轮换期双活
--   3. revoked_at 软撤销：留审计痕迹，不物理删除
--   4. verify_device_token 只读 + SECURITY DEFINER，可以安全地给写入路径的调用方 EXECUTE
--   5. 表对 anon / authenticated 全关，只有 service_role 能读写
--   6. 刻意**不开** RLS：权限层直接拒绝（报 42501），比"开了 RLS 但没策略"
--      更可诊断 —— 后者会让将来的某个角色读到 0 行，看起来像"没有 token"，
--      是典型的静默失败。这里要的是要么能用、要么明确报错。
-- ============================================================================

-- pgcrypto 提供 digest()。Supabase 默认把它装在 extensions schema 里，
-- 这里显式声明，避免在"已存在但装别处"的项目上依赖 search_path 的偶然性。
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- 表

create table if not exists public.device_tokens (
  device_id  text        not null,
  -- sha256(token) 的小写 hex（64 字符）。⚠️ 存的必须是摘要，不是 token 本身
  token_hash text        not null,
  label      text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint device_tokens_pkey primary key (device_id, token_hash),
  constraint device_tokens_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$')
);

comment on table  public.device_tokens            is '设备写库 token（只存 SHA-256 摘要；明文只在签发时出现一次）';
comment on column public.device_tokens.token_hash is 'sha256(token) 的小写 hex，64 字符';
comment on column public.device_tokens.label      is '人读标签，例如 watch-01-primary，方便轮换时区分新旧';
comment on column public.device_tokens.revoked_at is '软撤销时间；非空即失效，行保留用于审计';

-- 查"某设备还有哪些有效 token"用（部分索引，只覆盖未撤销行）
create index if not exists device_tokens_active_idx
  on public.device_tokens (device_id)
  where revoked_at is null;

-- ---------------------------------------------------------------- 校验函数

/**
 * 校验设备 token。
 *
 * 只返回 boolean，不返回行 —— 调用方（写入路径）拿不到任何其他设备的信息。
 * 空 token / 空 device_id 直接 false，避免"设备一个 token 都没有"时空值被当成匹配。
 */
create or replace function public.verify_device_token(p_device_id text, p_token text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  if p_device_id is null or btrim(p_device_id) = '' then
    return false;
  end if;
  if p_token is null or btrim(p_token) = '' then
    return false;
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  return exists (
    select 1
    from public.device_tokens t
    where t.device_id  = p_device_id
      and t.token_hash = v_hash
      and t.revoked_at is null
  );
end;
$$;

comment on function public.verify_device_token(text, text) is
  '校验设备 token（只匹配未撤销行；空值返回 false）。只读，可给 anon EXECUTE';

-- ---------------------------------------------------------------- 权限

-- 表：anon / authenticated 一律不给；service_role 负责签发与撤销
revoke all on table public.device_tokens from anon, authenticated;
grant select, insert, update on table public.device_tokens to service_role;

-- 函数：只读校验，允许写入路径的调用方执行（T1.2b 起用）
revoke all on function public.verify_device_token(text, text) from public;
grant execute on function public.verify_device_token(text, text)
  to service_role, anon, authenticated;
