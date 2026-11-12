<template>
  <view class="page">
    <!-- 配置缺失时最优先显示：这类问题最容易被误判成"蓝牙又连不上" -->
    <view v-if="missing.length" class="banner">
      <text class="banner-title">缺少环境变量</text>
      <text class="banner-body">{{ missing.join('、') }}</text>
      <text class="banner-hint">复制 .env.example 为 .env 并填写后重新构建</text>
    </view>

    <!-- 步数主视觉 -->
    <view class="hero">
      <view class="hero-item">
        <text class="hero-num">{{ totalSteps }}</text>
        <text class="hero-cap">累计步数（本次运行）</text>
      </view>
      <view class="hero-split"></view>
      <view class="hero-item">
        <text class="hero-num small">{{ windowSteps }}</text>
        <text class="hero-cap">最近 5 秒</text>
      </view>
    </view>

    <!-- 图表 -->
    <view class="card">
      <MiniChart
        label="合模量 |a|  (g)"
        :values="magnitudes"
        color="#3d7eff"
        :min="0"
        :max="2.5"
        :height="260"
        :digits="2"
      />
      <MiniChart
        label="每 5 秒窗口步数"
        :values="stepSeries"
        type="bar"
        color="#3ddc84"
        :min="0"
        :height="180"
        :digits="0"
      />
    </view>

    <!-- 状态 -->
    <view class="card">
      <view class="row">
        <text class="label">连接状态</text>
        <text :class="['value', connected ? 'ok' : 'warn']">{{ statusText }}</text>
      </view>
      <view v-if="statusDetail" class="hint">{{ statusDetail }}</view>

      <view class="row">
        <text class="label">最新均值 x,y,z</text>
        <text class="value mono">{{ liveText }}</text>
      </view>

      <view class="row">
        <text class="label">待上传 / 已上传</text>
        <text :class="['value', pending > 0 ? 'warn' : 'ok']">
          {{ pending }} / {{ uploadedTotal }}
        </text>
      </view>

      <view class="row">
        <text class="label">收包 / 丢包 / 坏包</text>
        <text class="value mono">{{ packets }} / {{ lostPackets }} / {{ badPackets }}</text>
      </view>

      <view class="row">
        <text class="label">上次同步</text>
        <text class="value">{{ lastSyncText }}</text>
      </view>

      <view v-if="dropped > 0" class="hint error">
        离线过久，已丢弃最旧的 {{ dropped }} 条（缓存上限 6 万条）
      </view>
      <view v-if="badPackets > 0" class="hint error">
        有 {{ badPackets }} 个包被丢弃：多半是 MTU 未协商导致负载被截断
      </view>
      <view v-if="lastError" class="hint error">{{ lastError }}</view>
    </view>

    <button class="btn" :loading="syncing" :disabled="syncing" @click="onSyncNow">
      {{ syncing ? '同步中…' : '立即同步' }}
    </button>

    <view class="hint center">
      每 {{ Math.round(syncIntervalMs / 60000) }} 分钟自动同步；App 退到后台会被系统挂起，
      演示时请保持前台
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MiniChart from '../../components/MiniChart.vue'
import { gatewayConfig, missingEnv } from '../../config'
import { useImuGateway } from '../../gateway/useImuGateway'

const missing = missingEnv

const {
  status,
  statusDetail,
  connected,
  pending,
  dropped,
  uploadedTotal,
  packets,
  lostPackets,
  badPackets,
  lastSample,
  lastSyncAt,
  syncing,
  lastError,
  history,
  totalSteps,
  windowSteps,
  start,
  syncNow,
} = useImuGateway(gatewayConfig)

const syncIntervalMs = gatewayConfig.syncIntervalMs

const STATUS_TEXT: Record<string, string> = {
  idle: '未启动',
  scanning: '扫描中',
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '异常',
}

const statusText = computed(() => STATUS_TEXT[status.value] ?? status.value)

const liveText = computed(() => {
  const s = lastSample.value
  if (!s) return '—'
  return `${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)}`
})

const lastSyncText = computed(() => {
  if (!lastSyncAt.value) return '尚未同步'
  const d = new Date(lastSyncAt.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

/** 合模量序列：图表只看"动没动"，|a| 去掉方向影响更直观 */
const magnitudes = computed(() =>
  history.value.map((s) => Math.sqrt(s.x * s.x + s.y * s.y + s.z * s.z)),
)

/** 每窗口步数；老固件没有 steps 时补 0，图不会断 */
const stepSeries = computed(() => history.value.map((s) => s.stepsInWindow ?? 0))

async function onSyncNow() {
  await syncNow()
}

start()
</script>

<style>
.page {
  padding: 24rpx;
  min-height: 100vh;
  background: #0f1115;
}

.banner {
  background: #3a1d1d;
  border: 1rpx solid #ff5c5c;
  border-radius: 16rpx;
  padding: 20rpx;
  margin-bottom: 24rpx;
}

.banner-title {
  display: block;
  color: #ff8080;
  font-size: 26rpx;
  font-weight: 600;
  margin-bottom: 8rpx;
}

.banner-body {
  display: block;
  color: #ffb0b0;
  font-size: 24rpx;
  font-family: monospace;
}

.banner-hint {
  display: block;
  color: #a06a6a;
  font-size: 22rpx;
  margin-top: 8rpx;
}

.hero {
  display: flex;
  align-items: center;
  background: #171a21;
  border-radius: 20rpx;
  padding: 28rpx 0;
  margin-bottom: 24rpx;
}

.hero-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.hero-num {
  color: #3ddc84;
  font-size: 64rpx;
  font-weight: 700;
  font-family: monospace;
  line-height: 1.1;
}

.hero-num.small {
  color: #e8ecf3;
  font-size: 48rpx;
}

.hero-cap {
  color: #8b93a7;
  font-size: 22rpx;
  margin-top: 8rpx;
}

.hero-split {
  width: 1rpx;
  height: 72rpx;
  background: #23262f;
}

.card {
  background: #171a21;
  border-radius: 20rpx;
  padding: 16rpx 24rpx;
  margin-bottom: 24rpx;
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 22rpx 0;
  border-bottom: 1rpx solid #23262f;
}

.row:last-child {
  border-bottom: none;
}

.label {
  color: #8b93a7;
  font-size: 26rpx;
}

.value {
  color: #e8ecf3;
  font-size: 28rpx;
}

.mono {
  font-family: monospace;
}

.ok {
  color: #3ddc84;
}

.warn {
  color: #ffb020;
}

.hint {
  color: #8b93a7;
  font-size: 24rpx;
  padding: 16rpx 0;
}

.hint.error {
  color: #ff5c5c;
}

.center {
  text-align: center;
}

.btn {
  background: #3d7eff;
  color: #fff;
  border-radius: 16rpx;
  font-size: 30rpx;
}
</style>
