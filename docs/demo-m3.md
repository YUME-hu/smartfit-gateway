# Demo 基线 M3（2026-11-23）

> 协议从文本换成 **18 字节二进制帧**，并完成 ACK/重传与 T1.1 安全收口。
> 这是第二阶段"工程可信度"最高的一版：链路有握手、有确认、有重传、有幂等、有门禁。

---

## 1. 相对 M2 的增量

| 层 | 变化 |
| --- | --- |
| 协议 | 文本 `x,y,z,seq,steps[,ts]` → **18 字节定长帧**（magic/ver/type/seq/ts/xyz/steps/CRC16） |
| 固件 | 帧编解码 + 开机自检；停等 ACK + 重传 ≤3；PSRAM 环形缓冲（24h） |
| 固件 | 收到文本 `V2` 才切二进制——旧 App 不受影响 |
| App | 按首字节 magic 自动区分帧/文本；每帧回 ACK；连接后声明 `V2` |
| 数据库 | **删除** `ingest_samples`(v1) 与 `ingest_samples_v2`，只留 `ingest_samples_v3` |
| 门禁 | `verify-db.cjs` 改为"正向断言旧函数已删除"，29 项全 PASS |

---

## 2. 烧录

```powershell
$esp='C:\Users\hubin\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe'
& $esp --port COM3 --chip esp32s3 --baud 921600 write-flash `
  0x0     firmware\releases\m3\bootloader.bin `
  0x8000  firmware\releases\m3\partitions.bin `
  0x10000 firmware\releases\m3\app.bin
```

App 侧需配套的新 APK（GitHub Actions `Build Android APK`）。**版本必须成对**：
新固件 + 旧 APK 仍能工作（文本降级），但拿不到帧/ACK 的新特性。

---

## 3. 验证清单

**手表开机自检**（串口）

```
[FRAME] 自检 PASS（18 字节帧 / CRC16-CCITT-FALSE）
[RING] 17280 个窗口（约 24h），占用 270 KB PSRAM
```

**PC 端（不依赖手机）**

```powershell
python .tools\ble_v2_test.py     # 写 V2 → HELLO proto=2 → 连续 data 帧，0 坏帧
python .tools\ble_ack_test.py    # A 段无重传；B 段故意不回 ACK → 同 seq 重发 3 次
python .tools\ble_m25_test.py    # 断开 35s → 重连 seq 连续（环形缓冲补发）
```

**手机端**

- [ ] 连上后数据正常（此时走的是二进制帧）
- [ ] 手表时间 = 手机时间（连接即对时）
- [ ] 断连 1 分钟再连，数据连续、`丢包` 不暴涨
- [ ] 设备信息页「缓存」在断连时上涨、重连后归零

**数据库**

```sql
select recorded_at, device_ts,
       extract(epoch from (recorded_at - device_ts)) as diff_s
  from imu_samples where device_ts is not null
 order by id desc limit 10;
```

---

## 4. 已知限制

1. **`session_id` 仍未填**：它与浏览器端（深蹲页）的会话同源，网关拿不到，等 M5。
2. **断电即丢缓冲**：PSRAM 不保持，断连+重启那段数据仍会丢（持久化要靠 SD/NVS）。
3. **重放靠 3 秒时间窗**：连接后等 3 秒才开始重放（等手机完成服务发现 + 订阅）。
   有了 ACK 之后不再是"发了就算发过"，但这 3 秒仍是经验值。
4. **旧 APK 已失效**：T1.1 删了 v1/v2，装着旧 APK 的设备同步会报"函数不存在"。
5. **只有一块板**：所有真机结论来自单板单片，未做批次一致性验证。

---

## 5. 回滚

```powershell
git checkout demo-m3 -- firmware/watch_lvgl src supabase scripts types tests
```
