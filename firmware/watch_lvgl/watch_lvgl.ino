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
#include <Preferences.h>

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
static struct { bool down; int32_t x0, y0, x1, y1; uint32_t lastMs, t0; } gTouch = {false, 0, 0, 0, 0, 0, 0};

static bool     trRunning = false;
static uint32_t trAccumMs = 0, trStartMs = 0, trStepBase = 0;

static void showPage(int p);
static void handleGesture(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint32_t durMs);
// ---- 设置导航与参数
static int        subPage = -1;                 // -1 = 设置列表；0..2 = 子页
static lv_obj_t  *subPages[3] = {nullptr};
static lv_obj_t  *hubVal[3]   = {nullptr};
static lv_obj_t  *lblGoalVal = nullptr, *lblRestVal = nullptr, *lblCalVal = nullptr;
static lv_obj_t  *lblBattDet = nullptr;

static int  goalSteps = 8000;
static int  restSec   = 60;
static int  battCal   = 100;                     // 电池百分比校准系数 80..120
static Preferences prefs;

static void openSub(int i);
static void closeSub();
static void rowClickCb(lv_event_t *e);
static void sliderCb(lv_event_t *e);
static void addFrame(lv_obj_t *p);
static lv_obj_t *mkRow(lv_obj_t *parent, int32_t y, const char *key, int idx);

/** 校准后的电量百分比：3.4V=0%，4.2V=100%，再乘系数 */
static int battPctCalibrated() {
    if (!pmuReady) return -1;
    int p = (battMv - 3400) * 100 / 800;
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    p = p * battCal / 100;
    if (p > 100) p = 100;
    return p;
}
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

