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

## 深蹲识别（MediaPipe，`web/src/features/squat/`）

看板顶部第二个 Tab。笔记本摄像头实时识别，另带**上传本地视频离线分析**作为答辩兜底。

### 资源全部同源，不碰任何 CDN

官方示例默认从 `storage.googleapis.com` / `cdn.jsdelivr.net` 拉 wasm 和模型，
国内大概率不通。这里全部落在 `web/public/`：

| 资源 | 来源 | 是否入库 |
| --- | --- | --- |
| `public/wasm/*`（4 个文件，28 MB） | `npm run prepare:assets` 从 `@mediapipe/tasks-vision` 复制 | ❌ 由 `npm install` 可复现，不入库 |
| `public/models/pose_landmarker_lite.task`（5.5 MB） | 一次性下载 | ✅ 入库 |

`dev` / `build` 脚本会自动先跑 `prepare:assets`，所以只要 `npm install` 过就不会缺文件。
浏览器实测三个请求都打到 `localhost:5199`，零外网。

### 判定算法（纯函数 + 16 条单测）

`squatCounter.ts` / `poseMath.ts` 不依赖 DOM 与 MediaPipe，可被 `node --test` 直接测。

```
站立(≥160°) ──▶ 下蹲中 ──▶ 蹲底(≤100°) ──▶ 起身中 ──▶ 站立
                                              │
                                   到过蹲底 + 时长≥0.6s 才 +1
```

- **双阈值滞回**：160° 与 100° 之间 60° 死区，人站着微抖不会刷数
- **最短时长 0.6s**：过滤摄像头抖动与快速抬腿
- **必须真的到过蹲底**：浅蹲 / 半蹲不计
- **可见度门控**：髋-膝-踝三点都要 ≥0.5 可见才采用该侧；两侧都不可用就**暂停计数**
- 两侧都可见时取两侧膝角平均，侧身拍摄时自动退化为单侧

单测覆盖：完整深蹲、浅蹲不计数、阈值抖动 30 次不刷数、动作过快不计数、
连续两次 repIndex 递增、跳帧级联、中途回蹲、NaN 输入、状态机不可变、
角度计算、单侧遮挡、关键点缺失。跑 `cd web && npm test`。

### 两种模式

| 模式 | 用途 | 说明 |
| --- | --- | --- |
| 实时摄像头 | 答辩主展示 | `getUserMedia`，前置摄像头画面做镜像（CSS `scaleX(-1)`，骨架同步镜像） |
| 上传视频 | 防翻车兜底 | 选本地视频文件 → 播放一遍分析，不依赖现场光线与摄像头权限 |

### 数据落库

每次动作完成写一行 `reps`（迁移 `20261112140000`）：

| 列 | 说明 |
| --- | --- |
| `client_key` | 幂等键 `session_id:rep_index`，唯一约束挡重复 |
| `session_id` | 一次训练会话，前端生成；可与同时段手表数据按时间对齐 |
| `source` | `vision`（视觉）/ `imu`（手表） |
| `rep_index` | 第几次 |
| `recorded_at` | 完成时刻（需求里的 `ts`） |
| `min_angle` | 本次最深膝角，深蹲质量指标 |
| `duration_ms` | 动作时长 |

写入用**普通 INSERT + 把 23505 当成功**，不用 `Prefer: resolution=...`
（原因见下文「坑 1」）。

### 已知限制

1. 摄像头要求 **localhost 或 HTTPS**，`http://192.168.x.x` 访问会拿不到摄像头。
2. 侧面拍摄最准；正面对髋踝遮挡多，容易丢关键点。
3. lite 模型在普通笔记本上约 15~20 FPS，够用；追求精度可换 `pose_landmarker_full`。
4. 判定参数（160/100/600ms）是按常规深蹲节奏定的，**不同人身高/柔韧度需要微调**，
   改 `DEFAULT_SQUAT_CONFIG` 即可。

## 数字生命养成（`web/src/features/pet/`）

第三个 Tab。宠物状态**持久化在云端**，刷新/换浏览器/手机重同步都不丢。

