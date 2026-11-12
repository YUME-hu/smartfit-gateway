/**
 * watch_ble.ino
 * 目标板: ESP32-S3-Touch-AMOLED-2.06 (ESP32-S3R8 + QMI8658C + AXP2101)
 * 功能  : 25Hz 连续采样 QMI8658，按 5 秒窗口聚合后通过 BLE Notify 发送一包
 *         负载格式: "x,y,z,seq,steps"
 *             x,y,z : 该窗口内三轴均值（g，2 位小数）
 *             seq   : 已成功发出的包序号，供手机端做丢包检测与幂等去重
 *             steps : 该窗口内计到的步数
 *         例: "-0.18,-0.05,-1.10,42,7"
 *
 * 计步算法见 ../common/step_counter.h（去重力 + 带滞回过零 + 不应期）。
 * 算法本身由 ../step_selftest 用合成信号回归测试，不靠"摇一摇看看"。
 *
 * 功耗说明：为了计步必须 25Hz 连续采样（40ms 一次 I2C 读），
 * 不能再像纯上报模式那样"发包时才读一次"。这是计步功能的必要代价。
 *
 * 为什么代码里有两组 I2C 引脚：
 *   微雪官方 pin_config.h 与本板原理图规定共享 I2C 为 SDA=15 / SCL=14，
 *   而需求里给的是 SDA=47 / SCL=48。为避免反复试错，本程序启动时先做
 *   I2C 总线扫描，在哪条总线上发现 0x6B(QMI8658) 就用哪条，并把扫描
 *   结果打印到串口。这样"传感器到底挂在哪组引脚"由日志给出答案。
 *
 * 库: SensorLib 0.3.1 (C:\Users\hubin\Documents\Arduino\libraries\SensorLib)
 *     不要升级到 0.5.x —— 该版本在本板上有虚函数表冲突导致死机。
 */

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "SensorQMI8658.hpp"
#include "../common/step_counter.h"

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
// BLE 配置
// ---------------------------------------------------------------------------
#define BLE_DEVICE_NAME  "ESP32_Fitness_Watch"
// 标准测试 UUID（FFF0 服务 / FFF1 特征）
#define SERVICE_UUID     "0000FFF0-0000-1000-8000-00805F9B34FB"
#define CHAR_UUID        "0000FFF1-0000-1000-8000-00805F9B34FB"

#define WINDOW_MS           5000   // 聚合窗口 = 发包周期
#define SAMPLE_PERIOD_MS    40     // 25Hz 采样，计步必须连续采（不能只在发包时读）

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
static SensorQMI8658 qmi;
static bool   sensorReady = false;
static bool   bleReady    = false;
static bool   clientConnected = false;
static int    activeSda = -1;
static int    activeScl = -1;

static BLEServer         *pServer  = nullptr;
static BLECharacteristic *pChar    = nullptr;

// 诊断计数：本版 BLECharacteristic::notify() 返回 void，只能统计"已尝试发送"次数
static uint32_t notifSent = 0;

// 计步与窗口聚合
static StepCounter stepCounter;
static uint32_t lastSampleMs  = 0;
static uint32_t windowStartMs = 0;
static uint32_t lifetimeSteps = 0;   // 上电以来累计步数（仅日志用）

static void printBanner()
{
    Serial.println();
    Serial.println("==================================================");
    Serial.println(" ESP32_Fitness_Watch  (BLE 加速度 + 计步节点)");
    Serial.println(" Board : ESP32-S3-Touch-AMOLED-2.06 / ESP32-S3R8");
    Serial.println(" Sensor: QMI8658C  @ I2C");
    Serial.println("==================================================");
}

// ---------------------------------------------------------------------------
// I2C 自检：扫描总线，返回是否发现 QMI8658
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

    // 依次尝试 0x6B，再尝试 0x6A
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

    // 量程 ±4g，输出速率 250Hz
    // 注意：loop 只在发包时读一次（5s 一次），所以这里的高 ODR 只影响
    // 单次采样的新鲜度，不影响功耗；想要步数统计需改成窗口内多次采样。
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
    delay(100);   // 等第一帧有效数据

    return true;
}

// ---------------------------------------------------------------------------
// BLE 回调
// ---------------------------------------------------------------------------
class ServerCallbacks : public BLEServerCallbacks
{
    void onConnect(BLEServer *server) override
    {
        clientConnected = true;
        Serial.println("[BLE] 主机已连接");
    }

    void onDisconnect(BLEServer *server) override
    {
        clientConnected = false;
        Serial.println("[BLE] 主机断开，重新广播");
        // 断开后必须重新开始广播，否则浏览器再扫就找不到了
        server->startAdvertising();
    }
};

