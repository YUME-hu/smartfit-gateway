/**
 * step_counter.h —— 单窗口（5 秒）聚合计步器
 *
 * 设计要点（这是答辩会被追问的部分，写清楚）：
 *
 * 1) **先去重力，再判步**。合模量 |a| 在静止时约 1g，这个 1g 是"直流偏置"，
 *    不扣掉的话任何阈值判断都会永远成立。这里用 EMA 估计重力基线。
 * 2) **带滞回的过零检测**，不是"超过阈值就 +1"。单阈值方案在噪声里会疯狂误报；
 *    这里要求 ac 先上穿 +threshold、再下穿 -release 才算一个完整步态周期，
 *    等价于要求峰峰值 > threshold+release。
 * 3) **不应期**（默认 250ms）限制最高步频 240 步/分，防止一次冲击被计成多步。
 * 4) 统计量（均值/方差/峰值）与判定状态分离：窗口统计每 5 秒清零，
 *    基线、滞回状态、上一步时间戳跨窗口保留 —— 否则每个窗口开头都会重新
 *    "适应"一次基线，导致窗口边界丢步或误计。
 *
 * 本文件不依赖 Arduino，只依赖 <math.h>/<stdint.h>，所以可以被
 * step_selftest.ino 用合成信号直接测（见 firmware/step_selftest/）。
 */

#pragma once

#include <math.h>
#include <stdint.h>

class StepCounter {
public:
  struct Config {
    /** 上穿阈值（g）：动态加速度超过它才"武装" */
    float thresholdG = 0.12f;
    /** 回落阈值（g）：必须下穿 -releaseG 才算走完一个周期 */
    float releaseG = 0.06f;
    /** 最小步间隔，限制最高步频 */
    uint32_t refractoryMs = 250;
    /** 重力基线 EMA 系数；25Hz 采样下时间常数约 0.8s */
    float baselineAlpha = 0.05f;
  };

  void configure(const Config &c) { cfg_ = c; }
  const Config &config() const { return cfg_; }

  /** 完全复位（基线重新学习） */
  void resetAll() {
    init_ = false;
    baseline_ = 0.0f;
    armed_ = false;
    hasStep_ = false;
    lastStepMs_ = 0;
    resetWindow();
  }

  /** 只清窗口统计，保留判定状态（跨窗口连续计步的关键） */
  void resetWindow() {
    n_ = 0;
    sx_ = sy_ = sz_ = 0.0f;
    sumSqAc_ = 0.0f;
    peak_ = 0.0f;
    windowSteps_ = 0;
  }

  /** 喂一个三轴采样，返回本次是否判定为一步 */
  bool feed(float x, float y, float z, uint32_t nowMs) {
    const float m = sqrtf(x * x + y * y + z * z);

    if (!init_) {
      baseline_ = m;
      init_ = true;
    }

    // 1) 去重力
    baseline_ += cfg_.baselineAlpha * (m - baseline_);
    const float ac = m - baseline_;

    // 2) 窗口统计
    n_++;
    sx_ += x;
    sy_ += y;
    sz_ += z;
    sumSqAc_ += ac * ac;
    const float a = fabsf(ac);
    if (a > peak_) peak_ = a;

    // 3) 带滞回的过零检测
    bool isStep = false;
    if (!armed_) {
      if (ac > cfg_.thresholdG) {
        armed_ = true;
      }
    } else if (ac < -cfg_.releaseG) {
      armed_ = false;
      if (!hasStep_ || (nowMs - lastStepMs_) >= cfg_.refractoryMs) {
        hasStep_ = true;
        lastStepMs_ = nowMs;
        windowSteps_++;
        isStep = true;
      }
    }

    return isStep;
  }

  // ---- 窗口统计 ----
  uint32_t samples() const { return n_; }
  uint32_t windowSteps() const { return windowSteps_; }
  float peak() const { return peak_; }
  /** 动态加速度的标准差（"合模量方差"的平方根），用于衡量运动强度 */
  float stdDev() const { return n_ ? sqrtf(sumSqAc_ / (float)n_) : 0.0f; }

  // ---- 窗口均值（上报给手机的 x,y,z）----
  float meanX() const { return n_ ? sx_ / (float)n_ : 0.0f; }
  float meanY() const { return n_ ? sy_ / (float)n_ : 0.0f; }
  float meanZ() const { return n_ ? sz_ / (float)n_ : 0.0f; }

private:
  Config cfg_{};

  // 判定状态（跨窗口保留）
  bool init_ = false;
  float baseline_ = 0.0f;
  bool armed_ = false;
  bool hasStep_ = false;
  uint32_t lastStepMs_ = 0;

  // 窗口统计（每窗口清零）
  uint32_t n_ = 0;
  float sx_ = 0.0f;
  float sy_ = 0.0f;
  float sz_ = 0.0f;
  float sumSqAc_ = 0.0f;
  float peak_ = 0.0f;
  uint32_t windowSteps_ = 0;
};
