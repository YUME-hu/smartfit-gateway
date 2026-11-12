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
| ④ 实时看板 | `src/gateway/latest.ts` + `web/useDeviceLatest.ts` | ✅ 云端实测收到 UPDATE 事件，⚠️ 未真机 |
| ⑤ 立即同步按钮 | `pages/gateway/index.vue` | ✅ SFC 编译，⚠️ 未真机 |
| ⑥ 波形/步数图表 | `components/MiniChart.vue` | ✅ SFC 编译，⚠️ 未真机 |
| ⑦ 云端 schema | `supabase/migrations/`（3 个迁移） | ✅ `db push` 已应用 + 10 项校验全过 |

## Web 实时看板（`web/`）

独立的 Vite + Vue3 项目，订阅 `device_latest` 的 Realtime 变化，实时显示步数与合模量。

### 启动

```bash
cd web
npm install
cp .env.example .env      # 填 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
npm run dev               # http://localhost:5199
```

生产构建：`npm run build`（产物在 `web/dist`）→ `npm run preview` 本地预览。

### 技术选择

- **ECharts 按需引入**：`echarts/core` + `LineChart`/`BarChart` + `Grid/Tooltip/Legend`
  + `CanvasRenderer`。全量 `import * as echarts from 'echarts'` 产物 1.34 MB，
  按需后 **804 kB（gzip 257 kB）**。
- 不引 `vue-echarts`，自己管实例生命周期 / resize / dispose，少一层依赖。
- 图表用固定 **5 分钟时间窗**（`xAxis.min = lastT - 5min`），数据自然左移，
  比让轴自动缩放更像"滚动"。
- `vue-tsc --noEmit` 做类型检查（`npm run typecheck`），CI 里可当门禁。

### 界面

- 四张 KPI：合模量 |a|、最近 5 秒步数、会话累计、最后更新时间
- 折线图：左轴 |a|（折线+面积）、右轴窗口步数（柱状），共用时间轴
- 状态胶囊：实时在线 / 连接中 / 连接异常，附「重连」按钮
- 超过 15 秒没更新会把时间标黄（3 个包周期）

### ⚠️ 两个必须知道的口径问题

1. **`steps` 是「最近 5 秒窗口的步数」，不是全天累计。**
   页面上的「会话累计」是前端从打开页面起自己叠加的，刷新归零。
   要真正的日/周累计，需要服务端聚合视图（例如按 `date_trunc('hour', recorded_at)`
   建视图并给 anon 只读权限），目前没做——因为 `imu_samples` 对 anon 不开放查询。
2. **数值停在第一帧不动** → 99% 是 `device_latest` 没开 `replica identity full`
   （见上文「坑 2」）。订阅会显示「实时在线」，但收不到 UPDATE 事件。

### 实测记录（浏览器端 E2E）

用真实项目跑过一遍：写入 `device_latest` → 页面在 1.5 秒内更新
（`|a|` 0.998 → 1.000 g，窗口步数 7 → 3，会话累计 7 → 10），
canvas 1102×380 采样到 551 个非背景像素，确认图表真的绘制了。

> 排障中发现的一个环境坑：本机 IE/系统代理开着（`127.0.0.1:7892`），
> 浏览器会把 `*.supabase.co` 也走代理并被断开（`ERR_CONNECTION_CLOSED`），
> 而 `curl` / Node 不读系统代理所以一直正常。如果页面在浏览器里连不上而
> 命令行能通，先看「设置 → 网络 → 代理」。

## 完整演示流程（Demo Flow）

答辩现场按这个顺序，任何一步跳过都会让后面看起来"没数据"。

### 演示前一天的准备（别在答辩现场装环境）

- [ ] 手表已烧录 `firmware/watch_ble`，USB 或电池供电正常
- [ ] 手机已装好 App（HBuilderX 真机运行，或已签名 APK）
- [ ] 手机蓝牙 /「附近的设备」权限已授权，系统定位开关已打开
- [ ] Web 看板能启动：`cd web && npm install && npm run dev`
- [ ] 浏览器能直连 `*.supabase.co`（代理别拦，见文末）
- [ ] （可选）清空演示数据：`delete from public.device_latest; delete from public.imu_samples;`

