/**
 * uni-app BLE 传输层
 *
 * 负责：扫描 → 连接 → 发现服务/特征 → 订阅 notify → 断线自动重连。
 *
 * 三个平台差异必须自己抹平：
 *   1. UUID 大小写：Android 常返回小写全 128 位，iOS 可能大写；
 *      有些平台对 4 位短 UUID 返回 "180F" 而不是完整形式。
 *   2. deviceId：Android 是 MAC 地址，iOS 是系统生成的 UUID。
 *      **不能把它当设备主键存库**，只当本次连接的句柄；主键用配置里的 deviceId。
 *   3. 后台运行：iOS 进入后台后 BLE 会被挂起，Android 也可能被省电策略杀掉。
 *      所以"每 15 分钟同步"这类定时任务在后台并不可靠，见 README 的说明。
 */

import type { GatewayStatus } from './types'
import { bytesToAscii } from './protocol'

export interface BleTransportOptions {
  deviceName: string
  serviceUuid: string
  charUuid: string
  /** 下行指令特征 UUID（M2 新增；找不到就降级为只读上报） */
  writeCharUuid?: string
  onPacket: (text: string) => void
  onStatus: (status: GatewayStatus, detail?: string) => void
  /** 上次成功连接的 deviceId，用于免扫描直连 */
  lastDeviceId?: string
  onDeviceId?: (deviceId: string) => void
  /** 扫描超时，默认 15s */
  scanTimeoutMs?: number
}

const RECONNECT_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/** 统一成小写全 128 位形式，便于跨平台比较 */
export function normalizeUuid(uuid: string): string {
  const u = uuid.trim().toLowerCase()
  if (u.length === 4) return `0000${u}-0000-1000-8000-00805f9b34fb`
  return u
}

// ------------------------------------------------------------------ Promise 包装

/**
 * Android 12+（API 31）把 BLUETOOTH_SCAN / BLUETOOTH_CONNECT 变成了**运行时权限**：
 * 只在 AndroidManifest 里声明是不够的，必须主动弹窗申请一次。
 * uni 的 openBluetoothAdapter 不会替你申请，所以扫描前先要一遍。
 *
 * 返回**被拒绝**的权限列表（空数组 = 全给了，或当前不是 App 平台）。
 * 非 App 平台（H5 / 小程序）没有 plus 对象，直接返回空数组。
 */
export function ensureBlePermissions(): Promise<string[]> {
  const plusAny = (globalThis as { plus?: any }).plus
  if (!plusAny?.android?.requestPermissions) return Promise.resolve([])

  const wanted = [
    'android.permission.BLUETOOTH_SCAN',
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]

  return new Promise((resolve) => {
    try {
      plusAny.android.requestPermissions(
        wanted,
        (e: { deniedAlways?: string[]; deniedPresent?: string[] }) =>
          resolve([...(e?.deniedAlways ?? []), ...(e?.deniedPresent ?? [])]),
        () => resolve(['调用 requestPermissions 失败']),
      )
    } catch {
      resolve(['调用 requestPermissions 抛异常'])
    }
  })
}

function pOpenAdapter(): Promise<void> {
  return new Promise((resolve, reject) => {
    uni.openBluetoothAdapter({
      success: () => resolve(),
      fail: (e: { errMsg?: string }) => reject(new Error(e?.errMsg || 'openBluetoothAdapter 失败')),
    })
  })
}

function pStartDiscovery(): Promise<void> {
  return new Promise((resolve, reject) => {
    uni.startBluetoothDevicesDiscovery({
      allowDuplicatesKey: false,
      success: () => resolve(),
      fail: (e: { errMsg?: string }) => reject(new Error(e?.errMsg || 'startBluetoothDevicesDiscovery 失败')),
    })
  })
}

function pStopDiscovery(): Promise<void> {
  return new Promise((resolve) => {
    uni.stopBluetoothDevicesDiscovery({
      success: () => resolve(),
      fail: () => resolve(), // 没在扫描时失败属正常
    })
  })
}

function pConnect(deviceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    uni.createBLEConnection({
      deviceId,
      timeout: 12000,
      success: () => resolve(),
      fail: (e: { errMsg?: string }) => reject(new Error(e?.errMsg || 'createBLEConnection 失败')),
    })
  })
}

function pClose(deviceId: string): Promise<void> {
  return new Promise((resolve) => {
    uni.closeBLEConnection({
      deviceId,
      success: () => resolve(),
      fail: () => resolve(),
    })
  })
}

function pGetServices(deviceId: string): Promise<Array<{ uuid: string }>> {
  return new Promise((resolve, reject) => {
    uni.getBLEDeviceServices({
      deviceId,
      success: (res: { services: Array<{ uuid: string }> }) => resolve(res.services || []),
      fail: (e: { errMsg?: string }) => reject(new Error(e?.errMsg || 'getBLEDeviceServices 失败')),
    })
  })
}

