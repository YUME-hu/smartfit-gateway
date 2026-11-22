/**
 * watch_lvgl.ino —— M1a/M1b 表盘：LVGL 9 + CO5300 PARTIAL，采样在 core1 独立任务
 *
 * 视觉主题：DeepSeek 蓝（#4D6BFE）+ 流浪地球式工业仪表
 *   - 深空黑蓝底、切角细线外框、冰青高亮、告警橙
 *   - 主信息：时间 / 步数 / 强度分段
 *   - 右下角极简线稿鲸鱼（呼应宠物主线的 DeepSeek 大肥鱼 IP）
 *   - 一条扫描线在面板上缓慢下扫（既是风格，也让帧率有意义）
 *
 * 结构（M0b 实测结论）：
 *   - 采样 core1 优先级 5；LVGL core0 优先级 3；loop() 只打统计
 *   - PARTIAL 双缓冲 410×50×2B（内部 RAM）；flush 用 BE 版本跳过字节交换
 *   - I2C 互斥：QMI8658 / AXP2101 共用 Wire
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
#include "SensorPCF85063.hpp"
#include <XPowersLib.h>
#include "../common/step_counter.h"
#include "whale_girl.h"
#include "Arduino_DriveBus_Library.h"

// ---------------------------------------------------------------- 配置
#define SAMPLE_PERIOD_MS 40      // 25Hz
#define WINDOW_MS        5000    // 统计窗口
#define BUF_LINES        50      // 410×50×2 = 41KB
#define STEP_TARGET      8000    // 步数目标（进度用，M2 可由手机下发）
#define CAL_SCREEN       0       // 1 = 开机先显示校准图案（排查色序/可见区用）

// ---------------------------------------------------------------- 全局
static Arduino_DataBus *bus = nullptr;
static Arduino_GFX     *gfx = nullptr;
static lv_display_t    *disp = nullptr;
static uint16_t        *buf1 = nullptr;
static uint16_t        *buf2 = nullptr;

static SensorQMI8658 qmi;
static SensorPCF85063 rtc;
static bool rtcOk = false;
static StepCounter   stepCounter;
static SemaphoreHandle_t i2cMutex = nullptr;
static bool sensorReady = false;

static XPowersPMU power;
static bool pmuReady = false;

// 采样统计
static volatile uint32_t winSamples = 0;
static volatile uint32_t lifetimeSteps = 0;
static volatile uint32_t totalSamples = 0, totalExpected = 0;

// flush 统计
static volatile uint32_t flushCnt = 0, flushSumUs = 0, flushMaxUs = 0, flushPx = 0;

// 电源状态
static volatile int  battMv = 0, battPct = -1;
static volatile bool vbusIn = true;

// UI 对象（只在 core0 的 LVGL 任务里访问）
static lv_obj_t *lblTime = nullptr, *lblSteps = nullptr, *lblLink = nullptr;
static lv_obj_t *lblBatt = nullptr, *lblInfo = nullptr, *scanLine = nullptr;
static lv_obj_t *whaleImg = nullptr;
static lv_obj_t *segBar[5] = {nullptr};
static volatile uint32_t uiFrames = 0;

// ---- 视觉主题（用户指定色板）
#define C_BG     lv_color_hex(0x000000)   // 背景（OLED 真黑）
#define C_INK    lv_color_hex(0xEAF0FF)   // 主文字/数字
#define C_BLUE   lv_color_hex(0x4D6BFE)   // 品牌强调、数据条、鲸鱼
#define C_BLUE_HI lv_color_hex(0x8FA8FF)  // 鲸鱼高光
#define C_DIM    lv_color_hex(0x55648A)   // 次级标签
#define C_DIM2   lv_color_hex(0x8FA3C8)   // 日期、电量文字
#define C_HAIR   lv_color_hex(0x1C2A4A)   // 发丝线、刻度
#define C_MINT   lv_color_hex(0x6FE3D2)   // 正常/在线
#define C_CORAL  lv_color_hex(0xFF6B4A)   // 告警（低电/断连，本屏未用）

// ---- 页面 / 触摸
static lv_obj_t *pages[3] = {nullptr};
static int       curPage = 0;
static lv_obj_t *dots[3] = {nullptr};
static lv_obj_t *setVal[6] = {nullptr};
static lv_obj_t *lblTrTime = nullptr, *lblTrSteps = nullptr, *lblTrState = nullptr;

static std::shared_ptr<Arduino_IIC_DriveBus> iicBus;
static std::unique_ptr<Arduino_IIC>          touchDev;
static bool touchReady = false;
static struct { bool down; int32_t x0, y0, x1, y1; uint32_t lastMs; } gTouch = {false, 0, 0, 0, 0, 0};

static bool     trRunning = false;
static uint32_t trAccumMs = 0, trStartMs = 0, trStepBase = 0;

static void showPage(int p);
static void handleGesture(int32_t x0, int32_t y0, int32_t x1, int32_t y1);
// ---------------------------------------------------------------- LVGL 显示
static void disp_flush_cb(lv_display_t *d, const lv_area_t *area, uint8_t *px_map) {
    const uint32_t t0 = micros();
    const int32_t w = lv_area_get_width(area);
    const int32_t h = lv_area_get_height(area);

    // 实测：BeRGB 版本会字节交换 → 整屏反色；RGB 版本才是对的（校准图第 3 行）
    gfx->draw16bitRGBBitmap(area->x1, area->y1, (uint16_t *)px_map, w, h);

    const uint32_t dt = micros() - t0;
    flushCnt++;
    flushSumUs += dt;
    if (dt > flushMaxUs) flushMaxUs = dt;
    flushPx += (uint32_t)(w * h);

    lv_display_flush_ready(d);
}

static uint32_t tick_cb() { return (uint32_t)millis(); }

/** CO5300 要求偶对齐的刷新区域 */
static void rounder_cb(lv_event_t *e) {
    lv_area_t *area = (lv_area_t *)lv_event_get_param(e);
    area->x1 = (area->x1 >> 1) << 1;
    area->y1 = (area->y1 >> 1) << 1;
    area->x2 = ((area->x2 >> 1) << 1) + 1;
    area->y2 = ((area->y2 >> 1) << 1) + 1;
}

