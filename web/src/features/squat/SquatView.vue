<script setup lang="ts">
/**
 * 深蹲识别视图
 *
 * 两种模式，都走同一套"取帧 → 关键点 → 膝角 → 状态机"管线：
 *   · 实时摄像头：答辩时的主展示
 *   · 上传视频：防翻车兜底（不依赖现场光线与摄像头权限）
 *
 * 判定逻辑全在 squatCounter.ts（纯函数、有 16 条单测），
 * 这里只负责取帧、画骨架、显示与入库。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RepEvent, SquatPhase } from './types'
import type { SquatState } from './squatCounter'
import { createSquatState, feedSquatAngle, phaseLabel } from './squatCounter'
import { kneeAngleFromPose, legLooksComplete } from './poseMath'
import { drawFramingGuide, drawSkeleton, framingLabel } from './drawSkeleton'
import type { FramingState } from './drawSkeleton'
import { usePoseLandmarker } from './usePoseLandmarker'
import { createRepsWriter } from './repsSync'

const env = import.meta.env
const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined) ?? ''
const supabaseKey = (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''
const canSync = Boolean(supabaseUrl && supabaseKey)

const writer = canSync ? createRepsWriter(supabaseUrl, supabaseKey) : null

const { status: modelStatus, error: modelError, delegate, init, detect } = usePoseLandmarker()

type Mode = 'camera' | 'video'

const mode = ref<Mode>('camera')
const running = ref(false)
const phase = ref<SquatPhase>('standing')
const reps = ref(0)
const angle = ref<number | null>(null)
const lastRep = ref<RepEvent | null>(null)
const recent = ref<RepEvent[]>([])
const savedCount = ref(0)
const failedCount = ref(0)
const hint = ref('')
/** 取景不合格时的提示（腿没拍全就不计数，避免拿幻觉关键点算角度） */
const framingHint = ref('')
/** 引导框状态：idle 没人 / bad 需调整 / good 取景完美 */
const framingState = ref<FramingState>('idle')

const videoEl = ref<HTMLVideoElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const fileEl = ref<HTMLInputElement | null>(null)

let counter: SquatState = createSquatState()
let rafId = 0
let stream: MediaStream | null = null
let objectUrl: string | null = null
/** 腿第一次被判为不完整的时间点，用来避免一闪而过的误提示 */
let legBadSince = 0

/** 一次会话 id：同一次训练的所有 reps 共享，方便和手表数据按时间段对齐 */
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const phaseText = computed(() => phaseLabel(phase.value))
const angleText = computed(() => (angle.value === null ? '—' : angle.value.toFixed(0)))

const modelText = computed(() => {
  switch (modelStatus.value) {
    case 'loading':
      return '模型加载中…'
    case 'ready':
      return `模型就绪 · ${delegate.value ?? ''}`
    case 'error':
      return '模型加载失败'
    default:
      return '模型未加载'
  }
})

const phaseClass = computed(() => `phase-${phase.value}`)

const framingText = computed(() => framingLabel(framingState.value))
const framingClass = computed(() =>
  framingState.value === 'good'
    ? 'framing-good'
    : framingState.value === 'bad'
      ? 'framing-bad'
      : 'framing-idle',
)

function resetCounter(): void {
  counter = createSquatState()
  reps.value = 0
  phase.value = 'standing'
  angle.value = null
  recent.value = []
  lastRep.value = null
  framingHint.value = ''
  legBadSince = 0
}

async function onRepDone(rep: RepEvent): Promise<void> {
  lastRep.value = rep
  recent.value.unshift(rep)
  if (recent.value.length > 5) recent.value.pop()

  if (!writer) return
  const res = await writer.save({
    clientKey: `${sessionId}:${rep.repIndex}`,
    sessionId,
    repIndex: rep.repIndex,
    // 用墙钟时间入库；rep.finishedAt 是 performance.now()，只适合算时长
    finishedAt: Date.now(),
    minAngle: rep.minAngle,
    durationMs: rep.durationMs,
  })

  if (res.outcome === 'ok' || res.outcome === 'duplicate') savedCount.value++
  else {
    failedCount.value++
    hint.value = `写入失败：${res.message ?? '未知错误'}`
  }
}

