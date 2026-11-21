/**
 * m0b_probe.ino —— M0b 技术探针（三件事，互不影响）
 *
 *   ① CO5300 QSPI 点亮，并实测两种推送方式的单帧耗时
 *      全帧 410×502（402KB） vs 条带 50 行（41KB）
 *   ② 显示持续刷新时 25Hz 采样的丢点率（验证"任务分离"方案）
 *      自动 A/B：前 60s 只采样，后 60s 采样 + 全速刷屏
 *   ③ RTC(PCF85063) 断电保时 OS 标志 + AXP2101 电量读数
 *
 * 设计要点：
 *   - 采样在 core1 独立任务里跑（vTaskDelayUntil 保节拍），显示在 core0 任务里跑
 *   - QMI8658 与 PCF85063/AXP2101 共享 I2C(Wire)，所有访问走同一把互斥锁
 *   - 丢点率的分母按**真实经过时间**算（elapsed/40ms），不是写死 125
 *
 * 串口：USB CDC，115200。上电后等 3s 方便接上串口。
 */
#include <Wire.h>
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

#include "pin_config.h"                 // 必须最先：里面定义了 XPOWERS_CHIP_AXP2101
#include "Arduino_GFX_Library.h"
#include "SensorQMI8658.hpp"
#include "SensorPCF85063.hpp"
#include <XPowersLib.h>
#include "../common/step_counter.h"

#define SAMPLE_PERIOD_MS 40             // 25Hz
#define WINDOW_MS        5000
#define STRIP_LINES      50             // 条带高度（例程 PARTIAL 用的就是 50 行）
#define PHASE_MS         60000UL        // 每个相位 60s

// ---------------------------------------------------------------- 全局
static Arduino_DataBus *bus = nullptr;
static Arduino_GFX     *gfx = nullptr;
static SensorQMI8658    qmi;
static SensorPCF85063   rtc;
static XPowersPMU       power;
static StepCounter      stepCounter;

static bool sensorReady = false;
static bool rtcReady    = false;
static bool pmuReady    = false;
static bool displayReady = false;

static SemaphoreHandle_t i2cMutex = nullptr;
static volatile bool displayOn = false;   // 显示任务是否全速刷屏

// 采样统计（按窗口清零）
static volatile uint32_t winSamples  = 0;
static volatile uint32_t winSteps    = 0;
static uint32_t winStartMs = 0;
// 全相位累积
static uint32_t phaseSamples = 0, phaseExpected = 0;
static uint32_t phaseIdleSamples = 0, phaseIdleExpected = 0;
static uint32_t phaseBusySamples = 0, phaseBusyExpected = 0;
static uint32_t lifetimeSteps = 0;

// 显示统计
static volatile uint32_t dispFrames = 0;
static volatile uint32_t dispWorstUs = 0;
static volatile uint32_t dispSumUs   = 0;

// ---------------------------------------------------------------- 工具
static void i2cTake()   { xSemaphoreTake(i2cMutex, portMAX_DELAY); }
static void i2cGive()   { xSemaphoreGive(i2cMutex); }

/** 用同一把锁读一次加速度 */
static bool readAccel(float &x, float &y, float &z) {
    bool ok = false;
    i2cTake();
    if (sensorReady) ok = qmi.getAccelerometer(x, y, z);
    i2cGive();
    return ok;
}

// ---------------------------------------------------------------- 采样任务
static void samplerTask(void *) {
    const TickType_t period = pdMS_TO_TICKS(SAMPLE_PERIOD_MS);
    TickType_t lastWake = xTaskGetTickCount();

    for (;;) {
        vTaskDelayUntil(&lastWake, period);

        float x = 0, y = 0, z = 0;
        if (readAccel(x, y, z)) {
            winSamples++;
            if (stepCounter.feed(x, y, z, millis())) lifetimeSteps++;
        }
    }
}

