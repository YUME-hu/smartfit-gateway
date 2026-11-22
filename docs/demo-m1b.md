# Demo 基线 M1b（2026-11-22）

> 这是第二阶段 **M1b 完成时的可回滚基线**。
> 之后再改协议/固件，如果线烧坏了，用这里的产物能 15 秒退回一个**能演示**的状态。

---

## 1. 这一版能做什么

| 能力 | 状态 |
| --- | --- |
| 表盘 / 训练 / 设置 三页 | 左右滑动、点屏幕两侧翻页 |
| 设置四栏 | 设备信息 / 显示 / 目标与休息 / 电源（两级导航） |
| 训练页 | 本次计时、本次步数、组间休息倒计时（归零三短震） |
| 息屏 | 30 秒无操作自动息屏；触摸唤醒；**抬腕唤醒** |
| 亮度 | 滑块实时调节（CO5300 0x51） |
| 中文界面 | 自建子集字体（184 字） |
| 采样 | 25Hz 连续采样，**息屏也不停**，丢点率 0.00% |
| 鲸鱼娘 | 8 帧呼吸动画（表盘页） |

**尚未接通**（第二阶段后续里程碑）：BLE 上报、手机对时、`device_ts`、协议 v2、云端。

> 也就是说：**这一版的手表是"能独立工作的设备"，但还没接回数据链。**
> 演示数据链请用第一阶段的 `firmware/watch_ble`。

---

## 2. 手势

| 位置 | 操作 | 结果 |
| --- | --- | --- |
| 任意页 | 左右滑动 | 翻页 |
| 表盘/训练页 | 点屏幕左 1/3 / 右 1/3 | 翻页 |
| 训练页 | 点中间 | 开始 / 停止本次训练 |
| 训练页 | 点「休息 60 秒」 | 开始 / 取消组间倒计时 |
| 设置列表 | 点某一行 | 进子页 |
| 子页 | 右滑 或 点顶部 `< XXX` | 返回 |
| 任意位置 | **长按 ≥1 秒** | 回表盘（触摸失灵时的逃生口） |

---

## 3. 烧录

```powershell
$cli='D:\vue school build\.tools\arduino-cli\arduino-cli.exe'
$cfg='D:\vue school build\.tools\arduino-cli\arduino-cli.yaml'
$fqbn='esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=32M,PSRAM=opi,FlashMode=qio,PartitionScheme=huge_app,UploadSpeed=921600,CPUFreq=240'

# 源码编译
& $cli --config-file $cfg compile --fqbn $fqbn `
  --build-property 'compiler.cpp.extra_flags=-DLV_CONF_INCLUDE_SIMPLE' `
  --output-dir build 'firmware/watch_lvgl'

# 烧录
& $cli --config-file $cfg upload -p COM3 --fqbn $fqbn `
  --input-dir build 'firmware/watch_lvgl'
```

**直接烧留档产物**（不编译）：

```powershell
$esp='C:\Users\hubin\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe'
& $esp --port COM3 --chip esp32s3 --baud 921600 write-flash `
  0x0     firmware\releases\m1b\bootloader.bin `
  0x8000  firmware\releases\m1b\partitions.bin `
  0x10000 firmware\releases\m1b\app.bin
```

> 分区方案是 `huge_app`（无 OTA），所以不需要 `boot_app0.bin`。

> 注：`lv_conf.h` 在 sketch 目录里，靠 `-DLV_CONF_INCLUDE_SIMPLE` 生效。
> **改 `lv_conf.h` 会触发 LVGL 全量重编（约 12 分钟）**，改 `.ino` 只要 2 分钟。

---

## 4. 已知限制（答辩要主动讲）

1. **表盘时间是"编译时刻 + 上电时长"**。板载无 RTC 备份电源，拔电池后时间会跳回编译时刻；插拔 USB 不影响（电池续命）。M2 接手机对时后这条会变成"未对时兜底"。
2. **息屏省电有限**：省的是面板 + LVGL 刷新，ESP32 的 25Hz 采样与射频仍在。实测待补。
3. **抬腕阈值是单人标定的**（下垂 18–22° → 抬起 76–80°，见 `docs/pin-ledger.md` §12.2）。换人戴可能要调。
4. **亮度对 AMOLED 的省电效果**未量化；M4b 会做"亮度 vs 功耗"曲线。
5. **鲸鱼娘素材来自 AGPL-3.0 仓库**，用途与署名待定（见 CREDITS 待办）。

---

## 5. 三分钟演示脚本

1. **抬腕** → 表盘亮，显示时间/步数/鲸鱼（15s）
2. **滑到训练页** → 点中间开始计时，走两步看步数涨（20s）
3. **点「休息 60 秒」** → 倒计时开始；等归零 → 震动（30s）
4. **滑到设置** → 显示 → 调亮度，屏幕立刻变暗；把"熄屏时间"改 15 秒（30s）
5. **不碰屏幕等息屏** → 触摸唤醒 / 抬腕唤醒各演示一次（30s）
6. **设备信息页** → 展示"采样 0.0% 丢点、25Hz"作为数据链质量的证据（20s）

---

## 6. 回滚

```powershell
git checkout demo-m1b -- firmware/watch_lvgl
# 或直接用上面的 esptool 命令烧 releases/m1b 里的产物
```