function pGetCharacteristics(
  deviceId: string,
  serviceId: string,
): Promise<Array<{ uuid: string; properties: { notify?: boolean; indicate?: boolean } }>> {
  return new Promise((resolve, reject) => {
    uni.getBLEDeviceCharacteristics({
      deviceId,
      serviceId,
      success: (res: { characteristics: Array<{ uuid: string; properties: { notify?: boolean; indicate?: boolean } }> }) =>
        resolve(res.characteristics || []),
      fail: (e: { errMsg?: string }) => reject(new Error(e?.errMsg || 'getBLEDeviceCharacteristics 失败')),
    })
  })
}

function asciiToBuffer(s: string): ArrayBuffer {
  const buf = new ArrayBuffer(s.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff
  return buf
}

function pWrite(
  deviceId: string,
  serviceId: string,
  characteristicId: string,
  data: ArrayBuffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    uni.writeBLECharacteristicValue({
      deviceId,
      serviceId,
      characteristicId,
      value: data,
      success: () => resolve(),
      fail: (e: { errMsg?: string }) =>
        reject(new Error(e?.errMsg || 'writeBLECharacteristicValue 失败')),
    })
  })
}

function pNotify(deviceId: string, serviceId: string, characteristicId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    uni.notifyBLECharacteristicValueChange({
      deviceId,
      serviceId,
      characteristicId,
      state: true,
      success: () => resolve(),
      fail: (e: { errMsg?: string }) => reject(new Error(e?.errMsg || 'notifyBLECharacteristicValueChange 失败')),
    })
  })
}

/** Android 上建议显式要 MTU；iOS 会自动协商，失败不算错 */
function pSetMtu(deviceId: string, mtu: number): Promise<void> {
  return new Promise((resolve) => {
    const api = (uni as unknown as { setBLEMTU?: (o: object) => void }).setBLEMTU
    if (typeof api !== 'function') {
      resolve()
      return
    }
    uni.setBLEMTU({
      deviceId,
      mtu,
      success: () => resolve(),
      fail: () => resolve(),
    })
  })
}

// ------------------------------------------------------------------ 传输层

export class UniBleTransport {
  private deviceId: string | null = null
  private charId: string | null = null
  private writeCharId: string | null = null
  private serviceId: string | null = null
  private stopped = true
  private connecting = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private listenersBound = false
  /** 当前扫描的挂起处理器；onBluetoothDeviceFound 只注册一次，靠它分发结果 */
  private scanResolve: ((deviceId: string) => void) | null = null
  private scanReject: ((e: Error) => void) | null = null

  constructor(private opts: BleTransportOptions) {}

  get isConnected(): boolean {
    return this.deviceId !== null && this.charId !== null
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.bindListeners()
    void this.connectLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearReconnect()
    if (this.deviceId) {
      await pStopDiscovery()
      await pClose(this.deviceId)
    }
    this.deviceId = null
    this.charId = null
    this.opts.onStatus('idle')
  }

  // ---------------------------------------------------------------- 内部

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce()
        // 连上后由 disconnect 事件驱动重连，这里退出循环
        return
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.opts.onStatus('error', msg)
        if (this.stopped) return

