/**
 * MediaPipe PoseLandmarker 封装
 *
 * 关键点（都是实测踩出来的）：
 *  1. **全部资源同源**：wasm 在 /wasm，模型在 /models，不碰任何 CDN。
 *     官方示例默认从 storage.googleapis.com 拉，国内大概率不通。
 *  2. **GPU 优先、CPU 兜底**：部分核显/老驱动创建 GPU delegate 会抛异常，
 *     直接失败会让整页不可用，所以失败就换 CPU 重试一次。
 *  3. **时间戳必须单调递增**：VIDEO 模式下传入相同或更小的 timestamp 会报错，
 *     视频暂停/拖进度条都可能触发，这里统一做 lastTs+1 钳制。
 *  4. **实例要 close()**：不释放会一直占着 WASM 内存，切页几次就卡。
 */

import { onBeforeUnmount, ref } from 'vue'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { PoseLandmarkerResult } from '@mediapipe/tasks-vision'

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Vite 的 BASE_URL 默认 '/'，即 /wasm 与 /models */
const BASE = import.meta.env.BASE_URL || '/'
const WASM_DIR = `${BASE}wasm`
const MODEL_URL = `${BASE}models/pose_landmarker_lite.task`

export function usePoseLandmarker() {
  const status = ref<ModelStatus>('idle')
  const error = ref<string | null>(null)
  const delegate = ref<'GPU' | 'CPU' | null>(null)

  let landmarker: PoseLandmarker | null = null
  let lastTs = -1

  async function create(fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, d: 'GPU' | 'CPU') {
    return PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: d,
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
  }

  async function init(): Promise<boolean> {
    if (landmarker) return true
    status.value = 'loading'
    error.value = null

    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_DIR)

      try {
        landmarker = await create(fileset, 'GPU')
        delegate.value = 'GPU'
      } catch {
        // GPU 不可用不是错误，退回 CPU 继续
        landmarker = await create(fileset, 'CPU')
        delegate.value = 'CPU'
      }

      status.value = 'ready'
      return true
    } catch (e) {
      status.value = 'error'
      error.value = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /**
   * 对一帧视频做推理。失败返回 null，不抛异常 ——
   * 单帧失败不该中断整段采集。
   */
  function detect(video: HTMLVideoElement, tsMs: number): PoseLandmarkerResult | null {
    if (!landmarker) return null
    // 单调钳制：视频暂停/回放时 performance.now 可能回退，这里保证严格递增
    const ts = tsMs > lastTs ? tsMs : lastTs + 1
    lastTs = ts
    try {
      return landmarker.detectForVideo(video, ts)
    } catch {
      return null
    }
  }

  function close(): void {
    landmarker?.close()
    landmarker = null
    lastTs = -1
    status.value = 'idle'
    delegate.value = null
  }

  onBeforeUnmount(close)

  return { status, error, delegate, init, detect, close }
}
