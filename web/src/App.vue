<script setup lang="ts">
/**
 * SmartFit 实时看板
 *
 * 数据源：Supabase `device_latest`（App 每收到手表一包就 upsert 一行）
 * 实时性：Supabase Realtime（WebSocket）推 postgres_changes 事件
 *
 * 注意 `steps` 的口径：它是**最近一个 5 秒窗口内的步数**，不是全天累计。
 * 所以这里的「会话累计」是从页面打开起自己累加的，刷新即归零。
 * 要真正的日累计，需要服务端做聚合视图（见 README）。
 */

import { computed, ref } from 'vue'
import LiveChart from './components/LiveChart.vue'
import SquatView from './features/squat/SquatView.vue'
import PetView from './features/pet/PetView.vue'
import { useDeviceLatest } from './composables/useDeviceLatest'

/** 顶部 Tab：实时数据 / 深蹲识别 / 我的宠物（不引 vue-router，减少一层依赖） */
const tab = ref<'data' | 'squat' | 'pet'>('data')

const env = import.meta.env
const supabaseUrl = env.VITE_SUPABASE_URL as string | undefined
const supabaseKey = env.VITE_SUPABASE_ANON_KEY as string | undefined
const deviceId = (env.VITE_DEVICE_ID as string | undefined) || 'watch-01'

const missing: string[] = []
if (!supabaseUrl) missing.push('VITE_SUPABASE_URL')
if (!supabaseKey) missing.push('VITE_SUPABASE_ANON_KEY')

const { latest, points, status, error, sessionSteps, lastAt, reconnect } = useDeviceLatest({
  supabaseUrl: supabaseUrl ?? 'https://placeholder.supabase.co',
  supabaseAnonKey: supabaseKey ?? 'placeholder',
  deviceId,
  enabled: missing.length === 0,
})

const STATUS_TEXT: Record<string, string> = {
  connecting: '连接中',
  live: '实时在线',
  error: '连接异常',
  closed: '未配置',
}

const statusText = computed(() => STATUS_TEXT[status.value] ?? status.value)
const isLive = computed(() => status.value === 'live')

/** 当前合模量（取最新一帧） */
const currentMag = computed(() => {
  const last = points.value[points.value.length - 1]
  return last ? last.mag.toFixed(3) : '—'
})

/** 最近一个 5 秒窗口的步数 */
const windowSteps = computed(() => latest.value?.steps ?? 0)