        // 重试到成功为止；用户点"停止"会置 stopped 打断
        const delay = RECONNECT_MS[Math.min(this.reconnectAttempt, RECONNECT_MS.length - 1)]
        this.reconnectAttempt++
        await this.sleep(delay)
      }
    }
  }

  private async connectOnce(): Promise<void> {
    this.connecting = true
    try {
      this.opts.onStatus('scanning', '检查蓝牙权限')
      const denied = await ensureBlePermissions()
      if (denied.length > 0) {
        throw new Error(
          `蓝牙权限被拒绝（${denied.join(', ')}）。请到 系统设置 → 应用 → SmartFit → 权限 里把"附近的设备"设为允许，然后重试`,
        )
      }

      this.opts.onStatus('scanning', '打开蓝牙适配器')

      await pOpenAdapter()

      const deviceId = await this.resolveAndConnect()
      this.deviceId = deviceId
      this.opts.onDeviceId?.(deviceId)
      await pSetMtu(deviceId, 185)

      const services = await pGetServices(deviceId)
      const wanted = normalizeUuid(this.opts.serviceUuid)
      const service = services.find((s) => normalizeUuid(s.uuid) === wanted)
      if (!service) {
        throw new Error(`找不到服务 ${this.opts.serviceUuid}（设备可能还没跑对固件）`)
      }
      const chars = await pGetCharacteristics(deviceId, service.uuid)
      const wantedChar = normalizeUuid(this.opts.charUuid)
      const target = chars.find((c) => normalizeUuid(c.uuid) === wantedChar)
      if (!target) {
        throw new Error(`找不到特征 ${this.opts.charUuid}`)
      }
      if (!target.properties.notify && !target.properties.indicate) {
        throw new Error('该特征不支持 notify，检查固件是否设置了 PROPERTY_NOTIFY')
      }
      this.charId = target.uuid

      await pNotify(deviceId, service.uuid, target.uuid)
      this.serviceId = service.uuid

      // M2：下行指令特征（可选能力 —— 老固件没有它，不能因此阻断上报）
      const wantedWrite = normalizeUuid(
        this.opts.writeCharUuid ?? '0000FFF2-0000-1000-8000-00805F9B34FB',
      )
      const w = chars.find((c) => normalizeUuid(c.uuid) === wantedWrite)
      this.writeCharId = w ? w.uuid : null
      if (!w) console.warn('[ble] 未找到写特征 FFF2：指令通道不可用（对时会降级）')

      this.reconnectAttempt = 0
      this.opts.onStatus('connected', this.opts.deviceName)
    } finally {
      this.connecting = false
    }
  }

  /** 是否具备下行指令通道（M2 起的新固件才有） */
  get supportsWrite(): boolean {
    return this.writeCharId !== null && this.serviceId !== null && this.deviceId !== null
  }

  /**
   * 发送一条文本指令。
   * 刻意不抛异常：指令通道是**可选能力**，它失败不能中断主链路采集。
   */
  async writeCommand(cmd: string): Promise<boolean> {
    if (!this.deviceId || !this.writeCharId || !this.serviceId) return false
    try {
      await pWrite(this.deviceId, this.serviceId, this.writeCharId, asciiToBuffer(cmd))
      return true
    } catch (e) {
      console.warn('[ble] 写指令失败：' + (e instanceof Error ? e.message : String(e)))
      return false
    }
  }

  /**
   * 拿到一个已连接的 deviceId。
   * 先试上次的 deviceId（iOS 重扫很慢，且后台扫描常被限制），失败再扫描。
   */
  private async resolveAndConnect(): Promise<string> {
    if (this.opts.lastDeviceId) {
      try {
        this.opts.onStatus('connecting', `直连 ${this.opts.lastDeviceId}`)
        await pConnect(this.opts.lastDeviceId)
        return this.opts.lastDeviceId
      } catch {
        // 直连失败 → 落到扫描分支
      }
    }

    const deviceId = await this.scanForDevice()
    this.opts.onStatus('connecting', `连接 ${deviceId}`)
    await pConnect(deviceId)
    return deviceId
  }

  private scanForDevice(): Promise<string> {
    const timeout = this.opts.scanTimeoutMs ?? 15000

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clearScan()
        reject(new Error(`扫描 ${timeout}ms 未发现 "${this.opts.deviceName}"`))
      }, timeout)

      // 回调只注册一次（bindListeners），这里只挂结果处理器，
      // 避免每次重连都新增一个 onBluetoothDeviceFound 监听器
      this.scanResolve = (deviceId: string) => {
        clearTimeout(timer)
        resolve(deviceId)
      }
      this.scanReject = (e: Error) => {
        clearTimeout(timer)
        reject(e)
      }

      pStartDiscovery().catch((e: unknown) => {
        const rej = this.scanReject
        this.clearScan()
        rej?.(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }

  private clearScan(): void {
    this.scanResolve = null
    this.scanReject = null
    void pStopDiscovery()
  }

  private bindListeners(): void {
    if (this.listenersBound) return
    this.listenersBound = true

    uni.onBluetoothDeviceFound((res: {
      devices: Array<{ deviceId: string; name?: string; localName?: string }>
    }) => {
      const resolve = this.scanResolve
      if (!resolve) return
      for (const d of res.devices || []) {
        const name = d.name || d.localName || ''
        if (name === this.opts.deviceName) {
          this.clearScan()
          resolve(d.deviceId)
          return
        }
      }
    })

    uni.onBLECharacteristicValueChange((res: {
      deviceId: string
      characteristicId: string
      value: ArrayBuffer
    }) => {
      if (res.deviceId !== this.deviceId) return
      if (this.charId && normalizeUuid(res.characteristicId) !== normalizeUuid(this.charId)) return
      this.opts.onPacket(bytesToAscii(res.value))
    })

    uni.onBLEConnectionStateChange((res: { deviceId: string; connected: boolean }) => {
      if (res.deviceId !== this.deviceId) return
      if (res.connected) return
      // 非主动停止才重连
      if (this.stopped) return
      this.opts.onStatus('disconnected', '连接断开，准备重连')
      this.charId = null
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = RECONNECT_MS[Math.min(this.reconnectAttempt, RECONNECT_MS.length - 1)]
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && !this.connecting) void this.connectLoop()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