function loop(): void {
  if (!running.value) return

  const v = videoEl.value
  const c = canvasEl.value

  if (v && c && v.readyState >= 2 && v.videoWidth > 0) {
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth
      c.height = v.videoHeight
    }

    const res = detect(v, performance.now())
    const ctx = c.getContext('2d')

    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height)
      const landmarks = res?.landmarks?.[0]

      // 先判定取景，再把引导框画出来（框的出处就是判定结果，人站对了会变绿）
      let legOk = false
      if (landmarks && landmarks.length) {
        legOk = legLooksComplete(landmarks).ok
      }
      const state: FramingState = !landmarks || !landmarks.length ? 'idle' : legOk ? 'good' : 'bad'
      drawFramingGuide(ctx, c.width, c.height, state)
      framingState.value = state

      if (landmarks && landmarks.length) {
        drawSkeleton(ctx, landmarks, c.width, c.height)

        // 腿没拍全就绝不计数（否则拿的是 MediaPipe 外推出来的假膝角）
        if (!legOk) {
          angle.value = null
          if (!legBadSince) legBadSince = performance.now()
          if (performance.now() - legBadSince > 700) {
            framingHint.value = legLooksComplete(landmarks).reason ?? '取景不合格'
          }
        } else {
          legBadSince = 0
          framingHint.value = ''
          const knee = kneeAngleFromPose(landmarks)
          angle.value = knee.angle
          if (knee.angle !== null) {
            const t = performance.now()
            const r = feedSquatAngle(counter, knee.angle, t)
            counter = r.state
            reps.value = r.state.reps
            phase.value = r.state.phase
            if (r.rep) void onRepDone(r.rep)
          }
        }
      } else {
        angle.value = null
        framingHint.value = '没有检测到人，请站到画面里'
      }
    }
  }

  rafId = requestAnimationFrame(loop)
}

async function start(): Promise<void> {
  hint.value = ''

  const ok = await init()
  if (!ok) {
    hint.value = `模型加载失败：${modelError.value ?? ''}`
    return
  }

  const v = videoEl.value
  if (!v) return

  if (mode.value === 'camera') {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
        audio: false,
      })
      v.srcObject = stream
      await v.play()
    } catch (e) {
      hint.value = `摄像头打开失败：${e instanceof Error ? e.message : String(e)}（请允许摄像头权限，或用「上传视频」模式）`
      return
    }
  } else {
    if (!v.src) {
      pickFile()
      return
    }
    await v.play()
  }

  resetCounter()
  running.value = true
  loop()
}

function stop(): void {
  running.value = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0

  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
  const v = videoEl.value
  if (v) {
    v.pause()
    if (mode.value === 'camera') v.srcObject = null
  }
}

function pickFile(): void {
  fileEl.value?.click()
}

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  stop()
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = URL.createObjectURL(file)

  const v = videoEl.value
  if (!v) return
  v.srcObject = null
  v.src = objectUrl
  hint.value = `已载入：${file.name}，点「开始分析」`
}

function switchMode(next: Mode): void {
  if (mode.value === next) return
  stop()
  mode.value = next
  hint.value = ''
  resetCounter()

  const v = videoEl.value
  if (v) {
    if (next === 'camera') {
      v.removeAttribute('src')
      v.load()
    }
  }
}

onMounted(() => {
  // 进页面就开始加载模型（5.5MB），避免用户点了才开始等
  void init()
})

onBeforeUnmount(() => {
  stop()
  if (objectUrl) URL.revokeObjectURL(objectUrl)
})
</script>