// ---------------------------------------------------------------------------
// BLE 初始化
// ---------------------------------------------------------------------------
static bool initBle()
{
    BLEDevice::init(BLE_DEVICE_NAME);
    BLEDevice::setMTU(185);          // 一包放得下 "x,y,z"，避免分片

    pServer = BLEDevice::createServer();
    if (!pServer) {
        Serial.println("[ERR] createServer 失败");
        return false;
    }
    pServer->setCallbacks(new ServerCallbacks());

    BLEService *pService = pServer->createService(SERVICE_UUID);
    if (!pService) {
        Serial.println("[ERR] createService 失败");
        return false;
    }

    pChar = pService->createCharacteristic(
                CHAR_UUID,
                BLECharacteristic::PROPERTY_READ |
                BLECharacteristic::PROPERTY_NOTIFY);
    pChar->addDescriptor(new BLE2902());   // 使能 Notify 的 CCCD
    pChar->setValue("0.00,0.00,0.00");

    pService->start();

    BLEAdvertising *pAdv = BLEDevice::getAdvertising();
    pAdv->addServiceUUID(SERVICE_UUID);
    pAdv->setScanResponse(true);
    // 让部分 Android 机型/更老的扫描器更容易发现本设备
    pAdv->setMinPreferred(0x06);
    pAdv->setMinPreferred(0x12);
    BLEDevice::startAdvertising();

    return true;
}

// ---------------------------------------------------------------------------
// setup / loop
// ---------------------------------------------------------------------------
void setup()
{
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    // 关键：没有主机打开串口时，USB CDC 的写操作会被阻塞并拖住 loop()，
    // 实测表现为 BLE notify 只发 1~2 包就停（手机连着、没人开串口时必然遇到）。
    // 超时设 0 = 不阻塞，缓冲区满了就直接丢日志，绝不牺牲实时性。
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

    // 计步器：阈值用默认值（0.12g / 回落 0.06g / 不应期 250ms），
    // 具体标定过程见 firmware/step_selftest 的合成信号回归
    stepCounter.configure(StepCounter::Config{});
    stepCounter.resetAll();
    lastSampleMs = millis();
    windowStartMs = millis();
    Serial.println("计步器就绪：25Hz 采样，5 秒窗口聚合");

    if (initBle()) {
        bleReady = true;
        Serial.printf("蓝牙准备就绪，设备名 \"%s\"\n", BLE_DEVICE_NAME);
        Serial.printf("  服务 UUID: %s\n", SERVICE_UUID);
        Serial.printf("  特征 UUID: %s (NOTIFY)\n", CHAR_UUID);
        Serial.println("  等待主机连接...");
    } else {
        Serial.println("蓝牙初始化失败");
    }
}

void loop()
{
    const uint32_t now = millis();

    // 1) 25Hz 连续采样：计步必须看波形，不能只在发包瞬间取一个点
    if (now - lastSampleMs >= SAMPLE_PERIOD_MS) {
        lastSampleMs = now;

        float x = 0.0f, y = 0.0f, z = 0.0f;
        if (sensorReady && qmi.getAccelerometer(x, y, z)) {
            if (stepCounter.feed(x, y, z, now)) {
                lifetimeSteps++;
            }
        }
    }

    // 2) 窗口结束：把 5 秒的均值、步数与序号一起发出去
    if (now - windowStartMs >= WINDOW_MS) {
        windowStartMs = now;

        const uint32_t windowSteps = stepCounter.windowSteps();

        // x,y,z 用窗口均值而不是瞬时值：5 秒一包时瞬时值代表性太差
        char payload[72];
        snprintf(payload, sizeof(payload), "%.2f,%.2f,%.2f,%u,%u",
                 stepCounter.meanX(), stepCounter.meanY(), stepCounter.meanZ(),
                 (unsigned)notifSent, (unsigned)windowSteps);

        bool sent = false;
        if (bleReady && clientConnected && pChar) {
            pChar->setValue((uint8_t *)payload, strlen(payload));
            pChar->notify();
            notifSent++;
            sent = true;
        }

        // len 必须盯着：默认 ATT MTU 23 时有效负载只有 20 字节，
        // 这一包典型 21~23 字节，靠手机端请求 MTU 185 才安全。
        Serial.printf("[WIN] n=%lu std=%.3f peak=%.3f steps=%lu total=%lu len=%u %s\n",
                      (unsigned long)stepCounter.samples(),
                      stepCounter.stdDev(), stepCounter.peak(),
                      (unsigned long)windowSteps, (unsigned long)lifetimeSteps,
                      (unsigned)strlen(payload),
                      sent ? "已推送" : "未连接");

        stepCounter.resetWindow();
    }

    // 3) 状态心跳
    static uint32_t lastState = 0;
    if (now - lastState >= 30000) {
        lastState = now;
        Serial.printf("[STATE] 传感器=%s 蓝牙=%s 主机连接=%s 已发送=%lu 累计步数=%lu\n",
                      sensorReady ? "OK" : "FAIL",
                      bleReady ? "广播中" : "未启动",
                      clientConnected ? "是" : "否",
                      (unsigned long)notifSent,
                      (unsigned long)lifetimeSteps);
    }
}