### 数据流（服务端权威）

```
imu_samples 插入（每 5 秒一条，含 steps） ──┐
                                          ├─▶ 触发器累加 steps_total / reps_total
reps 插入（每完成一个深蹲一行）      ──────┘            │
                                                      ▼
                                            pet_state（exp 是生成列）
                                                      │ Realtime
                                                      ▼
                                            Web 宠物页实时更新
```

前端**不直接写表**，只调三个 RPC：

| RPC | 用途 |
| --- | --- |
| `get_pet_summary(device_id)` | 读状态（含按时间衰减后的饱食度、实时深蹲计数） |
| `feed_pet(device_id)` | 喂食：消耗 1 食物，饱食度 +20 |
| `add_bonus_exp(device_id, delta)` | 奖励经验（演示/成就用） |

### 为什么 exp 必须是生成列

"每 100 步给 10 经验"**不是可加量**：

```
floor(310 / 100) * 10 = 30      ← 正确
floor(250 / 100) * 10 + floor(60 / 100) * 10 = 20   ← 按包累加会少算
```

批同步可能把步数拆成多包入库。所以表里存累计量，`exp` 由它派生：

```sql
exp         integer generated always as ((steps_total / 100) * 10 + (reps_total / 10) * 15 + bonus_exp) stored
food_earned integer generated always as ((steps_total / 100) + (reps_total / 10) * 2) stored
```

实测验证：250 步 → 20 经验；再插 60 步（累计 310）→ **30 经验**，不是 20。

### 计数器的通病：必须能对账

触发器只对"创建之后"的插入生效，而**删源数据不会回退累计量**。这个坑实际踩了两次：

1. 迁移上线时，之前的 282 条历史样本没被算进去 → 补了 `20261112151000_pet_backfill.sql`
2. 验证脚本删测试数据后，`pet_state` 留下了 +1 的残值 → 清理后必须跑对账

所以 `verify-db.cjs` 里有一条硬检查：

```
pet_state.steps_total == (select sum(steps) from imu_samples where device_id = ...)
pet_state.reps_total  == (select count(*)   from reps         where device_id = ...)
```

漂移会直接 FAIL。手工对账命令（幂等）：

```sql
update public.pet_state ps
   set steps_total = coalesce((select sum(steps) from public.imu_samples i where i.device_id = ps.device_id), 0),
       reps_total  = coalesce((select count(*)  from public.reps r where r.device_id = ps.device_id), 0),
       updated_at  = now();
```

### 进化动画

`PetAvatar.vue` 用 `phase` 状态机（`idle → shake → flash → reveal → jump`）跑四段编舞，
换图时机放在白光最亮处（800ms），避免硬切。只有 `stage` **变大**才触发（Lv1→2、Lv3→4）。

### 已知限制

1. `add_bonus_exp` 对 anon 开放，方便答辩手动推进等级——**正式上线应改成需要鉴权**。
2. 目前是单设备模型（`VITE_DEVICE_ID`），多用户需要接 Supabase Auth 把 `device_id` 绑到 `auth.uid()`。
3. 饥饿度衰减是在读取时按 `hunger_at` 时间差算的，没有后台定时任务，所以**不打开页面也不会"饿死"**（只在读数时结算）。

## 里程碑成就上链（SBT，Sepolia）

`contracts/SmartFitAchievement.sol` —— 运动里程碑成就，Soulbound（一人一枚、不可转让）。

**v2：数据由后端 EIP-712 签名担保，浏览器改不了。**

### 为什么必须有签名（v1 的问题）

v1 的 `exp / steps` 是浏览器传进合约的，改个数字就能拿"Lv5 成就"。
v2 要求这些数据由**后端签名**，签名里绑定 `to / exp / steps / level / nonce / deadline`：

```
浏览器 ──(地址, nonce)──▶ 签名服务 ──(读 pet_state)──▶ 数据库
                              │
                              └── EIP-712 签名 ──▶ 浏览器 ──(mint + 签名)──▶ 合约
                                                                    │
                                                        ecrecover == signer ?
```