<template>
  <div class="squat">
    <header class="bar">
      <div class="status" :class="modelStatus">
        <span class="dot"></span>{{ modelText }}
      </div>
      <div class="session">会话 {{ sessionId.slice(0, 7) }}</div>
    </header>

    <div class="modes">
      <button :class="['tab', { active: mode === 'camera' }]" @click="switchMode('camera')">
        实时摄像头
      </button>
      <button :class="['tab', { active: mode === 'video' }]" @click="switchMode('video')">
        上传视频分析
      </button>
      <button v-if="mode === 'video'" class="ghost" @click="pickFile">选择文件</button>
      <span class="spacer"></span>
      <button class="ghost" :disabled="!running" @click="resetCounter">重置计数</button>
    </div>

    <div class="stage">
      <video
        ref="videoEl"
        class="feed"
        :class="{ mirror: mode === 'camera' }"
        playsinline
        muted
        @ended="stop"
      ></video>
      <canvas ref="canvasEl" class="overlay-canvas" :class="{ mirror: mode === 'camera' }"></canvas>

      <div class="hud">
        <div class="hud-top">
          <span class="chip" :class="phaseClass">{{ phaseText }}</span>
          <span class="chip angle">膝角 {{ angleText }}°</span>
          <span class="chip" :class="framingClass">{{ framingText }}</span>
        </div>
        <div class="hud-count">
          <span class="num">{{ reps }}</span><span class="unit">次</span>
        </div>
      </div>

      <div v-if="!running" class="idle">
        <p class="idle-title">{{ mode === 'camera' ? '实时深蹲识别' : '离线视频分析' }}</p>
        <p class="idle-desc">
          {{ mode === 'camera'
            ? '点下方「开始」，允许摄像头权限后对着侧面做深蹲'
            : '先「选择文件」载入一段深蹲视频，再点「开始分析」' }}
        </p>
      </div>

      <div v-if="running && framingHint" class="framing">{{ framingHint }}</div>
    </div>

    <div class="actions">
      <button class="primary" :disabled="running || modelStatus !== 'ready'" @click="start">
        {{ mode === 'camera' ? '开始识别' : '开始分析' }}
      </button>
      <button class="ghost" :disabled="!running" @click="stop">停止</button>
    </div>

    <p v-if="hint" class="hint error">{{ hint }}</p>
    <p v-else-if="modelStatus === 'error'" class="hint error">{{ modelError }}</p>
    <p v-else-if="!canSync" class="hint warn">
      未配置 Supabase 环境变量，计数正常但不会入库
    </p>

    <div class="stats">
      <div class="stat">
        <span class="k">本次完成</span><span class="v accent">{{ reps }} 次</span>
      </div>
      <div class="stat">
        <span class="k">已入库 / 失败</span>
        <span class="v">{{ savedCount }} / {{ failedCount }}</span>
      </div>
      <div class="stat">
        <span class="k">最近一次</span>
        <span class="v">
          {{ lastRep ? `深度 ${lastRep.minAngle.toFixed(0)}° · 用时 ${(lastRep.durationMs / 1000).toFixed(2)}s` : '—' }}
        </span>
      </div>
    </div>

    <ul v-if="recent.length" class="recent">
      <li v-for="r in recent" :key="r.repIndex">
        <span class="idx">#{{ r.repIndex }}</span>
        <span>最低 {{ r.minAngle.toFixed(0) }}°</span>
        <span>{{ (r.durationMs / 1000).toFixed(2) }}s</span>
      </li>
    </ul>

    <p class="foot">
      判定规则：膝关节角 ≥160° 站立、≤100° 蹲底，完成一次动作需 ≥0.6s。
      侧面拍摄最准；画面里要能看到髋、膝、踝三个关节。
    </p>

    <input ref="fileEl" type="file" accept="video/*" class="file" @change="onFileChange" />
  </div>
</template>

<style scoped>
.squat {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #8b93a7;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #23262f;
}

.status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b7387;
}

.status.ready {
  color: #3ddc84;
  border-color: rgba(61, 220, 132, 0.35);
  background: rgba(61, 220, 132, 0.08);
}
.status.ready .dot {
  background: #3ddc84;
}

.status.loading .dot {
  background: #ffb020;
  animation: blink 1s infinite;
}

.status.error {
  color: #ff5c5c;
  border-color: rgba(255, 92, 92, 0.35);
}
.status.error .dot {
  background: #ff5c5c;
}

@keyframes blink {
  50% {
    opacity: 0.25;
  }
}

