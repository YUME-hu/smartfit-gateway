# 设备写库 token（T1.2a）

> 目的：给"设备/网关写库"这条链路一个可撤销、可轮换、库里不存明文的凭据。
> 本文只描述基础设施；**改造写入路径是 T1.2b**，收回旧权限是 T1.1。

## 为什么需要

只读摸底的结论：`ingest_samples` / `device_latest` / `reps` 都是 **anon 可写、零校验**，
而 anon key 会随 APK 一起发出去。于是"知道 anon key"等于"能为任意 `device_id` 写任意数据"。

token 的作用不是加密，而是**把"能写"收敛成"持有某设备 token 的人才能为这台设备写"**，
并且——这是关键——**可以单独撤销一台设备，而不必换掉全站 anon key**。

## 形态

| 项 | 值 |
| --- | --- |
| 明文 | 32 字节随机数 → 64 字符小写 hex（`crypto.randomBytes(32).toString('hex')`） |
| 库里存 | `sha256(明文)` 的 64 字符 hex，**不存明文** |
| 一行 | `(device_id, token_hash)` 联合主键 + `label` + `created_at` + `revoked_at` |
| 一设备多 token | 允许（轮换期双活），靠 `revoked_at` 区分死活 |

数据库被拖走 ≠ token 泄露：拿到 `token_hash` 也反推不出明文（32 字节随机，无字典可行）。

## 权限模型

| 角色 | `device_tokens` 表 | `verify_device_token()` |
| --- | --- | --- |
| `anon` / `authenticated` | 无任何权限（REVOKE 到底，越权访问直接报 `42501`） | EXECUTE |
| `service_role` | SELECT / INSERT / UPDATE | EXECUTE |
| 函数自身 | `SECURITY DEFINER`，只读，`search_path = public, extensions` | — |

给 anon `EXECUTE` 是安全的：函数只返回 boolean，不泄露任何其它设备的信息；
而 T1.2b 之后，写入路径正是要在 anon 身份下调用它做校验。

## 签发

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
node scripts/issue-device-token.cjs --device-id watch-01 --label watch-01-primary
```

输出（**明文只出现这一次**）：

```
  device_id  : watch-01
  token      : 6f1c…（64 字符 hex）
  label      : watch-01-primary
  created_at : 2026-11-16T08:12:33.123456+00:00
```

`service_role key` 只能出现在服务端或本地终端，**绝不能打进 APK / 前端 bundle**。
脚本会顺带校验这个 key 的 JWT 角色，误贴 anon key 会直接报错退出。

## 分发：token 存在哪

- **设备侧（首选）**：Android Keystore 支持的加密存储（需要原生插件）。
  uni-app 自带的 `uni.setStorage` **不是**安全存储 —— 未 root 的机器上它在 App 私有目录，
  root 后可读；对毕设演示够用，生产要换 Keystore。
- **网关侧（当前形态）**：`src/gateway` 跑在手机 App 里，token 通过 `.env` /
  本地配置文件注入，随包分发。**这意味着 token 仍然在包里**——比 anon key 好的是：
  它只对一台设备有效，且能单独撤销。
- **绝不**：写进 git、写进日志、写进看板的浏览器存储（看板不需要写权限）。

## 轮换

目标：不中断写入的前提下换掉 token。

1. 给同一 `device_id` 再签一个（新的 `label`，例如 `watch-01-2026Q2`）；
2. 把新 token 下发到设备/网关，重启采集；
3. 观察一段时间（新 token 的 `created_at` 之后应有新数据落库）；
4. 撤销旧的那一个：目前脚本的 `--revoke` 是"撤销该设备**所有**未撤销 token"，
   所以轮换的收尾是——先把旧 token 的 `revoked_at` 单独更新，或在新 token 生效后
   用 `--revoke` 一次性清空再补签。<br>
   > 已知粗糙点：`--revoke` 目前不支持只撤销某一个 label，轮换的"精细收尾"要手写一条 SQL。
   > 记在 [tech-debt.md](tech-debt.md)。

## 撤销

```bash
node scripts/issue-device-token.cjs --device-id watch-01 --revoke
```

软撤销：`revoked_at = now()`，行保留用于审计。撤销后 `verify_device_token` 立刻返回 `false`。

## 丢失

**没有找回路径**——库里只有摘要。丢掉就等于只能重新签发，然后按上面的轮换流程替换。

## 演示环境 vs 生产

- 生产：**每设备一份**，`label` 带设备与批次信息。
- 演示：可以多台设备共用一份 token（毕设只有一台手表），但这会让"按设备撤销"失效。
  记在 [tech-debt.md](tech-debt.md)。

## 本地验证（不连线上）

```bash
supabase start                     # 需要 Docker
supabase db reset                  # 应用 supabase/migrations/*
# 取 service_role key
supabase status | grep service_role
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=<上一步的 key> \
node scripts/issue-device-token.cjs --device-id watch-01 --label local-test
```

然后用 SQL 验四种情况（正确 / 错误 / 撤销后 / 空值）：

```sql
select public.verify_device_token('watch-01', '<刚签发的明文 token>');  -- t
select public.verify_device_token('watch-01', 'deadbeef');              -- f
select public.verify_device_token('', '');                              -- f
-- 撤销后
update public.device_tokens set revoked_at = now() where device_id = 'watch-01';
select public.verify_device_token('watch-01', '<同一个明文 token>');     -- f
```