浏览器只能"转交"签名，不能伪造内容 —— 改任何一个字段，`ecrecover` 出来的地址就变了。

### 合约设计

| 项 | 做法 |
| --- | --- |
| 标准 | ERC721 只读子集 + EIP-5192（`locked()` / `Locked` 事件） |
| 依赖 | **零依赖**，自包含；Remix 直接粘贴即可编译 |
| 验签 | `ecrecover` + EIP-712 domain（name/version/chainId/verifyingContract） |
| 防重放 | 每人自增 `nonce`（签名里绑定，用完即失效） |
| 防过期 | `deadline`（签名服务默认给 10 分钟） |
| 防锻造 | `s <= secp256k1n/2`、`v ∈ {27,28}` 检查 |
| 铸造门槛 | `exp ≥ 300` 或 `steps ≥ 5000`，一人一枚 |
| 数据校验 | 等级必须与经验区间吻合（阈值同 `petRules.ts`） |
| 元数据 | 完全上链：`tokenURI` 拼 base64 JSON + 内联 SVG |
| 编译产物 | **8424 bytes**（EIP-170 上限 24576） |

编译（改完合约后跑一次，会同时刷新前端 ABI）：

```bash
cd contracts && npm install && npm run compile
```

### 签名服务（`server/`）

零框架，只用 `node:http` + `ethers` + `pg`，100 多行。

```bash
cd server
npm install
cp .env.example .env        # 填 SIGNER_PRIVATE_KEY / SUPABASE_DB_URL / CONTRACT_ADDRESS
npm start                   # http://127.0.0.1:8787
```

接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 返回签名者地址、合约、门槛，前端可用来探活 |
| POST | `/sign` | body `{ to, nonce }` → 返回签名 + 服务端计算出的 exp/steps/level |

**关键点：请求体里没有 exp/steps**。服务端自己去 `pet_state` 查，所以浏览器没有篡改面。

生成一个测试网专用私钥：

```bash
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
```

把这个私钥对应的**地址**填进 Remix 部署时的构造参数 `initialSigner`。

集成测试（会自动起服务、签名、用 `verifyTypedData` 反解、并验证篡改后还原出不同地址）：

```bash
cd server
SUPABASE_DB_URL=postgresql://... npm run test:sign
```

