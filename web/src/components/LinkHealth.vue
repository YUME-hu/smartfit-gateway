<script setup lang="ts">
/**
 * 链路健康卡（M5）
 *
 * 四个数都是"看不到但很关键"的：
 *   数据新鲜度 / 到达率 / 时钟偏差 / 带表侧时间的比例
 * 用 imu_samples 统计，所以天然反映"同步之后"的真实情况。
 */
import { computed } from 'vue'
import type { LinkHealthSnapshot } from '../composables/useLinkHealth'

const props = defineProps<{
  snapshot: LinkHealthSnapshot | null
  loading: boolean
}>()

/** 相对时间：把"多久之前"说得比时间戳更直观 */
const freshness = computed(() => {
  const t = props.snapshot?.lastSampleAt ?? 0
  if (!t) return '无数据'
  const sec = Math.max(0, (Date.now() - t) / 1000)
  if (sec < 60) return `${Math.round(sec)} 秒前`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`
  return `${(sec / 3600).toFixed(1)} 小时前`
})

const arrival = computed(() => {
  const r = props.snapshot?.arrivalRate
  if (r === null || r === undefined) return '—'
  return (r * 100).toFixed(1) + '%'
})

const skew = computed(() => {
  const ms = props.snapshot?.clockSkewMs
  if (ms === null || ms === undefined) return '无表侧时间'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
})

const tsRatio = computed(() => {
  const r = props.snapshot?.deviceTsRatio
  if (r === null || r === undefined) return '—'
  return (r * 100).toFixed(0) + '%'
})

/** 到达率低于 90% 视为异常（5 秒一包，正常应接近 100%） */
const arrivalWarn = computed(() => {
  const r = props.snapshot?.arrivalRate
  return r !== null && r !== undefined && r < 0.9
})
</script>

<template>
  <section class="card">
    <div class="card-head">
      <h2>链路健康（最近 60 分钟）</h2>
      <span class="hint">{{ loading ? '刷新中…' : '每 30 秒刷新' }}</span>
    </div>

    <div class="health-grid">
      <div class="health-item">
        <div class="health-label">数据新鲜度</div>
        <div class="health-value">{{ freshness }}</div>
        <div class="health-foot">最后一行入库时间</div>
      </div>

      <div class="health-item">
        <div class="health-label">到达率</div>
        <div class="health-value" :class="{ warn: arrivalWarn }">{{ arrival }}</div>
        <div class="health-foot">
          {{ snapshot?.rows ?? 0 }} / {{ snapshot?.expected ?? 0 }} 包（每 5 秒一包）
        </div>
      </div>

      <div class="health-item">
        <div class="health-label">时钟偏差</div>
        <div class="health-value">{{ skew }}</div>
        <div class="health-foot">|收包时间 − 手表时刻| 中位数</div>
      </div>

      <div class="health-item">
        <div class="health-label">带表侧时间</div>
        <div class="health-value">{{ tsRatio }}</div>
        <div class="health-foot">device_ts 非空的行占比</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
  padding: 4px 0 2px;
}
.health-item {
  padding: 12px 14px;
  border: 1px solid var(--line, #1c2a4a);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}
.health-label {
  font-size: 12px;
  opacity: 0.6;
  letter-spacing: 0.04em;
}
.health-value {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  margin: 4px 0 2px;
}
.health-value.warn {
  color: #ff6b4a;
}
.health-foot {
  font-size: 11px;
  opacity: 0.5;
}
</style>
