-- ============================================================================
-- 20261123160000_t11_drop_legacy_ingest.sql
--
-- T1.1：删除两个旧写入 RPC，只保留带 token 校验的 ingest_samples_v3。
--
-- 为什么现在才做：
--   旧 APK 走 v2、新 App 走 v3，两者必须并存一段时间，否则升级期间会有一端写不进数据。
--   现在手机端已装 v3 版本（M2 已确认），可以收口了。
--
-- ⚠️ 不可逆：删完之后，任何装着旧 APK 的设备都无法再写库（会报"函数不存在"）。
--    回滚只能重新创建函数（见本文件末尾的注释，或 git 历史里的
--    20261112120000_ingest_rpc.sql / 20261116140000_ingest_rpc_v2.sql）。
--
-- 安全背景（这才是本迁移的真正目的）：
--   ingest_samples(p_rows jsonb) 是**无 token** 的 SECURITY DEFINER 函数，且 anon 可执行
--   —— 任何拿到 anon key 的人都能往 imu_samples 里写任意数据，还能伪造别的 device_id。
--   留着它，等于把 T1.2b 做的所有写入收口全部作废。
-- ============================================================================

-- v1：最早的无鉴权版本
drop function if exists public.ingest_samples(jsonb);

-- v2：有 token 校验，但列清单固定，写不进 device_ts / session_id
drop function if exists public.ingest_samples_v2(text, text, jsonb);

-- 兜底：万一存在别的重载（签名不同），一并扫掉同名函数，避免残留一个可执行入口
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('ingest_samples', 'ingest_samples_v2')
  loop
    execute format('drop function if exists %s cascade', r.sig);
    raise notice '已删除旧函数 %', r.sig;
  end loop;
end $$;

comment on function public.ingest_samples_v3(text, text, jsonb) is
  'M3/T1.1 之后**唯一**的样本写入入口：必须带有效设备 token，只走 SECURITY DEFINER，'
  'anon 无法直连表写入。v1/v2 已删除（不可逆）。';