static void onRefrReady(lv_event_t *) { uiFrames++; }

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

// ---------------------------------------------------------------- UI 构建
static lv_obj_t *makeLine(lv_obj_t *parent, lv_point_precise_t *pts, uint16_t n,
                          lv_color_t color, int32_t width) {
    lv_obj_t *l = lv_line_create(parent);
    lv_line_set_points(l, pts, n);
    lv_obj_set_style_line_color(l, color, 0);
    lv_obj_set_style_line_width(l, width, 0);
    lv_obj_set_style_line_rounded(l, true, 0);
    lv_obj_set_style_line_opa(l, LV_OPA_COVER, 0);
    lv_obj_remove_flag(l, LV_OBJ_FLAG_CLICKABLE);
    return l;
}




// ---------------------------------------------------------------- 页面切换
static void showPage(int p) {
    if (p < 0) p = 2;
    if (p > 2) p = 0;
    curPage = p;
    for (int i = 0; i < 3; i++) {
        if (!pages[i]) continue;
        if (i == p) lv_obj_remove_flag(pages[i], LV_OBJ_FLAG_HIDDEN);
        else        lv_obj_add_flag(pages[i], LV_OBJ_FLAG_HIDDEN);
        if (dots[i]) lv_obj_set_style_bg_color(dots[i], (i == p) ? C_BLUE : C_HAIR, 0);
    }
}

static void handleGesture(int32_t x0, int32_t y0, int32_t x1, int32_t y1) {
    const int32_t dx = x1 - x0;
    Serial.printf("[TOUCH] press(%ld,%ld) release(%ld,%ld) dx=%ld\n",
                  (long)x0, (long)y0, (long)x1, (long)y1, (long)dx);

    if (dx > 50 || x0 < 130) { showPage(curPage - 1); return; }
    if (dx < -50 || x0 > 280) { showPage(curPage + 1); return; }

    if (curPage == 1) {
        if (trRunning) { trAccumMs += millis() - trStartMs; trRunning = false; }
        else           { trStartMs = millis(); trStepBase = lifetimeSteps; trRunning = true; }
        Serial.printf("[TRN ] %s\n", trRunning ? "start" : "stop");
    }
}

