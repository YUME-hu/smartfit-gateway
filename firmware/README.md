# 手表固件（ESP32-S3-Touch-AMOLED-2.06 + QMI8658C）

两条数据链路的可编译、可烧录工程：

| 目录 | 作用 | 状态 |
| --- | --- | --- |
| `firmware/watch_ble/` | 25Hz 采样 + 5s 窗口聚合 + BLE Notify | 已烧录 COM3，实测通过 |
| `firmware/common/step_counter.h` | 计步算法（纯逻辑，无 Arduino 依赖） | 由 selftest 回归 |
| `firmware/step_selftest/` | 合成信号自测计步算法 | 实测 PASS |
| `firmware/watch_wifi/` | HTTP `GET /data` 返回 JSON（备胎方案） | 编译通过，未烧录 |
| `firmware/logs/ble_serial.log` | BLE 版开机日志 | 实测抓取 |
| `firmware/logs/step_selftest.log` | 计步自测输出 | 实测抓取 |

> Arduino 要求 `.ino` 必须放在同名文件夹里，所以文件名是
> `watch_ble/watch_ble.ino`，而不是工作区根目录下的单个 `watch_ble.ino`。

## 关键结论：I2C 引脚不是 47/48

需求里给的 `SDA=47, SCL=48` 在本板上**没有接 QMI8658**。证据有两条，互相独立：

1. 微雪 `board_config/pin_config.h` 第 16–17 行：`IIC_SDA 15`、`IIC_SCL 14`；
   官方文档「引脚定义」表里 `GPIO14/GPIO15` 是触控、AXP2101、QMI8658、
   PCF85063、ES8311、ES7210 共用的板载 I2C 总线。
2. 固件启动时做总线扫描，在 `SDA=15 SCL=14` 上扫到 7 个器件，其中
   `0x6B` 就是 QMI8658（`logs/ble_serial.log` 第 28–37 行）。

```
[I2C] 扫描 SDA=15 SCL=14 ...
       0x18 在线   ← ES8311
       0x34 在线   ← AXP2101（电源管理）
       0x38 在线   ← FT3168（触控）
       0x40 在线
       0x51 在线   ← PCF85063（RTC）
       0x6B 在线   ← QMI8658（六轴 IMU）
       0x7E 在线
[OK] QMI8658 已应答，地址 0x6B (SDA=15 SCL=14)
传感器初始化成功
蓝牙准备就绪，设备名 "ESP32_Fitness_Watch"
```

固件里保留了 47/48 作为「备用候选」：主总线扫不到 QMI8658 时会自动改扫
47/48 并把结果打出来，所以换板子也不会瞎猜。

## 编译与烧录

工具链不是 Arduino IDE，而是独立安装的 `arduino-cli`（复用你已有的
ESP32 内核与库，没有重复下载 SDK）：

```powershell
$cli  = "C:\Users\hubin\tools\arduino-cli\arduino-cli.exe"
$fqbn = "esp32:esp32:esp32s3:FlashSize=32M,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=cdc,FlashMode=qio,CPUFreq=240,UploadSpeed=921600"

# BLE 版
& $cli compile --fqbn $fqbn --upload -p COM3 "D:\vue school build\firmware\watch_ble"
# Wi-Fi 版
& $cli compile --fqbn $fqbn --upload -p COM3 "D:\vue school build\firmware\watch_wifi"
```

`PSRAM=opi` 是必须的：ESP32-S3R8 是 8MB **八线** PSRAM，用 `qspi` 配错会起不来。
`USBMode=hwcdc` + `CDCOnBoot=cdc` 让 `Serial` 走板上原生 USB（USB-Serial-JTAG）。

> **COM3 被占用怎么办**：Arduino IDE 的串口监视器会独占 COM3，
> `esptool` 会报 `PermissionError(13)`。关掉 IDE 里的串口监视器即可。

## BLE 版要点

- 设备名 `ESP32_Fitness_Watch`
- 服务 `0000FFF0-0000-1000-8000-00805F9B34FB`，特征 `0000FFF1-...`（READ + NOTIFY）
- **每 5 秒推送一包** `"x,y,z,seq,steps"`，例 `-0.12,-0.08,-1.11,3,7`（21 字节）
  - `x,y,z` = 该窗口内三轴**均值**（5 秒一包时瞬时值代表性太差）
  - `seq` = 已成功发出的包序号
  - `steps` = 该窗口内计到的步数
- 实测：17 秒 4 包，间隔 `5.06 / 5.05 / 4.97`，5 字段全部合法，静置 `steps=0`

⚠️ **21 字节已经超过默认 ATT MTU 23 的 20 字节有效负载**。手机端必须请求 MTU
（`setBLEMTU(185)`，iOS 自动协商）。App 的解析器对这种包做严格逐字段校验，
被截断就整包丢弃并计入 `badPackets`，不会静默入库半截数据。

## 计步是怎么做的

采样率从"发包时读一次"改为 **25Hz 连续采样**（40ms 一次，每窗口正好 125 个样本）。
这是计步的必要代价：只取瞬时点的话没有波形，做不了任何步态判断。

算法在 `common/step_counter.h`，三步：

1. **去重力**：合模量 |a| 静止时约 1g，这个直流分量不扣掉，任何阈值判断都恒成立。
   用 EMA（α=0.05，25Hz 下时间常数约 0.8s）估计基线。
