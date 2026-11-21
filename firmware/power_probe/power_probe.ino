/**
 * power_probe.ino —— 电源/电池/按键/RTC 诊断（屏幕会亮，用来"用眼睛"判断是否在跑）
 *
 * 解决的问题：
 *   ① 装电池后不亮、插 USB 才亮 —— 到底是没按电源键，还是电池供电路径没起来？
 *   ② 拔掉 USB 后板子还活着吗？（屏幕上有秒表，肉眼可判断；串口读不到时靠它）
 *   ③ AXP2101 电池/充电状态到底读到什么
 *   ④ RTC 的 OS 标志：读前后各一次，并写时间把标志清掉（为"总断电 10 分钟"测试做准备）
 *
 * 判读方法：
 *   - 屏幕上 "boot #N" 是持久化计数：拔插 USB 后如果 N 递增 = 重启过；不变 = 一直在跑
 *   - 屏幕上 "up=xxxs" 每秒自增：说明系统在跑（断电/重启会归零）
 */
#include <Wire.h>
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <Preferences.h>

#include "pin_config.h"                 // 必须最先（定义 XPOWERS_CHIP_AXP2101）
#include "Arduino_GFX_Library.h"
#include "SensorPCF85063.hpp"
#include <XPowersLib.h>

static Arduino_DataBus *bus = nullptr;
static Arduino_GFX     *gfx = nullptr;
static SensorPCF85063   rtc;
static XPowersPMU       power;
static Preferences      prefs;

static bool dispOk = false, rtcOk = false, pmuOk = false;
static int  bootNo = 0;
static uint32_t t0 = 0;

static const char *resetReasonStr(esp_reset_reason_t r) {
    switch (r) {
        case ESP_RST_POWERON:  return "POWERON(冷启动/上电)";
        case ESP_RST_EXT:      return "EXT(外部)";
        case ESP_RST_SW:       return "SW(软件重启)";
        case ESP_RST_PANIC:    return "PANIC(崩溃)";
        case ESP_RST_INT_WDT:  return "INT_WDT";
        case ESP_RST_TASK_WDT: return "TASK_WDT";
        case ESP_RST_WDT:      return "WDT";
        case ESP_RST_BROWNOUT: return "BROWNOUT(电压跌落!)";
        case ESP_RST_DEEPSLEEP:return "DEEPSLEEP";
        case ESP_RST_USB:      return "USB(USB 复位)";
        default:               return "UNKNOWN";
    }
}

static void dumpPmu() {
    if (!pmuOk) { Serial.println("[PMU] 未初始化"); return; }
    const int  mv    = power.getBattVoltage();
    const int  pct   = power.getBatteryPercent();
    const int  vbus  = power.getVbusVoltage();
    const bool bat   = power.isBatteryConnect();
    const bool vin   = power.isVbusIn();
    const bool chg   = power.isCharging();
    Serial.printf("[PMU] 电池=%s(%dmV,%d%%) VBUS=%s(%dmV) 充电中=%s\n",
                  bat ? "接入" : "未接入", mv, pct,
                  vin ? "有" : "无", vbus,
                  chg ? "是" : "否");
    Serial.printf("[PMU] 供电来源判定: %s\n", vin ? "USB/VBUS（电池只在充电）" : "电池（未插 USB）");
}

static void drawScreen(uint32_t upS) {
    if (!dispOk) return;
    // 整屏底色随供电方式变化：插 USB = 蓝，纯电池 = 橙
    static int lastMode = -1;
    const bool vin = pmuOk ? power.isVbusIn() : true;
    const int mode = vin ? 0 : 1;
    if (mode != lastMode) {
        gfx->fillScreen(mode == 0 ? RGB565_BLUE : RGB565_ORANGE);
        lastMode = mode;
    }
    gfx->fillRect(0, 180, LCD_WIDTH, 200, mode == 0 ? RGB565_BLUE : RGB565_ORANGE);
    gfx->setTextColor(RGB565_WHITE);
    gfx->setTextSize(4);
    gfx->setCursor(20, 190);
    gfx->printf("boot #%d\n", bootNo);
    gfx->setCursor(20, 240);
    gfx->printf("up %lus\n", (unsigned long)upS);
    gfx->setTextSize(3);
    gfx->setCursor(20, 300);
    gfx->printf("%s %dmV\n", vin ? "USB" : "BAT",
                pmuOk ? (vin ? power.getVbusVoltage() : power.getBattVoltage()) : 0);
    gfx->setCursor(20, 340);
    gfx->printf("rs=%d\n", (int)esp_reset_reason());
}

