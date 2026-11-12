/**
 * step_selftest.ino
 *
 * 为什么要有这个 sketch：
 *   "计步准不准"没法靠静态放置验证 —— 静置只能证明不误报，证明不了能计步。
 *   而我没有手去摇表，所以用**合成信号**把 step_counter.h 的同一份代码跑一遍：
 *     - 静置 3s          → 期望 0 步（不误报）
 *     - 1.8Hz / 0.35g 走 → 期望 ≈ 18 步/10s（能计步）
 *     - 2Hz / 0.05g 微振 → 期望 0 步（低于阈值不误报）
 *     - 静置 3s          → 期望 0 步
 *   跑的是真实 C++ 代码（同一头文件），不是 Python 复刻。
 *
 * 结果打到串口，最后一行是总的 PASS / FAIL。
 */

#include "../common/step_counter.h"

#define SAMPLE_HZ 25
#define SAMPLE_PERIOD_MS (1000 / SAMPLE_HZ)

static StepCounter sc;

// 确定性伪随机（不用 random()，保证每次跑结果一致，便于回归）
static uint32_t g_seed = 12345u;
static float noise(float amp) {
  g_seed = g_seed * 1664525u + 1013904223u;
  const float r = ((float)((g_seed >> 8) & 0xFFFF) / 65535.0f) * 2.0f - 1.0f;
  return r * amp;
}

static int g_fail = 0;

/** 喂一段合成信号：magnitude = base + amp*sin(2πft) */
static uint32_t runSegment(const char *label, float seconds, float freqHz, float ampG,
                           float noiseG, uint32_t startMs, uint32_t *outSamples) {
  const uint32_t n = (uint32_t)(seconds * SAMPLE_HZ);
  uint32_t steps = 0;

  // 每段单独统计，否则 std/peak 会把前面几段累积进来，读数会骗人
  sc.resetWindow();

  for (uint32_t i = 0; i < n; i++) {
    const float t = (float)i / (float)SAMPLE_HZ;
    const float m = 1.0f + ampG * sinf(2.0f * 3.14159265f * freqHz * t) + noise(noiseG);
    // 让合模量正好等于 m：只给 z 轴
    const bool stepped = sc.feed(0.0f, 0.0f, m, startMs + i * SAMPLE_PERIOD_MS);
    if (stepped) steps++;
  }

  if (outSamples) *outSamples = n;
  Serial.printf("[SEG] %-22s %.1fs f=%.1fHz amp=%.2fg noise=%.2f -> steps=%lu std=%.3f peak=%.3f\n",
                label, seconds, freqHz, ampG, noiseG,
                (unsigned long)steps, sc.stdDev(), sc.peak());
  return steps;
}

static void expect(const char *what, uint32_t got, uint32_t lo, uint32_t hi) {
  const bool ok = got >= lo && got <= hi;
  if (!ok) g_fail++;
  Serial.printf("  [%s] %s: got=%lu expect=[%lu,%lu]\n",
                ok ? "PASS" : "FAIL", what, (unsigned long)got,
                (unsigned long)lo, (unsigned long)hi);
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0) < 5000) {
    delay(10);
  }
  delay(300);

  Serial.println();
  Serial.println("==================================================");
  Serial.println(" StepCounter 合成信号自测");
  Serial.println("==================================================");

  StepCounter::Config cfg;
  sc.configure(cfg);
  sc.resetAll();

  uint32_t ms = 0;

  // 1) 静置 3s：不能有任何误计
  uint32_t s1 = runSegment("静置(预热)", 3.0f, 1.0f, 0.0f, 0.010f, ms, nullptr);
  ms += 3000;
  expect("静置不误报", s1, 0, 0);

  // 2) 走路 10s @1.8Hz：应当计到 ≈18 步
  const uint32_t s2 = runSegment("走路 1.8Hz/0.35g", 10.0f, 1.8f, 0.35f, 0.030f, ms, nullptr);
  ms += 10000;
  expect("走路能计步", s2, 14, 22);

  // 3) 微振动 5s @2Hz/0.05g：低于阈值，不能计步
  const uint32_t s3 = runSegment("微振 2Hz/0.05g", 5.0f, 2.0f, 0.05f, 0.010f, ms, nullptr);
  ms += 5000;
  expect("小幅振动不误报", s3, 0, 1);

  // 4) 静置 3s
  const uint32_t s4 = runSegment("静置(收尾)", 3.0f, 1.0f, 0.0f, 0.010f, ms, nullptr);
  ms += 3000;
  expect("静置不误报", s4, 0, 0);

  // 5) 窗口统计：走路时方差/峰值必须显著大于静置
  sc.resetWindow();
  runSegment("强度对比(取样)", 2.0f, 1.8f, 0.35f, 0.020f, ms, nullptr);
  const float stdWalk = sc.stdDev();
  const float peakWalk = sc.peak();

  sc.resetWindow();
  runSegment("静置对比(取样)", 2.0f, 1.0f, 0.0f, 0.010f, ms + 5000, nullptr);
  const float stdStill = sc.stdDev();

  expect("走路方差明显大于静置", (uint32_t)(stdWalk * 1000), (uint32_t)(stdStill * 1000) + 100, 1000);

  Serial.println("--------------------------------------------------");
  Serial.printf("走路 std=%.3fg peak=%.3fg | 静置 std=%.3fg\n", stdWalk, peakWalk, stdStill);
  Serial.println(g_fail == 0 ? "SELFTEST RESULT: PASS" : "SELFTEST RESULT: FAIL");
  Serial.println("--------------------------------------------------");
}

void loop() {
  delay(1000);
}
