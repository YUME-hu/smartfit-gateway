# 演示数据来源（Data Provenance）

> 目的：答辩或被审计时能回答"库里这些数字是怎么来的"。
> 记录时间：2026-11-16（Asia/Shanghai）。
> 取证方式：对项目库执行**只读** SELECT（语句见文末），全程没有写入。
> 结论：**线上没有任何第三方写入痕迹**，现有业务数据全部来自 2026-11-12 ~ 11-13
> 的本地演示操作。

## 保留决策

这 330 点经验**保留、不清理**：

1. 它刚好跨过 300 的门槛，演示时"已达标、可上链"靠它；清掉后答辩要重新造数据，风险大于收益。
2. 没有第三方脏数据，不存在"外部攻击痕迹需要抹掉"的问题。
3. 这 330 是作者自己演示时点的，属于预期行为，不是"漏洞被利用"。

T1.2 收紧 anon 写权限后，同类数据只能由带鉴权的路径产生；这份记录就是"收口前"的历史快照。

## 明细

### pet_state / watch-01（全库仅此 1 行）

| 字段 | 值 | 来源 |
| --- | --- | --- |
| `bonus_exp` | 300 | 2026-11-13T12:36:52Z，点「奖励经验 +100」调试按钮（`add_bonus_exp` RPC），演示用 |
| `steps_total` | 6 | 手表实测样本的 `steps` 窗口经触发器累加（多数样本 `steps` 为 null） |
| `reps_total` | 20 | 由下面 20 条 `reps` 经 `pet_bump_reps` 触发器累加 |
| `exp` | 330 | 生成列：`floor(6/100)*10 + floor(20/10)*15 + 300` = 0 + 30 + 300 |
| `food_earned` / `food_used` / `hunger` | 4 / 1 / 45.24 | 喂食 1 次（`last_fed_at` = 2026-11-13T12:36:34Z） |

### reps（全库 20 行）

- 时间窗：`2026-11-12T09:20:09.800Z` → `09:20:17.708Z`（**7.9 秒**）
- 同一个 `session_id`：`mwdc6oo1-elukw`
- 判定：**不是真人深蹲**。7.9 秒写 20 条、`duration_ms` 恒为 1500、`min_angle` 恒为 95
  —— 这是调试按钮「模拟 10 个深蹲」**点了两次**的指纹（每次 10 条）。

## 为什么这不是"漏洞被利用"

- `bonus_exp` 的 `updated_at`（12:36:52Z）比当天最后一次提交 `dd3810d`（12:39:48Z）
  **早 3 分钟**，同一串动作里还有一次喂食（12:36:34Z）—— 是人工演示节奏，不是外部扫描。
  外部攻击不会刚好卡在提交前 3 分钟、还顺手喂一次食。
- 全库只有 `watch-01` 一台设备、连同样本共 26 行左右；
  `max(steps_total)` / `max(reps_total)` / `max(bonus_exp)` 都等于这一行，没有第二台设备或刷量痕迹。

## 复现取证

用 service_role 或 `psql` 执行（均为只读）：

```sql
select device_id, bonus_exp, steps_total, reps_total, exp, food_earned, food_used,
       hunger, updated_at, last_fed_at
from pet_state;

select count(*) as n, min(recorded_at) as oldest, max(recorded_at) as newest from reps;

select session_id, device_id, count(*) as n, min(recorded_at), max(recorded_at)
from reps group by session_id, device_id order by n desc;

select count(*) as rows, max(steps_total) as max_steps,
       max(reps_total) as max_reps, max(bonus_exp) as max_bonus
from pet_state;
```

## 已知局限

- 数据库没有"写入者"字段，所以"是本人操作"这个结论来自**时间相关性 + 数据形态**
  （7.9 秒 20 条、固定 duration/min_angle），不是密码学证据。
- 2026-11-16 取证时，`pet_state.updated_at` 之后没有新写入，`reps` 也没有新增行。
