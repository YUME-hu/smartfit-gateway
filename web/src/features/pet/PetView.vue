<script setup lang="ts">
/**
 * 我的宠物（数字生命养成）
 *
 * 数据全部来自服务端（pet_state）：
 *   步数/深蹲 → 数据库触发器累加 → exp 是生成列 → RPC 读回来 → Realtime 推送
 * 所以刷新页面、换浏览器、手机重新同步，宠物的等级都不会变。
 *
 * 前端只做三件事：读 RPC、订阅变更、渲染规则（等级阈值仍是 petRules.ts 说了算）。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PetAvatar from './PetAvatar.vue'
import { celebrationImage, imageForMood, PET_CREDIT } from './petAssets'
import {
  decayHunger,
  moodOf,
  progressOf,
  stageFromLevel,
} from './petRules'
import type { PetMood } from './petRules'
import { usePetState } from './usePetState'
import { useAchievementMint } from '../chain/useAchievementMint'

const props = defineProps<{
  /** 最近一次收到手表数据的时刻，用于判断"正在运动" */
  lastAt: number
}>()

const env = import.meta.env
const supabaseUrl = (env.VITE_SUPABASE_URL as string | undefined) ?? ''
const supabaseKey = (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? ''
const DEVICE_ID = (env.VITE_DEVICE_ID as string | undefined) || 'watch-01'
const enabled = Boolean(supabaseUrl && supabaseKey)

const {
  summary,
  status,
  error,
  busy,
  refresh,
  feed,
  addBonusExp,
  recordSquat,
} = usePetState({ supabaseUrl, supabaseAnonKey: supabaseKey, deviceId: DEVICE_ID, enabled })

// ---------------------------------------------------------------- 上链

const CONTRACT = (env.VITE_ACHIEVEMENT_CONTRACT as string | undefined) ?? ''
const SIGNER_URL = (env.VITE_SIGNER_URL as string | undefined) || 'http://127.0.0.1:8787'
const MIN_EXP = 300
const MIN_STEPS = 5000

const {
  account,
  chainId,
  phase,
  error: mintError,
  txHash,
  tokenId,
  alreadyMinted,
  hasWallet,
  onSepolia,
  contractReady,
  connect,
  switchToSepolia,
  mint,
} = useAchievementMint({
  contractAddress: CONTRACT,
  signerUrl: SIGNER_URL,
  minExp: MIN_EXP,
  minSteps: MIN_STEPS,
})

/** 达标条件：经验 ≥300 或累计步数 ≥5000（合约里也校验一遍，这里是 UX） */
const eligible = computed(() => exp.value >= MIN_EXP || stepsTotal.value >= MIN_STEPS)

function short(v: string | null | undefined): string {
  if (!v) return '—'
  return v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v
}

async function onMint(): Promise<void> {
  await mint()
  if (!mintError.value) log('已提交上链交易（数据由签名服务担保）')
}

// ---------------------------------------------------------------- 本地 UI 状态

const celebrating = ref(false)
const now = ref(Date.now())
const events = ref<Array<{ t: number; text: string }>>([])
const avatarRef = ref<InstanceType<typeof PetAvatar> | null>(null)
const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
let repSeq = 0

let tick: number | undefined
let refreshTimer: number | undefined
let celebrateTimer: number | undefined

// ---------------------------------------------------------------- 派生

const exp = computed(() => summary.value?.exp ?? 0)
const progress = computed(() => progressOf(exp.value))
const stage = computed(() => stageFromLevel(progress.value.level))

const stepsTotal = computed(() => summary.value?.steps_total ?? 0)
const repsTotal = computed(() => summary.value?.reps_total ?? 0)
const food = computed(() => summary.value?.food ?? 0)

/**
 * 饥饿度用服务端返回的瞬时值，本地再按秒衰减做平滑显示
 * （避免两次刷新之间数字一动不动，看起来像卡住）
 */
const hunger = computed(() => {
  const base = summary.value?.hunger
  if (base === undefined) return 0
  const updatedAt = summary.value?.updated_at ? Date.parse(summary.value.updated_at) : now.value
  return decayHunger(base, Math.max(0, now.value - updatedAt))
})

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

const statusText = computed(() => {
  if (!enabled) return '未配置'
  switch (status.value) {
    case 'live':
      return '实时同步'
    case 'error':
      return '同步异常'
    case 'closed':
      return '未连接'
    default:
      return '连接中'
  }
})

// ---------------------------------------------------------------- 行为

function log(text: string): void {
  events.value.unshift({ t: Date.now(), text })
  if (events.value.length > 6) events.value.pop()
}

function celebrate(): void {
  celebrating.value = true
  if (celebrateTimer) clearTimeout(celebrateTimer)
  celebrateTimer = window.setTimeout(() => (celebrating.value = false), 1800)
}

async function onFeed(): Promise<void> {
  if (busy.value) return
  const r = await feed()
  if (r.ok) {
    celebrate()
    log('喂食成功，饱食度 +20')
  } else if (r.reason === 'no_food') {
    log('食物不够，多走走或做几个深蹲吧')
  } else {
    log(`喂食失败：${r.reason ?? '未知错误'}`)
  }
}

/** 调试：真实写 10 条深蹲记录（走 anon INSERT → 触发器 → pet_state） */
async function simulateSquats(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    repSeq++
    await recordSquat(sessionId, repSeq)
  }
  await refresh()
  log('模拟 10 个深蹲（已真实写库）')
}