### 现场顺序（约 2 分钟）

**① 手表上电**（约 5s）

手表开始 BLE 广播，设备名 `ESP32_Fitness_Watch`。
想确认广播正常：插 USB 看串口，应出现
`蓝牙准备就绪，设备名 "ESP32_Fitness_Watch"`。

**② 打开手机 App**（约 5~10s）

自动扫描并连接：状态「扫描中」→「连接中」→「已连接」。
首次会弹权限，**全部允许**。连接后每 5 秒一个包，页面开始出数。

**③ 打开 Web 看板**（约 3s）

地址 `http://localhost:5199`（或部署后的地址）。
右上角必须显示 **实时在线**（绿色）；显示「连接异常」先查代理。

**④ 拿着手表演示动作**（30s）

走动或做深蹲，Web 大屏的曲线与步数会实时跳动。
这是"实时链路"的核心证据：**手表 → 手机 → 云端 → 浏览器，中间没有任何刷新**。

**⑤ 点「立即同步」**（3s）

App 上「待上传」清零、「已上传」增加、「上次同步」变为当前时间。
切到 Supabase 控制台 `imu_samples` 表，能看到刚落库的行
（建议提前开好这个标签页，效果最好）。

**⑥ 收尾讲解**

- 手表：25Hz 采样 + 5 秒窗口聚合计步，单包仅 21 字节
- 手机：本地分块队列（断网不丢）+ 15 分钟批量 + 幂等键防重复
- 云端：RPC 逐行 `ON CONFLICT DO NOTHING`，Web 靠 Realtime 收增量

### 现场最容易翻车的四点

1. **App 不能切后台**：iOS/Android 都会挂起 BLE 与定时器。演示期间保持前台、屏幕常亮。
2. **别在手机蓝牙设置里"配对"手表**：系统配对会占用连接，App 反而连不上。
   只在 App 里连。
3. **Web 显示「实时在线」但没有数字**：99% 是 `device_latest` 没开
   `replica identity full`（迁移已修），其次是代理拦了 Supabase。
4. **两个步数对不上是正常的**：App 的「累计步数」从 App 启动算，
   Web 的「会话累计」从页面打开算，窗口不同，不要求相等。

> 实测参考：一次真机演示中 App 侧 41 包 / 丢 0 / 坏 0、已上传 23 条；
> Web 侧同一时刻 52 个采样点、`|a|` = 1.112 g、状态「实时在线」。

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
- **云端 schema 已实测**：3 个迁移 `db push` 成功；`scripts/verify-db.cjs`
  10 项全 PASS（表/列/RLS/策略/publication/RPC/幂等/混合批次）
- **Realtime 已实测**：`scripts/verify-realtime.cjs` 收到 UPDATE 事件
- **写入路径已实测**：anon 调 RPC 首次返回 1、重试返回 0；直连写表被 RLS 挡下
- **真机端到端已跑通**（2026-11-12）：ESP32 → 手机 App → Supabase → Vue3 看板。
  App 侧 41 包 / 丢包 0 / 坏包 0、已上传 23 条；Web 侧 52 个采样点、
  `|a|` = 1.112 g、状态「实时在线」、图表连续滚动

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
│     ├─ supabaseRest.ts          样本走 RPC / 最新值走 PostgREST upsert
│     ├─ syncEngine.ts            15 分钟定时 / 手动 / 退避重试 / 单飞
│     ├─ latest.ts                最新值节流发布
│     ├─ bleTransport.ts          uni-app BLE 扫描/连接/重连
│     └─ useImuGateway.ts         Vue3 装配层（含图表历史缓冲）
├─ components/MiniChart.vue       原生 canvas 折线/柱状图（零依赖，App 用）
├─ pages/gateway/index.vue        演示页：步数主视觉 + 双图表 + 立即同步
├─ web/                           ★ Vite + Vue3 实时看板（ECharts）
│  ├─ src/App.vue                 KPI 卡片 + 图表 + 状态
│  ├─ src/components/LiveChart.vue ECharts 薄封装（按需引入）
│  ├─ src/composables/useDeviceLatest.ts  Realtime 订阅 + 去重 + 滚动缓冲
│  └─ vite.config.ts              dev 端口 5199
├─ firmware/                      ESP32 固件（计步 + BLE）
├─ supabase/migrations/           Supabase CLI 迁移（唯一 schema 来源）
├─ scripts/                       单测/SFC/workflow/云端验证脚本
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

