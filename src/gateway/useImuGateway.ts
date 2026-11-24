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
import { decodeFrame, encodeAck } from './frame'
import { uniStore } from './storage'
import type { GatewayConfig, GatewayStatus, ImuSample } from './types'

const KEY_LAST_DEVICE = 'imu.lastDeviceId'
/** 图表保留的窗口数：5s/包 → 60 个 = 5 分钟 */
const HISTORY_MAX = 60

export function useImuGateway(config: GatewayConfig) {
  const status = ref<GatewayStatus>('idle')
  const statusDetail = ref('')
  const connected = ref(false)
  /** M2：最近一次对时成功的时间（ms）与结果 */
  const lastTimeSync = ref<number | null>(null)
  const timeSyncOk = ref(false)
  /** 手表报了 HELLO 才认为走 v2；否则一直用文本解析（自动降级） */
  const protoVersion = ref(0)
  /** 已发出的 ACK 数（用于确认 ACK 通道真的在工作） */
  const acksSent = ref(0)

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
    sampleRpc: config.sampleRpc,
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
      if (s === 'connected') {
        void syncDeviceTime()
        // 声明支持 v2；老固件会忽略它并继续发文本，App 侧靠 magic 自动降级
        void transport.writeCommand('V2')
      }
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
    onFrame: (bytes) => {
      const f = decodeFrame(bytes)
      if (!f) {
        // CRC 失败/长度不对：只计数，绝不抛异常打断采集
        badPackets.value++
        return
      }
      if (f.type === 'hello') {
        protoVersion.value = f.protoVer
        console.log(`[gateway] 手表协议 v${f.protoVer}，固件 ${f.fwMajor}.${f.fwMinor}`)
        return
      }
      if (f.type !== 'data') return

      // 二进制帧 → 复用文本协议的样本管线（幂等键、缓存、落库完全一致）
      const sample = session.attribute(
        {
          x: f.x,
          y: f.y,
          z: f.z,
          seq: f.seq,
          steps: f.steps,
          deviceTs: f.deviceTs > 0 ? f.deviceTs : null,
        },
        Date.now(),
      )
      cache.append(sample)
      packets.value++
      lostPackets.value += session.lastGap
      pending.value = cache.pending
      dropped.value = cache.dropped
      lastSample.value = sample
      history.value.push(sample)
      if (history.value.length > HISTORY_MAX) {
        history.value.splice(0, history.value.length - HISTORY_MAX)
      }
      if (sample.stepsInWindow !== null) {
        windowSteps.value = sample.stepsInWindow
        totalSteps.value += sample.stepsInWindow
      }
      latest.publish(sample)

      // 回 ACK：不让它在通知回调里直接写 —— Android 在 BLE 回调内发起 GATT 写
      // 经常被拒（write busy）或静默失败，表现就是"手表一直重传、App 却看不出问题"。
      queueAck(f.seq)
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

  // ---- ACK 发送队列（放在 BLE 回调之外写，见 onFrame 里的说明）
  let ackQueue: number[] = []
  let ackTimer: ReturnType<typeof setTimeout> | null = null

  function queueAck(seq: number): void {
    ackQueue.push(seq)
    if (ackQueue.length > 16) ackQueue.shift() // 积压时丢最旧的，避免越拖越长
    if (ackTimer === null) ackTimer = setTimeout(() => void flushAcks(), 40)
  }

  async function flushAcks(): Promise<void> {
    ackTimer = null
    const batch = ackQueue
    ackQueue = []
    for (const seq of batch) {
      let ok = await transport.writeBytes(encodeAck(seq))
      if (!ok) ok = await transport.writeBytes(encodeAck(seq)) // 失败重试一次
      if (ok) acksSent.value++
      else console.warn('[gateway] ACK 写失败 seq=' + seq)
    }
  }

  /**
   * M2：连接成功后自动对时。
   * 板载无 RTC 备份电源 —— 手表每次上电时间都可能是错的，所以"连上就对时"是必需步骤，
   * 而不是可选优化。指令通道（FFF2）不存在时只降级，不影响采集。
   */
  async function syncDeviceTime(): Promise<void> {
    const epoch = Math.floor(Date.now() / 1000)
    const ok = await transport.writeCommand('T' + epoch)
    timeSyncOk.value = ok
    if (ok) {
      lastTimeSync.value = Date.now()
      console.log('[gateway] 对时成功 T' + epoch)
    } else {
      console.warn('[gateway] 对时失败：固件可能没有 FFF2 写特征（非致命）')
    }
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
    // M2：对时状态
    lastTimeSync,
    timeSyncOk,
    protoVersion,
    acksSent,
    // 动作
    start,
    stop,
    syncNow,
    syncDeviceTime,
  }
}
