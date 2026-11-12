/**
 * watch_wifi.ino
 * 目标板: ESP32-S3-Touch-AMOLED-2.06 (ESP32-S3R8 + QMI8658C + AXP2101)
 * 功能  : 读取 QMI8658 三轴加速度，通过 HTTP GET /data 返回 JSON
 *
 * 为什么这条路线更稳：
 *   Web Bluetooth 需要浏览器在安全上下文(HTTPS 或 localhost)下工作，
 *   且对设备广播名/UUID/CCCD 的要求因浏览器而异。改成 ESP32 自建
 *   HTTP 服务后，Vue 前端只要 fetch('http://<ESP32_IP>/data') 即可，
 *   不依赖任何蓝牙权限。
 *
 * 库: SensorLib 0.3.1 —— 不要升级到 0.5.x（本板会因虚函数表冲突死机）
 */

#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include "SensorQMI8658.hpp"

// ---------------------------------------------------------------------------
// Wi-Fi 配置 —— 烧录前请改成你自己的手机热点
// ---------------------------------------------------------------------------
#define WIFI_SSID  "YOUR_HOTSPOT_SSID"
#define WIFI_PASS  "YOUR_HOTSPOT_PASSWORD"

#define WIFI_CONNECT_TIMEOUT_MS  20000

// ---------------------------------------------------------------------------
// 板级配置
// ---------------------------------------------------------------------------
// 官方文档 / board_config/pin_config.h: IIC_SDA 15, IIC_SCL 14
#define IIC_SDA_PRIMARY 15
#define IIC_SCL_PRIMARY 14

// 需求中给出的备用候选引脚（本板未把 QMI8658 接到这里，仅做自检对比）
#define IIC_SDA_ALTERNATE 47
#define IIC_SCL_ALTERNATE 48

#define QMI_ADDR        QMI8658_L_SLAVE_ADDRESS   // 0x6B
#define QMI_ADDR_ALT    QMI8658_H_SLAVE_ADDRESS   // 0x6A

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
static SensorQMI8658 qmi;
static WebServer      server(80);

static bool sensorReady   = false;
static int  activeSda = -1;
static int  activeScl = -1;

static void printBanner()
{
    Serial.println();
    Serial.println("==================================================");
    Serial.println(" ESP32_Fitness_Watch  (Wi-Fi / HTTP 加速度节点)");
    Serial.println(" Board : ESP32-S3-Touch-AMOLED-2.06 / ESP32-S3R8");
    Serial.println(" Sensor: QMI8658C  @ I2C");
    Serial.println("==================================================");
}

// ---------------------------------------------------------------------------
// I2C 自检
// ---------------------------------------------------------------------------
static bool probeBus(int sda, int scl, bool *qmiOnThisBus)
{
    *qmiOnThisBus = false;
    Wire.end();
    delay(20);
    Wire.begin(sda, scl, 400000);
    delay(30);

    Serial.printf("[I2C] 扫描 SDA=%d SCL=%d ...\n", sda, scl);
    int count = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        if (Wire.endTransmission() == 0) {
            Serial.printf("       0x%02X 在线\n", addr);
            count++;
            if (addr == QMI_ADDR || addr == QMI_ADDR_ALT) {
                *qmiOnThisBus = true;
            }
        }
    }
    if (count == 0) {
        Serial.println("       (总线上没有任何设备应答)");
    }
    Serial.printf("[I2C] SDA=%d SCL=%d 应答设备数 = %d\n", sda, scl, count);
    return *qmiOnThisBus;
}