![](https://img.shields.io/badge/-无需浏览器-important) 这个测试不需要钱包、不需要链，纯粹验证 EIP-712 实现自洽。

### 部署（二选一）

**A. Remix（最快，适合答辩前临时部署）**

1. 打开 <https://remix.ethereum.org>，新建 `SmartFitAchievement.sol`，粘贴源码
2. Compiler 选 `0.8.24+`，勾上 Enable optimization（runs 200）
3. Deploy & Run → Environment 选 **Injected Provider - MetaMask**
4. 网络切到 **Sepolia**（Chain ID `11155111`）
5. Deploy 时构造参数 `initialSigner` 填**签名服务的地址**（`npm start` 启动日志里那行 `signer address`）
6. 复制合约地址，填进 `web/.env` 的 `VITE_ACHIEVEMENT_CONTRACT`，并同步到 `server/.env` 的 `CONTRACT_ADDRESS`
7. 重启签名服务（它启动时会把合约地址打进日志，方便核对）

Sepolia 测试 ETH 水龙头：<https://sepoliafaucet.com> 或 <https://faucet.quicknode.com/ethereum/sepolia>

**B. Hardhat（要写脚本/测试时用）**

```bash
cd contracts
npm i -D hardhat
npx hardhat init            # 选 "Create a JS project"
# 把 SmartFitAchievement.sol 放到 contracts/ 下
npx hardhat compile
# 在 hardhat.config.js 里配 sepolia 网络 + PRIVATE_KEY（测试网私钥，别用真钱钱包）
npx hardhat run scripts/deploy.js --network sepolia
```

> 注意：本项目自带的 `npm run compile` 用 `solc` 直编，不依赖 Hardhat；
> 只有需要"自动化部署 + 单元测试"时才需要上 Hardhat。

### 前端交互

`web/src/features/chain/`：

| 文件 | 作用 |
| --- | --- |
| `achievementAbi.ts` | 编译自动生成，勿手改 |
| `useAchievementMint.ts` | 连钱包 / 切网络 / mint / 解析回执与自定义错误 |

技术选型：**ethers v6 直连 `window.ethereum`**，不用 wagmi（wagmi 是 React hooks 生态，Vue 要再包一层）。

流程：

```
连接钱包 (eth_requestAccounts)
  → 检查 chainId，不是 Sepolia 就 wallet_switchEthereumChain（未添加则 addEthereumChain）
  → 读 balanceOf 判断是否已领取
  → mint(exp, steps, level) → 等回执 → 解析 AchievementMinted 事件拿 tokenId
```

错误都做了人话映射：用户取消（4001）、余额不足、`AlreadyMinted`、`NotEligible`、
`LevelExpMismatch`（用 `interface.parseError` 解自定义错误）。

### ⚠️ 已知限制（答辩要主动讲）

1. **签名服务本身没有鉴权**。谁都能请求签名（只要数据达标），所以部署到公网前必须加
   鉴权（例如要求 Supabase 登录态）+ 限流。目前只监听 `127.0.0.1`，是本地演示形态。
2. **私钥在环境变量里**。测试网够用；生产应该用 KMS / 硬件钱包，且 signer 地址可轮换
   （合约里有 `setSigner`，仅 owner 可调）。
3. **nonce 由前端提供**（签名里绑定、链上校验）。这本身安全 —— 前端只能选 nonce，
   改不了 exp/steps —— 但如果想彻底消除前端参与，可以让签名服务直接读链上 nonce。
4. 一人一枚（`balanceOf == 0`），适合成就场景；要多个成就需改成按类型分发 tokenId。
5. 元数据完全上链，所以**改样式要重新部署**（不可升级）。

## 毕设答辩演示指南（Demo Script）

> 这份文档是答辩现场的**底稿**：按时间轴说明"做什么 / 说什么 / 看什么"，
> 后面附高频问题与标准答法、以及翻车预案。

### 0. 答辩前 30 分钟检查清单

| # | 检查项 | 命令 / 操作 | 预期 |
| --- | --- | --- | --- |
| 1 | 手表已烧录且能上电 | 插 USB 看串口 | `蓝牙准备就绪，设备名 "ESP32_Fitness_Watch"` |
| 2 | 手机装了 App、权限已给 | 打开 App | 状态变「已连接」 |
| 3 | Supabase 可写 | `npm run verify:db` | `VERIFY: PASS` |
| 4 | Web 看板可访问 | `cd web && npm run dev` | <http://localhost:5199> |
| 5 | 系统代理已关（或已放行 `*.supabase.co`） | 设置 → 网络 → 代理 | 看板右上角「实时在线」 |
| 6 | 签名服务已启动 | `cd server && npm start` | 日志打印 `signer address` 与部署时一致 |
| 7 | MetaMask 在 Sepolia、有测试币 | 钱包切网络 | 余额 > 0 |
| 8 | 宠物已达标 | 看宠物页 | 经验 ≥ 300 或步数 ≥ 5000 |

> 第 8 项没达标也不要紧：点两次「调试 · 奖励经验 +100」即可，**并且要说明这是调试按钮**。

### 1. 时间线（约 8 分钟）

#### ① 00:00–00:40｜一句话讲清系统

**说**：
> "这是一个基于 ESP32 可穿戴设备的多模态健身记录与数字生命养成系统。
> 手表采集六轴数据并做窗口计步，手机作为网关做本地缓存与批量同步，
> 云端做数据与规则，Web 端做实时看板、视觉深蹲识别和宠物养成，
> 最后把运动里程碑铸造成**链上不可转让的成就（SBT）**。"

**板书/PPT 只放一张图**：手表 → 手机 → Supabase → Web → 链。

#### ② 00:40–01:40｜手表层：为什么是 25Hz + 5 秒窗口

**操作**：手表上电，插串口。

**看**：`[WIN] n=125 std=0.00x steps=0 len=21`

**说**：
> "采样 25Hz，因为计步必须看波形；上报是 5 秒一包，因为手机端会批量同步，没必要高频。
> 每包 21 字节，卡在默认 BLE MTU 20 字节的边缘 —— 这是有意的取舍，
> 所以手机端会主动协商 MTU 到 185，解析器也会严格校验、截断包直接丢弃。"
>
> "这里有个实测发现：I2C 我一开始按 47/48 接，扫不到设备；
> 用总线扫描确认真实是 **SDA=15 / SCL=14**，地址 0x6B，总线上还有 6 个其他器件。"

**加分点**：说明"用扫描而不是猜"的工程方法。

#### ③ 01:40–02:40｜APP 层：分层同步与不丢数据

**操作**：打开手机 App，等「已连接」。

**看**：收包计数增长、`待上传/已上传`、`上次同步`。

**说**：
> "手机端不是收到就上传，而是先落本地队列（分块持久化，进程被杀也不丢），
> 每 15 分钟批量写云端，也可以手动立即同步 —— 这就是小米手环的分层思路。"
>
> "不丢数据靠三层：手表给序号 seq 让我能发现丢包；本地队列**先写库成功才删缓存**；
> 每条数据带幂等键 `设备:会话:序号`，云端唯一约束兜底，重试不会写重复行。"

**演示**：点「立即同步」→ 待上传清零。

#### ④ 02:40–03:40｜云端：为什么用 RPC + 生成列

**操作**：切到 Supabase 控制台 `imu_samples` 表，展示刚落库的行。

**说**：
> "写入没有直接用 PostgREST 的 upsert，因为实测它会生成 `ON CONFLICT DO UPDATE`，
> 要求 UPDATE 策略 —— 给匿名角色开 UPDATE 等于允许篡改历史。
> 所以改成一个 `SECURITY DEFINER` 的 RPC 做 `DO NOTHING`，逐行容错。"
>
> "经验值特意做成**生成列**：`floor(310/100)*10=30`，
> 但如果按包累加是 `floor(250/100)+floor(60/100)` 只有 20 —— 拆包就会少算。"
> （顺手展示 `verify-db` 的对账检查：`pet_state` 与源表必须一致。）

#### ⑤ 03:40–04:40｜Web 实时看板

**操作**：切到浏览器「实时数据」Tab，拿着手表走动。

**看**：曲线滚动、步数跳动、右上角「实时在线」。

**说**：
> "这条链路是 手表 → BLE → 手机 → Supabase → **Realtime(WebSocket)** → 浏览器，
> 中间没有任何手动刷新。"
>
> "为什么不用手机直接开 WebSocket 服务？手机在 NAT 后面没有公网 IP，
> 小程序/uni-app 运行时也起不了服务端。所以让 Supabase 的 Realtime 承担这一段，
> 对页面来说效果完全一样。"

#### ⑥ 04:40–05:50｜视觉深蹲识别（可选但很出彩）

**操作**：切「深蹲识别」，站到引导框里做 5 个深蹲。

**看**：骨架、膝角、状态机（站立→下蹲中→蹲底→起身中）、计数、**框变绿**。

**说**：
> "判定是纯函数状态机：膝关节角 ≥160° 站立、≤100° 蹲底，中间 60° 死区防抖，
> 一次动作至少 0.6 秒，而且**必须真的到过蹲底**，浅蹲不算。"
>
> "有个关键保护：腿不在画面里时，MediaPipe 仍会外推膝踝点、膝角照样算得出来。
> 我实测录屏里就出现过 87° 的假数据，所以加了**几何合理性校验 + 人体引导框**，
> 取景不合格直接拒绝计数。"
>
> "算法有 25 条单测。举两个：站在阈值附近抖动 30 次不会刷数；
> 动作小于 0.6 秒不计。还有个实测 bug：人走开两分钟回来，被算成一次 126 秒的深蹲 ——
> 现在超过 8 秒直接作废。"

#### ⑦ 05:50–07:00｜宠物养成（数据闭环）

**操作**：
1. 切「我的宠物」→ 展示等级、经验、饱食度
2. 点「喂食」→ 食物 −1、饱食度 +20、换表情
3. （可选）回深蹲页做几个 → 回宠物页看经验涨

**说**：
> "宠物状态存在云端 `pet_state`，步数和深蹲由数据库触发器累加，
> 所以**刷新页面、换浏览器都不会丢**。"
>
> "注意这里的'深蹲联动'不是前端算的：深蹲记录写进 `reps` 表 → 触发器 →
> `pet_state` → Realtime 推回页面。"
>
> "调试面板里有几个按钮，我标记了 `⚙ 调试`：奖励经验只写 bonus_exp，
> **不会修改步数和深蹲记录**，所以成就里的运动数据仍然是真实的。"

#### ⑧ 07:00–08:00｜上链：里程碑成就 SBT

**操作**：点「上链铭刻」→ MetaMask 确认 → 等回执 → 显示 `已领取 #N`。

**说**：
> "这是 Soulbound Token：一人一枚、不可转让，`transferFrom` 直接 revert。
> 元数据完全在链上，`tokenURI` 里拼的是 base64 的 JSON + SVG，不依赖 IPFS。"
>
> "关键设计是**数据可信性**：如果让浏览器传 exp/steps，改个数字就能拿 Lv5 成就。
> 所以做了 EIP-712：浏览器只能发'我是谁 + 我要第几次签名'，
> 经验/步数/等级由**后端从数据库读出来再签**，合约里 `ecrecover` 校验。
> 签名里绑定 `to`（防冒用）、`nonce`（防重放）、`deadline`（防过期）。"

**收尾一句**：
> "整条链路的核心不是某一个技术点，而是**每一层都为下一层兜底**：
> 手表有 seq、手机有持久队列、云端有唯一约束和 RPC、链上有签名。"

### 2. 高频问题与标准答法

#### 数据可靠性

**Q：数据怎么保证不丢？**
A：三层。① 手表给 `seq` 序号，手机能发现丢包；② 手机端分块持久化队列，**先写库成功才删缓存**，进程被杀也不丢；③ 云端 `client_key` 唯一约束 + `ON CONFLICT DO NOTHING`，重试不会写重复行。缓存上限 6 万条（约 3.5 天），超出会丢最旧并在界面提示。实测真机 41 包、丢包 0。

**Q：断网了怎么办？**
A：数据在手机本地排队，网络恢复自动补推（`onNetworkStatusChange` 触发）。所以断网只会延迟，不会丢。

**Q：重复上传会不会重复记步数？**
A：不会。幂等键是 `设备:上电会话:包序号`，云端唯一约束挡重复。而且经验是按**累计量**派生的（生成列），不是"每来一包加一次"，所以拆包、重放都不会放大。

**Q：为什么经验要用生成列？**
A：因为 `floor(total/100)` 不可加。实测：250 步 + 60 步 = 310 步应为 30 经验；按包累加只有 20。生成列从累计量直接算，从根上消除这个问题。

#### 算法

**Q：步数是怎么算的？**
A：25Hz 采样合模量 → EMA 估计重力基线并减去 → 带滞回的上穿/下穿检测（+0.12g / −0.06g）→ 250ms 不应期 → 5 秒窗口内计数。用合成信号做过回归：1.8Hz/0.35g 走 10 秒正好 18 步，静置 0 步，微振 0 步。

**Q：深蹲误判怎么处理？**
A：双阈值（160°/100°）+ 0.6 秒冷却 + 髋膝踝可见度门控 + 几何合理性校验（贴边/膝不在髋踝之间/腿跨度太短都拒算）+ 画面里的引导框。单测覆盖"阈值附近抖动 30 次"和"动作过快"。

**Q：为什么不用动作分类模型？**
A：关节角 + 状态机**可解释、可调参、能单测**，出错时能指着某个阈值说原因；分类模型需要标注数据，且答辩时说不清"为什么这次没数"。MediaPipe 本身是回归关键点，动作语义留给业务层。

#### 架构

**Q：为什么不直接用 Web Bluetooth？**
A：iOS Safari 完全不支持；Web Bluetooth 还要求 HTTPS 或 localhost，局域网 IP 打开的页面直接拿不到 API。所以改成"手机 App 做网关"，这也是小米手环这类产品的实际做法。

**Q：怎么绕开校园网？**
A：手机做网关走蜂窝或热点；云端只依赖 HTTPS / WSS，不依赖校园网的内网穿透。电脑端如果被代理拦截，把 `*.supabase.co` 放行即可（我实测过系统代理会把 TLS 连接掐断）。

**Q：为什么用 Supabase Realtime 而不是自己写 WebSocket？**
A：手机没有公网 IP，起不了 WS 服务端；而且 `https` 页面连 `ws://内网IP` 会被混合内容策略拦。Supabase Realtime 本身就是 WSS，语义等价。**坑**：表必须 `replica identity full`，否则 UPDATE 事件不推送且**不报错**（我实测踩到过，看板会停在第一帧）。

#### 链

**Q：为什么用 EIP-712，不用 `personal_sign`？**
A：三点。① 结构化，钱包里能看到各字段，用户知道自己在签什么；② domain 绑定 `chainId` + `verifyingContract`，防止跨链/跨合约重放；③ 字段被密码学绑定，改任一处 `ecrecover` 出来的地址就变了（我用 `verifyTypedData` 实测验证过）。

**Q：nonce 是干什么的？**
A：防重放。签名里绑定当前 nonce，合约校验后 `nonce+1`，同一份签名只能用一次。

**Q：为什么是 SBT 不是普通 NFT？**
A：成就不该能卖。转移和授权函数直接 revert，并实现 EIP-5192 的 `locked()` 与 `Locked` 事件，钱包和浏览器能识别"不可转让"。

**Q：一人一枚够用吗？**
A：毕设场景够。扩展方案是按成就类型发不同 tokenId（`keccak(设备, 里程碑ID)` 派生），或改成 ERC-1155 多份。

**Q：测试网算区块链吗？**
A：合约与 EVM 完全一致，主网只是 `chainId` 不同。用测试网是为了**可复现、零成本**，答辩现场也能真的点一次。

**Q：上链的数据能改吗？**
A：不能。合约没有升级代理，元数据（等级/经验/步数/时间）在链上只写一次。

#### 工程与测试

**Q：触发器会不会有性能问题？**
A：一次批量插入 500 行会触发 500 次 upsert，实测可忽略。要优化可以换成语句级触发器（`REFERENCING NEW TABLE`）一次聚合。

**Q：测试覆盖到什么程度？**
A：Web 端 38 条单测（深蹲 25 + 宠物 13）、App 端 20 条，共 **58 条**；另有类型检查、SFC 编译检查、workflow 语法检查、以及**云端 schema 16 项校验**（含"pet_state 与源表对账"）。签名服务有独立集成测试，会验证"篡改 exp 后还原出不同地址"。

**Q：你的创新点是什么？**
A：① **多模态**：IMU 计步 + 视觉深蹲，两条数据流在宠物经验上汇合；② **分层同步**：手表/手机/云端各司其职，断网可用；③ **数据可信性**：EIP-712 让链上成就的数据真的来自数据库，而不是浏览器自报；④ **养成闭环**：运动量直接驱动数字生命形态，而不是单纯的数字记录。

**Q：最难的地方？**
A：不是写功能，是**排查那些"看起来正常"的错误**。举三个实测案例：① 没接串口时 `Serial.printf` 阻塞把 BLE 循环拖死，只发 2 包就断；② 深蹲界面算得挺顺，但录屏一看腿根本没在画面里，87° 是模型外推的假数据；③ 数据库回填时 `reps` 里还有测试行，`pet_state` 多算 1 个深蹲，之后源数据删了却不会回退 —— 所以我加了"对账"检查。

### 3. 翻车预案

| 现场故障 | 立刻做什么 | 兜底说法 |
| --- | --- | --- |
| 摄像头打不开 / 画面暗 | 切「上传视频分析」，用事前录的视频 | "实时识别对环境有要求，我准备了离线视频模式" |
| 看板「连接异常」 | 关系统代理，刷新 | "本机代理拦截了 Supabase 的连接，这是环境问题" |
| 看板「在线」但数字不动 | 检查 `replica identity full`（已修） | 直接讲这个坑，反而是加分项 |
| 签名服务没起 | `cd server && npm start` | 提示会明确说"确认签名服务已启动" |
| MetaMask 网络不对 | 点按钮会自动 `wallet_switchEthereumChain` | — |
| 余额不足 | 提前领水龙头；或只讲已完成的交易 | "链上部分我留了 Sepolia 交易记录" |
| Web 端白屏 / 模块报错 | 清 `node_modules/.vite` 重启 dev server | "Vite 的模块缓存脏了，重启即可" |
| 手机连不上手表 | 系统蓝牙里"取消配对"，关掉其他 BLE App | 系统配对会占用连接 |
| 演示时间被压缩到 3 分钟 | 只走 ②③⑤⑧（手表 → App → 看板 → 上链） | 保留"每层兜底"这条主线 |

### 4. 一句话总结（结尾用）

> "这套系统把'一次运动'从传感器采样、到手机缓存、到云端规则、到链上成就，
> 完整走通了一遍。它的价值不在于用了多少技术，而在于**每一层都考虑了数据不丢、不可伪造**。"

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

**⑤′ 切到「深蹲识别」Tab**（可选，30s）

在笔记本前做 3~5 个深蹲，页面实时显示骨架、膝角、状态与计数。
如果现场光线或摄像头不给力，**立刻切「上传视频分析」**，用事先录好的视频兜底。

**⑤″ 切到「我的宠物」Tab**（40s，宠物链路演示）

1. 先说数据来源：步数/深蹲由数据库触发器累加进 `pet_state`，**刷新不丢**
2. 点 **「喂食（消耗 1 食物）」** → 食物 −1、饱食度 +20、宠物换成"比心心"表情
   - 食物不够时按钮是灰的，并提示"多走走或做几个深蹲吧"（这个失败态也是设计的一部分）
3. **深蹲联动**：回「深蹲识别」做几个深蹲 → 回到宠物页，`深蹲` 计数与经验会涨
   （`reps` 表写入 → 触发器 → `pet_state` → Realtime → 页面自动更新，全程不用刷新）
4. 点调试面板的 **「奖励经验 +100」** 可以立刻看进化动画（震动 → 白光 → 换形态 → 跳跃）
5. 强调：**刷新页面，等级和经验全都还在**

**⑤‴ 上链铭刻**（可选，需先部署合约）

宠物经验 ≥300 或累计步数 ≥5000 后，"上链铭刻"按钮解锁。
点它 → MetaMask 确认 → 交易上 Sepolia → 页面显示 tokenId 与 Etherscan 链接。
细节见下方「里程碑成就上链」。

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
│  ├─ src/App.vue                 Tab 外壳：实时数据 / 深蹲识别
│  ├─ src/components/LiveChart.vue ECharts 薄封装（按需引入）
│  ├─ src/composables/useDeviceLatest.ts  Realtime 订阅 + 去重 + 滚动缓冲
│  ├─ src/features/squat/         深蹲识别
│  │  ├─ squatCounter.ts          状态机（纯函数）
│  │  ├─ poseMath.ts              膝角计算 + 左右侧选择（纯函数）
│  │  ├─ usePoseLandmarker.ts     MediaPipe 加载/推理（同源、GPU→CPU 兜底）
│  │  ├─ drawSkeleton.ts          骨架绘制
│  │  ├─ repsSync.ts              写 reps 表（23505 视为成功）
│  │  └─ SquatView.vue            摄像头/视频双模式 UI
│  ├─ public/models/              pose_landmarker_lite.task（入库）
│  ├─ public/wasm/                MediaPipe wasm（脚本生成，不入库）
│  ├─ tests/squatCounter.test.cjs 16 条算法单测
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
npm run dev        # http://localhost:5199（自动准备 wasm/模型）
npm run typecheck  # vue-tsc
npm test           # 深蹲算法 16 条单测
npm run build      # 产物 web/dist
```