// ---------------------------------------------------------------- 触摸读取
static void touchReadCb(lv_indev_t *, lv_indev_data_t *data) {
    static uint32_t lastPoll = 0;
    static lv_point_t pt = {0, 0};
    static bool down = false;

    if (millis() - lastPoll >= 20) {
        lastPoll = millis();

        int32_t x = 0, y = 0;
        bool got = false;
        if (touchDev && xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
            if (touchDev->IIC_Interrupt_Flag) {
                touchDev->IIC_Interrupt_Flag = false;
                x = touchDev->IIC_Read_Device_Value(
                        touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_COORDINATE_X);
                y = touchDev->IIC_Read_Device_Value(
                        touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_COORDINATE_Y);
                // 无手指时芯片可能返回 -1 或超范围值，必须过滤，
                // 否则开机那次"伪中断"会直接把页面切走
                got = (x >= 0 && y >= 0 && x < LCD_WIDTH && y < LCD_HEIGHT);
            }
            xSemaphoreGive(i2cMutex);
        }

        if (got) {
            pt.x = (lv_coord_t)x;
            pt.y = (lv_coord_t)y;
            gTouch.x1 = x; gTouch.y1 = y; gTouch.lastMs = millis();
            if (!gTouch.down) { gTouch.down = true; gTouch.x0 = x; gTouch.y0 = y; }
            down = true;
        } else if (gTouch.down && millis() - gTouch.lastMs > 80) {
            gTouch.down = false;
            down = false;
            handleGesture(gTouch.x0, gTouch.y0, gTouch.x1, gTouch.y1);
        }
    }

    data->point = pt;
    data->state = down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}
static void touchISR() {
    if (touchDev) touchDev->IIC_Interrupt_Flag = true;
}
static lv_obj_t *mkPage(lv_obj_t *parent) {
    lv_obj_t *p = lv_obj_create(parent);
    lv_obj_remove_style_all(p);
    lv_obj_set_size(p, LCD_WIDTH, LCD_HEIGHT);
    lv_obj_set_pos(p, 0, 0);
    lv_obj_remove_flag(p, LV_OBJ_FLAG_SCROLLABLE);
    return p;
}

static lv_obj_t *mkText(lv_obj_t *parent, const lv_font_t *font, lv_color_t color,
                        int32_t x, int32_t y, const char *txt) {
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, color, 0);
    lv_label_set_text(l, txt);
    lv_obj_set_pos(l, x, y);
    return l;
}

