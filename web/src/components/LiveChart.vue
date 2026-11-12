<script setup lang="ts">
/**
 * ECharts 滚动折线图
 *
 * 只包一层薄封装，不引 vue-echarts：
 *   - 实例生命周期、resize、dispose 都在这里管住
 *   - 数据更新用 setOption 增量合并（notMerge=false），避免每次重建导致闪动
 *
 * 两条序列共用时间轴：
 *   左轴 合模量 |a|（折线 + 面积）
 *   右轴 每窗口步数（柱状）
 */

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
// 按需引入：全量 import * as echarts from 'echarts' 会打进 1.3MB，
// 这里只注册用到的图表与组件，产物能小一多半
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { ChartPoint } from '../composables/useDeviceLatest'

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
])

const props = defineProps<{ points: ChartPoint[] }>()

/** 时间窗口：固定 5 分钟，数据滚动而不是轴自动缩放 */
const WINDOW_MS = 5 * 60 * 1000

const el = ref<HTMLDivElement | null>(null)
// 用 ReturnType 推导实例类型，避免依赖 echarts 具体导出了哪个类型名
let chart: ReturnType<typeof echarts.init> | null = null
let observer: ResizeObserver | null = null

function buildOption(points: ChartPoint[]) {
  const line = points.map((p) => [p.t, Number(p.mag.toFixed(3))])
  const bars = points.map((p) => [p.t, p.steps])

  const lastT = points.length ? points[points.length - 1].t : Date.now()
  const maxSteps = Math.max(8, ...points.map((p) => p.steps))
  const upper = Math.max(1.2, ...points.map((p) => p.mag)) * 1.15

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 58, right: 58, top: 40, bottom: 34 },
    legend: {
      data: ['合模量 |a|', '窗口步数'],
      textStyle: { color: '#8b93a7' },
      top: 4,
      itemWidth: 14,
      itemHeight: 8,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(23,26,33,0.95)',
      borderColor: '#2b2f3a',
      textStyle: { color: '#e8ecf3' },
    },
    xAxis: {
      type: 'time',
      min: lastT - WINDOW_MS,
      max: lastT,
      axisLabel: { color: '#6b7387' },
      axisLine: { lineStyle: { color: '#23262f' } },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: '|a| (g)',
        min: 0,
        max: Number(upper.toFixed(2)),
        nameTextStyle: { color: '#6b7387' },
        axisLabel: { color: '#6b7387' },
        splitLine: { lineStyle: { color: '#1d2029' } },
      },
      {
        type: 'value',
        name: '步数',
        min: 0,
        max: maxSteps,
        nameTextStyle: { color: '#6b7387' },
        axisLabel: { color: '#6b7387' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '合模量 |a|',
        type: 'line',
        smooth: true,
        showSymbol: points.length <= 2,
        yAxisIndex: 0,
        lineStyle: { width: 2, color: '#3d7eff' },
        itemStyle: { color: '#3d7eff' },
        areaStyle: { opacity: 0.18 },
        data: line,
      },
      {
        name: '窗口步数',
        type: 'bar',
        yAxisIndex: 1,
        barWidth: '38%',
        itemStyle: { color: 'rgba(61,220,132,0.55)' },
        data: bars,
      },
    ],
  }
}

function render(): void {
  if (!chart) return
  chart.setOption(buildOption(props.points), { notMerge: false })
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value, undefined, { renderer: 'canvas' })
  render()

  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(el.value)
})

watch(
  () => props.points,
  () => render(),
  { deep: true },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
})
</script>

<template>
  <div ref="el" class="chart"></div>
</template>

<style scoped>
.chart {
  width: 100%;
  height: 380px;
}
</style>