// ---------------------------------------------------------------- 显示任务
static void displayTask(void *) {
    const size_t stripPx = (size_t)LCD_WIDTH * STRIP_LINES;
    uint16_t *strip = (uint16_t *)heap_caps_malloc(stripPx * 2, MALLOC_CAP_SPIRAM);
    if (!strip) {
        Serial.println("[ERR] 条带缓冲分配失败（PSRAM）");
        vTaskDelete(nullptr);
        return;
    }
    // 一条彩色渐变，用来确认色彩顺序 / 偏移是否正确
    for (size_t i = 0; i < stripPx; i++) {
        uint16_t c = (uint16_t)(((i * 31) & 0x1F) << 11) | (uint16_t)(((i * 7) & 0x3F) << 5) | (uint16_t)(i & 0x1F);
        strip[i] = c;
    }

    uint32_t y = 0;
    for (;;) {
        if (!displayOn) { vTaskDelay(pdMS_TO_TICKS(50)); continue; }

        uint32_t t0 = micros();
        // 满屏滚动的条带 + 顶部文字（模拟真实表盘刷新负担）
        for (uint32_t row = 0; row < LCD_HEIGHT; row += STRIP_LINES) {
            gfx->draw16bitRGBBitmap(0, row, strip, LCD_WIDTH, STRIP_LINES);
        }
        gfx->setTextColor(RGB565_BLACK, RGB565_WHITE);
        gfx->setTextSize(3);
        gfx->setCursor(12, 12);
        gfx->printf("f=%lu s=%lu", (unsigned long)dispFrames, (unsigned long)lifetimeSteps);

        uint32_t dt = micros() - t0;
        dispFrames++;
        dispSumUs += dt;
        if (dt > dispWorstUs) dispWorstUs = dt;
        (void)y;
        vTaskDelay(1);   // 让出 CPU（真实固件里这里是 lv_task_handler 的节拍）
    }
}

// ---------------------------------------------------------------- 启动时的一次性测量
static void benchPush() {
    if (!displayReady) return;

    const size_t fullPx = (size_t)LCD_WIDTH * LCD_HEIGHT;
    uint16_t *full = (uint16_t *)heap_caps_malloc(fullPx * 2, MALLOC_CAP_SPIRAM);
    const size_t stripPx = (size_t)LCD_WIDTH * STRIP_LINES;
    uint16_t *strip = (uint16_t *)heap_caps_malloc(stripPx * 2, MALLOC_CAP_SPIRAM);

    Serial.printf("[BENCH] PSRAM 全帧缓冲 402KB: %s\n", full ? "OK" : "FAIL");
    Serial.printf("[BENCH] PSRAM 条带缓冲  41KB: %s\n", strip ? "OK" : "FAIL");

    if (full) {
        for (size_t i = 0; i < fullPx; i++) full[i] = (uint16_t)(i & 0xFFFF);
        uint32_t best = 0xFFFFFFFF, worst = 0, sum = 0;
        for (int k = 0; k < 5; k++) {
            uint32_t t0 = micros();
            gfx->draw16bitRGBBitmap(0, 0, full, LCD_WIDTH, LCD_HEIGHT);
            uint32_t dt = micros() - t0;
            sum += dt; if (dt < best) best = dt; if (dt > worst) worst = dt;
        }
        Serial.printf("[BENCH] 全帧 402KB: avg=%.1fms best=%.1fms worst=%.1fms\n",
                      sum / 5.0f / 1000.0f, best / 1000.0f, worst / 1000.0f);
        free(full);
    }

    if (strip) {
        for (size_t i = 0; i < stripPx; i++) strip[i] = (uint16_t)(i & 0xFFFF);
        uint32_t best = 0xFFFFFFFF, worst = 0, sum = 0;
        const int N = 50;
        for (int k = 0; k < N; k++) {
            uint32_t t0 = micros();
            gfx->draw16bitRGBBitmap(0, (k * STRIP_LINES) % LCD_HEIGHT, strip, LCD_WIDTH, STRIP_LINES);
            uint32_t dt = micros() - t0;
            sum += dt; if (dt < best) best = dt; if (dt > worst) worst = dt;
        }
        Serial.printf("[BENCH] 条带 41KB:   avg=%.2fms best=%.2fms worst=%.2fms (逐条推满一屏≈%.1fms)\n",
                      sum / (float)N / 1000.0f, best / 1000.0f, worst / 1000.0f,
                      (sum / (float)N / 1000.0f) * (LCD_HEIGHT / STRIP_LINES));
        free(strip);
    }
}

