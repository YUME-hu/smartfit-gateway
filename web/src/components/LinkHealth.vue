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
/** 把桶换成柱状图数据：0 就是空洞 */
const bars = computed(() => {
  const bs = props.snapshot?.buckets ?? []
  return bs.map((b) => {
    const ratio = b.expected > 0 ? b.rows / b.expected : 0
    let level: 'ok' | 'partial' | 'gap' = 'gap'
    if (ratio >= 0.9) level = 'ok'
    else if (ratio > 0) level = 'partial'
    return { t: b.t, ratio: Math.min(1, ratio), rows: b.rows, expected: b.expected, level }
  })
})

/** 有没有任何数据：没有的话不画空柱阵，避免"看着像断了 60 分钟" */
const hasData = computed(() => (props.snapshot?.rows ?? 0) > 0)

/** 最近 60 分钟里有几个 2 分钟桶是空的 */
const gapCount = computed(() => bars.value.filter((b) => b.level === 'gap').length)

const hm = (ms: number) =>
  new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

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

    <!-- 到达时间线：每柱 = 2 分钟；柱子为空 = 那段没有数据 -->
    <div class="timeline">
      <div class="timeline-head">
        <span>到达时间线（每柱 2 分钟）</span>
        <template v-if="hasData">
          <span v-if="gapCount > 0" class="gap-note">{{ gapCount }} 段空洞</span>
          <span v-else class="ok-note">无空洞</span>
        </template>
        <span v-else class="idle-note">暂无数据</span>
      </div>

      <div v-if="hasData" class="bars">
        <div
          v-for="b in bars"
          :key="b.t"
          class="bar"
          :class="b.level"
          :style="{ height: Math.max(3, b.ratio * 100) + '%' }"
          :title="`${hm(b.t)}  ${b.rows}/${b.expected} 包`"
        />
      </div>
      <!-- 完全没有数据时不画 30 根空柱，那是误导：看着像"断了 60 分钟" -->
      <div v-else class="empty-line">最近 60 分钟没有样本入库（手表是否在连？App 是否在同步？）</div>

      <div v-if="hasData" class="axis">
        <span>{{ bars.length ? hm(bars[0].t) : '' }}</span>
        <span>现在</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line, #1c2a4a);
}
.timeline-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  opacity: 0.65;
  margin-bottom: 8px;
}
.gap-note {
  color: #ff6b4a;
}
.ok-note {
  color: #6fe3d2;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 56px;
}
.bar {
  flex: 1;
  border-radius: 2px 2px 0 0;
  min-height: 3px;
}
.bar.ok {
  background: #6fe3d2;
}
.bar.partial {
  background: #ffb84d;
}
.bar.gap {
  background: #2a3350;
}
.idle-note {
  opacity: 0.5;
}
.empty-line {
  font-size: 12px;
  opacity: 0.5;
  padding: 10px 0 4px;
}
.axis {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  opacity: 0.45;
  margin-top: 4px;
}
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
