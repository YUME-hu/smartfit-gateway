/**
 * 网关装配层（Vue3 composable）
 *
 * 把 BLE 采集、本地缓存、定时批量同步、手动同步、最新值发布串起来，
 * 页面只需要关心这里的几个响应式状态 + 三个动作。
 *
 * 数据流：
 *   BLE notify → parsePacket → SessionTracker(生成幂等键)
 *              → SampleCache.append(落盘)
 *              → LatestPublisher.publish(实时看板)
 *   每 15 分钟 / 点按钮 → SyncEngine.flush → Supabase upsert → 成功后删缓存
 */

import { getCurrentInstance, onUnmounted, ref } from 'vue'

import { SampleCache } from './cache'
import { SessionTracker } from './session'
import { SupabaseRest } from './supabaseRest'
import { SyncEngine } from './syncEngine'
import { LatestPublisher } from './latest'
import { UniBleTransport } from './bleTransport'
import { parsePacket } from './protocol'
import { uniStore } from './storage'
import type { GatewayConfig, GatewayStatus, ImuSample } from './types'

const KEY_LAST_DEVICE = 'imu.lastDeviceId'
/** 图表保留的窗口数：5s/包 → 60 个 = 5 分钟 */
const HISTORY_MAX = 60

export function useImuGateway(config: GatewayConfig) {
  const status = ref<GatewayStatus>('idle')
  const statusDetail = ref('')
  const connected = ref(false)

  /** 本地待上传条数 */
  const pending = ref(0)
  /** 因容量上限被丢弃的条数（>0 说明离线太久，要提示用户） */
  const dropped = ref(0)
  /** 本次运行累计上传成功条数 */
  const uploadedTotal = ref(0)

  const packets = ref(0)
  const lostPackets = ref(0)
  const badPackets = ref(0)

  const lastSample = ref<ImuSample | null>(null)
  const lastSyncAt = ref<number | null>(null)
  const syncing = ref(false)
  const lastError = ref<string | null>(null)

  /** 最近若干个窗口样本（图表用），不参与持久化 */
  const history = ref<ImuSample[]>([])
  /** 本次运行累计步数（= 各窗口 steps 求和） */
  const totalSteps = ref(0)
  /** 最近一个窗口的步数 */
  const windowSteps = ref(0)

  const store = uniStore()
  const cache = new SampleCache(store)
  const session = new SessionTracker(store, config.deviceId)
  const api = new SupabaseRest({
    url: config.supabaseUrl,
    anonKey: config.supabaseAnonKey,
    sampleTable: config.sampleTable,
    latestTable: config.latestTable,
  })

  const engine = new SyncEngine(cache, api, {
    intervalMs: config.syncIntervalMs,
    batchSize: config.batchSize,
    maxBatchesPerRun: config.maxBatchesPerRun,
  })

  const latest = new LatestPublisher(api, 1000, (msg) => {
    // 最新值推送失败不影响主链路，仅记录
    lastError.value = msg
  })

  engine.onResult((o) => {
    if (o.uploaded > 0) {
      uploadedTotal.value += o.uploaded
      lastSyncAt.value = Date.now()
    }
    pending.value = cache.pending
    dropped.value = cache.dropped
    if (o.error) lastError.value = o.error
  })

  const transport = new UniBleTransport({
    deviceName: config.deviceName,
    serviceUuid: config.serviceUuid,
    charUuid: config.charUuid,
    lastDeviceId: store.get(KEY_LAST_DEVICE) ?? undefined,
    onDeviceId: (id) => store.set(KEY_LAST_DEVICE, id),
    onStatus: (s, detail) => {
      status.value = s
      statusDetail.value = detail ?? ''
      connected.value = s === 'connected'
    },
    onPacket: (text) => {
      const parsed = parsePacket(text)
      if (!parsed) {
        // 坏包只计数，绝不抛异常打断采集
        badPackets.value++
        return
      }

      const sample = session.attribute(parsed, Date.now())
      cache.append(sample)

      packets.value++
      lostPackets.value += session.lastGap
      pending.value = cache.pending
      dropped.value = cache.dropped
      lastSample.value = sample

      // 图表历史：只保留最近 HISTORY_MAX 个窗口（5s/包 → 60 个 = 5 分钟）
      history.value.push(sample)
      if (history.value.length > HISTORY_MAX) {
        history.value.splice(0, history.value.length - HISTORY_MAX)
      }
      if (sample.stepsInWindow !== null) {
        windowSteps.value = sample.stepsInWindow
        totalSteps.value += sample.stepsInWindow
      }

      // 实时看板：写 device_latest，让 Web 端用 Realtime 收到
      latest.publish(sample)
    },
  })

  function onNetworkChange(res: { isConnected: boolean }): void {
    if (res.isConnected) {
      // 断网期间缓存的样本，网络一恢复就补推
      engine.onNetworkRestored()
    }
  }

  function start(): void {
    lastError.value = null
    engine.start()
    transport.start()
    uni.onNetworkStatusChange(onNetworkChange)
  }

  async function stop(): Promise<void> {
    engine.stop()
    latest.stop()
    await transport.stop()
    uni.offNetworkStatusChange?.(onNetworkChange)
    connected.value = false
  }

  /** 「立即同步」按钮 */
  async function syncNow(): Promise<void> {
    syncing.value = true
    try {
      const outcome = await engine.syncNow()
      if (outcome.error) {
        lastError.value = outcome.error
      } else {
        lastError.value = null
        if (outcome.uploaded > 0) lastSyncAt.value = Date.now()
      }
    } finally {
      syncing.value = false
      pending.value = cache.pending
    }
  }

  function dispose(): void {
    void stop()
  }

  if (getCurrentInstance()) {
    onUnmounted(dispose)
  }

  return {
    // 状态
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
    // 动作
    start,
    stop,
    syncNow,
  }
}