.session {
  font-family: monospace;
  color: #5f6779;
}

.modes {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.tab,
.ghost {
  background: transparent;
  border: 1px solid #2b2f3a;
  color: #c7cede;
  border-radius: 9px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}

.tab.active {
  background: rgba(61, 126, 255, 0.14);
  border-color: #3d7eff;
  color: #fff;
}

.ghost:disabled,
.tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #0b0d12;
  border: 1px solid #1f232c;
  border-radius: 14px;
  overflow: hidden;
}

.feed {
  width: 100%;
  height: 100%;
  /* 用 contain 而不是 cover：
     cover 在摄像头不是 16:9 时会裁掉画面，但 MediaPipe 读的是完整原始帧、
     canvas 也按原始比例绘制 —— 显示被裁 + 骨架没裁 = 对不上。
     contain 让两者都按同一比例 letterbox，永远不会错位。 */
  object-fit: contain;
  display: block;
}

.feed.mirror,
.overlay-canvas.mirror {
  transform: scaleX(-1);
}

.overlay-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* canvas 是替换元素，object-fit 同样生效，保证与 video 的 letterbox 完全一致 */
  object-fit: contain;
  pointer-events: none;
}

.hud {
  position: absolute;
  inset: 0;
  padding: 14px 16px;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.hud-top {
  display: flex;
  gap: 8px;
}

.chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(11, 13, 18, 0.7);
  border: 1px solid #23262f;
  color: #c7cede;
}

.phase-standing {
  color: #3ddc84;
  border-color: rgba(61, 220, 132, 0.4);
}
.phase-descending,
.phase-ascending {
  color: #ffb020;
  border-color: rgba(255, 176, 32, 0.4);
}
.phase-bottom {
  color: #3d7eff;
  border-color: rgba(61, 126, 255, 0.5);
}

.framing-good {
  color: #3ddc84;
  border-color: rgba(61, 220, 132, 0.55);
  background: rgba(61, 220, 132, 0.12);
  font-weight: 600;
}

.framing-bad {
  color: #ffb020;
  border-color: rgba(255, 176, 32, 0.55);
  background: rgba(255, 176, 32, 0.12);
}

.framing-idle {
  color: #c7cede;
}

.hud-count {
  align-self: flex-end;
  display: flex;
  align-items: baseline;
  gap: 6px;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.8);
}

.hud-count .num {
  font-family: monospace;
  font-size: 64px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
}

.hud-count .unit {
  font-size: 16px;
  color: #9aa3b8;
}

.idle {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  background: rgba(11, 13, 18, 0.72);
  color: #8b93a7;
}

.framing {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  max-width: 80%;
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(255, 92, 92, 0.18);
  border: 1px solid rgba(255, 92, 92, 0.55);
  color: #ffc2c2;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
  backdrop-filter: blur(4px);
}

.idle-title {
  font-size: 18px;
  color: #e8ecf3;
  margin: 0;
}

.idle-desc {
  font-size: 13px;
  margin: 0;
  line-height: 1.7;
}

.actions {
  display: flex;
  gap: 10px;
}

.primary {
  flex: 1;
  background: #3d7eff;
  border: none;
  color: #fff;
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 15px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.hint {
  font-size: 12px;
  margin: 0;
  line-height: 1.7;
}

.hint.error {
  color: #ff7b7b;
}
.hint.warn {
  color: #ffb020;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.stat {
  background: #171a21;
  border: 1px solid #1f232c;
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stat .k {
  font-size: 11px;
  color: #8b93a7;
}

.stat .v {
  font-size: 15px;
  color: #e8ecf3;
  font-family: monospace;
}

.stat .v.accent {
  color: #3ddc84;
}

.recent {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.recent li {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: #8b93a7;
  font-family: monospace;
  background: #12151c;
  border-radius: 8px;
  padding: 7px 12px;
}

.recent .idx {
  color: #3d7eff;
}

.foot {
  font-size: 12px;
  color: #5f6779;
  line-height: 1.8;
  margin: 0;
}

.file {
  display: none;
}
</style>