async function onAddExp(): Promise<void> {
  await addBonusExp(100)
  log('调试：奖励经验 +100')
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
      const evolved = stage.value !== stageFromLevel(prev)
      log(`升级到 Lv${next}${evolved ? '，形态进化！' : ''}`)
      celebrate()
    }
  },
)

watch(
  () => error.value,
  (e) => {
    if (e) log(`同步错误：${e}`)
  },
)

onMounted(() => {
  tick = window.setInterval(() => {
    now.value = Date.now()
  }, 2000)
  // 60 秒兜底刷新，保证饥饿度衰减、以及 Realtime 偶发丢事件后能自愈
  refreshTimer = window.setInterval(() => {
    void refresh()
  }, 60000)
})

onBeforeUnmount(() => {
  if (tick) clearInterval(tick)
  if (refreshTimer) clearInterval(refreshTimer)
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
        <div class="head-right">
          <span class="sync" :class="status">{{ statusText }}</span>
          <span class="mood" :class="mood">{{ moodText }}</span>
        </div>
      </div>

      <PetAvatar ref="avatarRef" :src="petSrc" :stage="stage" alt="宠物" />

      <div class="exp-block">
        <div class="exp-top">
          <span>经验 {{ exp }}</span>
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
        <button class="feed" :disabled="food < 1 || busy" @click="onFeed">
          {{ busy ? '喂食中…' : '喂食（消耗 1 食物）' }}
        </button>
      </div>

      <p v-if="!summary && enabled" class="loading">正在读取宠物状态…</p>
      <p v-if="!enabled" class="loading">未配置 Supabase 环境变量，宠物无法持久化</p>
    </section>

    <section class="stats">
      <div class="stat">
        <span class="k">累计步数（云端）</span>
        <span class="v">{{ stepsTotal }}</span>
        <span class="s">每 100 步 = 10 经验 + 1 食物</span>
      </div>
      <div class="stat">
        <span class="k">深蹲（云端）</span>
        <span class="v">{{ repsTotal }}</span>
        <span class="s">每 10 个 = 15 经验 + 2 食物</span>
      </div>
      <div class="stat">
        <span class="k">形态</span>
        <span class="v">{{ stageText }}</span>
        <span class="s">Lv4 起进入成熟体</span>
      </div>
    </section>

    <section class="card chain">
      <div class="chain-head">
        <h3>里程碑成就（SBT）</h3>
        <span class="chain-tag" :class="{ on: eligible }">{{ eligible ? '已达标' : '未达标' }}</span>
      </div>
      <p class="chain-desc">
        经验 ≥ {{ MIN_EXP }} 或累计步数 ≥ {{ MIN_STEPS }} 可上链领取。一人一枚、不可转让（Soulbound）。
      </p>
      <ul class="chain-rows">
        <li><span>合约</span><code>{{ contractReady ? short(CONTRACT) : '未配置合约地址' }}</code></li>
        <li><span>钱包</span><code>{{ account ? short(account) : hasWallet ? '未连接' : '未安装 MetaMask' }}</code></li>
        <li><span>网络</span><code>{{ onSepolia ? 'Sepolia ✓' : chainId ? `chainId ${chainId}` : '—' }}</code></li>
      </ul>

      <div class="chain-actions">
        <button v-if="!account" :disabled="!hasWallet || !contractReady" @click="connect">
          连接钱包
        </button>
        <button v-else-if="!contractReady" disabled>未配置合约地址</button>
        <button v-else-if="!onSepolia" @click="switchToSepolia">切到 Sepolia</button>
        <button
          v-else-if="!alreadyMinted"
          class="mint"
          :disabled="!eligible || phase === 'signing' || phase === 'pending'"
          @click="onMint"
        >
          {{ phase === 'signing' ? '等待钱包确认…' : phase === 'pending' ? '上链中…' : '上链铭刻' }}
        </button>
        <span v-else class="minted">已领取 #{{ tokenId ?? '—' }}</span>
      </div>

      <p v-if="mintError" class="chain-err">{{ mintError }}</p>
      <a
        v-if="txHash"
        class="chain-link"
        :href="`https://sepolia.etherscan.io/tx/${txHash}`"
        target="_blank"
        rel="noreferrer noopener"
      >
        在 Sepolia Etherscan 查看交易 {{ short(txHash) }}
      </a>
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
      <summary>
        <span class="dev-tag">⚙ 调试</span>
        调试面板（仅供演示，非正式功能）
      </summary>
      <div class="debug-body">
        <button @click="onAddExp"><span class="dev-tag">调试</span>奖励经验 +100</button>
        <button @click="simulateSquats"><span class="dev-tag">调试</span>模拟 10 个深蹲</button>
        <button @click="forceEvolution()"><span class="dev-tag">调试</span>播一次进化动画</button>
        <p class="debug-note">
          这些按钮只为演示"升级 / 进化"效果，正式版本会整个移除：
          <br />· <strong>奖励经验</strong>只写 <code>bonus_exp</code>，
          <strong>不修改步数与深蹲记录</strong>（所以成就里的运动数据仍然是真实的）
          <br />· <strong>模拟深蹲</strong>会真实写入 <code>reps</code> 表（等价于你在深蹲页做 10 个）
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

.head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sync {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #23262f;
  color: #6b7387;
}

.sync.live {
  color: #3ddc84;
  border-color: rgba(61, 220, 132, 0.4);
  background: rgba(61, 220, 132, 0.1);
}

.sync.error {
  color: #ff5c5c;
  border-color: rgba(255, 92, 92, 0.4);
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

.loading {
  margin: 12px 0 0;
  font-size: 12px;
  color: #6b7387;
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

/* ---------------- 上链卡片 ---------------- */

.chain-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.chain-head h3 {
  margin: 0;
}

.chain-tag {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid #2b2f3a;
  color: #6b7387;
}

.chain-tag.on {
  color: #3ddc84;
  border-color: rgba(61, 220, 132, 0.5);
  background: rgba(61, 220, 132, 0.1);
}

.chain-desc {
  font-size: 12px;
  color: #6b7387;
  line-height: 1.7;
  margin: 0 0 10px;
}

.chain-rows {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chain-rows li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: #8b93a7;
}

.chain-rows code {
  font-family: monospace;
  color: #c7cede;
  background: #12151c;
  padding: 2px 8px;
  border-radius: 6px;
}

.chain-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.chain-actions button {
  flex: 1;
  background: transparent;
  border: 1px solid #2b2f3a;
  color: #c7cede;
  border-radius: 10px;
  padding: 9px 14px;
  font-size: 13px;
  cursor: pointer;
}

.chain-actions button.mint {
  background: linear-gradient(90deg, rgba(61, 126, 255, 0.2), rgba(61, 220, 132, 0.2));
  border-color: #3d7eff;
  color: #fff;
  font-weight: 600;
}

.chain-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.minted {
  font-size: 13px;
  color: #3ddc84;
  font-family: monospace;
}

.chain-err {
  margin: 10px 0 0;
  font-size: 12px;
  color: #ff8080;
  line-height: 1.6;
}

.chain-link {
  display: inline-block;
  margin-top: 10px;
  font-size: 12px;
  color: #6b9bff;
  word-break: break-all;
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

/* 调试标记：防止答辩时被误认为"作弊功能" */
.dev-tag {
  display: inline-block;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  margin-right: 6px;
  border-radius: 4px;
  background: rgba(255, 176, 32, 0.16);
  border: 1px solid rgba(255, 176, 32, 0.5);
  color: #ffb020;
  font-family: monospace;
  vertical-align: middle;
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