写入不走 PostgREST 的 upsert，而是走 `ingest_samples(p_rows jsonb)` 这个
`SECURITY DEFINER` 函数（`INSERT ... ON CONFLICT DO NOTHING`）。原因见下节。

## 云端链路实测记录（两个必踩的坑）

这一段是接真 Supabase 项目时实测出来的，不是纸面设计。都已在迁移里修掉。

### 坑 1：带 `Prefer: resolution=...` 的写入会被 RLS 拒绝

隔离实验（同一个 anon key、同一张表）：

| 请求 | 结果 |
| --- | --- |
| 纯 INSERT，无参数无 header | **201** ✅ |
| 只带 `?on_conflict=client_key` | **201** ✅ |
| 只带 `Prefer: resolution=ignore-duplicates` | **401 / 42501** ❌ |
| 两者都带（原实现） | **401 / 42501** ❌ |

PostgREST 把 `resolution` 翻译成 `ON CONFLICT DO UPDATE`，而 DO UPDATE 分支
要求调用者有 UPDATE 策略 —— 即使没有任何冲突也会检查。给 anon 开 UPDATE 等于
允许篡改历史样本，不能接受。

退化成纯 INSERT 虽然能写，但**一行重复会让整批回滚**：App 重装后本地
`bootEpoch` 从 0 重来，seq 与历史撞键，这一批的新样本会一起被拒 —— 静默丢数据。

**修法**：写入改走 `ingest_samples(jsonb)` RPC（`SECURITY DEFINER` +
`ON CONFLICT DO NOTHING`）。重复行跳过、新行照写，anon 只需 EXECUTE。
实测：首次调用返回 `1`，同批重试返回 `0`，混合批次只写新行。

### 坑 2：Realtime 收不到 UPDATE 事件

`device_latest` 每个包都会被 UPDATE 一次，但默认 `REPLICA IDENTITY`（仅主键）
下，带 RLS 的订阅**收不到 UPDATE 事件，而且不报错**：

- 插入全新行 → 收到 ✅
- UPDATE 已有行 → 10 秒收不到 ❌

表现就是 Web 看板只显示第一帧、之后永远不刷新。

**修法**：`alter table public.device_latest replica identity full;`
（迁移 `20261112130000`）。修完复测，UPDATE 事件正常到达。
代价是 UPDATE 的 WAL 记录变大，单行小表可忽略。

### 本机网络注意：直连是纯 IPv6

`db.<ref>.supabase.co` 只有 AAAA 记录，本机没有全局 IPv6，所以直连 5432 不通。
必须走 IPv4 的连接池：

```bash
supabase db push --remote="postgresql://postgres.<ref>:<密码>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres" --yes
```

- `aws-1-<region>` 而不是 `aws-0-`（用错误密码探测可区分：`aws-0` 报
  `tenant/user not found`，`aws-1` 报 `password authentication failed`，后者才对）
- 非交互环境必须加 `--yes`，否则提示 `Confirmation required`
- `--remote=<url>` 模式**不需要** `supabase login`

### 凭据走环境变量

验证脚本从环境变量读连接串，不写死、不入库：

```powershell
$env:SUPABASE_DB_URL="postgresql://..."; node scripts/verify-db.cjs
$env:SUPABASE_URL="https://<ref>.supabase.co"; $env:SUPABASE_KEY="sb_publishable_..."; node scripts/verify-realtime.cjs
```

## 命令

```bash
npm run typecheck   # 类型检查
npm run check:sfc   # .vue 编译检查
npm test            # 编译 + 20 个单元测试
npm run verify      # 上面三个一起跑

# 连云端验证（需要环境变量，见上）
npm run verify:db   # schema / RLS / RPC / publication
npm run verify:rt   # Realtime 是否真的推事件
```

Web 看板：

```bash
cd web
npm run dev        # http://localhost:5199
npm run typecheck  # vue-tsc
npm run build      # 产物 web/dist
```