2. **带滞回的过零检测**：要求 ac 先上穿 `+0.12g`、再下穿 `-0.06g` 才算走完一个
   步态周期。单阈值方案在噪声里会疯狂误报。
3. **不应期 250ms**：限制最高 240 步/分，防止一次冲击被计成多步。

窗口统计（均值/方差/峰值）每 5 秒清零，但**基线、滞回状态、上一步时间戳跨窗口保留**
—— 否则每个窗口开头都要重新适应基线，窗口边界会丢步或误计。

### 为什么要单独写个自测 sketch

"计步准不准"没法靠静置验证：静置只能证明**不误报**，证明不了**能计步**。
而我没有手去摇表，所以用合成信号跑同一份 C++ 代码（不是 Python 复刻）：

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 静置 3s | 0 步 | 0 步（std 0.006g） |
| 走路 1.8Hz / 0.35g，10s | ≈18 步 | **18 步**（std 0.239g，peak 0.368g） |
| 微振 2Hz / 0.05g，5s | 0 步 | 0 步（std 0.036g） |
| 静置收尾 3s | 0 步 | 0 步 |

跑法：

```powershell
& $cli compile --fqbn $fqbn --upload -p COM3 "D:\vue school build\firmware\step_selftest"
# 串口最后一行应为 SELFTEST RESULT: PASS
```

⚠️ 自测用的是合成正弦信号，只能证明"参数落在合理区间、边界不误报"。
**真实步态的频谱比正弦复杂得多**，实测建议：正常走 1 分钟，数 60 秒内的步数
与串口 `[STATE] 累计步数` 对比，偏差大再调 `thresholdG` / `refractoryMs`。

### 三个曾经踩中、已修复的坑

**1. `configAccelerometer()` 返回 0 才是成功。** 一开始写成 `== 0` 报错，
导致"传感器其实配好了却被判失败"。现在按 `!= 0` 判失败。

**2. 没有串口主机时，`Serial.printf` 会阻塞 `loop()`。** 现象极具迷惑性：
接着串口监视器时 notify 有 101 包，拔掉串口用手机连只有 **2 包**就断流。
根因是 USB CDC 没有主机读、缓冲区满后写操作阻塞，把整个循环拖死。
修复是 `Serial.setTxTimeoutMs(0)`（写不阻塞，满了丢日志）。改完拔掉串口
复测仍是 101 包（当时间隔还是 50ms，故计数是 101；现在 5s 间隔正常是 4 包/17s）。

**3. `BLECharacteristic::notify()` 在本内核返回 `void`，不是 `bool`。**
想统计"发成功没"而写成 `if (pChar->notify())` 会编译失败，只能统计已尝试次数。

## Wi-Fi 版要点

烧录前把这两行改成你的手机热点（ESP32-S3 **只支持 2.4GHz**，5GHz 连不上）：

```cpp
#define WIFI_SSID  "YOUR_HOTSPOT_SSID"
#define WIFI_PASS  "YOUR_HOTSPOT_PASSWORD"
```

启动后串口会打印 IP，接口：

```
GET http://<ESP32_IP>/data
=> {"x":0.12,"y":-0.05,"z":0.98}
```

已带 CORS 头（`Access-Control-Allow-Origin: *`）并处理了 `OPTIONS` 预检，
Vue 前端跨域直连不用再配代理。

## 前端对接

### 方案 B：Wi-Fi（推荐）

```js
const res = await fetch('http://192.168.43.xx/data');
const { x, y, z } = await res.json();
```

### 方案 A：Web Bluetooth

```js
const device = await navigator.bluetooth.requestDevice({
  filters: [{ name: 'ESP32_Fitness_Watch' }],
  optionalServices: ['0000fff0-0000-1000-8000-00805f9b34fb'],
});
const server  = await device.gatt.connect();
const service = await server.getPrimaryService('0000fff0-0000-1000-8000-00805f9b34fb');
const ch      = await service.getCharacteristic('0000fff1-0000-1000-8000-00805f9b34fb');
await ch.startNotifications();
ch.addEventListener('characteristicvaluechanged', (e) => {
  const [x, y, z] = new TextDecoder().decode(e.target.value).split(',').map(Number);
});
```

Web Bluetooth 的三个硬限制（`NotFoundError` 多半来自这里，而不是固件）：

1. **必须 HTTPS 或 localhost**。`http://192.168.x.x` 打开的页面调用
   `navigator.bluetooth` 会直接失败。Vue 用 `npm run dev` 的
   `http://localhost:5173` 是安全的，局域网 IP 访问则不是。
2. **iOS Safari 完全不支持 Web Bluetooth**。如果答辩演示机是 iPhone，
   这条方案走不通，只能用 Wi-Fi 方案。
3. 需要用户手势（点击）触发 `requestDevice()`，不能页面加载时自动调用。

## 已知偏差

静止平放时读数约为 `(-0.18, -0.05, -1.10)`，合模量 ≈1.11g 而不是 1.00g，
即约 10% 的量程/零偏误差。对「有没有在动」的判断无影响，但如果毕设要
算步数/卡路里，建议做一次静态标定（记录静止样本求零偏与比例系数后扣除）。
需要的话我可以加一个标定函数。
