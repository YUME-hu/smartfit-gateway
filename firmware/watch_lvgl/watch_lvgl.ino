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

// 自建子集中文字体（Noto Sans SC，OFL；lv_font_conv 生成 cjk16.c）
LV_FONT_DECLARE(cjk16);
#include "Arduino_DriveBus_Library.h"
#include "frame.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

// ---------------------------------------------------------------- 配置
#define SAMPLE_PERIOD_MS 40      // 25Hz
#define WINDOW_MS        5000    // 统计窗口
#define BUF_LINES        50      // 410×50×2 = 41KB
#define STEP_TARGET      8000    // 步数目标（进度用，M2 可由手机下发）
#define CAL_SCREEN       0       // 1 = 开机先显示校准图案（排查色序/可见区用）
#define ATT_LOG          0       // 1 = 以 10Hz 打印姿态（标定用；平时 0）

// ---------------------------------------------------------------- 全局
static Arduino_DataBus *bus = nullptr;
static Arduino_GFX     *gfx = nullptr;
static Arduino_CO5300  *panel = nullptr;   // 具体类型：setBrightness 只在子类里
static lv_display_t    *disp = nullptr;
static uint16_t        *buf1 = nullptr;
static uint16_t        *buf2 = nullptr;

static SensorQMI8658 qmi;
static SensorPCF85063 rtc;
static bool rtcOk = false;
static bool rtcTrusted = false;   // RTC 时间是否可信（对过时，或上电时未停振）
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

// 中文标签字体（lv_conf 里打开了 SOURCE_HAN_SANS_SC_16_CJK）
#define F_CJK    (&cjk16)

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

// 组间休息倒计时 + 震动马达（原理图：GPIO18 -> R12 4.7K -> Q1 MMBT3904 -> 马达，马达电源来自 ALDO3）
#define PIN_MOTOR 18
static bool     restRunning = false;
static uint32_t restEndMs = 0, restTotalMs = 60000;
static lv_obj_t *lblTrCap = nullptr, *lblRestBtn = nullptr, *barRest = nullptr;
static uint8_t  vibStep = 0;
static uint32_t vibNextMs = 0;

static void showPage(int p);
static void handleGesture(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint32_t durMs);
// ---- 设置导航与参数
static int        subPage = -1;                 // -1 = 设置列表；0..2 = 子页
static lv_obj_t  *subPages[4] = {nullptr};
static lv_obj_t  *hubVal[4]   = {nullptr};
static lv_obj_t  *lblToVal = nullptr, *lblBrightVal = nullptr, *lblRaiseVal = nullptr, *lblChargeVal = nullptr;
static lv_obj_t  *valBuf = nullptr;
static lv_obj_t  *lblGoalVal = nullptr, *lblRestVal = nullptr, *lblCalVal = nullptr;
static lv_obj_t  *lblBattDet = nullptr;

static int  goalSteps = 8000;
static int  restSec   = 60;
static int  battCal   = 100;                     // 电池百分比校准系数 80..120
static int  screenTimeoutSec = 30;               // 0 = 不息屏
static int  brightnessVal    = 200;              // 20..255
static int  raiseWake        = 1;                // 抬腕亮屏开关（功能下一步接）
static int  chargeNoSleep    = 1;                // 1 = 充电时不息屏（方便演示/调试）
static bool screenOn         = true;
static uint32_t lastActivityMs = 0;
static bool     attLog       = false;
static volatile float attPitch = 0, attRoll = 0;
static float    rpWinStart = 0, rpStableRef = 0;   // 抬腕检测窗口
static uint32_t rpTWin = 0, rpTStable = 0;
static volatile bool  wakeRequest = false;
static volatile bool  redrawRequest = false;
static uint32_t lastAttPrint = 0;
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

            // 姿态（低通后算俯仰/横滚），给抬腕检测用
            static float lx = 0, ly = 0, lz = 0;
            lx += (x - lx) * 0.15f;
            ly += (y - ly) * 0.15f;
            lz += (z - lz) * 0.15f;
            attPitch = atan2f(-ly, sqrtf(lx * lx + lz * lz)) * 57.29578f;
            attRoll  = atan2f(lx, lz) * 57.29578f;
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




// ---------------------------------------------------------------- BLE（M2 第一步：先把上报找回来）
#define SERVICE_UUID      "0000FFF0-0000-1000-8000-00805F9B34FB"
#define CHAR_NOTIFY_UUID  "0000FFF1-0000-1000-8000-00805F9B34FB"
#define CHAR_WRITE_UUID   "0000FFF2-0000-1000-8000-00805F9B34FB"   // M2 新增：下行指令

static BLEServer         *pServer  = nullptr;
static BLECharacteristic *pNotify  = nullptr;
static BLECharacteristic *pWrite   = nullptr;
static volatile bool      bleConnected = false;
static uint32_t           bleConnectedAt = 0;   // 连接时刻：重放要等手机订阅完成
static volatile bool      protoV2 = false;      // App 发过 "V2" 才切二进制帧（旧 App 保持文本）
static volatile bool      helloPending = false; // HELLO 帧待发（不在 BLE 写回调里直接 notify）

// 停等重传状态（提前声明：SrvCb 断连时要清）
static bool     inflight = false;
static uint32_t inflightAt = 0;
static uint8_t  inflightTries = 0;
static volatile uint16_t ackSeqRecv = 0;
static volatile bool     ackPending = false;
static uint32_t rtRetransmit = 0, rtGiveUp = 0, rtAcked = 0;
static uint32_t           notifSent = 0;

