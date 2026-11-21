/**
 * watch_lvgl.ino —— M1a：亮屏（LVGL 9 + CO5300 PARTIAL）+ 保采样（core1 25Hz）
 *
 * 相对 M0b 探针的三个结论，这一版把它们变成正式固件结构：
 *   1. 显示用 PARTIAL + 50 行缓冲（全帧 402KB/53.7ms 不可用，条带 41KB/5.4ms 可用）
 *   2. flush 用 draw16bitBeRGBBitmap（跳过 Arduino_GFX 的逐像素字节交换）
 *      —— 开机时自动做一次 RGB vs BE 的对比测量，瓶颈是否真的在字节序，看日志
 *   3. 采样在 core1 独立任务（优先级 5），LVGL 在 core0 任务（优先级 3），
 *      QMI8658 访问走互斥锁；loop() 只负责打统计，不碰 LVGL
 *
 * 串口统计每 5 秒一行：采样/期望/丢点率 + flush 耗时 + 帧数
 */
#include <Wire.h>
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

#include "pin_config.h"
#include <lvgl.h>
#include "Arduino_GFX_Library.h"
#include "SensorQMI8658.hpp"
#include "../common/step_counter.h"

// ---------------------------------------------------------------- 配置
#define SAMPLE_PERIOD_MS 40      // 25Hz
#define WINDOW_MS        5000    // 统计窗口 / 发包周期
#define BUF_LINES        50      // LVGL 局部缓冲高度（410×50×2 = 41KB）

// ---------------------------------------------------------------- 全局
static Arduino_DataBus *bus = nullptr;
static Arduino_GFX     *gfx = nullptr;
static lv_display_t    *disp = nullptr;
static uint16_t        *buf1 = nullptr;
static uint16_t        *buf2 = nullptr;

static SensorQMI8658 qmi;
static StepCounter   stepCounter;
static SemaphoreHandle_t i2cMutex = nullptr;
static bool sensorReady = false;

// 采样统计（写：core1；读：loop/core0）
static volatile uint32_t winSamples = 0;
static volatile uint32_t lifetimeSteps = 0;
static volatile uint32_t totalSamples = 0, totalExpected = 0;

// flush 统计
static volatile uint32_t flushCnt = 0, flushSumUs = 0, flushMaxUs = 0, flushPx = 0;

// UI 用（core0 独占 LVGL）
static lv_obj_t *lblSteps = nullptr, *lblTime = nullptr, *lblInfo = nullptr;
static lv_obj_t *barLoad = nullptr;
static volatile uint32_t uiFrames = 0;

// ---------------------------------------------------------------- LVGL
static void disp_flush_cb(lv_display_t *d, const lv_area_t *area, uint8_t *px_map) {
    const uint32_t t0 = micros();
    const int32_t w = lv_area_get_width(area);
    const int32_t h = lv_area_get_height(area);

    // BE 版本：数据已是 RGB565 大端，跳过逐像素交换
    gfx->draw16bitBeRGBBitmap(area->x1, area->y1, (uint16_t *)px_map, w, h);

    const uint32_t dt = micros() - t0;
    flushCnt++;
    flushSumUs += dt;
    if (dt > flushMaxUs) flushMaxUs = dt;
    flushPx += (uint32_t)(w * h);

    lv_display_flush_ready(d);
}

static uint32_t tick_cb() { return (uint32_t)millis(); }

/** CO5300 要求偶对齐的刷新区域，否则边缘会错位（官方例程同款做法） */
static void rounder_cb(lv_event_t *e) {
    lv_area_t *area = (lv_area_t *)lv_event_get_param(e);
    area->x1 = (area->x1 >> 1) << 1;
    area->y1 = (area->y1 >> 1) << 1;
    area->x2 = ((area->x2 >> 1) << 1) + 1;
    area->y2 = ((area->y2 >> 1) << 1) + 1;
}

