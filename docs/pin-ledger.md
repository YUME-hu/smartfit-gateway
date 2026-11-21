# 引脚与总线台账（M0a 交付）

> 版本 v1（2026-11-21）｜对应 `research-notes.md` §7 M0a 第 3 项
> 数值来源：官方板级仓库的 `pin_config.h` + 8 个 Arduino 例程里写死的引脚（见 §1），**不是猜的**。
> 空白单元格 = 需要拿板子实测（M0b），不填猜测值。

---

## 0. M0a 收尾状态

| # | M0a 任务 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 固件唯一源 | ✅ 完成 | 两份树 7/7 文件 SHA256 完全一致；仓库根确认为 `app-gateway/`（`git status` 干净）；工作区根那份游离副本已删除 |
| 2 | 文档-代码对齐（3 处） | ✅ 完成 | README 目录树"16 条单测"→"条数见 npm test"；README"手表无 RTC"→如实描述；`watch_ble.ino` 注释 5s→40ms。改后 `npm run verify` exit 0（20/20） |
| 3 | 引脚/总线台账模板 | ✅ 本文 | — |
| 4 | 下单同款 2.06 备用板 | ⬜ **待你点** | 不要买 1.75C（触摸芯片 CST9217 ≠ FT3168） |

> 待办：改动尚未 commit（`M README.md`、`M firmware/watch_ble/watch_ble.ino`），要提交说一声。

---

## 1. 数据来源与一个必须先解决的漂移