static void buildUi() {
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, C_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    for (int i = 0; i < 3; i++) pages[i] = mkPage(scr);

    // 页面指示点（放在最上层）
    for (int i = 0; i < 3; i++) {
        dots[i] = lv_obj_create(scr);
        lv_obj_remove_style_all(dots[i]);
        lv_obj_set_size(dots[i], 8, 8);
        lv_obj_set_pos(dots[i], 187 + i * 14, 452);
        lv_obj_set_style_radius(dots[i], LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_color(dots[i], C_HAIR, 0);
        lv_obj_set_style_bg_opa(dots[i], LV_OPA_COVER, 0);
    }

    // ================= 页 0：表盘 =================
    lv_obj_t *p0 = pages[0];
    {
        static lv_point_precise_t brTL[] = {{34, 60}, {34, 34}, {60, 34}};
        static lv_point_precise_t brTR[] = {{350, 34}, {376, 34}, {376, 60}};
        static lv_point_precise_t brBR[] = {{376, 442}, {376, 468}, {350, 468}};
        static lv_point_precise_t brBL[] = {{60, 468}, {34, 468}, {34, 442}};
        makeLine(p0, brTL, 3, C_HAIR, 2);
        makeLine(p0, brTR, 3, C_HAIR, 2);
        makeLine(p0, brBR, 3, C_HAIR, 2);
        makeLine(p0, brBL, 3, C_HAIR, 2);

        static lv_point_precise_t diamond[] = {{46, 40}, {53, 48}, {46, 56}, {39, 48}, {46, 40}};
        makeLine(p0, diamond, 5, C_BLUE, 2);

        mkText(p0, &lv_font_montserrat_14, C_DIM, 62, 36, "SMARTFIT");
        mkText(p0, &lv_font_montserrat_14, C_DIM2, 62, 54, "NAV-0PS");

        lblBatt = mkText(p0, &lv_font_montserrat_14, C_DIM2, 300, 40, "PWR --");

        lblTime = mkText(p0, &lv_font_montserrat_48, C_INK, 34, 84, "00:00");
        lblSteps = mkText(p0, &lv_font_montserrat_48, C_BLUE_HI, 34, 186, "0");
        mkText(p0, &lv_font_montserrat_20, C_DIM, 34, 246, "STEPS");
        mkText(p0, &lv_font_montserrat_14, C_DIM2, 120, 252, "GOAL 8000");

        static lv_point_precise_t accent[] = {{34, 282}, {88, 282}};
        makeLine(p0, accent, 2, C_BLUE, 3);

        for (int i = 0; i < 5; i++) {
            segBar[i] = lv_obj_create(p0);
            lv_obj_remove_style_all(segBar[i]);
            lv_obj_set_size(segBar[i], 56, 8);
            lv_obj_set_pos(segBar[i], 36 + i * 68, 296);
            lv_obj_set_style_bg_color(segBar[i], C_HAIR, 0);
            lv_obj_set_style_bg_opa(segBar[i], LV_OPA_COVER, 0);
        }

        whaleImg = lv_image_create(p0);
        lv_image_set_src(whaleImg, &whale_girl_frames[0]);
        lv_obj_set_pos(whaleImg, 262, 322);
        lv_obj_remove_flag(whaleImg, LV_OBJ_FLAG_CLICKABLE);

        lblLink = mkText(p0, &lv_font_montserrat_20, C_DIM, 34, 428, "LINK --");
    }

    // ================= 页 1：训练 =================
    lv_obj_t *p1 = pages[1];
    {
        static lv_point_precise_t brTL[] = {{34, 60}, {34, 34}, {60, 34}};
        static lv_point_precise_t brTR[] = {{350, 34}, {376, 34}, {376, 60}};
        static lv_point_precise_t brBR[] = {{376, 442}, {376, 468}, {350, 468}};
        static lv_point_precise_t brBL[] = {{60, 468}, {34, 468}, {34, 442}};
        makeLine(p1, brTL, 3, C_HAIR, 2);
        makeLine(p1, brTR, 3, C_HAIR, 2);
        makeLine(p1, brBR, 3, C_HAIR, 2);
        makeLine(p1, brBL, 3, C_HAIR, 2);

        mkText(p1, &lv_font_montserrat_14, C_DIM, 34, 40, "TRAINING / SESSION");

        lblTrTime = mkText(p1, &lv_font_montserrat_48, C_INK, 34, 96, "00:00");

        lblTrSteps = mkText(p1, &lv_font_montserrat_48, C_BLUE_HI, 34, 196, "0");
        mkText(p1, &lv_font_montserrat_20, C_DIM, 34, 256, "STEPS");

        lblTrState = mkText(p1, &lv_font_montserrat_20, C_DIM, 34, 316, "IDLE");
        mkText(p1, &lv_font_montserrat_14, C_DIM2, 34, 420, "TAP CENTER = START / STOP");
    }

    // ================= 页 2：设置 =================
    lv_obj_t *p2 = pages[2];
    {
        static lv_point_precise_t brTL[] = {{34, 60}, {34, 34}, {60, 34}};
        static lv_point_precise_t brTR[] = {{350, 34}, {376, 34}, {376, 60}};
        static lv_point_precise_t brBR[] = {{376, 442}, {376, 468}, {350, 468}};
        static lv_point_precise_t brBL[] = {{60, 468}, {34, 468}, {34, 442}};
        makeLine(p2, brTL, 3, C_HAIR, 2);
        makeLine(p2, brTR, 3, C_HAIR, 2);
        makeLine(p2, brBR, 3, C_HAIR, 2);
        makeLine(p2, brBL, 3, C_HAIR, 2);

        mkText(p2, &lv_font_montserrat_14, C_DIM, 34, 40, "SETTINGS");

        const char *keys[6] = {"POWER", "SOURCE", "RTC", "SAMPLE", "DISPLAY", "FIRMWARE"};
        for (int i = 0; i < 6; i++) {
            const int32_t y = 96 + i * 40;
            mkText(p2, &lv_font_montserrat_14, C_DIM, 34, y, keys[i]);
            setVal[i] = mkText(p2, &lv_font_montserrat_14, C_DIM2, 200, y, "--");
        }

        mkText(p2, &lv_font_montserrat_14, C_DIM2, 34, 420, "SWIPE OR TAP EDGE TO SWITCH");
    }

    showPage(0);
}// ---------------------------------------------------------------- UI 任务（core0）
static void uiTask(void *) {
    uint32_t lastText = 0;
    static uint32_t fpsMs = 0, fpsFrames = 0;
    static float fpsNow = 0;

    for (;;) {
        if (millis() - lastText >= 200) {
            lastText = millis();
            const uint32_t up = millis() / 1000;

            // ---- 页 0
            int hh = (int)((up / 3600) % 24), mm = (int)((up / 60) % 60);
            if (rtcOk) {
                xSemaphoreTake(i2cMutex, portMAX_DELAY);
                RTC_DateTime dt = rtc.getDateTime();
                hh = dt.getHour();
                mm = dt.getMinute();
                xSemaphoreGive(i2cMutex);
            }
            lv_label_set_text_fmt(lblTime, "%02d:%02d", hh, mm);
            lv_label_set_text_fmt(lblSteps, "%lu", (unsigned long)lifetimeSteps);

            const uint32_t pct = (lifetimeSteps * 100) / STEP_TARGET;
            for (int i = 0; i < 5; i++)
                lv_obj_set_style_bg_color(segBar[i], ((int)pct >= (i + 1) * 20) ? C_BLUE : C_HAIR, 0);

            if (pmuReady) {
                if (battPct >= 0) lv_label_set_text_fmt(lblBatt, "%d%%", (int)battPct);
                else              lv_label_set_text_fmt(lblBatt, "%dmV", (int)battMv);
                lv_obj_set_style_text_color(lblBatt, vbusIn ? C_MINT : C_DIM2, 0);
            }

            // ---- 页 1
            const uint32_t tms = trAccumMs + (trRunning ? (millis() - trStartMs) : 0);
            lv_label_set_text_fmt(lblTrTime, "%02lu:%02lu",
                                  (unsigned long)(tms / 60000), (unsigned long)((tms / 1000) % 60));
            lv_label_set_text_fmt(lblTrSteps, "%lu",
                                  (unsigned long)(trRunning ? (lifetimeSteps - trStepBase) : 0));
            lv_label_set_text(lblTrState, trRunning ? "RUNNING" : "IDLE");
            lv_obj_set_style_text_color(lblTrState, trRunning ? C_MINT : C_DIM, 0);

            // ---- 页 2
            lv_label_set_text_fmt(setVal[0], "%dmV  %d%%", (int)battMv, (int)battPct);
            lv_label_set_text(setVal[1], vbusIn ? "USB" : "BATTERY");
            lv_label_set_text(setVal[2], rtcOk ? "OK" : "FAIL");
            const uint32_t loss1000 = totalExpected
                ? (uint32_t)(1000.0f * (1.0f - (float)totalSamples / totalExpected)) : 0;
            lv_label_set_text_fmt(setVal[3], "%lu.%lu%%  n=%lu",
                                  (unsigned long)(loss1000 / 10), (unsigned long)(loss1000 % 10),
                                  (unsigned long)totalSamples);
            const uint32_t avgFlush = flushCnt ? flushSumUs / flushCnt : 0;
            lv_label_set_text_fmt(setVal[4], "%d fps  %lums", (int)fpsNow,
                                  (unsigned long)(avgFlush / 1000));
            lv_label_set_text(setVal[5], "M1b  LVGL 9.3");
        }

        // fps（独立于 loop 的 5 秒窗口）
        if (millis() - fpsMs >= 1000) {
            const uint32_t n = uiFrames;
            fpsNow = (float)(n - fpsFrames) * 1000.0f / (float)(millis() - fpsMs);
            fpsFrames = n;
            fpsMs = millis();
        }

        // 鲸鱼逐帧动画
        static uint8_t wf = 0;
        static uint32_t lastWf = 0;
        if (whaleImg && millis() - lastWf >= 160) {
            lastWf = millis();
            wf = (uint8_t)((wf + 1) % WHALE_FRAMES);
            lv_image_set_src(whaleImg, &whale_girl_frames[wf]);
        }

        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}
// ---------------------------------------------------------------- 字节序对比测量
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

// ---------------------------------------------------------------- 校准图案（直接走 Arduino_GFX，不经 LVGL）
static void drawCalibration() {
    if (!gfx) return;
    gfx->fillScreen(RGB565_BLACK);

    // ① 整屏 1px 白框：标记真实的 410×502 边界（被圆角切掉多少，一眼可见）
    gfx->drawRect(0, 0, LCD_WIDTH, LCD_HEIGHT, RGB565_WHITE);

    gfx->setTextColor(RGB565_WHITE, RGB565_BLACK);
    gfx->setTextSize(2);
    gfx->setCursor(12, 12);
    gfx->print("CAL 410x502");

    // ② 三行色块：fillRect / BE 位图 / RGB 位图 —— 用来判定色序与字节序
    const uint16_t colors[4] = {0xF800 /*R*/, 0x07E0 /*G*/, 0x001F /*B*/, 0xFFFF /*W*/};
    const uint16_t rows[3] = {60, 120, 180};

    // 第一行：fillRect
    for (int i = 0; i < 4; i++) gfx->fillRect(20 + i * 90, rows[0], 70, 40, colors[i]);

    // 准备 70×40 的小位图
    static uint16_t bmp[70 * 40];
    for (int i = 0; i < 4; i++) {
        for (int k = 0; k < 70 * 40; k++) bmp[k] = colors[i];
        // 第二行：BE 版本
        gfx->draw16bitBeRGBBitmap(20 + i * 90, rows[1], bmp, 70, 40);
        // 第三行：RGB 版本
        gfx->draw16bitRGBBitmap(20 + i * 90, rows[2], bmp, 70, 40);
    }

    gfx->setCursor(12, 46);  gfx->print("fillRect");
    gfx->setCursor(12, 106); gfx->print("draw16bitBeRGBBitmap");
    gfx->setCursor(12, 166); gfx->print("draw16bitRGBBitmap");

    // ③ 两张鲸鱼并排：BE 与 RGB 各一张，直接判定图像路径是否反色
    gfx->draw16bitBeRGBBitmap(20, 240, (uint16_t *)whale_girl_frames[0].data, WHALE_W, WHALE_H);
    gfx->draw16bitRGBBitmap(250, 240, (uint16_t *)whale_girl_frames[0].data, WHALE_W, WHALE_H);
    gfx->setTextColor(RGB565_WHITE, RGB565_BLACK);
    gfx->setCursor(20, 228);  gfx->print("BE");
    gfx->setCursor(250, 228); gfx->print("RGB");

    // ④ 圆角视野标定：三个内缩矩形 + 四条对角线
    for (int k = 0; k < 3; k++) {
        int in = 20 + k * 30;
        gfx->drawRect(in, in, LCD_WIDTH - 2 * in, LCD_HEIGHT - 2 * in, RGB565_WHITE);
    }
    gfx->drawLine(0, 0, LCD_WIDTH - 1, LCD_HEIGHT - 1, 0x7BEF);
    gfx->drawLine(LCD_WIDTH - 1, 0, 0, LCD_HEIGHT - 1, 0x7BEF);

    gfx->setCursor(12, LCD_HEIGHT - 30);
    gfx->print("inset 20/50/80");
}

// ---------------------------------------------------------------- setup
void setup() {
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);
#endif
    delay(3000);

    Serial.println();
    Serial.println("=== watch_lvgl: LVGL9 PARTIAL + 25Hz 采样 ===");
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

    // 校准图：换屏/换板/怀疑色序时把 CAL_SCREEN 打开，开机先显示 8 秒
    if (CAL_SCREEN) {
        drawCalibration();
        Serial.println("[CAL ] 校准图案 8 秒：整屏白框 / 三行色块 / 两张鲸鱼 / 三个内缩框");
        delay(8000);
    }

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

    // ---- RTC：板载无备份电源，一旦停振就用编译时刻初始化（M2 会改成手机对时）
    xSemaphoreTake(i2cMutex, portMAX_DELAY);
    rtcOk = rtc.begin(Wire, IIC_SDA, IIC_SCL);
    if (rtcOk) {
        const bool integrity = rtc.isClockIntegrityGuaranteed();
        if (!rtc.isRunning()) rtc.start();
        if (!integrity) rtc.setDateTime(RTC_DateTime(__DATE__, __TIME__));
    }
    xSemaphoreGive(i2cMutex);
    Serial.printf("[RTC ] PCF85063 = %s%s\n", rtcOk ? "OK" : "FAIL",
                  rtcOk ? "（停振则用编译时刻初始化）" : "");

    stepCounter.configure(StepCounter::Config{});
    stepCounter.resetAll();

    // ---- 电源
    xSemaphoreTake(i2cMutex, portMAX_DELAY);
    pmuReady = power.init(Wire, IIC_SDA, IIC_SCL, AXP2101_SLAVE_ADDRESS);
    if (pmuReady) {
        power.enableBattDetection();
        power.enableBattVoltageMeasure();
        power.enableVbusVoltageMeasure();
    }
    xSemaphoreGive(i2cMutex);
    Serial.printf("[PMU ] AXP2101 = %s\n", pmuReady ? "OK" : "FAIL");

    // ---- 触摸 FT3168（DriveBus；与 IMU/AXP 共用 Wire，读取时必须持锁）
    xSemaphoreTake(i2cMutex, portMAX_DELAY);
    iicBus = std::make_shared<Arduino_HWIIC>(IIC_SDA, IIC_SCL, &Wire);
    // 传 TP_RESET：让驱动做一次硬件复位序列，否则芯片可能停在上电后的未知状态
    touchDev.reset(new Arduino_FT3x68(iicBus, FT3168_DEVICE_ADDRESS, TP_RESET,
                                      TP_INT, touchISR));
    for (int attempt = 0; attempt < 3 && !touchReady; attempt++) {
        touchReady = touchDev->begin();
        if (!touchReady) {
            Serial.printf("[TOUCH] begin() 第 %d 次失败，重试\n", attempt + 1);
            delay(60);
        }
    }
    if (touchReady) {
        Serial.printf("[TOUCH] device id = 0x%02X\n", (unsigned)touchDev->IIC_Read_Device_ID());
    }
    if (touchReady) {
        touchDev->IIC_Write_Device_State(touchDev->Arduino_IIC_Touch::Device::TOUCH_POWER_MODE,
                                         touchDev->Arduino_IIC_Touch::Device_Mode::TOUCH_POWER_MONITOR);
    }
    xSemaphoreGive(i2cMutex);
    Wire.setClock(400000);   // DriveBus 内部可能把速率改回默认
    Serial.printf("[TOUCH] FT3168 = %s\n", touchReady ? "OK" : "FAIL");
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
    Serial.printf("[LVGL] 双缓冲 %d 行 = %u B ×2, 位置=%s\n",
                  BUF_LINES, (unsigned)bufBytes,
                  esp_ptr_internal(buf1) ? "内部RAM" : "PSRAM");

    disp = lv_display_create(LCD_WIDTH, LCD_HEIGHT);
    lv_display_set_flush_cb(disp, disp_flush_cb);
    lv_display_set_buffers(disp, buf1, buf2, bufBytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_add_event_cb(disp, rounder_cb, LV_EVENT_INVALIDATE_AREA, nullptr);
    lv_display_add_event_cb(disp, onRefrReady, LV_EVENT_REFR_READY, nullptr);

    buildUi();

    if (touchReady) {
        lv_indev_t *indev = lv_indev_create();
        lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
        lv_indev_set_read_cb(indev, touchReadCb);
        lv_indev_set_display(indev, disp);
        Serial.println("[TOUCH] 输入设备已挂到 LVGL");
    }

    xTaskCreatePinnedToCore(samplerTask, "sampler", 4096, nullptr, 5, nullptr, 1);
    xTaskCreatePinnedToCore(uiTask, "ui", 8192, nullptr, 3, nullptr, 0);

    Serial.printf("[RUN ] 采样 core1 / LVGL core0；统计每 %d ms 一行\n", WINDOW_MS);
}

// ---------------------------------------------------------------- loop：统计 + 读电源
void loop() {
    const uint32_t now = millis();
    static uint32_t winStart = 0;
    static uint32_t lastPmu = 0;
    if (winStart == 0) winStart = now;

    // 电源 2s 读一次（共享 I2C，必须持锁）
    if (pmuReady && now - lastPmu >= 2000) {
        lastPmu = now;
        xSemaphoreTake(i2cMutex, portMAX_DELAY);
        battMv = power.getBattVoltage();
        battPct = power.getBatteryPercent();
        vbusIn = power.isVbusIn();
        xSemaphoreGive(i2cMutex);
    }

    if (now - winStart >= WINDOW_MS) {
        const uint32_t elapsed = now - winStart;
        winStart = now;

        // 分母四舍五入，别用整数截断（会伪造约 0.8% 的"丢点"）
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

        flushCnt = 0; flushSumUs = 0; flushMaxUs = 0; flushPx = 0;
    }

    delay(20);
}