const lastUpdate = computed(() => {
  if (!lastAt.value) return '—'
  const d = new Date(lastAt.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

/** 超过 15 秒（3 个包周期）没更新就提示可能断了 */
const stale = computed(() => lastAt.value > 0 && Date.now() - lastAt.value > 15000)
</script>

<template>
  <div class="page">
    <nav class="app-tabs">
      <button :class="['app-tab', { active: tab === 'data' }]" @click="tab = 'data'">
        实时数据
      </button>
      <button :class="['app-tab', { active: tab === 'squat' }]" @click="tab = 'squat'">
        深蹲识别
      </button>
      <button :class="['app-tab', { active: tab === 'pet' }]" @click="tab = 'pet'">
        我的宠物
      </button>
    </nav>

    <template v-if="tab === 'data'">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="{ live: isLive }"></span>
        <h1>SmartFit 实时看板</h1>
        <span class="device">{{ deviceId }}</span>
      </div>
      <div class="topbar-right">
        <span class="pill" :class="status">{{ statusText }}</span>
        <button class="ghost" @click="reconnect">重连</button>
      </div>
    </header>

    <div v-if="missing.length" class="banner">
      <strong>缺少环境变量：</strong>{{ missing.join('、') }}
      <div class="banner-sub">
        复制 <code>web/.env.example</code> 为 <code>web/.env</code> 并填写后重启 dev server
      </div>
    </div>

    <div v-if="error" class="banner error">{{ error }}</div>

    <section class="kpis">
      <article class="kpi">
        <div class="kpi-label">合模量 |a|</div>
        <div class="kpi-value">{{ currentMag }}<span class="unit">g</span></div>
        <div class="kpi-foot">静止约 1.0 g</div>
      </article>

      <article class="kpi">
        <div class="kpi-label">最近 5 秒步数</div>
        <div class="kpi-value accent">{{ windowSteps }}<span class="unit">步</span></div>
        <div class="kpi-foot">手表端窗口聚合结果</div>
      </article>

      <article class="kpi">
        <div class="kpi-label">会话累计</div>
        <div class="kpi-value">{{ sessionSteps }}<span class="unit">步</span></div>
        <div class="kpi-foot">自本页打开起累加</div>
      </article>

      <article class="kpi">
        <div class="kpi-label">最后更新</div>
        <div class="kpi-value small" :class="{ warn: stale }">{{ lastUpdate }}</div>
        <div class="kpi-foot">{{ points.length }} / 120 个采样点</div>
      </article>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>加速度与步数（5 分钟滚动窗口）</h2>
        <span class="hint">每 5 秒一包 · ECharts</span>
      </div>
      <div class="chart-wrap">
        <LiveChart :points="points" />
        <div v-if="points.length === 0" class="empty">
          <p>等待数据…</p>
          <p class="small">
            确认手机 App 已连接手表并写入数据；<br />
            没有数据时检查 <code>device_latest</code> 是否已开 <code>replica identity full</code>
          </p>
        </div>
      </div>
    </section>

    <footer class="foot">
      <p>
        说明：此处「步数」是手表端每 5 秒窗口内的步数，会话累计由前端叠加，
        <strong>不是全天总计</strong>；全天统计需要服务端聚合视图。
      </p>
    </footer>
    </template>

    <SquatView v-else-if="tab === 'squat'" />
    <PetView v-else-if="tab === 'pet'" :steps="sessionSteps" :last-at="lastAt" />
  </div>
</template>

<style scoped>
.app-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
  border-bottom: 1px solid #1f232c;
  padding-bottom: 12px;
}

.app-tab {
  background: transparent;
  border: 1px solid #2b2f3a;
  color: #8b93a7;
  border-radius: 999px;
  padding: 7px 18px;
  font-size: 14px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.app-tab:hover {
  color: #c7cede;
  border-color: #3a4050;
}

.app-tab.active {
  background: rgba(61, 126, 255, 0.14);
  border-color: #3d7eff;
  color: #fff;
}

.page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 20px 48px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  gap: 12px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand h1 {
  font-size: 20px;
  margin: 0;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.device {
  font-family: monospace;
  font-size: 12px;
  color: #8b93a7;
  border: 1px solid #23262f;
  padding: 2px 8px;
  border-radius: 999px;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #6b7387;
  box-shadow: 0 0 0 0 rgba(61, 220, 132, 0.5);
}

.dot.live {
  background: #3ddc84;
  animation: pulse 1.8s infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(61, 220, 132, 0.45);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(61, 220, 132, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(61, 220, 132, 0);
  }
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pill {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #23262f;
  color: #8b93a7;
}

.pill.live {
  color: #3ddc84;
  border-color: rgba(61, 220, 132, 0.35);
  background: rgba(61, 220, 132, 0.08);
}

.pill.error {
  color: #ff5c5c;
  border-color: rgba(255, 92, 92, 0.35);
  background: rgba(255, 92, 92, 0.08);
}

.ghost {
  background: transparent;
  border: 1px solid #2b2f3a;
  color: #c7cede;
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
}

.ghost:hover {
  border-color: #3d7eff;
  color: #fff;
}

.banner {
  background: rgba(255, 92, 92, 0.08);
  border: 1px solid rgba(255, 92, 92, 0.35);
  color: #ffb0b0;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

.banner.error {
  color: #ff8080;
}

.banner-sub {
  margin-top: 6px;
  color: #a06a6a;
  font-size: 12px;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.kpi {
  background: #171a21;
  border: 1px solid #1f232c;
  border-radius: 14px;
  padding: 16px 18px;
}

.kpi-label {
  font-size: 12px;
  color: #8b93a7;
  margin-bottom: 8px;
}

.kpi-value {
  font-family: monospace;
  font-size: 34px;
  font-weight: 700;
  line-height: 1.1;
  color: #e8ecf3;
}

.kpi-value.small {
  font-size: 24px;
}

.kpi-value.accent {
  color: #3ddc84;
}

.kpi-value.warn {
  color: #ffb020;
}

.unit {
  font-size: 14px;
  color: #8b93a7;
  margin-left: 4px;
  font-weight: 400;
}

.kpi-foot {
  margin-top: 8px;
  font-size: 12px;
  color: #5f6779;
}

.card {
  background: #171a21;
  border: 1px solid #1f232c;
  border-radius: 14px;
  padding: 16px 18px 10px;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.card-head h2 {
  font-size: 15px;
  margin: 0;
  font-weight: 600;
  color: #c7cede;
}

.hint {
  font-size: 12px;
  color: #5f6779;
}

.chart-wrap {
  position: relative;
}

.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #8b93a7;
  font-size: 14px;
  text-align: center;
  pointer-events: none;
}

.empty .small {
  font-size: 12px;
  color: #5f6779;
  line-height: 1.7;
}

.foot {
  margin-top: 18px;
  color: #5f6779;
  font-size: 12px;
  line-height: 1.8;
}

code {
  background: #1f232c;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  color: #a8b2c7;
}
</style>
