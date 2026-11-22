# Demo 基线 M2（2026-11-22 深夜）

> 在 `demo-m1b` 之上接回了**双向 BLE 通道**和**对时**。
> 这一版是"数据链重新闭合"的基线：手表 → 手机 → 云端 → 看板 全通，且手表时间可信。

---

## 1. 相对 M1b 的增量

| 层 | 变化 |
| --- | --- |
| 固件 | 恢复 BLE（FFF0/FFF1 上报，负载格式与第一阶段一致）+ 新增 FFF2 写特征 |
| 固件 | 支持对时指令 `T<unix_epoch_utc>`、`P` ping |
| 固件 | 上报追加可选第 6 字段 `device_ts`（窗口起始的 UTC 秒），**仅时间可信时才发** |
| App | 解析 3~6 字段；连接成功后**自动对时** |
| App | 写入改走 `ingest_samples_v3`（多两列） |
| 数据库 | `imu_samples` 加 `device_ts` / `session_id`；新增 `ingest_samples_v3` |

---

## 2. 烧录

```powershell
$esp='C:\Users\hubin\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe'
& $esp --port COM3 --chip esp32s3 --baud 921600 write-flash `
  0x0     firmware\releases\m2\bootloader.bin `
  0x8000  firmware\releases\m2\partitions.bin `
  0x10000 firmware\releases\m2\app.bin
```

源码编译见 `docs/demo-m1b.md` 第 3 节（FQBN 与 `-DLV_CONF_INCLUDE_SIMPLE` 都要带）。

---

## 3. 验证清单

**主链路**
- [ ] App 能连上，实时数据在跳，表盘底部 `LINK BLE` 变薄荷绿
- [ ] 手表时间 = 手机真实时间（连上即对时，误差 < 1s）
- [ ] 等 15 分钟或点"立即同步"，数据进库

**数据库**（`device_ts` 不再全 null，且与 `recorded_at` 差 0~6 秒）

```sql
select recorded_at, device_ts,
       extract(epoch from (recorded_at - device_ts)) as diff_s
  from imu_samples
 where device_ts is not null
 order by id desc limit 10;
```

**离线验证**（不用手机，PC 直接对时）

```powershell
python .tools\ble_time_sync.py     # 需要 bleak
```

---

## 4. 已知限制

1. **`session_id` 列建了但没填**：它要和 `reps.session_id` 同源，而那个会话概念在浏览器端（深蹲页），网关拿不到。等 M5 训练页一起处理。
2. **T1.1 未执行**：旧 `ingest_samples(jsonb)`（无 token）仍对 anon 开放，计划在 M3 一次性删 v1+v2。
3. **版本顺序**：旧 APK + 新固件会整包丢弃（旧解析器不认识 6 字段）。必须先升 App 再升固件。
4. `device_ts` 是**窗口起始**，`recorded_at` 是**手机收包**，天然差 0~5 秒，属正常。

---

## 5. 回滚

```powershell
git checkout demo-m2 -- firmware/watch_lvgl src supabase scripts types
```

或直接烧 `firmware/releases/m2/` 里的产物（App 侧需重新打 APK）。
