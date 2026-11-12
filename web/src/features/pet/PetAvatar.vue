<script setup lang="ts">
/**
 * 宠物立绘 + 进化过场动画
 *
 * 编舞（父组件只管改 stage，这里自己跑完整时间轴）：
 *   0ms     高频震动 + 缩小到 0.82，亮度上扬
 *   420ms   白光爆闪（全屏 + 双光环扩散）
 *   800ms   在白光遮蔽下换图 → 放大回弹（0.55 → 1.12 → 1.0）
 *   1300ms  落地跳跃（带 squash & stretch）
 *   2000ms  归位，emit('evolved')
 *
 * 换图时机刻意放在 800ms：此时白光最亮，旧图淡出、新图淡入都看不见，
 * 避免"硬切"的廉价感。
 */

import { onBeforeUnmount, ref, watch } from 'vue'
import type { PetStage } from './petRules'

const props = defineProps<{
  /** 当前应该显示的图（随心情变化） */
  src: string
  /** 形态阶段，只在"变大"时触发进化动画 */
  stage: PetStage
  alt?: string
}>()

const emit = defineEmits<{ (e: 'evolved'): void }>()

type Phase = 'idle' | 'shake' | 'flash' | 'reveal' | 'jump'

const phase = ref<Phase>('idle')
const displaySrc = ref(props.src)
const timers: ReturnType<typeof setTimeout>[] = []

function clearTimers(): void {
  for (const t of timers) clearTimeout(t)
  timers.length = 0
}

/** 外部也可以手动触发（调试用） */
function playEvolution(): void {
  if (phase.value !== 'idle') return
  phase.value = 'shake'
  timers.push(setTimeout(() => (phase.value = 'flash'), 420))
  timers.push(
    setTimeout(() => {
      // 白光最亮的时候换图
      displaySrc.value = props.src
      phase.value = 'reveal'
    }, 800),
  )
  timers.push(setTimeout(() => (phase.value = 'jump'), 1300))
  timers.push(
    setTimeout(() => {
      phase.value = 'idle'
      emit('evolved')
    }, 2000),
  )
}

watch(
  () => props.stage,
  (next, prev) => {
    if (next > prev) playEvolution()
  },
)

// 心情变化只做柔和切换，不播进化动画
watch(
  () => props.src,
  (next) => {
    if (phase.value === 'idle') displaySrc.value = next
  },
)

onBeforeUnmount(clearTimers)

defineExpose({ playEvolution })
</script>

<template>
  <div class="pet-frame" :class="[`stage-${stage}`, `phase-${phase}`]">
    <!-- Lv4+ 常驻光环 -->
    <span v-if="stage >= 3" class="aura" aria-hidden="true"></span>

    <!-- 进化特效 -->
    <span v-if="phase === 'flash'" class="flash" aria-hidden="true"></span>
    <template v-if="phase === 'flash' || phase === 'reveal'">
      <span class="evo-ring ring-1" aria-hidden="true"></span>
      <span class="evo-ring ring-2" aria-hidden="true"></span>
    </template>

    <div class="pet-scale">
      <div class="pet-body">
        <div class="pet-breath">
          <img class="pet-img" :src="displaySrc" :alt="alt ?? '宠物'" draggable="false" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pet-frame {
  position: relative;
  width: 100%;
  display: grid;
  place-items: center;
  min-height: 300px;
  isolation: isolate;
}

/* 阶段缩放放在独立层，避免和动画的 transform 互相覆盖 */
.stage-1 {
  --stage-scale: 0.78;
}
.stage-2 {
  --stage-scale: 0.9;
}
.stage-3 {
  --stage-scale: 1;
}

.pet-scale {
  transform: scale(var(--stage-scale));
  transition: transform 600ms cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 2;
}

.pet-body {
  transform-origin: 50% 85%;
  will-change: transform, filter;
}

.pet-img {
  display: block;
  width: min(320px, 42vw);
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 18px 28px rgba(0, 0, 0, 0.45));
}

/* 呼吸：常驻，极轻微，避免抢戏 */
.pet-breath {
  animation: pet-breathe 3.8s ease-in-out infinite;
}

@keyframes pet-breathe {
  0%,
  100% {
    transform: scale(1, 1);
  }
  50% {
    transform: scale(1.02, 0.985);
  }
}

/* ---------------- 进化四段 ---------------- */

.phase-shake .pet-body {
  animation: evo-shake 420ms cubic-bezier(0.36, 0.07, 0.19, 0.97) forwards;
}

