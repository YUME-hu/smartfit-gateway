# 固件留档

## m1b/ —— 2026-11-22，M1b 演示基线

烧录用（`esptool write-flash`，分区方案 `huge_app`，无 OTA 所以不需要 boot_app0）：

| 文件 | 烧录地址 |
| --- | --- |
| `bootloader.bin` | 0x0 |
| `partitions.bin` | 0x8000 |
| `app.bin` | 0x10000 |

```powershell
$esp='C:\Users\hubin\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe'
& $esp --port COM3 --chip esp32s3 --baud 921600 write-flash `
  0x0 firmware\releases\m1b\bootloader.bin `
  0x8000 firmware\releases\m1b\partitions.bin `
  0x10000 firmware\releases\m1b\app.bin
```

来源：`firmware/watch_lvgl`，commit 见 git tag `demo-m1b`。
功能与已知限制见 `docs/demo-m1b.md`。

> 注意：这一版**不含 BLE 上报**。它演示的是"手表作为独立设备"（表盘/训练/设置/息屏/抬腕/震动），
> 数据链演示仍用第一阶段的 `firmware/watch_ble`。