class SrvCb : public BLEServerCallbacks {
    void onConnect(BLEServer *) override {
        bleConnected = true;
        bleConnectedAt = millis();
        markActivity();
        Serial.println("[BLE] 主机已连接");
    }
    void onDisconnect(BLEServer *s) override {
        bleConnected = false;
        inflight = false;
        inflightTries = 0;
        Serial.println("[BLE] 断开，重新广播");
        s->startAdvertising();
    }
};

// ---------------------------------------------------------------- M2.5 窗口环形缓冲
// 目标：手机不在身边时窗口不丢，重连后按原顺序重放（App 靠 client_key 幂等去重）。
// 记录 16 字节：seq u32 / device_ts u32 / x,y,z int16(milli-g) / steps u8 / pad u8
// 17280 个窗口 = 24 小时，占 PSRAM 约 270KB。
#define RING_WINDOWS    17280
#define RING_REC_BYTES  16

static uint8_t *ringBuf = nullptr;
static uint32_t ringHead = 0;      // 最旧待发
static uint32_t ringCount = 0;
static uint32_t ringDropped = 0;   // 缓冲满被丢掉的窗口数
static uint32_t winSeq = 0;        // 窗口序号（在**采集时**分配，重放保持不变）
static uint32_t lastDrainMs = 0;

static inline uint8_t *ringSlot(uint32_t idx) {
    return ringBuf + (idx % RING_WINDOWS) * RING_REC_BYTES;
}

static void ringInit() {
    ringBuf = (uint8_t *)heap_caps_malloc((size_t)RING_WINDOWS * RING_REC_BYTES, MALLOC_CAP_SPIRAM);
    if (!ringBuf) {
        Serial.println("[RING] PSRAM 分配失败，退化为不缓存（断连会丢）");
        return;
    }
    memset(ringBuf, 0, (size_t)RING_WINDOWS * RING_REC_BYTES);
    ringHead = ringCount = 0;
    Serial.printf("[RING] %u 个窗口（约 24h），占用 %u KB PSRAM\n",
                  (unsigned)RING_WINDOWS,
                  (unsigned)((size_t)RING_WINDOWS * RING_REC_BYTES / 1024));
}

static void ringPush(uint32_t ts, float mx, float my, float mz, uint32_t steps) {
    if (!ringBuf) return;

    const uint32_t seq = ++winSeq;

    if (ringCount >= RING_WINDOWS) {           // 满 → 丢最旧并计数
        ringHead = (ringHead + 1) % RING_WINDOWS;
        ringCount--;
        ringDropped++;
    }

    uint8_t *p = ringSlot(ringHead + ringCount);
    p[0] = (uint8_t)(seq & 0xFF); p[1] = (uint8_t)((seq >> 8) & 0xFF);
    p[2] = (uint8_t)((seq >> 16) & 0xFF); p[3] = (uint8_t)((seq >> 24) & 0xFF);
    p[4] = (uint8_t)(ts & 0xFF); p[5] = (uint8_t)((ts >> 8) & 0xFF);
    p[6] = (uint8_t)((ts >> 16) & 0xFF); p[7] = (uint8_t)((ts >> 24) & 0xFF);

    const int16_t ix = (int16_t)lroundf(mx * 1000.0f);
    const int16_t iy = (int16_t)lroundf(my * 1000.0f);
    const int16_t iz = (int16_t)lroundf(mz * 1000.0f);
    p[8]  = (uint8_t)(ix & 0xFF);  p[9]  = (uint8_t)((ix >> 8) & 0xFF);
    p[10] = (uint8_t)(iy & 0xFF);  p[11] = (uint8_t)((iy >> 8) & 0xFF);
    p[12] = (uint8_t)(iz & 0xFF);  p[13] = (uint8_t)((iz >> 8) & 0xFF);

    p[14] = (uint8_t)(steps > 255 ? 255 : steps);
    p[15] = 0;
    ringCount++;
}