本机上有**两个**官方副本：

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `C:\Users\hubin\Downloads\ESP32-S3-Touch-AMOLED-2.06-main\` | 官方仓库快照：`hardware/schematic/*.pdf`、`examples/{arduino,esp-idf,factory}` | **权威源**，含 8 个 Arduino 例程与随附库（Arduino_GFX / lvgl 9 / SensorLib / XPowersLib / Arduino_DriveBus） |
| `C:\Users\hubin\Documents\Arduino\libraries\board_config\pin_config.h` | 已装进 Arduino 的库 | 内容与上面**不完全一致** |

⚠️ **两份 `pin_config.h` 的 SD 宏名不同**：仓库版是 `SDMMC_CLK/CMD/DATA/CS`，Arduino 库版是 `WS_SDMMC_CLK/...`（引脚号相同）。`07_LVGL_SD_Test` 用的是仓库版名字。→ **建议统一以官方仓库版为准**，把 Arduino 库那份覆盖掉，否则以后拷例程会编译不过。

---

## 2. GPIO 占用表

| 功能 | 信号 | GPIO | 来源 | 备注 |
| --- | --- | --- | --- | --- |
| AMOLED (CO5300) | QSPI SDIO0 | 4 | pin_config.h | 410×502，col_offset1 = **22** |
| | QSPI SDIO1 | 5 | pin_config.h | |
| | QSPI SDIO2 | 6 | pin_config.h | |
| | QSPI SDIO3 | 7 | pin_config.h | |
| | QSPI SCLK | 11 | pin_config.h | |
| | QSPI CS | 12 | pin_config.h | |
| | RESET | 8 | pin_config.h | 与触摸 RST(9) 相邻，注意上电顺序 |
| | TE | — | 例程未使用 | 若做 TE 帧同步需从原理图确认 |
| 触摸 FT3168 | I2C 地址 0x38 | — | 例程 | 走共享 I2C |
| | INT | 38 | pin_config.h | |
| | RESET | 9 | pin_config.h | |
| 共享 I2C | SDA | **15** | pin_config.h | 400kHz；固件现用 |
| | SCL | **14** | pin_config.h | 固件现用 |
| | （备选 47/48） | 47/48 | 需求文档 | ⚠️ **板上未接**，固件探测失败才会去试；QMI8658 已证实在 15/14 |
| RTC PCF85063 | 0x51（I2C） | — | 例程 03 | 无独立 GPIO；有 OS 标志可判断电 |
| PMU AXP2101 | 0x34（I2C） | — | 例程 05 | 有 IRQ 引脚但例程未用 |
| 音频 ES8311 | 控制口 0x18（I2C） | — | 例程 08 | |
| | I2S BCLK | **41** | 例程 08 `setPins(41,45,40,42,16)` | |
| | I2S WS/LRCK | **45** | 同上 | ⚠️ 45 是 ESP32-S3 strapping 引脚（VDD_SPI 电压选择） |
| | I2S DOUT（表→codec） | **40** | 同上 | |
| | I2S DIN（codec→表，麦克风） | **42** | 同上 | |
| | I2S MCLK | **16** | 同上 | MCLK = 采样率×256 |
| | 功放使能 PA | **46** | 例程 08 `pinMode(46, OUTPUT)` | ⚠️ 46 是 strapping 引脚；官方例程即如此使用 |
| Micro SD | SDMMC CLK | 2 | pin_config.h | 例程用 1-bit 模式 |
| | SDMMC CMD | 1 | pin_config.h | |
| | SDMMC DATA | 3 | pin_config.h | |
| | SDMMC CS | 17 | pin_config.h | 1-bit 模式下用途待确认 |
| USB | D-/D+ | 19/20 | ESP32-S3 固定 | 烧录 + USB CDC 日志 |

**结论：显示 / 触摸 / 音频 / SD 之间没有引脚冲突**，全部可以共存于一块板。真正要留意的是 **45 和 46 两个 strapping 引脚**（见 §5）。

---

## 3. I2C 地址表（与固件启动扫描对照）

| 地址 | 器件 | 当前固件 | 第二阶段用途 |
| --- | --- | --- | --- |
| 0x6B | QMI8658 IMU | ✅ 在用 | 不变 |
| 0x51 | PCF85063 RTC | ❌ 未初始化 | M2 对时 + `device_ts` |
| 0x34 | AXP2101 PMU | ❌ 未用 | M1b 电量显示 / M4b 功耗 |
| 0x38 | FT3168 触摸 | ❌ 未用 | M1b 翻页 |
| 0x18 | ES8311 DAC | ❌ 未用 | M6 提示音 |
| 0x40 | ES7210 麦克风 ADC | ❌ 未用 | （音频输入，暂不做） |
| 0x7E | ❓ 待确认 | — | M0b 扫一遍确认是什么 |

---

## 4. 内存预算表（M0b 填实测值，先给算法）

| 项 | 算法 | 估算 | 放哪 |
| --- | --- | --- | --- |
| 全屏帧缓冲（DIRECT 模式） | 410 × 502 × 2 B | **402 KB** | PSRAM（内部 RAM 装不下，官方例程先试 INTERNAL 再回落） |
| 部分缓冲（PARTIAL，50 行） | 410 × 50 × 2 B | **41 KB** | 可进内部 RAM |
| LVGL 对象/样式堆 | — | 待实测 | 内部 RAM |
| 手表侧环形缓冲（M2.5） | 12 B × 17280 窗口 | **≈ 200 KB** | PSRAM |
| 音频缓冲 | 16kHz × 16bit × 声道 × 缓冲时长 | 待定 | 内部 RAM |
| PSRAM 总量 | — | 8192 KB（八线） | 余量充足 |

> **一条直接影响 M1a 的设计建议**：官方例程默认 `DIRECT_RENDER_MODE`（整帧 402KB，每帧全量 `draw16bitRGBBitmap`，loop 里还带 `delay(5)`）。M1a 要"保采样"，应改用例程里已有的 **PARTIAL 分支（`bufSize = screenWidth * 50`，41KB，只刷脏区）**——每帧搬运量降一个数量级，是保住 25Hz 采样最省力的手段。帧时间实测值填这一格。

---

## 5. 已知坑（从官方例程里读出来的，不是推测）

1. **`col_offset1 = 22`**：`Arduino_CO5300` 初始化必须带这个参数，否则画面整体左偏。
2. **触摸库不是 SensorLib**：用的是 `Arduino_DriveBus` 的 `Arduino_FT3x68`，且必须把 `TOUCH_POWER_MODE` 设成 `TOUCH_POWER_MONITOR` 才能拿到中断。
3. **例程的 `loop()` 结构本身就阻塞**：`lv_task_handler()` + 全屏 `draw16bitRGBBitmap()` + `delay(5)` → 上限 20fps，且期间不喂采样。**M1a 的任务分离是必须做的，不是优化项。**
4. **日志口用的是 `HWCDC USBSerial`**（USB CDC），跟我们现在 `Serial.setTxTimeoutMs(0)` 踩的是同一类坑：没有主机读串口时会阻塞。
5. **45 / 46 是 strapping 引脚**：45 被当 I2S WS、46 被当功放使能。官方例程这么用说明基本可行，但 M0b 上电时要确认启动模式没被影响（尤其 46 上电瞬间的电平）。
6. **`#ifdef DEV_DEVICE_INIT` / `DEV_DEVICE_INIT()`**：部分板子需要先做电源初始化再点屏。

---

## 6. M0b 三个探针的可执行写法

### 6.1 RTC 是否断电保时（决定 M4b 漂移实验口径）

不用"看秒数还在不在跳"，SensorLib 直接暴露了 PCF85063 的 **OS（振荡器停振）标志**：

```cpp
#include "SensorPCF85063.hpp"
SensorPCF85063 rtc;
rtc.begin(Wire, 15, 14);                       // 复用共享 I2C
bool ok = rtc.isClockIntegrityGuaranteed();    // 实现: SEC 寄存器 bit7 == 0
```

流程：`rtc.setDateTime(...)` 对时 → **断电 10 分钟** → 上电 → 读 `isClockIntegrityGuaranteed()`。

- `true` → 有备份电源，断电保时成立 → M4b 用"断电 24h 漂移"
- `false` → 无备份/电池耗尽 → M4b 只能测"上电期间漂移（对时后 8h）"，并在论文里写明口径

### 6.2 AXP2101 读电量（M1b 电量显示的前置）

```cpp
#include <XPowersLib.h>
XPowersPMU power;
Wire.begin(15, 14);                                  // 先起总线
power.init(Wire, 15, 14, AXP2101_SLAVE_ADDRESS);     // 显式 init（见下方坑）
power.enableBattDetection();
power.enableBattVoltageMeasure();
power.getBattVoltage();      // uint16_t，mV
power.getBatteryPercent();   // int，%
power.isBatteryConnect();    // bool
```

> **坑**：官方例程 05 **没有调用 `init()`**，只是 `XPowersPMU power;` 然后直接 `enableBattVoltageMeasure()`。
> 它能跑通是因为它在此之前已经 `Wire.begin(IIC_SDA, IIC_SCL)`，而 `enable*()` 只是普通寄存器写；
> 我们自己的固件必须显式 `init(Wire, 15, 14)`，否则用的是默认引脚（不是 15/14）。
> M1b 验收要求"与万用表误差 < 5%"，所以还要拿万用表标一次电压。

### 6.3 LVGL 点亮（M0b 的 1.5 天 spike）

**直接跑 `examples/arduino/examples/06_LVGL_Arduino_v9`**，不要再从零移植。它已经包含：Arduino_ESP32QSPI + Arduino_CO5300 + LVGL 9 tick/flush + FT3168 输入 + `lv_demo_widgets()`。spike 只需要在它上面加两件事：① 把 `DIRECT_RENDER_MODE` 换成 PARTIAL；② 在 loop 里插入 25Hz 采样 + `samples/expected` 计数。

> 这条把 M0b 的最大不确定性砍掉了一大半：**LVGL 9 在本板的可用性已经有官方例程背书**，spike 的性质从"能不能跑"变成"跑得够不够快"。

---

## 7. 待 M0b / M1b 实测确认

- [ ] 0x7E 是什么器件
- [x] RTC 是否接 VBAT → **见 §9.3：OS 标志已读出为 1（停振过），但需受控测试才能下结论**
- [ ] 45/46 strapping 引脚对上电/下载的实际影响（本次烧录/复位均正常，未观察到异常）
- [ ] SD 是 1-bit 还是 4-bit 可用（例程用 1-bit；4-bit 需 DATA1/2 引脚，pin_config.h 未给）
- [x] 单帧渲染时间 → **见 §9.2：全帧 53.7ms / 50 行条带 5.4ms**
- [x] `heap_caps_malloc(402KB, MALLOC_CAP_SPIRAM)` → **OK（见 §9.2）**

---

## 8. 构建与烧录（已在本机跑通，2026-11-21）

工具链是**新装的 arduino-cli**，复用已装的 ESP32 core 3.3.12 和 `Documents\Arduino\libraries`：

| 项 | 值 |
| --- | --- |
| arduino-cli | `D:\vue school build\.tools\arduino-cli\arduino-cli.exe`（v1.6.0） |
| 配置 | `D:\vue school build\.tools\arduino-cli\arduino-cli.yaml`（data → `%LOCALAPPDATA%\Arduino15`，user → `Documents\Arduino`） |
| core | esp32 3.3.12 |
| 端口 | **COM3**（VID 303A / PID 1001，原生 USB-Serial-JTAG） |
| esptool | `%LOCALAPPDATA%\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe` |

**FQBN（已验证可编译 + 可烧录）**

```
esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=32M,PSRAM=opi,FlashMode=qio,PartitionScheme=huge_app,UploadSpeed=921600,CPUFreq=240
```

```powershell
$cli='D:\vue school build\.tools\arduino-cli\arduino-cli.exe'
$cfg='D:\vue school build\.tools\arduino-cli\arduino-cli.yaml'
$fqbn='esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=32M,PSRAM=opi,FlashMode=qio,PartitionScheme=huge_app,UploadSpeed=921600,CPUFreq=240'
& $cli --config-file $cfg compile --fqbn $fqbn --output-dir <out> <sketch_dir>
& $cli --config-file $cfg upload -p COM3 --fqbn $fqbn --input-dir <out> <sketch_dir>
```

**回滚**：`<out>\watch_ble.ino.bin` 已留在 `.tools\build\watch_ble\`，重烧一次即可回到第一阶段固件（约 15s）。

> 注意：`arduino-cli upload` 会一并写 bootloader + 分区表 + app，是自洽镜像；单写 app 分区在分区方案不一致时会起不来。

---

## 9. M0b 实测结果（2026-11-21，探针固件 `firmware/m0b_probe`）

### 9.1 点亮

`gfx->begin() = OK (410×502, col_offset1=22)`。`Arduino_ESP32QSPI` + `Arduino_CO5300` 在本板可用，**无需 ESP-IDF 迁移**。

### 9.2 推送耗时（关键数字）

| 方式 | 数据量 | 平均 | 结论 |
| --- | --- | --- | --- |
| 全帧 `draw16bitRGBBitmap` | 402 KB | **53.7 ms** | 上限约 18 fps，**不可用于表盘** |
| 50 行条带 | 41 KB | **5.4 ms** | 只刷脏区时每帧可压到 5–11 ms |

- 反推有效带宽 ≈ **7.7 MB/s**（两种方式一致）。QSPI 理论值远高于此 → 瓶颈很可能在**逐像素字节序转换**。
- **M1a 的设计结论**：必须走 PARTIAL 脏区刷新（LVGL 的 `LV_DISPLAY_RENDER_MODE_PARTIAL` + 50 行缓冲）。
- **待验证的优化**：改用 `draw16bitBeRGBBitmap` 或在 LVGL 侧做 `rgb565_swap`，绕开转换，可能有数倍提升 → 进 M1a 的任务清单。

### 9.3 RTC 断电保时（还没结论，别急着写进论文）

读数：`PCF85063 OK | 时钟完整(OS=0) = 否 | 正在走 = 是`

- `isClockIntegrityGuaranteed()` 读的是秒寄存器 bit7（OS，振荡器停振标志）。返回 false = **停振过**。
- 但**这不足以判定无备份电源**：这版固件从没写过 RTC，OS 位可能是出厂/很久以前某次断电留下的。
- 严格判定需要三步：**① 写时间（清 OS）→ ② 拔掉 USB 断电 10 分钟 → ③ 上电读 OS**。第 ② 步需人工。

### 9.4 采样共存（M1a 最大风险已消除）

| 相位 | 时长 | 采样/期望 | 丢点率 | 显示 |
| --- | --- | --- | --- | --- |
| A 只采样 | 60 s | 1499 / 1500 | **0.07%** | 关 |
| B 采样 + 全速刷屏 | 60 s | 1501 / 1500 | **−0.07%**（实为 0） | 开，1001 帧 ≈ 16.7 fps |

**双核任务分离（采样 core1 / 显示 core0 + I2C 互斥）在满速刷屏下零丢点** → M1a 的"保采样"方案成立，不用再为它预留降级时间。

> ⚠️ 指标口径的坑：`期望 = 经过时间 / 40ms` 用整数除法会少算（出现 −0.07% 的负丢点）。
> 正式实现要按浮点算，或取 `ceil`。这条要同步进 `docs/实验方案-M4a.md` §2.1。

### 9.5 电源：电池已接入（2026-11-21 晚补齐）

用户已装 3.7V 锂电。`power_probe` 实测：

```
[PMU] 电池=接入(4096mV,100%) VBUS=有(5082mV) 充电中=否
→ 数秒后：电池=接入(4204mV,100%) 充电中=是
[HEAP] 内部剩余=334596 B, PSRAM 剩余=8384596 B
```

- 电池被正确识别，插 USB 时开始充电。**M1b 电量显示、M4b 续航/功耗三项目前具备条件**（之前"无电池"的记录作废）。
- 内部 RAM 空闲 334KB、PSRAM 空闲 8.38MB（此时未分配帧缓冲）→ §4 的内存预算有充足余量。

### 9.6 电源路径实测（2026-11-21 22:48）

**测试 A 结论：✅ 电池供电正常** —— 拔掉 USB 后设备继续运行，没有重启。

判据是 NVS 持久化的启动计数（比串口可靠，原因见下）：

| 启动 # | 来源 |
| --- | --- |
| #1 | 烧录 power_probe v1 |
| #2 | 我的串口工具第一次连接（见下方 ⚠️） |
| #3 | 我的串口工具第二次连接 |
| #4 | 烧录 power_probe v2 |

用户测试 A 的时间窗（22:43:37–22:46:11）落在 #3 之前，#1–#4 全部有归属，**没有多余重启** → 拔 USB 期间系统持续运行。

> ⚠️ **方法论警告（很重要）**：ESP32-S3 的原生 USB-CDC 在**串口工具打开/关闭时会被 DTR/RTS 复位**。
> 也就是说"用串口观察是否重启"这个做法本身会造成重启（本次 #2、#3 就是这么来的）。
> 以后判断"断电后有没有重启"，必须看**屏幕上的 boot #** 或 NVS 计数，不能看串口日志有没有重打 banner。

### 9.6b "装电池不亮、插 USB 才亮"的定性解释

现象与上面数据拼起来是自洽的：

1. **装电池不会自动上电**（AXP2101 默认需要 VBUS 插入或按下 PWRKEY）
2. 插 USB → VBUS 上电 → 系统启动
3. 拔 USB → 电池无缝接管，继续运行 ✅（测试 A）

→ 结论：**从"完全关断"状态改用电池开机，需要短按电源键**；运行中切换供电不需要任何操作。

**还没验证的一项**：完全断电（拔电池）后，按电源键能否在纯电池下启动。这条留到 M1b 做按键处理时一起验（届时本来就要读 PWRKEY IRQ）。

→ 需要写进 README「必须知道的运行限制」：*装电池后不会自动开机，需短按电源键；演示时别误判为故障。*

### 9.7 RTC：OS 已清零，基线已建立

```
[RTC] 启动时：OS 标志=0(未停振，时间可信) | 走时=是
[RTC] 未停振：保留原有走时（用于漂移测量，不覆盖）
```

- 固件已改成**只在 OS=1（停振过）时才写时间**，否则保留原走时 —— 否则每次重启都覆盖时间，永远测不了漂移。
- **漂移基线（host 时钟 ↔ RTC 读数）**：`2026-11-21 22:48:57.9` ↔ `22:42:18`
  偏置 −399 s（因为中途被旧固件用硬编码时间覆盖过几次，偏置无意义）。
  **测漂移只需看速率**：取两个 (host, RTC) 样本，`漂移率 = (ΔRTC − Δhost) / Δhost`，与偏置无关。
  → 下一次读数与这条对比即可得出 ppm 级漂移。
- 待办：把硬编码的 `22:40:00` 改成 `__DATE__/__TIME__`（编译时注入），新板子上电即得准确时间。
- **测试 B（拆电池 10 分钟 → 看 OS 标志）仍未做**，做了才能定 M4b 用哪种漂移口径。

---

## 10. 探针固件一览（进仓库，供 M1a 复用）

| 固件 | 用途 | 状态 |
| --- | --- | --- |
| `firmware/watch_ble` | 第一阶段正式固件（BLE + 计步） | 已编译，回滚包在 `.tools\build\watch_ble` |
| `firmware/m0b_probe` | 显示推送耗时 + 采样共存 A/B（§9.1–9.4） | 已实测，结论已入档 |
| `firmware/power_probe` | 电源/电池/按键/RTC 诊断（§9.5–9.7），屏幕显示心跳 | 已烧录，等待两次物理验证 |
| `firmware/step_selftest` | 计步算法合成信号回归 | 第一阶段遗留 |