// ---------------------------------------------------------------- 采样任务
static void samplerTask(void *) {
    const TickType_t period = pdMS_TO_TICKS(SAMPLE_PERIOD_MS);
    TickType_t lastWake = xTaskGetTickCount();

    for (;;) {
        vTaskDelayUntil(&lastWake, period);

        float x = 0, y = 0, z = 0;
        bool ok = false;
        xSemaphoreTake(i2cMutex, portMAX_DELAY);
        if (sensorReady) ok = qmi.getAccelerometer(x, y, z);
        xSemaphoreGive(i2cMutex);

        if (ok) {
            winSamples++;
            totalSamples++;
            if (stepCounter.feed(x, y, z, millis())) lifetimeSteps++;
        }
    }
}

/** LVGL 完成一帧刷新（真正出图）—— 用它统计真实帧率，而不是 handler 调用次数 */
static void onRefrReady(lv_event_t *) { uiFrames++; }

// ---------------------------------------------------------------- UI 任务（core0）
static void uiTask(void *) {
    uint32_t lastText = 0;
    for (;;) {
        // ① 文本/数值 200ms 更新一次（LVGL 不是线程安全的，所有 lv_* 调用只在这个任务里）
        if (millis() - lastText >= 200) {
            lastText = millis();
            lv_label_set_text_fmt(lblSteps, "%lu", (unsigned long)lifetimeSteps);
            const uint32_t up = millis() / 1000;
            lv_label_set_text_fmt(lblTime, "%02lu:%02lu",
                                  (unsigned long)(up / 60), (unsigned long)(up % 60));

            const uint32_t loss1000 = totalExpected
                ? (uint32_t)(1000.0f * (1.0f - (float)totalSamples / totalExpected)) : 0;
            const uint32_t avgFlush = flushCnt ? flushSumUs / flushCnt : 0;
            lv_label_set_text_fmt(lblInfo, "loss %lu.%lu%%\nflush %lums max %lums\npx %luK",
                                  (unsigned long)(loss1000 / 10), (unsigned long)(loss1000 % 10),
                                  (unsigned long)(avgFlush / 1000), (unsigned long)(flushMaxUs / 1000),
                                  (unsigned long)(flushPx / 1024));
            lv_bar_set_value(barLoad, (int32_t)(lifetimeSteps % 100), LV_ANIM_OFF);
        }

        // ② lv_timer_handler 必须按 LV_DEF_REFR_PERIOD(16ms) 的节奏跑，
        //    否则帧率被这里拖死（第一版就是这么掉到 5fps 的）
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}

// ---------------------------------------------------------------- 建界面
static void buildUi() {
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    // 顶部：计时
    lblTime = lv_label_create(scr);
    lv_obj_set_style_text_font(lblTime, &lv_font_montserrat_28, 0);
    lv_obj_set_style_text_color(lblTime, lv_color_hex(0x9FD3FF), 0);
    lv_label_set_text(lblTime, "00:00");
    lv_obj_align(lblTime, LV_ALIGN_TOP_MID, 0, 28);

    // 中间：步数（大数字）
    lblSteps = lv_label_create(scr);
    lv_obj_set_style_text_font(lblSteps, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(lblSteps, lv_color_white(), 0);
    lv_label_set_text(lblSteps, "0");
    lv_obj_align(lblSteps, LV_ALIGN_CENTER, 0, -20);

    lv_obj_t *cap = lv_label_create(scr);
    lv_obj_set_style_text_font(cap, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(cap, lv_color_hex(0x666666), 0);
    lv_label_set_text(cap, "STEPS");
    lv_obj_align(cap, LV_ALIGN_CENTER, 0, 40);

    // 底部：进度条 + 统计
    barLoad = lv_bar_create(scr);
    lv_obj_set_size(barLoad, 300, 10);
    lv_obj_align(barLoad, LV_ALIGN_BOTTOM_MID, 0, -120);
    lv_bar_set_range(barLoad, 0, 100);
    lv_obj_set_style_bg_color(barLoad, lv_color_hex(0x222222), LV_PART_MAIN);
    lv_obj_set_style_bg_color(barLoad, lv_color_hex(0x2ECC71), LV_PART_INDICATOR);

    lblInfo = lv_label_create(scr);
    lv_obj_set_style_text_font(lblInfo, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lblInfo, lv_color_hex(0x888888), 0);
    lv_obj_set_style_text_align(lblInfo, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_text(lblInfo, "boot");
    lv_obj_align(lblInfo, LV_ALIGN_BOTTOM_MID, 0, -30);

    // 持续动画：给"帧率"一个真实可测的对象（否则 LVGL 只在内容变了才重绘，
    // 5fps 的读数是"需求驱动"的，不是能力上限）
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, barLoad);
    lv_anim_set_values(&a, 0, 100);
    lv_anim_set_duration(&a, 1200);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_repeat_delay(&a, 0);
    lv_anim_set_exec_cb(&a, [](void *, int32_t v) { lv_bar_set_value(barLoad, v, LV_ANIM_OFF); });
    lv_anim_start(&a);
}

// ---------------------------------------------------------------- 开机前的字节序对比测量
static void benchSwap() {
    const size_t stripPx = (size_t)LCD_WIDTH * BUF_LINES;
    uint16_t *buf = (uint16_t *)heap_caps_malloc(stripPx * 2, MALLOC_CAP_SPIRAM);
    if (!buf) { Serial.println("[BENCH] 缓冲分配失败，跳过"); return; }
    for (size_t i = 0; i < stripPx; i++) buf[i] = (uint16_t)((i * 37) & 0xFFFF);

    const int N = 20;
    uint32_t tRgb = 0, tBe = 0;
    for (int k = 0; k < N; k++) {
        uint32_t t0 = micros();
        gfx->draw16bitRGBBitmap(0, 0, buf, LCD_WIDTH, BUF_LINES);
        tRgb += micros() - t0;
    }
    for (int k = 0; k < N; k++) {
        uint32_t t0 = micros();
        gfx->draw16bitBeRGBBitmap(0, 0, buf, LCD_WIDTH, BUF_LINES);
        tBe += micros() - t0;
    }
    Serial.printf("[BENCH] 50 行条带 41KB: RGB(带交换)=%.2fms  BE(免交换)=%.2fms  加速=%.2fx\n",
                  tRgb / (float)N / 1000.0f, tBe / (float)N / 1000.0f,
                  tBe ? (float)tRgb / (float)tBe : 0.0f);
    free(buf);
}

// ---------------------------------------------------------------- setup
void setup() {
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);
#endif
    delay(4000);

    Serial.println();
    Serial.println("=== M1a watch_lvgl: LVGL9 PARTIAL + 25Hz 采样 ===");
    Serial.printf("[LVGL] 版本 %d.%d.%d\n", lv_version_major(), lv_version_minor(), lv_version_patch());

    i2cMutex = xSemaphoreCreateMutex();

    // ---- 显示
    bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
    gfx = new Arduino_CO5300(bus, LCD_RESET, 0, LCD_WIDTH, LCD_HEIGHT, 22, 0, 0, 0);
    if (!gfx->begin()) {
        Serial.println("[DISP] gfx->begin() 失败");
    } else {
        gfx->fillScreen(RGB565_BLACK);
        Serial.printf("[DISP] OK %dx%d\n", LCD_WIDTH, LCD_HEIGHT);
    }
    benchSwap();

    // ---- I2C + IMU
    Wire.begin(IIC_SDA, IIC_SCL, 400000);
    delay(50);
    xSemaphoreTake(i2cMutex, portMAX_DELAY);
    sensorReady = qmi.begin(Wire, QMI8658_L_SLAVE_ADDRESS, IIC_SDA, IIC_SCL);
    if (sensorReady) {
        sensorReady = (qmi.configAccelerometer(SensorQMI8658::ACC_RANGE_4G,
                                               SensorQMI8658::ACC_ODR_250Hz,
                                               SensorQMI8658::LPF_MODE_0) == 0) &&
                      qmi.enableAccelerometer();
    }
    xSemaphoreGive(i2cMutex);
    Serial.printf("[IMU ] QMI8658 = %s\n", sensorReady ? "OK" : "FAIL");

    stepCounter.configure(StepCounter::Config{});
    stepCounter.resetAll();

    // ---- LVGL
    lv_init();
    lv_tick_set_cb(tick_cb);

    const size_t bufBytes = (size_t)LCD_WIDTH * BUF_LINES * sizeof(uint16_t);
    buf1 = (uint16_t *)heap_caps_malloc(bufBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    buf2 = (uint16_t *)heap_caps_malloc(bufBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf1 || !buf2) {
        Serial.println("[LVGL] 内部 RAM 分配失败，退回 PSRAM");
        if (!buf1) buf1 = (uint16_t *)heap_caps_malloc(bufBytes, MALLOC_CAP_SPIRAM);
        if (!buf2) buf2 = (uint16_t *)heap_caps_malloc(bufBytes, MALLOC_CAP_SPIRAM);
    }
    Serial.printf("[LVGL] 双缓冲 %d 行 ×2 = %u B each, 位置=%s\n",
                  BUF_LINES, (unsigned)bufBytes,
                  esp_ptr_internal(buf1) ? "内部RAM" : "PSRAM");

    disp = lv_display_create(LCD_WIDTH, LCD_HEIGHT);
    lv_display_set_flush_cb(disp, disp_flush_cb);
    lv_display_set_buffers(disp, buf1, buf2, bufBytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_add_event_cb(disp, rounder_cb, LV_EVENT_INVALIDATE_AREA, nullptr);
    lv_display_add_event_cb(disp, onRefrReady, LV_EVENT_REFR_READY, nullptr);

    buildUi();

    // ---- 起任务
    xTaskCreatePinnedToCore(samplerTask, "sampler", 4096, nullptr, 5, nullptr, 1);
    xTaskCreatePinnedToCore(uiTask, "ui", 8192, nullptr, 3, nullptr, 0);

    Serial.printf("[RUN ] 采样 core1 / LVGL core0；统计每 %d ms 一行\n", WINDOW_MS);
}

// ---------------------------------------------------------------- loop：只统计和打印
void loop() {
    const uint32_t now = millis();
    static uint32_t winStart = 0;
    if (winStart == 0) winStart = now;

    if (now - winStart >= WINDOW_MS) {
        const uint32_t elapsed = now - winStart;
        winStart = now;

        // 分母按真实经过时间算，并**四舍五入**：整数截断会系统性少算
        // （5001ms/40=125 而实际可能采到 126，累计起来会伪造出 ~0.8% 的"丢点"）
        const uint32_t expected = (elapsed + SAMPLE_PERIOD_MS / 2) / SAMPLE_PERIOD_MS;
        const uint32_t got = winSamples;
        winSamples = 0;
        totalExpected += expected;

        const uint32_t ws = stepCounter.windowSteps();
        stepCounter.resetWindow();

        const uint32_t avgFlush = flushCnt ? flushSumUs / flushCnt : 0;
        Serial.printf("[WIN] 采样=%lu/%lu 丢点=%.2f%% 步=%lu | flush avg=%luus max=%luus 次=%lu px=%luK | ui帧=%lu\n",
                      (unsigned long)got, (unsigned long)expected,
                      expected ? (100.0f * (1.0f - (float)got / expected)) : 0.0f,
                      (unsigned long)ws,
                      (unsigned long)avgFlush, (unsigned long)flushMaxUs,
                      (unsigned long)flushCnt, (unsigned long)(flushPx / 1024),
                      (unsigned long)uiFrames);

        flushCnt = 0; flushSumUs = 0; flushMaxUs = 0; flushPx = 0; uiFrames = 0;
    }

    delay(20);
}