// ---------------------------------------------------------------- setup
void setup() {
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);
#endif
    delay(8000);   // 开一个足够宽的窗口让串口接上（探针固件，不追求开机速度）

    Serial.println();
    Serial.println("=== M0b probe: CO5300 + 25Hz 采样共存 + RTC/PMU ===");

    i2cMutex = xSemaphoreCreateMutex();

    // ---- 显示
    bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
    gfx = new Arduino_CO5300(bus, LCD_RESET, 0, LCD_WIDTH, LCD_HEIGHT, 22, 0, 0, 0);
    displayReady = gfx->begin();
    Serial.printf("[DISP] gfx->begin() = %s (%dx%d, col_offset1=22)\n",
                  displayReady ? "OK" : "FAIL", LCD_WIDTH, LCD_HEIGHT);
    if (displayReady) gfx->fillScreen(RGB565_BLACK);

    // ---- I2C 总线（共享）
    Wire.begin(IIC_SDA, IIC_SCL, 400000);
    delay(50);

    // ---- IMU
    i2cTake();
    sensorReady = qmi.begin(Wire, QMI8658_L_SLAVE_ADDRESS, IIC_SDA, IIC_SCL);
    if (sensorReady) {
        sensorReady = (qmi.configAccelerometer(SensorQMI8658::ACC_RANGE_4G,
                                               SensorQMI8658::ACC_ODR_250Hz,
                                               SensorQMI8658::LPF_MODE_0) == 0) &&
                      qmi.enableAccelerometer();
    }
    i2cGive();
    Serial.printf("[IMU ] QMI8658 = %s\n", sensorReady ? "OK" : "FAIL");

    // ---- RTC（OS 标志 = 是否断电丢时）
    i2cTake();
    rtcReady = rtc.begin(Wire, IIC_SDA, IIC_SCL);
    i2cGive();
    if (rtcReady) {
        i2cTake();
        bool integrity = rtc.isClockIntegrityGuaranteed();
        bool running   = rtc.isRunning();
        i2cGive();
        Serial.printf("[RTC ] PCF85063 OK | 时钟完整(OS=0) = %s | 正在走 = %s\n",
                      integrity ? "是" : "否（断电期间停振 → 无备份电源或电池耗尽）",
                      running ? "是" : "否");
    } else {
        Serial.println("[RTC ] PCF85063 未应答");
    }

    // ---- PMU 电量
    i2cTake();
    pmuReady = power.init(Wire, IIC_SDA, IIC_SCL, AXP2101_SLAVE_ADDRESS);
    if (pmuReady) {
        power.enableBattDetection();
        power.enableBattVoltageMeasure();
        power.enableVbusVoltageMeasure();
    }
    i2cGive();
    if (pmuReady) {
        i2cTake();
        int mv = power.getBattVoltage();
        int pct = power.getBatteryPercent();
        bool bat = power.isBatteryConnect();
        bool vbus = power.isVbusIn();
        i2cGive();
        Serial.printf("[PMU ] AXP2101 OK | 电池接入=%s 充电线=%s | %d mV | %d %%\n",
                      bat ? "是" : "否", vbus ? "是" : "否", mv, pct);
    } else {
        Serial.println("[PMU ] AXP2101 未应答");
    }

    stepCounter.configure(StepCounter::Config{});
    stepCounter.resetAll();

    benchPush();

    // ---- 起任务：采样 core1，显示 core0
    xTaskCreatePinnedToCore(samplerTask, "sampler", 4096, nullptr, 5, nullptr, 1);
    xTaskCreatePinnedToCore(displayTask, "display", 8192, nullptr, 3, nullptr, 0);

    winStartMs = millis();
    Serial.printf("[RUN ] 相位 A（只采样 60s）开始...\n");
}