static void handleGesture(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint32_t durMs) {
    const int32_t dx = x1 - x0;
    Serial.printf("[TOUCH] (%ld,%ld)->(%ld,%ld) dx=%ld dur=%lums page=%d sub=%d\n",
                  (long)x0, (long)y0, (long)x1, (long)y1, (long)dx,
                  (unsigned long)durMs, curPage, subPage);

    // 长按 ≥1 秒：兜底回表盘（触摸失灵/迷路时的逃生口）
    if (durMs >= 1000) { closeSub(); showPage(0); return; }

    // 子页：右滑返回
    if (subPage >= 0) {
        if (dx > 50) closeSub();
        return;
    }

    // 设置列表页：只允许滑动换页（避免和行点击打架）
    if (curPage == 2) {
        if (dx > 50) showPage(1);
        else if (dx < -50) showPage(0);
        return;
    }

    // 表盘 / 训练页：滑动或边点翻页
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
            if (!gTouch.down) { gTouch.down = true; gTouch.x0 = x; gTouch.y0 = y; gTouch.t0 = millis(); }
            down = true;
        } else if (gTouch.down && millis() - gTouch.lastMs > 80) {
            gTouch.down = false;
            down = false;
            handleGesture(gTouch.x0, gTouch.y0, gTouch.x1, gTouch.y1, millis() - gTouch.t0);
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

static void addFrame(lv_obj_t *p) {
    static lv_point_precise_t a[] = {{34, 60}, {34, 34}, {60, 34}};
    static lv_point_precise_t b[] = {{350, 34}, {376, 34}, {376, 60}};
    static lv_point_precise_t c[] = {{376, 442}, {376, 468}, {350, 468}};
    static lv_point_precise_t d[] = {{60, 468}, {34, 468}, {34, 442}};
    makeLine(p, a, 3, C_HAIR, 2);
    makeLine(p, b, 3, C_HAIR, 2);
    makeLine(p, c, 3, C_HAIR, 2);
    makeLine(p, d, 3, C_HAIR, 2);
}

static void rowClickCb(lv_event_t *e) {
    lv_obj_t *r = (lv_obj_t *)lv_event_get_target(e);
    const int idx = (int)(intptr_t)lv_obj_get_user_data(r);
    if (idx < 0) { closeSub(); return; }   // -1 = 返回行
    openSub(idx);
}

static void sliderCb(lv_event_t *e) {
    lv_obj_t *s = (lv_obj_t *)lv_event_get_target(e);
    const int idx = (int)(intptr_t)lv_obj_get_user_data(s);
    const int v = (int)lv_slider_get_value(s);
    if (idx == 0) goalSteps = v;
    else if (idx == 1) restSec = v;
    else battCal = v;

    if (lv_event_get_code(e) == LV_EVENT_RELEASED) {
        prefs.putInt("goal", goalSteps);
        prefs.putInt("rest", restSec);
        prefs.putInt("cal", battCal);
        Serial.printf("[SET ] goal=%d rest=%d cal=%d\n", goalSteps, restSec, battCal);
    }
}

static lv_obj_t *mkSlider(lv_obj_t *parent, int32_t y, int idx, int vmin, int vmax, int val) {
    lv_obj_t *s = lv_slider_create(parent);
    lv_obj_set_size(s, 300, 8);
    lv_obj_set_pos(s, 36, y);
    lv_slider_set_range(s, vmin, vmax);
    lv_slider_set_value(s, val, LV_ANIM_OFF);
    lv_obj_set_user_data(s, (void *)(intptr_t)idx);
    lv_obj_add_event_cb(s, sliderCb, LV_EVENT_ALL, nullptr);
    lv_obj_set_style_bg_color(s, C_HAIR, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s, C_BLUE, LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(s, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(s, C_BLUE_HI, LV_PART_KNOB);
    lv_obj_set_style_bg_opa(s, LV_OPA_COVER, LV_PART_KNOB);
    return s;
}

static lv_obj_t *mkRow(lv_obj_t *parent, int32_t y, const char *key, int idx) {
    lv_obj_t *r = lv_obj_create(parent);
    lv_obj_remove_style_all(r);
    lv_obj_set_size(r, 342, 62);
    lv_obj_set_pos(r, 34, y);
    lv_obj_add_flag(r, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_bg_color(r, C_HAIR, 0);
    lv_obj_set_style_bg_opa(r, 0, 0);
    lv_obj_set_style_bg_opa(r, 120, LV_STATE_PRESSED);
    lv_obj_set_user_data(r, (void *)(intptr_t)idx);
    lv_obj_add_event_cb(r, rowClickCb, LV_EVENT_CLICKED, nullptr);
    mkText(r, &lv_font_montserrat_20, C_INK, 6, 18, key);
    mkText(r, &lv_font_montserrat_20, C_DIM, 316, 18, ">");
    return r;
}

static void openSub(int i) {
    subPage = i;
    for (int k = 0; k < 3; k++) {
        if (!subPages[k]) continue;
        if (k == i) lv_obj_remove_flag(subPages[k], LV_OBJ_FLAG_HIDDEN);
        else        lv_obj_add_flag(subPages[k], LV_OBJ_FLAG_HIDDEN);
    }
    for (int k = 0; k < 3; k++) if (dots[k]) lv_obj_add_flag(dots[k], LV_OBJ_FLAG_HIDDEN);
    Serial.printf("[UI  ] 进入子页 %d\n", i);
}

static void closeSub() {
    subPage = -1;
    for (int k = 0; k < 3; k++) if (subPages[k]) lv_obj_add_flag(subPages[k], LV_OBJ_FLAG_HIDDEN);
    for (int k = 0; k < 3; k++) if (dots[k]) lv_obj_remove_flag(dots[k], LV_OBJ_FLAG_HIDDEN);
    Serial.println("[UI  ] 返回设置列表");
}
static void buildUi() {
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, C_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    for (int i = 0; i < 3; i++) pages[i] = mkPage(scr);

    // 页面指示点
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
    {
        lv_obj_t *p = pages[0];
        addFrame(p);
        static lv_point_precise_t diamond[] = {{46, 40}, {53, 48}, {46, 56}, {39, 48}, {46, 40}};
        makeLine(p, diamond, 5, C_BLUE, 2);
        mkText(p, &lv_font_montserrat_14, C_DIM, 62, 36, "SMARTFIT");
        mkText(p, &lv_font_montserrat_14, C_DIM2, 62, 54, "NAV-0PS");
        lblBatt = mkText(p, &lv_font_montserrat_14, C_DIM2, 300, 40, "--");
        lblTime = mkText(p, &lv_font_montserrat_48, C_INK, 34, 84, "00:00");
        lblSteps = mkText(p, &lv_font_montserrat_48, C_BLUE_HI, 34, 186, "0");
        mkText(p, &lv_font_montserrat_20, C_DIM, 34, 246, "STEPS");
        mkText(p, &lv_font_montserrat_14, C_DIM2, 120, 252, "GOAL --");
        static lv_point_precise_t accent[] = {{34, 282}, {88, 282}};
        makeLine(p, accent, 2, C_BLUE, 3);
        for (int i = 0; i < 5; i++) {
            segBar[i] = lv_obj_create(p);
            lv_obj_remove_style_all(segBar[i]);
            lv_obj_set_size(segBar[i], 56, 8);
            lv_obj_set_pos(segBar[i], 36 + i * 68, 296);
            lv_obj_set_style_bg_color(segBar[i], C_HAIR, 0);
            lv_obj_set_style_bg_opa(segBar[i], LV_OPA_COVER, 0);
        }
        whaleImg = lv_image_create(p);
        lv_image_set_src(whaleImg, &whale_girl_frames[0]);
        lv_obj_set_pos(whaleImg, 262, 322);
        lv_obj_remove_flag(whaleImg, LV_OBJ_FLAG_CLICKABLE);
        lblLink = mkText(p, &lv_font_montserrat_20, C_DIM, 34, 428, "LINK --");
    }

    // ================= 页 1：训练 =================
    {
        lv_obj_t *p = pages[1];
        addFrame(p);
        mkText(p, &lv_font_montserrat_14, C_DIM, 34, 40, "TRAINING / SESSION");
        lblTrTime = mkText(p, &lv_font_montserrat_48, C_INK, 34, 96, "00:00");
        lblTrSteps = mkText(p, &lv_font_montserrat_48, C_BLUE_HI, 34, 196, "0");
        mkText(p, &lv_font_montserrat_20, C_DIM, 34, 256, "STEPS");
        lblTrState = mkText(p, &lv_font_montserrat_20, C_DIM, 34, 316, "IDLE");
        mkText(p, &lv_font_montserrat_14, C_DIM2, 34, 420, "TAP CENTER = START / STOP");
    }

    // ================= 页 2：设置列表 =================
    {
        lv_obj_t *p = pages[2];
        addFrame(p);
        mkText(p, &lv_font_montserrat_14, C_DIM, 34, 40, "SETTINGS");
        mkRow(p, 92,  "DEVICE INFO", 0);
        mkRow(p, 162, "GOAL & REST", 1);
        mkRow(p, 232, "POWER",      2);
        hubVal[0] = mkText(p, &lv_font_montserrat_14, C_DIM2, 250, 112, "M1b");
        hubVal[1] = mkText(p, &lv_font_montserrat_14, C_DIM2, 250, 182, "--");
        hubVal[2] = mkText(p, &lv_font_montserrat_14, C_DIM2, 250, 252, "--");
        mkText(p, &lv_font_montserrat_14, C_DIM2, 34, 420, "SWIPE TO SWITCH PAGE");
    }

    // ================= 子页 0：设备信息 =================
    subPages[0] = mkPage(scr);
    {
        lv_obj_t *p = subPages[0];
        addFrame(p);
        mkRow(p, 24, "< SETTINGS", -1);
        const char *keys[6] = {"POWER", "SOURCE", "RTC", "SAMPLE", "DISPLAY", "FIRMWARE"};
        for (int i = 0; i < 6; i++) {
            const int32_t y = 104 + i * 40;
            mkText(p, &lv_font_montserrat_14, C_DIM, 34, y, keys[i]);
            setVal[i] = mkText(p, &lv_font_montserrat_14, C_DIM2, 190, y, "--");
        }
    }

    // ================= 子页 1：目标与休息 =================
    subPages[1] = mkPage(scr);
    {
        lv_obj_t *p = subPages[1];
        addFrame(p);
        mkRow(p, 24, "< GOAL & REST", -1);
        mkText(p, &lv_font_montserrat_14, C_DIM, 34, 104, "DAILY GOAL");
        lblGoalVal = mkText(p, &lv_font_montserrat_20, C_INK, 250, 98, "--");
        mkSlider(p, 140, 0, 2000, 20000, goalSteps);
        mkText(p, &lv_font_montserrat_14, C_DIM, 34, 196, "REST INTERVAL");
        lblRestVal = mkText(p, &lv_font_montserrat_20, C_INK, 250, 190, "--");
        mkSlider(p, 232, 1, 15, 180, restSec);
        mkText(p, &lv_font_montserrat_14, C_DIM2, 34, 420, "DRAG SLIDER  /  SWIPE RIGHT = BACK");
    }

    // ================= 子页 2：电源 =================
    subPages[2] = mkPage(scr);
    {
        lv_obj_t *p = subPages[2];
        addFrame(p);
        mkRow(p, 24, "< POWER", -1);
        lblBattDet = mkText(p, &lv_font_montserrat_20, C_INK, 34, 104, "--");
        mkText(p, &lv_font_montserrat_14, C_DIM, 34, 160, "CAPACITY CALIBRATION");
        lblCalVal = mkText(p, &lv_font_montserrat_20, C_INK, 250, 154, "--");
        mkSlider(p, 196, 2, 80, 120, battCal);
        mkText(p, &lv_font_montserrat_14, C_DIM2, 34, 420, "DRAG SLIDER  /  SWIPE RIGHT = BACK");
    }

    for (int i = 0; i < 3; i++) lv_obj_add_flag(subPages[i], LV_OBJ_FLAG_HIDDEN);
    showPage(0);
}// ---------------------------------------------------------------- 字节序对比测量
static void uiTask(void *) {
    uint32_t lastText = 0;
    static uint32_t fpsMs = 0, fpsFrames = 0;
    static float fpsNow = 0;

    for (;;) {
        if (millis() - lastText >= 200) {
            lastText = millis();
            const uint32_t up = millis() / 1000;

            // ---- 页 0 表盘
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

            const uint32_t pct = (lifetimeSteps * 100) / (uint32_t)(goalSteps > 0 ? goalSteps : 1);
            for (int i = 0; i < 5; i++)
                lv_obj_set_style_bg_color(segBar[i], ((int)pct >= (i + 1) * 20) ? C_BLUE : C_HAIR, 0);

            const int calPct = battPctCalibrated();
            if (calPct >= 0) lv_label_set_text_fmt(lblBatt, "%d%%", calPct);
            lv_obj_set_style_text_color(lblBatt, vbusIn ? C_MINT : C_DIM2, 0);

            // ---- 页 1 训练
            const uint32_t tms = trAccumMs + (trRunning ? (millis() - trStartMs) : 0);
            lv_label_set_text_fmt(lblTrTime, "%02lu:%02lu",
                                  (unsigned long)(tms / 60000), (unsigned long)((tms / 1000) % 60));
            lv_label_set_text_fmt(lblTrSteps, "%lu",
                                  (unsigned long)(trRunning ? (lifetimeSteps - trStepBase) : 0));
            lv_label_set_text(lblTrState, trRunning ? "RUNNING" : "IDLE");
            lv_obj_set_style_text_color(lblTrState, trRunning ? C_MINT : C_DIM, 0);

            // ---- 页 2 设置列表
            if (hubVal[0]) lv_label_set_text(hubVal[0], "M1b");
            if (hubVal[1]) lv_label_set_text_fmt(hubVal[1], "%d / %ds", goalSteps, restSec);
            if (hubVal[2]) lv_label_set_text_fmt(hubVal[2], "%d%%", calPct);

            // ---- 子页 0 设备信息
            const uint32_t loss1000 = totalExpected
                ? (uint32_t)(1000.0f * (1.0f - (float)totalSamples / totalExpected)) : 0;
            const uint32_t avgFlush = flushCnt ? flushSumUs / flushCnt : 0;
            if (setVal[0]) lv_label_set_text_fmt(setVal[0], "%dmV  %d%%", (int)battMv, calPct);
            if (setVal[1]) lv_label_set_text(setVal[1], vbusIn ? "USB" : "BATTERY");
            if (setVal[2]) lv_label_set_text(setVal[2], rtcOk ? "OK" : "FAIL");
            if (setVal[3]) lv_label_set_text_fmt(setVal[3], "%lu.%lu%%  n=%lu",
                                  (unsigned long)(loss1000 / 10), (unsigned long)(loss1000 % 10),
                                  (unsigned long)totalSamples);
            if (setVal[4]) lv_label_set_text_fmt(setVal[4], "%d fps  %lums", (int)fpsNow,
                                  (unsigned long)(avgFlush / 1000));
            if (setVal[5]) lv_label_set_text(setVal[5], "M1b  LVGL 9.3");

            // ---- 子页 1 / 2
            if (lblGoalVal) lv_label_set_text_fmt(lblGoalVal, "%d", goalSteps);
            if (lblRestVal) lv_label_set_text_fmt(lblRestVal, "%ds", restSec);
            if (lblCalVal)  lv_label_set_text_fmt(lblCalVal, "%d%%", battCal);
            if (lblBattDet) lv_label_set_text_fmt(lblBattDet, "%dmV   %d%%", (int)battMv, calPct);
        }

        // fps（只统计真正出帧的次数）
        if (millis() - fpsMs >= 1000) {
            const uint32_t n = uiFrames;
            fpsNow = (float)(n - fpsFrames) * 1000.0f / (float)(millis() - fpsMs);
            fpsFrames = n;
            fpsMs = millis();
        }

        // 鲸鱼逐帧动画（只在表盘页）
        static uint8_t wf = 0;
        static uint32_t lastWf = 0;
        if (whaleImg && curPage == 0 && subPage < 0 && millis() - lastWf >= 160) {
            lastWf = millis();
            wf = (uint8_t)((wf + 1) % WHALE_FRAMES);
            lv_image_set_src(whaleImg, &whale_girl_frames[wf]);
        }

        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}
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

    prefs.begin("sf", false);
    goalSteps = prefs.getInt("goal", 8000);
    restSec   = prefs.getInt("rest", 60);
    battCal   = prefs.getInt("cal", 100);
    Serial.printf("[SET ] goal=%d rest=%d cal=%d\n", goalSteps, restSec, battCal);

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