void setup() {
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);
#endif
    delay(6000);

    prefs.begin("diag", false);
    bootNo = prefs.getInt("boots", 0) + 1;
    prefs.putInt("boots", bootNo);
    prefs.end();

    t0 = millis();
    const esp_reset_reason_t rr = esp_reset_reason();
    Serial.println();
    Serial.println("========== power_probe ==========");
    Serial.printf("[BOOT] 第 %d 次启动 | reset_reason=%d %s\n", bootNo, (int)rr, resetReasonStr(rr));
    Serial.printf("[BOOT] CPU=%dMHz\n", getCpuFrequencyMhz());

    // ---- 显示（第一件事，保证"能不能亮"先有答案）
    bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
    gfx = new Arduino_CO5300(bus, LCD_RESET, 0, LCD_WIDTH, LCD_HEIGHT, 22, 0, 0, 0);
    dispOk = gfx->begin();
    Serial.printf("[DISP] begin=%s\n", dispOk ? "OK" : "FAIL");
    if (dispOk) gfx->fillScreen(RGB565_BLACK);

    // ---- I2C
    Wire.begin(IIC_SDA, IIC_SCL, 400000);
    delay(50);

    // ---- PMU（先于 RTC：AXP 是总电源）
    pmuOk = power.init(Wire, IIC_SDA, IIC_SCL, AXP2101_SLAVE_ADDRESS);
    Serial.printf("[PMU] init=%s\n", pmuOk ? "OK" : "FAIL");
    if (pmuOk) {
        power.enableBattDetection();
        power.enableBattVoltageMeasure();
        power.enableVbusVoltageMeasure();
        power.enableIRQ(XPOWERS_AXP2101_PKEY_SHORT_IRQ | XPOWERS_AXP2101_PKEY_LONG_IRQ);
        power.clearIrqStatus();
        dumpPmu();
    }

    // ---- RTC：先读 OS 标志；只有"停振过"才写时间
    //       ⚠️ 千万别每次开机都写时间 —— 那样永远测不了漂移
    rtcOk = rtc.begin(Wire, IIC_SDA, IIC_SCL);
    Serial.printf("[RTC] begin=%s\n", rtcOk ? "OK" : "FAIL");
    if (rtcOk) {
        const bool osBefore = rtc.isClockIntegrityGuaranteed();
        const bool runBefore = rtc.isRunning();
        Serial.printf("[RTC] 启动时：OS 标志=%s | 走时=%s\n",
                      osBefore ? "0(未停振，时间可信)" : "1(停振过，时间不可信)", runBefore ? "是" : "否");
        if (!runBefore) rtc.start();
        if (!osBefore) {
            // 停振过才设时（这次设时会顺带把 OS 清零）
            rtc.setDateTime((uint16_t)2026, (uint8_t)11, (uint8_t)21, (uint8_t)22, (uint8_t)40, (uint8_t)0);
            delay(20);
            Serial.printf("[RTC] 已重新设时，OS 现在=%s ← 下次总断电后再看它\n",
                          rtc.isClockIntegrityGuaranteed() ? "0" : "1");
        } else {
            Serial.println("[RTC] 未停振：保留原有走时（用于漂移测量，不覆盖）");
        }
        RTC_DateTime dt = rtc.getDateTime();
        Serial.printf("[RTC] 当前读数: %04d-%02d-%02d %02d:%02d:%02d\n",
                      dt.getYear(), dt.getMonth(), dt.getDay(),
                      dt.getHour(), dt.getMinute(), dt.getSecond());
    }

    drawScreen(0);
    Serial.println("=================================");
    Serial.println("拔掉 USB：屏幕若继续走秒 = 电池供电正常；若黑屏/重启(#N 变) = 电池供电路径没起来");
    Serial.println("=================================");
}

void loop() {
    static uint32_t lastSec = 0, lastPmu = 0, lastSize = 0;
    const uint32_t now = millis();

    if (now - lastSec >= 1000) {
        lastSec = now;
        drawScreen((now - t0) / 1000);
    }

    // 每 5s 打一次电源快照（拔掉 USB 后串口会断，这是正常的）
    if (now - lastPmu >= 5000) {
        lastPmu = now;
        if (pmuOk) {
            dumpPmu();
            const uint64_t irq = power.getIrqStatus();
            if (power.isPekeyShortPressIrq()) { Serial.println("[KEY] 电源键短按"); power.clearIrqStatus(); }
            else if (power.isPekeyLongPressIrq()) { Serial.println("[KEY] 电源键长按"); power.clearIrqStatus(); }
            else if (irq) { Serial.printf("[KEY] 其他 IRQ: 0x%04llX\n", (unsigned long long)irq); power.clearIrqStatus(); }
        }
        if (rtcOk) {
            RTC_DateTime dt = rtc.getDateTime();
            Serial.printf("[RTC] %04d-%02d-%02d %02d:%02d:%02d\n",
                          dt.getYear(), dt.getMonth(), dt.getDay(),
                          dt.getHour(), dt.getMinute(), dt.getSecond());
        }
        Serial.printf("[BOOT] boot #%d | up=%lus | reason=%s\n",
                      bootNo, (unsigned long)((now - t0) / 1000),
                      resetReasonStr(esp_reset_reason()));
        Serial.printf("[HEAP] 内部剩余=%u B, PSRAM 剩余=%u B\n",
                      (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                      (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    delay(20);
}