// ---------------------------------------------------------------- loop：统计与相位切换
void loop() {
    const uint32_t now = millis();

    if (now - winStartMs >= WINDOW_MS) {
        const uint32_t elapsed = now - winStartMs;
        winStartMs = now;

        // 分母按真实经过时间算，别写死 125
        const uint32_t expected = elapsed / SAMPLE_PERIOD_MS;
        const uint32_t got = winSamples;
        winSamples = 0;

        const uint32_t ws = stepCounter.windowSteps();
        stepCounter.resetWindow();

        phaseSamples  += got;
        phaseExpected += expected;
        if (displayOn) { phaseBusySamples += got; phaseBusyExpected += expected; }
        else           { phaseIdleSamples += got; phaseIdleExpected += expected; }

        Serial.printf("[WIN] 采样=%lu/%lu 丢点=%.2f%% 步=%lu 显示=%s 帧=%lu 最差帧=%.1fms\n",
                      (unsigned long)got, (unsigned long)expected,
                      expected ? (100.0f * (1.0f - (float)got / expected)) : 0.0f,
                      (unsigned long)ws, displayOn ? "开" : "关",
                      (unsigned long)dispFrames,
                      dispWorstUs / 1000.0f);
    }

    // 相位切换
    static int phase = 0;
    static uint32_t phaseStart = 0;
    if (phaseStart == 0) phaseStart = millis();

    if (phase == 0 && millis() - phaseStart >= PHASE_MS) {
        const float lossIdle = phaseIdleExpected
            ? 100.0f * (1.0f - (float)phaseIdleSamples / phaseIdleExpected) : 0.0f;
        Serial.printf("\n[PHASE] A 结束（只采样 60s）：采样 %lu/%lu，丢点 %.2f%%\n\n",
                      (unsigned long)phaseIdleSamples, (unsigned long)phaseIdleExpected, lossIdle);
        displayOn = true;
        phase = 1;
        Serial.println("[RUN ] 相位 B（采样 + 全速刷屏 60s）开始...");
    } else if (phase == 1 && millis() - phaseStart >= 2 * PHASE_MS) {
        const float lossBusy = phaseBusyExpected
            ? 100.0f * (1.0f - (float)phaseBusySamples / phaseBusyExpected) : 0.0f;
        const float lossIdle = phaseIdleExpected
            ? 100.0f * (1.0f - (float)phaseIdleSamples / phaseIdleExpected) : 0.0f;
        Serial.printf("\n[PHASE] B 结束（刷屏 60s）：采样 %lu/%lu，丢点 %.2f%%\n",
                      (unsigned long)phaseBusySamples, (unsigned long)phaseBusyExpected, lossBusy);
        Serial.printf("[PHASE] 对比：只采样 %.2f%% → 刷屏 %.2f%%（差 %+.2f 个百分点）\n",
                      lossIdle, lossBusy, lossBusy - lossIdle);
        Serial.printf("[PHASE] 显示帧 %lu，平均帧时间 %.1fms，最差 %.1fms\n",
                      (unsigned long)dispFrames,
                      dispFrames ? dispSumUs / (float)dispFrames / 1000.0f : 0.0f,
                      dispWorstUs / 1000.0f);
        Serial.println("[PHASE] 判定：差 < 1 个百分点 = 任务分离方案成立\n");
        displayOn = false;
        phase = 2;
        Serial.println("[RUN ] 相位 C（只采样，长跑）——可直接看丢点是否随时间恶化");
    }

    delay(50);
}
