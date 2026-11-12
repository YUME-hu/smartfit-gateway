-- ============================================================================
-- 20261112130000_realtime_replica_identity.sql
--
-- 实测结论（很重要，别删）：
--   device_latest 每收到一包就被 UPDATE 一次，但 Realtime 在默认
--   REPLICA IDENTITY（仅主键）下**不会把 UPDATE 事件投递给带 RLS 的订阅**：
--     - INSERT 新行 → 客户端能收到 ✅
--     - UPDATE 已有行 → 客户端收不到 ❌（不报错，静默不推）
--   结果就是 Web 看板只显示第一帧，之后永远不再刷新 —— 极难排查。
--
-- 原因：Realtime 需要用"旧行"来评估 RLS 与 filter，默认 identity 只带主键，
-- 无法完成评估，于是直接丢弃事件。改成 FULL 后旧行完整，事件正常投递。
--
-- 代价：UPDATE 的 WAL 记录会变大（多存一份完整旧行）。
-- device_latest 是单行小表，代价可忽略。
-- ============================================================================

alter table public.device_latest replica identity full;

comment on table public.device_latest is
  '每设备一行最新样本，Web 端通过 Realtime 订阅（必须 REPLICA IDENTITY FULL 才能收到 UPDATE）';