static uint32_t rdU32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static int16_t rdI16(const uint8_t *p) {
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

// ---------------------------------------------------------------- 发送与 ACK 重传
// v2 用"一帧在途 + 等 ACK"的停等协议：
//   发出后 1.5s 没等到 ACK 就重发同一 seq（内容完全相同，App 侧按 client_key 幂等去重），
//   重试 3 次仍无 ACK 才放弃并计一次 giveup。
// 文本模式没有 ACK 通道，保持"发完即出队"的旧行为。

static inline uint32_t rdHeadSeq() {
    return ringBuf ? rdU32(ringSlot(ringHead)) : 0;
}

static inline void ringPopHead() {
    if (ringCount == 0) {                 // 下溢保护：uint32 掉到 0xFFFFFFFF 会读整个空环
        Serial.println("[RING] 保护：空环出队被忽略");
        inflight = false;
        return;
    }
    ringHead = (ringHead + 1) % RING_WINDOWS;
    ringCount--;
    if (ringCount == 0) inflight = false;
}

/** 推一个窗口出去；v2 走停等 + 重传，文本走发完即出队 */
static void ringDrain() {
    if (!ringBuf || !bleConnected || !pNotify || ringCount == 0) return;
    // 连接后先等 3 秒：手机要做服务发现 + 订阅 CCCD，期间发的包会打到空气里。
    if (millis() - bleConnectedAt < 3000) return;
    if (millis() - lastDrainMs < 20) return;
    lastDrainMs = millis();

    // 先消费 ACK（只认队首那一帧的确认）
    if (ackPending) {
        ackPending = false;
        if (inflight && (uint16_t)(rdHeadSeq() & 0xFFFFu) == ackSeqRecv) {
            ringPopHead();
            inflight = false;
            inflightTries = 0;
            rtAcked++;
            // ⚠️ 本函数开头的 ringCount==0 检查是在处理 ACK **之前**做的。
            // 这里弹完可能已经空了，必须重新判，否则会把一个从未写入的空槽当数据发出去。
            if (ringCount == 0) return;
        }
    }

    if (inflight) {
        if (millis() - inflightAt < 1500) return;      // 还在等 ACK
        if (inflightTries >= 3) {                      // 放弃这一帧
            rtGiveUp++;
            ringPopHead();
            inflight = false;
            inflightTries = 0;
            Serial.println("[RT  ] 3 次无 ACK，放弃该帧");
            return;
        }
        rtRetransmit++;
        Serial.printf("[RT  ] 重传 seq=%u（第 %u 次）\n",
                      (unsigned)(rdHeadSeq() & 0xFFFFu), (unsigned)(inflightTries + 1));
    }

    const uint8_t *p = ringSlot(ringHead);
    const uint32_t seq = rdU32(p);
    const uint32_t ts  = rdU32(p + 4);
    const float mx = rdI16(p + 8)  / 1000.0f;
    const float my = rdI16(p + 10) / 1000.0f;
    const float mz = rdI16(p + 12) / 1000.0f;
    const uint32_t steps = p[14];

    if (protoV2) {
        uint8_t frame[FFRAME_SIZE];
        fframe_encode_data(frame, (uint16_t)(seq & 0xFFFF), ts, mx, my, mz, (uint8_t)steps);
        pNotify->setValue(frame, FFRAME_SIZE);
    } else {
        char payload[80];
        if (ts != 0) {
            snprintf(payload, sizeof(payload), "%.2f,%.2f,%.2f,%u,%u,%u",
                     mx, my, mz, (unsigned)seq, (unsigned)steps, (unsigned)ts);
        } else {
            snprintf(payload, sizeof(payload), "%.2f,%.2f,%.2f,%u,%u",
                     mx, my, mz, (unsigned)seq, (unsigned)steps);
        }
        pNotify->setValue((uint8_t *)payload, strlen(payload));
    }
    pNotify->notify();

    inflight = true;
    inflightAt = millis();
    inflightTries++;

    if (!protoV2) {                                    // 文本模式：无 ACK 可等
        ringPopHead();
        inflight = false;
        inflightTries = 0;
    }
}

// ---------------------------------------------------------------- 对时
// 指令格式（文本，便于串口/工具直接测）：T<unix_epoch_utc_seconds>
// 固件按固定 CST+8 换算成本地时间写入 PCF85063。
#define TZ_OFFSET_SEC (8 * 3600)

// 公历 <-> epoch 的手写换算（工具链里没有 timegm，也不依赖本地时区设置）
static int64_t daysFromCivil(int y, unsigned m, unsigned d) {
    y -= (m <= 2);
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

static void civilFromDays(int64_t z, int &y, unsigned &m, unsigned &d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = (unsigned)(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    y = (int)yoe + (int)(era * 400);
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp + (mp < 10 ? 3 : -9);
    y += (m <= 2);
}

/** 把 RTC 里的本地时间换算成真正的 UTC epoch 秒 */
static uint32_t rtcEpochUtc() {
    if (!rtcOk) return 0;
    RTC_DateTime dt = rtc.getDateTime();
    const int64_t days = daysFromCivil(dt.getYear(), dt.getMonth(), dt.getDay());
    int64_t secs = days * 86400 + dt.getHour() * 3600 + dt.getMinute() * 60 + dt.getSecond();
    secs -= TZ_OFFSET_SEC;                 // RTC 存的是本地时间
    return secs > 0 ? (uint32_t)secs : 0;
}

static void applyEpoch(uint32_t epochUtc) {
    if (!rtcOk) { Serial.println("[RTC] 未就绪，忽略对时"); return; }

    int64_t secs = (int64_t)epochUtc + TZ_OFFSET_SEC;   // 转成本地
    int64_t days = secs / 86400;
    int32_t rem  = (int32_t)(secs % 86400);
    if (rem < 0) { rem += 86400; days -= 1; }

    int y; unsigned mo, dd;
    civilFromDays(days, y, mo, dd);
    const uint8_t hh = rem / 3600;
    const uint8_t mi = (rem % 3600) / 60;
    const uint8_t ss = rem % 60;

    xSemaphoreTake(i2cMutex, portMAX_DELAY);
    RTC_DateTime before = rtc.getDateTime();
    rtc.setDateTime(RTC_DateTime((uint16_t)y, (uint8_t)mo, (uint8_t)dd, hh, mi, ss));
    RTC_DateTime after = rtc.getDateTime();
    xSemaphoreGive(i2cMutex);

    rtcTrusted = true;
    Serial.printf("[RTC] 对时 -> %04d-%02d-%02d %02d:%02d:%02d （原 %04d-%02d-%02d %02d:%02d:%02d）\n",
                  after.getYear(), after.getMonth(), after.getDay(),
                  after.getHour(), after.getMinute(), after.getSecond(),
                  before.getYear(), before.getMonth(), before.getDay(),
                  before.getHour(), before.getMinute(), before.getSecond());
}
class WriteCb : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *c) override {
        // 二进制帧（v2 的 ACK）优先：整 18 字节 + magic 匹配才当帧处理
        const uint8_t *raw = c->getData();
        const size_t len = c->getLength();
        if (len == FFRAME_SIZE && raw && raw[0] == FFRAME_MAGIC) {
            if (fframe_valid(raw, len) && raw[2] == FFRAME_TYPE_ACK) {
                ackSeqRecv = fframe_get_u16(raw, 3);
                ackPending = true;
            }
            return;
        }

        String v = c->getValue();
        v.trim();
        Serial.printf("[BLE] 收到指令 (%u B): \"%s\"\n", (unsigned)v.length(), v.c_str());
        markActivity();
        if (v.length() < 2) return;

        const char cmd = v[0];
        const uint32_t arg = (uint32_t)strtoul(v.c_str() + 1, nullptr, 10);
        switch (cmd) {
            case 'T':                       // 对时
                applyEpoch(arg);
                break;
            case 'V':                       // V2：切换到二进制帧协议
                if (arg == 2) {
                    protoV2 = true;
                    helloPending = true;
                    Serial.println("[PROTO] 切到 v2 二进制帧");
                }
                break;
            case 'P':                       // ping：回一段当前状态
                Serial.printf("[BLE] pong, uptime=%lus\n", (unsigned long)(millis() / 1000));
                break;
            default:
                Serial.printf("[BLE] 未知指令 '%c'\n", cmd);
                break;
        }
    }
};

static void initBle() {
    BLEDevice::init("ESP32_Fitness_Watch");
    BLEDevice::setMTU(185);

    pServer = BLEDevice::createServer();
    if (!pServer) { Serial.println("[BLE] createServer 失败"); return; }
    pServer->setCallbacks(new SrvCb());

    BLEService *svc = pServer->createService(SERVICE_UUID);

    pNotify = svc->createCharacteristic(CHAR_NOTIFY_UUID,
                    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
    pNotify->addDescriptor(new BLE2902());
    pNotify->setValue("0.00,0.00,0.00");

    pWrite = svc->createCharacteristic(CHAR_WRITE_UUID,
                    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    pWrite->setCallbacks(new WriteCb());

    svc->start();

    BLEAdvertising *adv = BLEDevice::getAdvertising();
    adv->addServiceUUID(SERVICE_UUID);
    adv->setScanResponse(true);
    adv->setMinPreferred(0x06);
    adv->setMinPreferred(0x12);
    BLEDevice::startAdvertising();
    Serial.println("[BLE] 广播中：ESP32_Fitness_Watch（FFF1 上报 / FFF2 指令）");
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
    markActivity();
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

// ---------------------------------------------------------------- 息屏与唤醒
static const int TO_SEC[5] = {0, 15, 30, 60, 120};

static void screenOff() {
    if (!screenOn) return;
    screenOn = false;
    rpWinStart = attPitch;
    rpStableRef = attPitch;
    rpTWin = millis();
    rpTStable = millis();
    if (gfx) gfx->displayOff();
    Serial.println("[SCR ] 息屏");
}

static void screenWake(const char *why) {
    if (screenOn) return;
    screenOn = true;
    if (gfx) {
        gfx->displayOn();
        delay(30);
        gfx->fillScreen(RGB565_BLACK);       // 面板睡过一觉，RAM 里的内容已经丢了
    }
    lv_obj_invalidate(lv_screen_active());
    lv_refr_now(nullptr);                    // 立刻强制整屏刷新，否则只重画脏区 → 出现"重影"
    lastActivityMs = millis();
    Serial.printf("[SCR ] 亮屏（%s）\n", why);
}

static void markActivity() { lastActivityMs = millis(); }

// ---------------------------------------------------------------- 电量日志（放电实验）
// 断 USB 后没法往串口打日志，所以把 mV 写进 NVS：电池耗尽重启后仍能读出整条曲线。
// 5 分钟一条；低于 10% 改 1 分钟一条，为了抓到末尾那段陡降。
static String   blogCache;
static uint32_t lastBlogMs = 0;

static void blogTick() {
    const uint32_t now = millis();
    uint32_t period = 5UL * 60UL * 1000UL;
    if (battPct >= 0 && battPct <= 10) period = 60UL * 1000UL;
    if (now - lastBlogMs < period) return;
    lastBlogMs = now;

    if (blogCache.length() > 3500) {                   // 超长时只丢最旧的，保留近期数据
        const int cut = blogCache.indexOf(",", blogCache.length() - 1500);
        blogCache = (cut > 0) ? blogCache.substring(cut + 1) : "";
    }

    char line[20];
    snprintf(line, sizeof(line), "%u:%d,", (unsigned)(now / 60000UL), (int)battMv);
    blogCache += line;
    prefs.putString("blog", blogCache);
    Serial.printf("[BLOG] %s\n", line);                // 插着 USB 时也能看到
}

// 逐条一行打印：整串一行打会被 [WIN] 之类的周期性输出从中间切断，抓不全
static uint32_t lastBlogDumpMs = 0;
static void blogDumpTick() {
    if (blogCache.length() == 0) return;
    if (millis() - lastBlogDumpMs < 60000) return;
    lastBlogDumpMs = millis();
    Serial.printf("[BLOGD] %u\n", (unsigned)blogCache.length());
    int start = 0;
    while (start < (int)blogCache.length()) {
        int comma = blogCache.indexOf(',', start);
        if (comma < 0) break;
        Serial.print("[BLOGD] ");
        Serial.println(blogCache.substring(start, comma));
        start = comma + 1;
        delay(2);                       // 让出串口，避免整段塞爆 TX 缓冲
    }
    Serial.println("[BLOGD] END");
}
// ---------------------------------------------------------------- 抬腕亮屏
// 标定结论（2026-11-22）：手臂下垂时 pitch ≈ 18-22°，抬到眼前 ≈ 76-80°，
// 抬起过程约 1-1.5 秒。判据：1.5 秒内净上升 ≥30° + 终点 ≥55° + 之后静止 300ms。
static void raiseTick() {
    if (!raiseWake) return;
    const uint32_t now = millis();
    const float p = attPitch;

    if (now - rpTWin >= 1500) { rpWinStart = p; rpTWin = now; }

    // 运动检测：姿态变化超过 4° 就认为还在动
    if (fabsf(p - rpStableRef) > 4.0f) { rpStableRef = p; rpTStable = now; }

    const float rise = p - rpWinStart;
    if (rise >= 30.0f && p >= 55.0f && (now - rpTStable) >= 300) {
        Serial.printf("[RAISE] 抬腕触发 rise=%.1f pitch=%.1f\n", rise, p);
        screenWake("抬腕");
    }
}

/** 息屏状态下直接轮询触摸芯片（此时 LVGL 的 indev 不跑） */
static bool touchWakeCheck() {
    if (screenOn || !touchDev) return false;
    bool hit = false;
    if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        if (touchDev->IIC_Interrupt_Flag) {
            touchDev->IIC_Interrupt_Flag = false;
            int32_t x = touchDev->IIC_Read_Device_Value(
                            touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_COORDINATE_X);
            int32_t y = touchDev->IIC_Read_Device_Value(
                            touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_COORDINATE_Y);
            if (x >= 0 && y >= 0 && x < LCD_WIDTH && y < LCD_HEIGHT) hit = true;
        }
        xSemaphoreGive(i2cMutex);
    }
    return hit;
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

static void vibrateStart() { vibStep = 1; vibNextMs = millis(); }

/** 非阻塞震动：三短震（140ms 振 / 90ms 停） */
static void vibrateTick() {
    if (!vibStep) return;
    if ((int32_t)(millis() - vibNextMs) < 0) return;
    switch (vibStep) {
        case 1: digitalWrite(PIN_MOTOR, HIGH); vibNextMs = millis() + 140; vibStep = 2; break;
        case 2: digitalWrite(PIN_MOTOR, LOW);  vibNextMs = millis() + 90;  vibStep = 3; break;
        case 3: digitalWrite(PIN_MOTOR, HIGH); vibNextMs = millis() + 140; vibStep = 4; break;
        case 4: digitalWrite(PIN_MOTOR, LOW);  vibNextMs = millis() + 90;  vibStep = 5; break;
        case 5: digitalWrite(PIN_MOTOR, HIGH); vibNextMs = millis() + 140; vibStep = 6; break;
        default: digitalWrite(PIN_MOTOR, LOW); vibStep = 0; break;
    }
}

static void restBtnCb(lv_event_t *) {
    if (restRunning) {
        restRunning = false;
        Serial.println("[REST] 取消");
        return;
    }
    restTotalMs = (uint32_t)restSec * 1000;
    restEndMs = millis() + restTotalMs;
    restRunning = true;
    Serial.printf("[REST] 开始 %d 秒\n", restSec);
}
static void rowClickCb(lv_event_t *e) {
    lv_obj_t *r = (lv_obj_t *)lv_event_get_target(e);
    const int idx = (int)(intptr_t)lv_obj_get_user_data(r);
    if (idx < 0) { closeSub(); return; }   // -1 = 返回行
    if (idx == 100) {                      // 抬腕亮屏开关
        raiseWake = raiseWake ? 0 : 1;
        prefs.putInt("rw", raiseWake);
        Serial.printf("[SET ] raiseWake=%d\n", raiseWake);
        markActivity();
        return;
    }
    if (idx == 101) {                      // 充电不息屏开关
        chargeNoSleep = chargeNoSleep ? 0 : 1;
        prefs.putInt("cn", chargeNoSleep);
        Serial.printf("[SET ] chargeNoSleep=%d\n", chargeNoSleep);
        markActivity();
        return;
    }
    openSub(idx);
}

static void sliderCb(lv_event_t *e) {
    lv_obj_t *s = (lv_obj_t *)lv_event_get_target(e);
    const int idx = (int)(intptr_t)lv_obj_get_user_data(s);
    const int v = (int)lv_slider_get_value(s);
    if (idx == 0) goalSteps = v;
    else if (idx == 1) restSec = v;
    else if (idx == 2) battCal = v;
    else if (idx == 3) screenTimeoutSec = TO_SEC[v < 0 ? 0 : (v > 4 ? 4 : v)];
    else if (idx == 4) { brightnessVal = v; if (panel) panel->setBrightness((uint8_t)v); }

    if (lv_event_get_code(e) == LV_EVENT_RELEASED) {
        prefs.putInt("goal", goalSteps);
        prefs.putInt("rest", restSec);
        prefs.putInt("cal", battCal);
        prefs.putInt("to", screenTimeoutSec);
        prefs.putInt("br", brightnessVal);
        Serial.printf("[SET ] goal=%d rest=%d cal=%d to=%d br=%d\n",
                      goalSteps, restSec, battCal, screenTimeoutSec, brightnessVal);
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
    mkText(r, F_CJK, C_INK, 6, 14, key);
    mkText(r, F_CJK, C_DIM, 316, 14, ">");
    return r;
}

static void openSub(int i) {
    subPage = i;
    for (int k = 0; k < 4; k++) {
        if (!subPages[k]) continue;
        if (k == i) lv_obj_remove_flag(subPages[k], LV_OBJ_FLAG_HIDDEN);
        else        lv_obj_add_flag(subPages[k], LV_OBJ_FLAG_HIDDEN);
    }
    for (int k = 0; k < 3; k++) if (dots[k]) lv_obj_add_flag(dots[k], LV_OBJ_FLAG_HIDDEN);
    redrawRequest = true;                 // ⚠️ 不能在 LVGL 回调里 lv_refr_now（会重入）
    Serial.printf("[UI  ] 进入子页 %d\n", i);
}

static void closeSub() {
    subPage = -1;
    for (int k = 0; k < 4; k++) if (subPages[k]) lv_obj_add_flag(subPages[k], LV_OBJ_FLAG_HIDDEN);
    for (int k = 0; k < 3; k++) if (dots[k]) lv_obj_remove_flag(dots[k], LV_OBJ_FLAG_HIDDEN);
    redrawRequest = true;
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
        mkText(p, &lv_font_montserrat_14, C_DIM, 34, 40, "TRAINING");
        lblTrCap = mkText(p, F_CJK, C_DIM, 34, 66, "本次");
        lblTrTime = mkText(p, &lv_font_montserrat_48, C_INK, 34, 92, "00:00");

        barRest = lv_bar_create(p);
        lv_obj_set_size(barRest, 300, 6);
        lv_obj_set_pos(barRest, 36, 154);
        lv_bar_set_range(barRest, 0, 1000);
        lv_bar_set_value(barRest, 0, LV_ANIM_OFF);
        lv_obj_set_style_bg_color(barRest, C_HAIR, LV_PART_MAIN);
        lv_obj_set_style_bg_opa(barRest, LV_OPA_COVER, LV_PART_MAIN);
        lv_obj_set_style_bg_color(barRest, C_MINT, LV_PART_INDICATOR);
        lv_obj_set_style_bg_opa(barRest, LV_OPA_COVER, LV_PART_INDICATOR);

        lblTrSteps = mkText(p, &lv_font_montserrat_48, C_BLUE_HI, 34, 186, "0");
        mkText(p, &lv_font_montserrat_20, C_DIM, 34, 246, "STEPS");
        lblTrState = mkText(p, &lv_font_montserrat_20, C_DIM, 34, 294, "IDLE");

        lv_obj_t *btn = lv_obj_create(p);
        lv_obj_remove_style_all(btn);
        lv_obj_set_size(btn, 250, 56);
        lv_obj_set_pos(btn, 34, 356);
        lv_obj_add_flag(btn, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_set_style_bg_color(btn, C_HAIR, 0);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(btn, 10, 0);
        lv_obj_set_style_bg_color(btn, C_BLUE, LV_STATE_PRESSED);
        lv_obj_add_event_cb(btn, restBtnCb, LV_EVENT_CLICKED, nullptr);
        lblRestBtn = mkText(btn, F_CJK, C_INK, 60, 16, "休息 60 秒");

        mkText(p, &lv_font_montserrat_14, C_DIM2, 34, 432, "TAP CENTER = START / STOP");
    }

    // ================= 页 2：设置列表 =================
    {
        lv_obj_t *p = pages[2];
        addFrame(p);
        mkText(p, F_CJK, C_DIM, 34, 36, "设置");
        mkRow(p, 82,  "设备信息", 0);
        mkRow(p, 148, "显示", 1);
        mkRow(p, 214, "目标与休息", 2);
        mkRow(p, 280, "电源", 3);
        hubVal[0] = mkText(p, F_CJK, C_DIM2, 230, 100, "M1b");
        hubVal[1] = mkText(p, F_CJK, C_DIM2, 250, 166, "--");
        hubVal[2] = mkText(p, F_CJK, C_DIM2, 200, 232, "--");
        hubVal[3] = mkText(p, F_CJK, C_DIM2, 290, 298, "--");
        mkText(p, F_CJK, C_DIM2, 34, 420, "左右滑动切换页面");
    }

    // ================= 子页 0：设备信息 =================
    subPages[0] = mkPage(scr);
    {
        lv_obj_t *p = subPages[0];
        addFrame(p);
        mkRow(p, 24, "< 返回", -1);
        const char *keys[6] = {"电量", "供电", "时钟", "采样", "显示", "固件"};
        for (int i = 0; i < 6; i++) {
            const int32_t y = 104 + i * 42;
            mkText(p, F_CJK, C_DIM, 34, y, keys[i]);
            setVal[i] = mkText(p, F_CJK, C_DIM2, 170, y, "--");
        }
        // M2.5：断连缓存状态（待发窗口数 / 因满丢弃数）
        mkText(p, F_CJK, C_DIM, 34, 356, "缓存");
        valBuf = mkText(p, F_CJK, C_DIM2, 170, 356, "--");
    }

    // ================= 子页 1：显示 =================
    subPages[1] = mkPage(scr);
    {
        lv_obj_t *p = subPages[1];
        addFrame(p);
        mkRow(p, 24, "< 显示", -1);
        mkText(p, F_CJK, C_DIM, 34, 104, "熄屏时间");
        lblToVal = mkText(p, F_CJK, C_INK, 240, 98, "--");
        mkSlider(p, 140, 3, 0, 4, 2);
        mkText(p, F_CJK, C_DIM, 34, 196, "亮度");
        lblBrightVal = mkText(p, F_CJK, C_INK, 240, 190, "--");
        mkSlider(p, 232, 4, 20, 255, 200);
        mkRow(p, 292, "抬腕亮屏", 100);
        lblRaiseVal = mkText(p, F_CJK, C_INK, 290, 310, "--");
        mkRow(p, 356, "充电不息屏", 101);
        lblChargeVal = mkText(p, F_CJK, C_INK, 290, 374, "--");
        mkText(p, F_CJK, C_DIM2, 34, 432, "拖动滑块 / 右滑返回");
    }

    // ================= 子页 2：目标与休息 =================
    subPages[2] = mkPage(scr);
    {
        lv_obj_t *p = subPages[2];
        addFrame(p);
        mkRow(p, 24, "< 目标与休息", -1);
        mkText(p, F_CJK, C_DIM, 34, 104, "每日目标");
        lblGoalVal = mkText(p, &lv_font_montserrat_20, C_INK, 270, 98, "--");
        mkSlider(p, 140, 0, 2000, 20000, goalSteps);
        mkText(p, F_CJK, C_DIM, 34, 196, "组间休息");
        lblRestVal = mkText(p, &lv_font_montserrat_20, C_INK, 270, 190, "--");
        mkSlider(p, 232, 1, 15, 180, restSec);
        mkText(p, F_CJK, C_DIM2, 34, 420, "拖动滑块 / 右滑返回");
    }

    // ================= 子页 3：电源 =================
    subPages[3] = mkPage(scr);
    {
        lv_obj_t *p = subPages[3];
        addFrame(p);
        mkRow(p, 24, "< 电源", -1);
        lblBattDet = mkText(p, &lv_font_montserrat_20, C_INK, 34, 104, "--");
        mkText(p, F_CJK, C_DIM, 34, 160, "容量校准");
        lblCalVal = mkText(p, &lv_font_montserrat_20, C_INK, 270, 154, "--");
        mkSlider(p, 196, 2, 80, 120, battCal);
        mkText(p, F_CJK, C_DIM2, 34, 420, "拖动滑块 / 右滑返回");
    }

    // 子页必须是不透明的，否则会透出下面的设置列表
    // 注意：数量必须和 subPages 一样（4 个）—— 少一个就会留下一个全屏透明层挡住点击
    for (int i = 0; i < 4; i++) {
        lv_obj_set_style_bg_color(subPages[i], C_BG, 0);
        lv_obj_set_style_bg_opa(subPages[i], LV_OPA_COVER, 0);
        lv_obj_set_style_opa(subPages[i], LV_OPA_COVER, 0);   // 整对象不透明，双保险
        lv_obj_add_flag(subPages[i], LV_OBJ_FLAG_HIDDEN);
        Serial.printf("[UI  ] subPage[%d] bg_opa=%d opa=%d size=%dx%d\n", i,
                      (int)lv_obj_get_style_bg_opa(subPages[i], 0),
                      (int)lv_obj_get_style_opa(subPages[i], 0),
                      (int)lv_obj_get_width(subPages[i]), (int)lv_obj_get_height(subPages[i]));
    }
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
            if (lblLink) {
                lv_label_set_text(lblLink, bleConnected ? "LINK BLE" : "LINK --");
                lv_obj_set_style_text_color(lblLink, bleConnected ? C_MINT : C_DIM, 0);
            }
            if (calPct >= 0) lv_label_set_text_fmt(lblBatt, "%d%%", calPct);
            lv_obj_set_style_text_color(lblBatt, vbusIn ? C_MINT : C_DIM2, 0);

            // ---- 页 1 训练（休息倒计时优先占用大数字位）
            if (restRunning) {
                const uint32_t now2 = millis();
                const uint32_t left = (restEndMs > now2) ? (restEndMs - now2) : 0;
                lv_label_set_text_fmt(lblTrTime, "%02lu:%02lu",
                                      (unsigned long)(left / 60000), (unsigned long)((left / 1000) % 60));
                lv_obj_set_style_text_color(lblTrTime, C_MINT, 0);
                lv_label_set_text(lblTrCap, "休息");
                lv_bar_set_value(barRest, (int32_t)(1000 - (left * 1000 / (restTotalMs ? restTotalMs : 1))), LV_ANIM_OFF);
                if (left == 0) {
                    restRunning = false;
                    lv_bar_set_value(barRest, 0, LV_ANIM_OFF);
                    vibrateStart();
                    Serial.println("[REST] 结束，震动提示");
                }
            } else {
                const uint32_t tms = trAccumMs + (trRunning ? (millis() - trStartMs) : 0);
                lv_label_set_text_fmt(lblTrTime, "%02lu:%02lu",
                                      (unsigned long)(tms / 60000), (unsigned long)((tms / 1000) % 60));
                lv_obj_set_style_text_color(lblTrTime, C_INK, 0);
                lv_label_set_text(lblTrCap, "本次");
            }
            lv_label_set_text_fmt(lblTrSteps, "%lu",
                                  (unsigned long)(trRunning ? (lifetimeSteps - trStepBase) : 0));
            lv_label_set_text(lblTrState, restRunning ? "RESTING" : (trRunning ? "RUNNING" : "IDLE"));
            lv_obj_set_style_text_color(lblTrState, (restRunning || trRunning) ? C_MINT : C_DIM, 0);
            if (lblRestBtn) lv_label_set_text_fmt(lblRestBtn, "休息 %d 秒", restSec);

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
            if (setVal[5]) lv_label_set_text(setVal[5], "M2  LVGL 9.3");
            if (valBuf) lv_label_set_text_fmt(valBuf, "%u / 丢 %u",
                                              (unsigned)ringCount, (unsigned)ringDropped);

            // ---- 子页 1 / 2
            if (lblGoalVal) lv_label_set_text_fmt(lblGoalVal, "%d", goalSteps);
            if (lblRestVal) lv_label_set_text_fmt(lblRestVal, "%ds", restSec);
            if (lblCalVal)  lv_label_set_text_fmt(lblCalVal, "%d%%", battCal);
            if (lblBattDet) lv_label_set_text_fmt(lblBattDet, "%dmV   %d%%", (int)battMv, calPct);

            // ---- 显示子页
            if (lblToVal)     lv_label_set_text(lblToVal, screenTimeoutSec ? (screenTimeoutSec == 15 ? "15 秒" : screenTimeoutSec == 30 ? "30 秒" : screenTimeoutSec == 60 ? "1 分钟" : "2 分钟") : "关闭");
            if (lblBrightVal) lv_label_set_text_fmt(lblBrightVal, "%d", brightnessVal);
            if (lblRaiseVal)  lv_label_set_text(lblRaiseVal, raiseWake ? "开" : "关");
            if (lblChargeVal) lv_label_set_text(lblChargeVal, chargeNoSleep ? "否" : "是");
            if (hubVal[1])    lv_label_set_text(hubVal[1], screenTimeoutSec ? (screenTimeoutSec == 15 ? "15s" : screenTimeoutSec == 30 ? "30s" : screenTimeoutSec == 60 ? "1min" : "2min") : "OFF");
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

        vibrateTick();

        // ---- 姿态日志（进"显示"子页时开启，用于抬腕标定）
        if (ATT_LOG && millis() - lastAttPrint >= 100) {
            lastAttPrint = millis();
            Serial.printf("[ATT] pitch=%.1f roll=%.1f\n", attPitch, attRoll);
        }

        if (wakeRequest) {
            wakeRequest = false;
            screenWake("USB 插入");
        }
        if (redrawRequest && screenOn) {
            redrawRequest = false;
            lv_obj_invalidate(lv_screen_active());
            lv_refr_now(nullptr);
        }

        // ---- 息屏状态：不跑 LVGL，只轮询触摸唤醒
        if (!screenOn) {
            if (touchWakeCheck()) {
                screenWake("触摸");
            } else {
                raiseTick();
                if (!screenOn) {
                    vTaskDelay(pdMS_TO_TICKS(50));
                    continue;
                }
            }
        }

        // ---- 空闲超时息屏（充电时不息屏，方便演示）
        const bool allowSleep = (chargeNoSleep == 0) || !vbusIn;
        if (screenTimeoutSec > 0 && allowSleep &&
            millis() - lastActivityMs > (uint32_t)screenTimeoutSec * 1000) {
            screenOff();
            continue;
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
    fframe_selftest();
    Serial.printf("[LVGL] 版本 %d.%d.%d\n", lv_version_major(), lv_version_minor(), lv_version_patch());

    i2cMutex = xSemaphoreCreateMutex();

    prefs.begin("sf", false);
    goalSteps = prefs.getInt("goal", 8000);
    restSec   = prefs.getInt("rest", 60);
    battCal   = prefs.getInt("cal", 100);
    screenTimeoutSec = prefs.getInt("to", 30);
    brightnessVal    = prefs.getInt("br", 200);
    raiseWake        = prefs.getInt("rw", 1);
    chargeNoSleep    = prefs.getInt("cn", 1);
    Serial.printf("[SET ] goal=%d rest=%d cal=%d\n", goalSteps, restSec, battCal);

    // ---- 显示
    bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
    panel = new Arduino_CO5300(bus, LCD_RESET, 0, LCD_WIDTH, LCD_HEIGHT, 22, 0, 0, 0);
    gfx = panel;
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
        rtcTrusted = integrity;                 // 未停振 → 时间仍可信
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
    // ---- 震动马达：GPIO18 经 MMBT3904 驱动，马达正极来自 ALDO3（必须在 PMU 起来之后）
    pinMode(PIN_MOTOR, OUTPUT);
    digitalWrite(PIN_MOTOR, LOW);
    if (pmuReady) {
        power.setALDO3Voltage(3300);
        power.enableALDO3();
        delay(20);
    }
    if (panel) panel->setBrightness((uint8_t)brightnessVal);
    lastActivityMs = millis();
    Serial.printf("[MOTOR] GPIO18 就绪，ALDO3=%s\n",
                  (pmuReady && power.isEnableALDO3()) ? "已开" : "未确认");
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

    blogCache = prefs.getString("blog");
    if (blogCache.length() > 0) {
        Serial.printf("[BLOG] 上次运行的电量记录（%u 字节）：\n%s\n", (unsigned)blogCache.length(), blogCache.c_str());
    }

    ringInit();
    initBle();

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
        const bool wasVbus = vbusIn;
        vbusIn = power.isVbusIn();
        xSemaphoreGive(i2cMutex);

        // 插上 USB 就亮屏（安全网：息屏后迷路时插线即可恢复）
        if (vbusIn && !wasVbus && !screenOn) wakeRequest = true;

        blogTick();
        blogDumpTick();
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

        // M2.5：窗口一律先入环形缓冲（连没连上都入），再由 ringDrain 按顺序推出去。
        // 这样断连期间的数据不会丢，重连后从最旧的重放，App 靠 client_key 幂等去重。
        uint32_t devTs = 0;
        if (rtcTrusted) {
            if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(20)) == pdTRUE) {
                devTs = rtcEpochUtc();
                xSemaphoreGive(i2cMutex);
            }
            if (devTs > (elapsed / 1000)) devTs -= (elapsed / 1000);
        }
        ringPush(devTs, stepCounter.meanX(), stepCounter.meanY(), stepCounter.meanZ(), ws);

        stepCounter.resetWindow();

        const uint32_t avgFlush = flushCnt ? flushSumUs / flushCnt : 0;
        Serial.printf("[WIN] 采样=%lu/%lu 丢点=%.2f%% 步=%lu | %dmV %d%% | flush avg=%luus max=%luus 次=%lu px=%luK | ui帧=%lu\n",
                      (unsigned long)got, (unsigned long)expected,
                      expected ? (100.0f * (1.0f - (float)got / expected)) : 0.0f,
                      (unsigned long)ws,
                      (int)battMv, (int)battPct,
                      (unsigned long)avgFlush, (unsigned long)flushMaxUs,
                      (unsigned long)flushCnt, (unsigned long)(flushPx / 1024),
                      (unsigned long)uiFrames);

        flushCnt = 0; flushSumUs = 0; flushMaxUs = 0; flushPx = 0;
    }

    if (helloPending && bleConnected && pNotify && millis() - bleConnectedAt > 300) {
        helloPending = false;
        uint8_t f[FFRAME_SIZE];
        fframe_encode_hello(f, FFRAME_VER, 1, 0);   // proto=2, fw 1.0
        pNotify->setValue(f, FFRAME_SIZE);
        pNotify->notify();
        Serial.println("[PROTO] 已回 HELLO(proto=2 fw=1.0)");
    }

    ringDrain();

    delay(20);
}