@keyframes evo-shake {
  0% {
    transform: translate(0, 0) scale(1);
    filter: brightness(1);
  }
  15% {
    transform: translate(-4px, 2px) scale(0.97);
    filter: brightness(1.15);
  }
  30% {
    transform: translate(4px, -3px) scale(0.94);
    filter: brightness(1.1);
  }
  45% {
    transform: translate(-3px, -3px) scale(0.9);
  }
  60% {
    transform: translate(3px, 3px) scale(0.87);
  }
  80% {
    transform: translate(-2px, 1px) scale(0.84);
  }
  100% {
    transform: translate(0, 0) scale(0.82);
    filter: brightness(1.5) saturate(1.2);
  }
}

.phase-reveal .pet-body {
  animation: evo-reveal 620ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

@keyframes evo-reveal {
  0% {
    transform: scale(0.55);
    opacity: 0;
    filter: brightness(2.2) blur(3px);
  }
  55% {
    transform: scale(1.12);
    opacity: 1;
    filter: brightness(1.25) blur(0);
  }
  80% {
    transform: scale(0.97);
  }
  100% {
    transform: scale(1);
    opacity: 1;
    filter: brightness(1);
  }
}

.phase-jump .pet-body {
  animation: evo-jump 700ms cubic-bezier(0.34, 1.4, 0.64, 1) forwards;
}

@keyframes evo-jump {
  0% {
    transform: translateY(0) scale(1, 1);
  }
  18% {
    transform: translateY(0) scale(1.1, 0.9);
  }
  46% {
    transform: translateY(-22px) scale(0.96, 1.06);
  }
  72% {
    transform: translateY(0) scale(1.06, 0.94);
  }
  88% {
    transform: translateY(-4px) scale(1, 1);
  }
  100% {
    transform: translateY(0) scale(1, 1);
  }
}

/* ---------------- 特效层 ---------------- */

.flash {
  position: fixed;
  inset: 0;
  z-index: 40;
  pointer-events: none;
  background: radial-gradient(
    circle at 50% 46%,
    rgba(255, 255, 255, 0.98) 0%,
    rgba(214, 236, 255, 0.86) 22%,
    rgba(140, 190, 255, 0.35) 45%,
    rgba(10, 14, 22, 0) 72%
  );
  animation: evo-flash 520ms ease-out forwards;
}

@keyframes evo-flash {
  0% {
    opacity: 0;
  }
  18% {
    opacity: 0.95;
  }
  55% {
    opacity: 0.65;
  }
  100% {
    opacity: 0;
  }
}

.evo-ring {
  position: absolute;
  left: 50%;
  top: 52%;
  border-radius: 50%;
  border: 2px solid rgba(160, 210, 255, 0.9);
  box-shadow: 0 0 24px rgba(120, 180, 255, 0.65), inset 0 0 24px rgba(180, 220, 255, 0.4);
  pointer-events: none;
  z-index: 3;
  width: 180px;
  height: 180px;
  animation: evo-ring 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.ring-2 {
  animation-delay: 130ms;
  border-color: rgba(255, 255, 255, 0.75);
}

@keyframes evo-ring {
  0% {
    transform: translate(-50%, -50%) scale(0.35);
    opacity: 0.9;
  }
  100% {
    transform: translate(-50%, -50%) scale(3);
    opacity: 0;
  }
}

.stage-3 .aura {
  position: absolute;
  left: 50%;
  top: 52%;
  width: 260px;
  height: 260px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(
    circle,
    rgba(61, 220, 132, 0.18) 0%,
    rgba(61, 126, 255, 0.14) 45%,
    rgba(0, 0, 0, 0) 70%
  );
  animation: aura-pulse 4s ease-in-out infinite;
  pointer-events: none;
  z-index: 1;
}

@keyframes aura-pulse {
  0%,
  100% {
    opacity: 0.55;
    transform: translate(-50%, -50%) scale(1);
  }
  50% {
    opacity: 0.9;
    transform: translate(-50%, -50%) scale(1.08);
  }
}

/* 尊重系统"减少动态效果"设置 */
@media (prefers-reduced-motion: reduce) {
  .pet-breath,
  .stage-3 .aura,
  .phase-shake .pet-body,
  .phase-reveal .pet-body,
  .phase-jump .pet-body,
  .flash,
  .evo-ring {
    animation: none !important;
  }
}
</style>
