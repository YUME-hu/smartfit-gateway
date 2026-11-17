# 技术债登记（Tech Debt）

> 规则：每条都写清"为什么现在不做 / 什么时候必须做 / 触发后怎么处理"。
> 不写"以后优化"这种没有触发条件的条目。

## CA 轮换

- 根证书有效期至 **2031-04-26**，毕设周期内不会轮换。现用证书已入库：
  `server/certs/supabase-root.pem`（Supabase Root 2021 CA，公开根证书，SHA-256
  `80:70:25:AD:…:CA:FA`）。
- 如果 Supabase 换 CA，现象：`/sign` 全部 **500**，message 是
  `self-signed certificate in certificate chain`（`SELF_SIGNED_CERT_IN_CHAIN`）。
- 重新抓取命令见 README「已知限制（答辩要主动讲）」第 6 条：
  `openssl s_client -starttls postgres -connect <pooler-host>:5432 -showcerts`
  取链上第 3 张（自签根）覆盖 `server/certs/supabase-root.pem`，重启 signer 即可。
- 可选：固化为 `scripts/fetch-supabase-ca.cjs`。未做的理由——抓取逻辑只有 3 行命令，
  写进文档足够；固化要处理"Windows 默认没有 openssl"、跨平台路径、证书链解析等边界，
  投入产出比低。**触发条件**：一旦发生第一次轮换，或要在 CI 里自动校验证书有效期，就固化它。

## 设备 token：演示环境单份共用

- 生产要求：每台设备一份 token（`label` 带设备与批次），这样才能"只撤销一台"。
- 当前演示：只有一台手表（`watch-01`），可以多机共用一份，省去分发成本。
- **触发条件**：接入第二台设备（或第二个用户）之前必须改成每设备一份。
  否则撤销一台会连带影响所有共用者。

## device token 撤销：不支持按 label 精细撤销

- `scripts/issue-device-token.cjs --revoke` 目前撤销该 `device_id` 下**所有**未撤销 token。
- 轮换的"只废旧 token"收尾要手写一条 SQL：
  `update public.device_tokens set revoked_at = now() where device_id = $1 and label = $2;`
- **触发条件**：第一次真正做滚动轮换时补 `--revoke-label` 参数。

## Realtime 端到端验证未在本地跑通（环境缺口，非代码问题）

- T1.2b-2 的 f 项（看板 2 秒内收到 UPDATE）在本地 harness 里只做到：
  订阅建立 `SUBSCRIBED` ✅、RPC 写入成功 40ms ✅、**事件没推出来** ❌。
- 根因：Docker 官方 `postgres:17` 没有 Supabase 的 `realtime.list_changes()` 辅助函数
  （`3F000 invalid_schema_name`），Realtime 的逻辑解码因此拿不到变更；`wal2json` 是后装的，
  而 `ghcr.io/supabase/postgres` 镜像在本地网络下 20 分钟没拉完。
- 不构成代码风险（订阅、SELECT 策略、RPC 写库都已实测通过），但"服务端推送那一段"没有本地证据。
- **触发条件**：在任何能跑 `supabase start` 的机器上（本项目 CI 跑不了）执行
  `DEVICE_ID=verify-probe DEVICE_TOKEN=<token> node scripts/verify-realtime.cjs`，
  10 秒内应打印 `PASS 收到 Realtime 事件`。**答辩前必须跑一次**。

## reps 仍 anon 可无限 INSERT，T1.3 未收口（方案 C）

- 现状：`public.reps` 仍有 `gateway insert reps`（`for insert to anon with check (true)`），
  anon 可无限插入；每次插入经 `trg_pet_bump_reps` 累加 `pet_state.reps_total`，
  10 条 = 15 经验 —— **审计项"匿名可无限插入刷 exp"在这条决策下继续存在**。
- 为什么不沿用 T1.2b-2 的模式收口：reps 的唯一写入方是浏览器
  （`web/src/features/squat/SquatView.vue` → `repsSync.ts`，`source='vision'`），
  属于**用户数据**而不是设备数据；设备 token 存在 APK 的 uni storage 里，浏览器没有、
  也不该有（token 会随 JS 一起公开，等于把设备凭据降级成公开凭据）。
  硬套会把两种信任模型搞混，所以**不建** `update_device_reps`。
- 触发条件（满足任一即启动收口）：
  a) 引入 Supabase Auth 或服务端代理 → reps 改走 `authenticated` 写；
  b) 手表侧未来要本地算 reps（`source='imu'`）→ 届时按 T1.2b-2 同构做
     `update_device_reps(p_device_id, p_token, p_rows)`，含迁移 + 三条 verify 断言 + harness 实测；
  c) ~~T1.1 收尾时若 a/b 都未满足，在 README 权限章节明确记录此例外~~
     → **已做（2026-11-17）**：README「必须知道的运行限制」第 5 条已写明本例外与理由。
     a/b 两个触发条件继续有效。
- 两个连带事实（避免误判）：`scripts/verify-db.cjs` 里的 reps 写入用的是 DSN 的
  `postgres` 超户，绕过 RLS，不受本条影响；reps 也**不在** `supabase_realtime`
  publication 里（目前没有任何代码订阅它）。