// ---------------------------------------------------------------------------
// 传感器初始化
// ---------------------------------------------------------------------------
static bool initSensor()
{
    bool qmiOnBus = false;

    probeBus(IIC_SDA_PRIMARY, IIC_SCL_PRIMARY, &qmiOnBus);
    if (!qmiOnBus) {
        Serial.println("[I2C] 主总线未发现 QMI8658，改用备用引脚 47/48 复查");
        probeBus(IIC_SDA_ALTERNATE, IIC_SCL_ALTERNATE, &qmiOnBus);
        if (!qmiOnBus) {
            Serial.println("[ERR] 两组引脚都没发现 QMI8658(0x6B/0x6A)");
            return false;
        }
        activeSda = IIC_SDA_ALTERNATE;
        activeScl = IIC_SCL_ALTERNATE;
    } else {
        activeSda = IIC_SDA_PRIMARY;
        activeScl = IIC_SCL_PRIMARY;
    }

    Wire.end();
    delay(20);
    Wire.begin(activeSda, activeScl, 400000);
    delay(50);

    uint8_t addr = QMI_ADDR;
    if (!qmi.begin(Wire, addr, activeSda, activeScl)) {
        Serial.printf("[WARN] 0x%02X 初始化失败，尝试 0x%02X\n", addr, QMI_ADDR_ALT);
        addr = QMI_ADDR_ALT;
        if (!qmi.begin(Wire, addr, activeSda, activeScl)) {
            Serial.println("[ERR] QMI8658 begin() 失败");
            return false;
        }
    }
    Serial.printf("[OK] QMI8658 已应答，地址 0x%02X (SDA=%d SCL=%d)\n",
                  addr, activeSda, activeScl);

    if (qmi.configAccelerometer(SensorQMI8658::ACC_RANGE_4G,
                                SensorQMI8658::ACC_ODR_250Hz,
                                SensorQMI8658::LPF_MODE_0) != 0) {
        Serial.println("[ERR] configAccelerometer 失败");
        return false;
    }
    if (!qmi.enableAccelerometer()) {
        Serial.println("[ERR] enableAccelerometer 失败");
        return false;
    }
    delay(100);

    return true;
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------
// Vue 前端通常跑在 http://localhost:5173，与 ESP32 不同源，
// 因此必须带 CORS 头，否则浏览器会拦掉响应。
static void addCorsHeaders()
{
    server.sendHeader("Access-Control-Allow-Origin", "*");
    server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    server.sendHeader("Cache-Control", "no-store");
}

static void handleData()
{
    float x = 0.0f, y = 0.0f, z = 0.0f;
    bool ok = sensorReady && qmi.getAccelerometer(x, y, z);

    char json[128];
    if (ok) {
        snprintf(json, sizeof(json),
                 "{\"x\":%.2f,\"y\":%.2f,\"z\":%.2f}", x, y, z);
    } else {
        snprintf(json, sizeof(json),
                 "{\"error\":\"sensor not available\"}");
    }

    addCorsHeaders();
    server.send(ok ? 200 : 503, "application/json", json);
}

static void handleRoot()
{
    addCorsHeaders();
    String body = "ESP32_Fitness_Watch OK\n";
    body += "GET /data  -> {\"x\":..,\"y\":..,\"z\":..}\n";
    server.send(200, "text/plain; charset=utf-8", body);
}

static void handleNotFound()
{
    addCorsHeaders();
    server.send(404, "application/json", "{\"error\":\"not found\"}");
}

// ---------------------------------------------------------------------------
// Wi-Fi 连接
// ---------------------------------------------------------------------------
static bool connectWiFi()
{
    Serial.printf("[WiFi] 正在连接 \"%s\" ...\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);          // 关省电，降低 HTTP 响应抖动
    WiFi.begin(WIFI_SSID, WIFI_PASS);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
        delay(500);
        Serial.print('.');
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("[WiFi] 连接成功");
        Serial.print("[WiFi] IP 地址: ");
        Serial.println(WiFi.localIP());
        Serial.print("[WiFi] 信号强度(RSSI): ");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");
        Serial.printf("[HTTP] 数据接口: http://%s/data\n",
                      WiFi.localIP().toString().c_str());
        return true;
    }

    Serial.println("[WiFi] 连接失败（检查 SSID/密码，或热点是否为 2.4GHz）");
    return false;
}

// ---------------------------------------------------------------------------
// setup / loop
// ---------------------------------------------------------------------------
void setup()
{
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    // 没有主机打开串口时，USB CDC 的写会阻塞并拖慢 loop()，这里设为不阻塞
    Serial.setTxTimeoutMs(0);
#endif
    // USB CDC 必须先由主机打开端口；给 5s 重连窗口，避免烧录后重启丢掉开机日志
    unsigned long tWait = millis();
    while (!Serial && (millis() - tWait) < 5000) {
        delay(10);
    }
    delay(200);
    printBanner();

    if (initSensor()) {
        sensorReady = true;
        Serial.println("传感器初始化成功");
    } else {
        Serial.println("传感器初始化失败（详见上方 I2C 扫描结果）");
    }

    if (connectWiFi()) {
        server.on("/", HTTP_GET, handleRoot);
        server.on("/data", HTTP_GET, handleData);
        server.on("/data", HTTP_OPTIONS, []() {   // CORS 预检
            addCorsHeaders();
            server.send(204, "text/plain", "");
        });
        server.onNotFound(handleNotFound);
        server.begin();
        Serial.println("HTTP 服务已启动，端口 80");
    } else {
        Serial.println("[HTTP] 未联网，服务未启动（继续输出本地数据到串口）");
    }
}

void loop()
{
    if (WiFi.status() == WL_CONNECTED) {
        server.handleClient();
    }

    // 未联网时也持续打印，方便串口确认传感器是否真的在出数据
    static unsigned long lastPrint = 0;
    if (millis() - lastPrint >= 1000) {
        lastPrint = millis();
        float x, y, z;
        if (sensorReady && qmi.getAccelerometer(x, y, z)) {
            Serial.printf("[DATA] %.2f,%.2f,%.2f\n", x, y, z);
        }
    }

    // 网络心跳：每 10s 复述一次 IP，避免错过开机那一行
    static unsigned long lastNet = 0;
    if (millis() - lastNet >= 10000) {
        lastNet = millis();
        if (WiFi.status() == WL_CONNECTED) {
            Serial.printf("[NET] 在线  IP=%s  http://%s/data\n",
                          WiFi.localIP().toString().c_str(),
                          WiFi.localIP().toString().c_str());
        } else {
            Serial.printf("[NET] 未连接 (status=%d)\n", (int)WiFi.status());
        }
    }
}
