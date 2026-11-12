-- ============================================================================
-- 20261112151000_pet_backfill.sql
--
-- 回填历史数据
--
-- 为什么需要：pet_state 的累计量是**触发器**维护的，而触发器只对
-- 创建之后的新插入生效。在此之前已经入库的 imu_samples / reps
-- （实测有 282 条样本）不会被算进宠物经验，用户会看到"我一直在走，宠物还是 0 级"。
--
-- 这里从源表重新算一遍绝对量，幂等：
--   再跑一次结果相同，因为它用 SUM/COUNT 覆盖而不是累加。
-- ============================================================================

-- 步数：按设备汇总窗口步数
insert into public.pet_state (device_id, steps_total)
select device_id, coalesce(sum(steps), 0)::integer
from public.imu_samples
group by device_id
on conflict (device_id) do update
  set steps_total = excluded.steps_total,
      updated_at  = now();

-- 深蹲：按设备计数（reps.device_id 在 20261112150000 里补上了，默认 watch-01）
insert into public.pet_state (device_id, reps_total)
select device_id, count(*)::integer
from public.reps
group by device_id
on conflict (device_id) do update
  set reps_total = excluded.reps_total,
      updated_at = now();
