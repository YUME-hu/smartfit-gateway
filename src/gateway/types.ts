/**
 * 网关数据模型
 *
 * 分层同步策略里，一条样本要跨越三个边界：
 *   手表(BLE) → 手机(本地队列) → Supabase(批量 insert) → Vue(Realtime)
 * 所以它必须自带幂等键，否则"重试 = 写重复行"。
 */

/** 一条加速度样本（已归属到某次手表上电会话） */
export interface ImuSample {
  /**
   * 幂等键。用于 Supabase 唯一约束 + upsert 去重。
   * 形如 `watch-01:3:128`（设备:上电会话序号:包序号）
   * 或 `watch-01:3:@1735689600000`（手表没给 seq 时退化为接收时间）
   */
  key: string
  /** 设备标识，网关侧固定配置，不用系统分配的设备地址（iOS/Android 不一致） */
  deviceId: string
  /**
   * 手表上电会话序号。手表没有 RTC 广播，无法直接给出；
   * 网关通过"seq 回退"判定手表重启并自增该值。
   */
  bootEpoch: number
  /** 手表侧包序号；老固件不带 seq 时为 null */
  seq: number | null
  /** 该 5 秒窗口内的步数；老固件不带 steps 时为 null */
  stepsInWindow: number | null
  /** 手机接收时间（epoch ms）。手表无 RTC，用手机时钟作记录时间轴 */
  ts: number
  /** 三轴加速度，单位 g */
  x: number
  y: number
  z: number
}

/** BLE 连接状态 */
export type GatewayStatus =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

/** 网关运行参数 */
export interface GatewayConfig {
  /** 手表广播名，必须与固件 BLE_DEVICE_NAME 一致 */
  deviceName: string
  /** 服务 UUID（固件 SERVICE_UUID） */
  serviceUuid: string
  /** 特征 UUID（固件 CHAR_UUID） */
  charUuid: string

  /** 写入数据库的设备标识，见 ImuSample.deviceId 的说明 */
  deviceId: string

  supabaseUrl: string
  supabaseAnonKey: string
  /** 样本表名 */
  sampleTable: string
  /** 批量写入用的 Postgres 函数（SECURITY DEFINER，逐行 ON CONFLICT DO NOTHING） */
  sampleRpc: string
  /** 最新值表名（供 Web 端 Realtime 订阅） */
  latestTable: string

  /** 批量同步周期，默认 15 分钟 */
  syncIntervalMs: number
  /** 单次 HTTP 请求最多携带多少行，默认 500 */
  batchSize: number
  /** 单次同步最多跑几个批次（防止一次卡死太久），默认 40 */
  maxBatchesPerRun: number
}

export const DEFAULT_CONFIG: Omit<GatewayConfig, 'supabaseUrl' | 'supabaseAnonKey'> = {
  deviceName: 'ESP32_Fitness_Watch',
  serviceUuid: '0000FFF0-0000-1000-8000-00805F9B34FB',
  charUuid: '0000FFF1-0000-1000-8000-00805F9B34FB',
  deviceId: 'watch-01',
  sampleTable: 'imu_samples',
  sampleRpc: 'ingest_samples',
  latestTable: 'device_latest',
  syncIntervalMs: 15 * 60 * 1000,
  batchSize: 500,
  maxBatchesPerRun: 40,
}
