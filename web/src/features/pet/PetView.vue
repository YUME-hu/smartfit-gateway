<script setup lang="ts">
/**
 * 我的宠物（数字生命养成）
 *
 * 数据来源：
 *   · 步数：父组件传进来的 `steps`（= 已订阅的 device_latest 窗口步数累加）
 *   · 深蹲：目前用调试按钮模拟（reps 表对 anon 不可读，正式版要接 RPC，见下方 TODO）
 *
 * 经验设计成**累计量的纯函数**（expFromSteps(总步数)），所以：
 *   · 刷新页面重放数据不会多给经验
 *   · 手机上批同步过来的数据，也是"到账即按总量结算"
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PetAvatar from './PetAvatar.vue'
import { celebrationImage, imageForMood, PET_CREDIT } from './petAssets'
import {
  decayHunger,
  expFromReps,
  expFromSteps,
  foodFromReps,
  foodFromSteps,
  moodOf,
  progressOf,
  stageFromLevel,
} from './petRules'
import type { PetMood } from './petRules'

const props = defineProps<{
  /** 本次会话累计步数（来自 device_latest） */
  steps: number
  /** 最近一次收到数据的时刻，用于判断"正在运动" */
  lastAt: number
}>()

// ---------------------------------------------------------------- 状态

/** 调试/奖励经验，正式版应由服务端 pet_state 提供 */
const bonusExp = ref(0)
/** 深蹲次数（正式版从 reps 表聚合，目前调试模拟） */
const squats = ref(0)
const hunger = ref(80)
const foodUsed = ref(0)
const celebrating = ref(false)
const now = ref(Date.now())
const events = ref<Array<{ t: number; text: string }>>([])
const avatarRef = ref<InstanceType<typeof PetAvatar> | null>(null)

let tick: number | undefined
let celebrateTimer: number | undefined

// ---------------------------------------------------------------- 派生

const stepsExp = computed(() => expFromSteps(props.steps))
const repsExp = computed(() => expFromReps(squats.value))
const totalExp = computed(() => stepsExp.value + repsExp.value + bonusExp.value)
const progress = computed(() => progressOf(totalExp.value))
const stage = computed(() => stageFromLevel(progress.value.level))

const foodEarned = computed(() => foodFromSteps(props.steps) + foodFromReps(squats.value))
const food = computed(() => Math.max(0, foodEarned.value - foodUsed.value))

/** 10 秒内有过数据 = 正在运动 */
const active = computed(() => props.lastAt > 0 && now.value - props.lastAt < 10000)
const mood = computed<PetMood>(() => moodOf(hunger.value, active.value))
const petSrc = computed(() => (celebrating.value ? celebrationImage() : imageForMood(mood.value)))

const MOOD_TEXT: Record<PetMood, string> = {
  idle: '发呆中',
  happy: '开心！',
  hungry: '饿扁了…',
  exercise: '跟着你一起动！',
  sleep: '有点困',
  dizzy: '晕乎乎的',
}
const moodText = computed(() => MOOD_TEXT[mood.value])

const stageText = computed(() => (stage.value === 1 ? '幼体' : stage.value === 2 ? '少年' : '成熟体'))
const hungerTone = computed(() => (hunger.value < 25 ? 'bad' : hunger.value < 50 ? 'warn' : 'ok'))

function log(text: string): void {
  events.value.unshift({ t: Date.now(), text })
  if (events.value.length > 6) events.value.pop()
}

function celebrate(): void {
  celebrating.value = true
  if (celebrateTimer) clearTimeout(celebrateTimer)
  celebrateTimer = window.setTimeout(() => (celebrating.value = false), 1800)
}

// ---------------------------------------------------------------- 交互

function feed(): void {
  if (food.value < 1) {
    log('食物不够，多走走或做几个深蹲吧')
    return
  }
  foodUsed.value++
  hunger.value = Math.min(100, hunger.value + 20)
  celebrate()
  log('喂食成功，饱食度 +20')
}

