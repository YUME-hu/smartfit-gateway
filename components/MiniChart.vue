<template>
  <view class="wrap">
    <view v-if="label" class="head">
      <text class="label">{{ label }}</text>
      <text class="value" :style="{ color: color }">{{ latestText }}</text>
    </view>
    <canvas
      :canvas-id="canvasId"
      :id="canvasId"
      class="chart"
      :style="{ height: height + 'rpx' }"
    ></canvas>
  </view>
</template>

<script setup lang="ts">
/**
 * 轻量折线/柱状图（原生 canvas，零依赖）
 *
 * 为什么不用 ECharts：uni-app 里 ECharts 需要额外的 canvas 适配层
 * （lime-echart / renderjs 之类），打包体积和真机兼容性都是风险；
 * 这里只画一条序列，几十行 canvas 就够，且 App/H5 行为一致。
 *
 * 坐标：uni 的 legacy canvas 绘图单位就是 CSS px，所以先用
 * createSelectorQuery 量出实际尺寸再画。
 */
import { getCurrentInstance, nextTick, onMounted, ref, watch } from 'vue'

let seq = 0

const props = withDefaults(
  defineProps<{
    values: number[]
    type?: 'line' | 'bar'
    color?: string
    label?: string
    /** 固定下界；不给则按数据自适应 */
    min?: number
    /** 固定上界；不给则按数据自适应 */
    max?: number
    height?: number
    /** 小数位 */
    digits?: number
  }>(),
  {
    type: 'line',
    color: '#3d7eff',
    label: '',
    height: 240,
    digits: 2,
  },
)

const canvasId = `mini_chart_${++seq}`
const size = ref({ w: 0, h: 0 })
const instance = getCurrentInstance()

const latestText = ref('—')

function measure(): Promise<void> {
  return new Promise((resolve) => {
    const query = uni.createSelectorQuery()
    const scoped = instance?.proxy ? query.in(instance.proxy) : query
    scoped
      .select(`#${canvasId}`)
      .boundingClientRect((rect: { width: number; height: number } | null) => {
        if (rect && rect.width > 0) size.value = { w: rect.width, h: rect.height }
        resolve()
      })
      .exec()
  })
}

function draw(): void {
  const { w, h } = size.value
  if (w <= 0 || h <= 0) return

  const ctx = uni.createCanvasContext(canvasId, instance?.proxy)
  const padL = 38
  const padR = 10
  const padT = 12
  const padB = 16
  const plotW = Math.max(1, w - padL - padR)
  const plotH = Math.max(1, h - padT - padB)

  // 背景
  ctx.setFillStyle('#171a21')
  ctx.fillRect(0, 0, w, h)

  const vals = props.values
  if (!vals.length) {
    ctx.setFontSize(12)
    ctx.setFillStyle('#5b6478')
    ctx.fillText('等待数据…', padL + 8, padT + plotH / 2)
    ctx.draw()
    latestText.value = '—'
    return
  }

  let lo = props.min !== undefined ? props.min : Math.min(...vals)
  let hi = props.max !== undefined ? props.max : Math.max(...vals)
  if (hi - lo < 1e-6) {
    hi = lo + 1
  }
  const span = hi - lo

  const xAt = (i: number): number => {
    if (vals.length === 1) return padL + plotW / 2
    return padL + (plotW * i) / (vals.length - 1)
  }
  const yAt = (v: number): number => padT + plotH * (1 - (v - lo) / span)

  // 网格 + Y 轴刻度
  ctx.setStrokeStyle('#23262f')
  ctx.setLineWidth(1)
  ctx.setFontSize(10)
  for (let i = 0; i <= 3; i++) {
    const y = padT + (plotH * i) / 3
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + plotW, y)
    ctx.stroke()

    const v = hi - (span * i) / 3
    ctx.setFillStyle('#5b6478')
    ctx.fillText(v.toFixed(props.digits), 2, y + 3)
  }

  if (props.type === 'bar') {
    const barW = Math.max(2, (plotW / Math.max(vals.length, 1)) * 0.62)
    for (let i = 0; i < vals.length; i++) {
      const x = padL + (plotW * (i + 0.5)) / vals.length - barW / 2
      const y = yAt(vals[i])
      ctx.setFillStyle(props.color)
      ctx.fillRect(x, y, barW, Math.max(0, padT + plotH - y))
    }
  } else {
    // 面积
    ctx.setFillStyle(hexToRgba(props.color, 0.16))
    ctx.beginPath()
    ctx.moveTo(xAt(0), padT + plotH)
    for (let i = 0; i < vals.length; i++) ctx.lineTo(xAt(i), yAt(vals[i]))
    ctx.lineTo(xAt(vals.length - 1), padT + plotH)
    ctx.closePath()
    ctx.fill()

    // 折线
    ctx.setStrokeStyle(props.color)
    ctx.setLineWidth(2)
    ctx.beginPath()
    for (let i = 0; i < vals.length; i++) {
      const x = xAt(i)
      const y = yAt(vals[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // 末点
    const lx = xAt(vals.length - 1)
    const ly = yAt(vals[vals.length - 1])
    ctx.setFillStyle(props.color)
    ctx.beginPath()
    ctx.arc(lx, ly, 3, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.draw()

  latestText.value = vals[vals.length - 1].toFixed(props.digits)
}

/** #rrggbb + alpha → rgba()，canvas 的 setFillStyle 不认 8 位 hex */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

onMounted(async () => {
  await nextTick()
  await measure()
  draw()
})

watch(
  () => props.values,
  () => draw(),
  { deep: true },
)
</script>

<style>
.wrap {
  margin-bottom: 20rpx;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 8rpx 4rpx 12rpx;
}

.label {
  color: #8b93a7;
  font-size: 24rpx;
}

.value {
  font-family: monospace;
  font-size: 30rpx;
  font-weight: 600;
}

.chart {
  width: 100%;
  background: #171a21;
  border-radius: 16rpx;
}
</style>
