# 手机网关（uni-app）+ Supabase + Vue3 实时看板

参考小米手环的分层同步：手表只管低功耗采集与**窗口计步**，手机负责缓存与批量回传，
Web 端只看"最新值"。

```
手表 (25Hz 采样 → 5s 窗口聚合 → BLE notify)
   │  "x,y,z,seq,steps"
   ▼
App 网关
   ├─ 严格解析（截断包丢弃并计数）
   ├─ 幂等键 client_key
   ├─ 本地分块队列（进程被杀不丢）
   ├─ 实时图表（合模量 / 每窗口步数）
   ├─ 最新值 ──────────────────────────────────┐
   └─ 每 15 分钟 / 点「立即同步」批量 upsert    │
        ▼                                      ▼
   Supabase imu_samples              Supabase device_latest
                                               │ Realtime（本身就是 WebSocket）
                                               ▼
                                        Vue3 实时看板
```

## ⚠️ 需求第 4 条为什么换了实现方式

原文是"App 保留一份最新数据，**通过 WebSocket 推给 Web 端**"。手机做不到：

1. 手机在运营商/校园网 NAT 后面，没有公网 IP，Web 端连不上；
2. 小程序/uni-app 运行时**不能监听端口**，起不了 WebSocket 服务端；
3. 即使能起，Vue 页面在 `https://` 下连 `ws://<手机内网IP>` 会被混合内容策略拦截。

改由 Supabase Realtime 承担这一段 WebSocket：App 只写一行 `device_latest`，
数据库变更由 Supabase 推给浏览器。对页面而言效果一致，但不需要手机有公网地址。

## 需求逐条对应

| 需求 | 实现位置 | 验证状态 |
| --- | --- | --- |
| ① 手表 5 秒一包 + 窗口计步 | `firmware/watch_ble/` + `firmware/common/step_counter.h` | ✅ 实测 5.01s / 5 字段 / 静置 0 步；算法合成信号自测 PASS |
| ② 手机本地缓存 | `src/gateway/cache.ts` | ✅ 单测 |
| ③ 每 15 分钟批量 insert | `src/gateway/syncEngine.ts` | ✅ 单测 |
| ④ 实时看板 | `src/gateway/latest.ts` + `web/useDeviceLatest.ts` | ⚠️ 未真机 |
| ⑤ 立即同步按钮 | `pages/gateway/index.vue` | ✅ SFC 编译，⚠️ 未真机 |
| ⑥ 波形/步数图表 | `components/MiniChart.vue` | ✅ SFC 编译，⚠️ 未真机 |

## 工程化三件事

### 1. 配置走 .env（供 CI 注入）

`src/config.ts` 从 `VITE_*` 环境变量读取，不存在时不崩溃，而是在页面顶部显示红色
「缺少环境变量」提示——避免把配置问题误判成"蓝牙又连不上了"。

```bash
cp .env.example .env
# 填 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_DEVICE_ID
```

⚠️ `VITE_` 变量会被打进 APK，属公开信息，**只能放 anon key**。

### 2. 建表走 Supabase CLI

```bash
npm i -g supabase          # 或 brew install supabase/tap/supabase
supabase login             # 浏览器里授权一次
cd app-gateway
supabase init              # 生成 supabase/config.toml（只需一次）
supabase link --project-ref <你的-project-ref>   # 会要求输入数据库密码
supabase db push           # 应用 supabase/migrations/*.sql
```

`supabase/migrations/` 是**唯一**的 schema 来源（原来的 `schema.sql` 已删除，
避免两处 DDL 漂移）。改表结构的正确姿势：`supabase migration new add_xxx` → 写 SQL →
`supabase db push`，不要手改控制台。

本地起一套 Postgres 试跑：`supabase start && supabase db reset`。

### 3. GitHub Actions 打 APK

`.github/workflows/build-apk.yml`，两个 job：

- **build-assets**：跑 `npm run build:app`，产出 `dist/build/app` 并作为 artifact。
  这一步不依赖任何 DCloud 私有资源，**总是能跑通**，用来第一时间发现编译错误。
- **package-apk**：下载 DCloud 离线 SDK → 把产物塞进 `assets/apps/<appid>/www` →
  `./gradlew assembleRelease` → 上传 APK。缺 `vars.ANDROID_SDK_URL` 时自动跳过。

需要配置的 Secrets / Variables：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| secret | `VITE_SUPABASE_URL` | Supabase 项目地址 |
| secret | `VITE_SUPABASE_ANON_KEY` | anon key |
| secret | `ANDROID_KEYSTORE_BASE64` | 签名库的 base64（`base64 -w0 release.keystore`） |
| secret | `ANDROID_STORE_PASSWORD` | 签名库口令 |
| secret | `ANDROID_KEY_ALIAS` | 别名 |
| secret | `ANDROID_KEY_PASSWORD` | 别名口令 |
| var | `UNI_APP_ID` | `manifest.json` 里的 appid，如 `__UNI__A1B2C3D` |
| var | `ANDROID_SDK_URL` | DCloud Android 离线 SDK 的 zip 直链 |
| var | `GRADLE_PROJECT` | SDK 内 Gradle 工程目录，如 `HBuilder-Integrate-AS` |
| var | `VITE_DEVICE_ID` | 默认 `watch-01` |

**三个一定会踩的坑**（写在这里省你几小时）：

1. **项目必须是 CLI 工程**。HBuilderX 里"新建的空项目"没有 `package.json`，
   CI 跑不了 `build:app`。用 `npx degit dcloudio/uni-preset-vue#vite-ts my-app` 建工程，
   再把 `src/gateway`、`pages`、`components` 拷进去。