/** 调试：模拟深蹲（正式版替换为 reps 聚合） */
function simulateSquats(n: number): void {
  squats.value += n
  log(`模拟 ${n} 个深蹲`)
}

/** 调试：直接加经验，用来验证进化动画 */
function addExp(n: number): void {
  bonusExp.value += n
  log(`调试：经验 +${n}`)
}

function forceEvolution(): void {
  avatarRef.value?.playEvolution()
  log('调试：手动播放进化动画')
}

// ---------------------------------------------------------------- 生命周期

watch(
  () => progress.value.level,
  (next, prev) => {
    if (next > prev) {
      log(`升级到 Lv${next}${stage.value !== stageFromLevel(prev) ? '，形态进化！' : ''}`)
      celebrate()
    }
  },
)

onMounted(() => {
  tick = window.setInterval(() => {
    now.value = Date.now()
    hunger.value = decayHunger(hunger.value, 2000)
  }, 2000)
})

onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
  if (celebrateTimer) clearTimeout(celebrateTimer)
})
</script>

<template>
  <div class="pet-view">
    <section class="card hero">
      <div class="hero-head">
        <div class="hero-title">
          <h2>深海鲸鱼娘</h2>
          <span class="badge">Lv{{ progress.level }} · {{ stageText }}</span>
        </div>
        <span class="mood" :class="mood">{{ moodText }}</span>
      </div>

      <PetAvatar ref="avatarRef" :src="petSrc" :stage="stage" alt="宠物" />

      <div class="exp-block">
        <div class="exp-top">
          <span>经验 {{ totalExp }}</span>
          <span v-if="progress.nextAt !== null">
            {{ progress.expIntoLevel }} / {{ progress.expForLevel }} → Lv{{ progress.level + 1 }}
          </span>
          <span v-else>已满级</span>
        </div>
        <div class="bar">
          <div class="fill exp" :style="{ width: (progress.ratio * 100).toFixed(1) + '%' }"></div>
        </div>
      </div>

      <div class="hunger">
        <div class="exp-top">
          <span>饱食度 {{ hunger.toFixed(0) }}</span>
          <span class="food">食物 {{ food }}</span>
        </div>
        <div class="bar">
          <div class="fill" :class="hungerTone" :style="{ width: hunger + '%' }"></div>
        </div>
        <button class="feed" :disabled="food < 1" @click="feed">喂食（消耗 1 食物）</button>
      </div>
    </section>

    <section class="stats">
      <div class="stat">
        <span class="k">本次步数</span>
        <span class="v">{{ steps }}</span>
        <span class="s">≈ {{ stepsExp }} 经验</span>
      </div>
      <div class="stat">
        <span class="k">深蹲</span>
        <span class="v">{{ squats }}</span>
        <span class="s">≈ {{ repsExp }} 经验</span>
      </div>
      <div class="stat">
        <span class="k">形态</span>
        <span class="v">{{ stageText }}</span>
        <span class="s">Lv4 起进入成熟体</span>
      </div>
    </section>

    <section class="card">
      <h3>成长记录</h3>
      <ul v-if="events.length" class="events">
        <li v-for="(e, i) in events" :key="i">
          <span class="time">{{ new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
          <span>{{ e.text }}</span>
        </li>
      </ul>
      <p v-else class="empty">还没有记录，走两步试试</p>
    </section>

    <details class="debug">
      <summary>调试面板（演示与测试用）</summary>
      <div class="debug-body">
        <button @click="addExp(100)">经验 +100</button>
        <button @click="simulateSquats(10)">模拟 10 个深蹲</button>
        <button @click="forceEvolution()">播一次进化动画</button>
        <p class="debug-note">
          步数来自 <code>device_latest</code> 实时订阅（本次会话累计）；
          深蹲数暂用按钮模拟 —— <code>reps</code> 表对 anon 不开放读取，
          正式版需要加一个聚合 RPC。
        </p>
      </div>
    </details>

    <p class="credit">
      {{ PET_CREDIT.text }} ·
      <a :href="PET_CREDIT.url" target="_blank" rel="noreferrer noopener">素材出处</a>
      （非商业，毕设使用）
    </p>
  </div>
</template>

<style scoped>
.pet-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.card {
  background: #171a21;
  border: 1px solid #1f232c;
  border-radius: 14px;
  padding: 16px 18px;
}

.hero {
  position: relative;
  overflow: hidden;
  background:
    radial-gradient(600px 300px at 50% 0%, rgba(61, 126, 255, 0.12), transparent 70%),
    #171a21;
}

.hero-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.hero-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hero-title h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: #e8ecf3;
}

.badge {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(61, 126, 255, 0.5);
  background: rgba(61, 126, 255, 0.12);
  color: #9dc0ff;
  font-family: monospace;
}

.mood {
  font-size: 13px;
  color: #8b93a7;
}

.mood.exercise {
  color: #3ddc84;
}
.mood.hungry {
  color: #ff5c5c;
}
.mood.sleep {
  color: #ffb020;
}

.exp-block,
.hunger {
  margin-top: 14px;
}

.exp-top {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #8b93a7;
  margin-bottom: 7px;
  font-family: monospace;
}

.bar {
  height: 8px;
  border-radius: 999px;
  background: #10131a;
  overflow: hidden;
  border: 1px solid #1f232c;
}

.fill {
  height: 100%;
  border-radius: 999px;
  transition: width 480ms cubic-bezier(0.22, 1, 0.36, 1);
}

.fill.exp {
  background: linear-gradient(90deg, #3d7eff, #7ba7ff);
  box-shadow: 0 0 12px rgba(61, 126, 255, 0.5);
}

.fill.ok {
  background: linear-gradient(90deg, #3ddc84, #8ef0b7);
}
.fill.warn {
  background: linear-gradient(90deg, #ffb020, #ffd27a);
}
.fill.bad {
  background: linear-gradient(90deg, #ff5c5c, #ff9a9a);
}

.food {
  color: #ffd27a;
}

.feed {
  margin-top: 10px;
  width: 100%;
  background: rgba(61, 220, 132, 0.14);
  border: 1px solid rgba(61, 220, 132, 0.5);
  color: #8ef0b7;
  border-radius: 10px;
  padding: 9px;
  font-size: 13px;
  cursor: pointer;
}

.feed:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.stat {
  background: #171a21;
  border: 1px solid #1f232c;
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.stat .k {
  font-size: 12px;
  color: #8b93a7;
}

.stat .v {
  font-size: 22px;
  font-family: monospace;
  color: #e8ecf3;
}

.stat .s {
  font-size: 11px;
  color: #5f6779;
}

.card h3 {
  margin: 0 0 10px;
  font-size: 14px;
  color: #c7cede;
  font-weight: 600;
}

.events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.events li {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #8b93a7;
  background: #12151c;
  border-radius: 8px;
  padding: 7px 10px;
}

.events .time {
  color: #5f6779;
  font-family: monospace;
}

.empty {
  font-size: 12px;
  color: #5f6779;
  margin: 0;
}

.debug {
  border: 1px dashed #2b2f3a;
  border-radius: 12px;
  padding: 10px 14px;
  font-size: 12px;
  color: #8b93a7;
}

.debug summary {
  cursor: pointer;
  color: #6b7387;
}

.debug-body {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.debug-body button {
  background: transparent;
  border: 1px solid #2b2f3a;
  color: #c7cede;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.debug-body button:hover {
  border-color: #3d7eff;
}

.debug-note {
  flex-basis: 100%;
  margin: 4px 0 0;
  line-height: 1.7;
  color: #5f6779;
}

.credit {
  font-size: 11px;
  color: #4d5566;
  line-height: 1.7;
  margin: 0;
}

.credit a {
  color: #5b7bb5;
}

code {
  background: #1f232c;
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