2. **离线 SDK 版本必须与 `@dcloudio/*` 各包版本一致**，否则 App 启动白屏，
   而且 logcat 里只会看到一句很含糊的报错。
3. **appid 必须与 SDK 里 `dcloud_control.xml` 一致**，同样是白屏。

> 这三步我只能写出配置，**没法在这台机器上验证**——这里没有 Android SDK 和
> DCloud SDK。workflow 的 YAML 语法已用 `js-yaml` 校验通过（2 jobs / 19 steps）。

## 验证情况（请按这个判断可信度）

已做：

- `npm run verify` = `tsc --noEmit` + SFC 编译检查 + 单元测试，全部通过
- **20 个单元测试**（`tests/gateway.test.cjs`）：协议 5/4/3 字段、截断包丢弃、
  缓存块切换与容量上限、seq 回退判定、同步失败不丢数据、并发单飞、批次上限
- 两个 `.vue` 用 `@vue/compiler-sfc` 编译通过（`scripts/check-sfc.cjs`）
- workflow YAML 解析通过

没做（没有 HBuilderX / 手机 / Android SDK，不能声称已验证）：

- 真机 BLE、真机调 Supabase、图表真机渲染
- GitHub Actions 实际跑通（首次跑大概率要调 SDK 路径）

## 目录

```
app-gateway/
├─ src/
│  ├─ config.ts                   从 .env 读 Supabase 配置 + 缺失项收集
│  ├─ env.ts                      import.meta.env 封装
│  └─ gateway/
│     ├─ types.ts                 数据模型与配置
│     ├─ protocol.ts              负载解析（严格校验，防 MTU 截断）
│     ├─ storage.ts               存储抽象（uni / 内存）
│     ├─ cache.ts                 分块持久化队列
│     ├─ session.ts               上电会话判定 + 幂等键
│     ├─ supabaseRest.ts          PostgREST 批量 upsert
│     ├─ syncEngine.ts            15 分钟定时 / 手动 / 退避重试 / 单飞
│     ├─ latest.ts                最新值节流发布
│     ├─ bleTransport.ts          uni-app BLE 扫描/连接/重连
│     └─ useImuGateway.ts         Vue3 装配层（含图表历史缓冲）
├─ components/MiniChart.vue       原生 canvas 折线/柱状图（零依赖）
├─ pages/gateway/index.vue        演示页：步数主视觉 + 双图表 + 立即同步
├─ web/useDeviceLatest.ts         Vue3 Web 端 Realtime 订阅
├─ supabase/migrations/           Supabase CLI 迁移（唯一 schema 来源）
├─ scripts/check-sfc.cjs          .vue 编译检查
├─ tests/gateway.test.cjs         20 个单元测试
└─ .github/workflows/build-apk.yml
```

## 接入步骤

1. `supabase link` + `supabase db push` 建表（见上）
2. `cp .env.example .env` 填地址与 anon key
3. 用 CLI 模板建 uni-app 工程，把 `src/`、`pages/gateway/`、`components/` 拷进去，
   `pages.json` 注册 `pages/gateway/index`
4. 权限：Android `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`（API 31+ 搜 BLE 还需定位权限）；
   iOS `NSBluetoothAlwaysUsageDescription`
5. 运行到手机 → 点「立即同步」验证一次写入

## 必须知道的运行限制

1. **App 退到后台会断**。iOS 进后台挂起 BLE 与定时器，Android 也会被省电策略杀。
   "每 15 分钟同步"只在**前台**可靠。常驻采集需要 Android 原生前台服务（uni-app
   默认没有，得写原生插件）与 iOS `bluetooth-central` 后台模式。
2. **5 秒窗口 ≠ 原始波形**。图表画的是每 5 秒的均值序列，能看出"动没动"，
   但看不到步态波形。要看真实波形需把上报频率提回去或改成窗口 min/max。
3. **时间轴用手机时间**。手表无 RTC，`recorded_at` 是手机收包时刻。
4. **缓存上限 6 万条（约 3.5 天）**，超出丢最旧并在界面提示。
5. **anon key 公开**：`migrations` 里给 anon 开放了 insert，拿到 key 的人能写脏数据。
   加固方案（`x-device-token` 请求头校验）写在迁移文件末尾。
6. **MTU**：一包典型 21 字节，超过默认 ATT MTU 23 的 20 字节有效负载。
   App 会 `setBLEMTU(185)`（iOS 自动协商）。若协商失败导致截断，页面会显示
   「有 N 个包被丢弃」，不会静默入库半截数据。

## 数据契约

BLE 负载：`x,y,z,seq,steps`

| 字段 | 含义 | 例 |
| --- | --- | --- |
| x,y,z | 该 5 秒窗口的三轴**均值**（g） | `-0.12` |
| seq | 已成功发出的包序号 | `3` |
| steps | 该窗口内计到的步数 | `7` |

幂等键 `client_key = {deviceId}:{bootEpoch}:{seq}`，如 `watch-01:1:42`。
`bootEpoch` 由网关通过 "seq 回退 ⇒ 手表重启" 推断并持久化。
Supabase 对 `client_key` 有唯一约束 + upsert，重试不会写重复行。

## 命令

```bash
npm run typecheck   # 类型检查
npm run check:sfc   # .vue 编译检查
npm test            # 编译 + 20 个单元测试
npm run verify      # 上面三个一起跑
```
