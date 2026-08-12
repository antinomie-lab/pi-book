<script setup>
/**
 * Language switcher: the current locale's own name as glyph outlines
 * (中文 / English / Español). One click cycles to the next locale and
 * the word flows into it — the morph is the feedback, no menu needed.
 */
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useLocale } from "../i18n/locale.js";
import { createMorph } from "morphicons/dom";
import { LANG_WORDS } from "../i18n/lang-words.js";

const { locale, locales, t, setLocale } = useLocale();

/* the label is rendered from compiled outlines via morphicons' dom
 * driver on a raw path; fill-rule evenodd keeps counters hollow
 * regardless of how the engine reorders vertices mid-flight */
const wordRef = ref(null);
const initialD = LANG_WORDS[locale.value].d;
let morph = null;

/* the pill never resizes: the svg spans the widest word, and only the
 * viewBox x-offset glides — the morphing word stays centred while the
 * button itself never moves */
const BOX = ["zh", "en", "es"].reduce(
  (acc, k) => {
    const w = LANG_WORDS[k];
    return {
      w: Math.max(acc.w, w.w),
      minY: Math.min(acc.minY, w.minY),
      h: Math.max(acc.h, w.h),
    };
  },
  { w: 0, minY: 0, h: 0 },
);

const centerOff = (code) => -(BOX.w - LANG_WORDS[code].w) / 2;
const offX = ref(centerOff(locale.value));
let offTween = null;

function tweenOff(target) {
  if (offTween) cancelAnimationFrame(offTween);
  const from = offX.value;
  const t0 = performance.now();
  const DUR = 450;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / DUR);
    const e = 1 - Math.pow(1 - p, 3);
    offX.value = from + (target - from) * e;
    if (p < 1) offTween = requestAnimationFrame(step);
  };
  offTween = requestAnimationFrame(step);
}

function cycle() {
  const i = locales.findIndex((l) => l.code === locale.value);
  const next = locales[(i + 1) % locales.length];
  if (next) setLocale(next.code);
}

onMounted(() => {
  morph = createMorph(wordRef.value, initialD);
});
onUnmounted(() => {
  morph?.destroy();
  if (offTween) cancelAnimationFrame(offTween);
});

watch(locale, (code) => {
  const target = LANG_WORDS[code];
  if (target) {
    morph?.morphTo(target.d, "smooth");
    tweenOff(centerOff(code));
  }
});
</script>

<template>
  <button
    type="button"
    class="lang-trigger"
    :aria-label="t.languageMenu"
    :title="t.languageMenu"
    @click="cycle"
  >
    <svg
      class="lang-word"
      :width="BOX.w"
      :height="BOX.h"
      :viewBox="`${offX} ${BOX.minY} ${BOX.w} ${BOX.h}`"
      aria-hidden="true"
    >
      <path
        ref="wordRef"
        fill="currentColor"
        fill-rule="evenodd"
        :d="initialD"
      />
    </svg>
  </button>
</template>

<style scoped>
.lang-trigger {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 13px;
  border: 1.5px solid var(--control-border);
  border-radius: var(--radius);
  background: var(--surface-glass);
  backdrop-filter: blur(8px);
  color: var(--ink);
  cursor: pointer;
  transition:
    border-color 0.25s,
    background 0.25s,
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.lang-trigger:hover {
  border-color: var(--ink);
  background: var(--surface);
}

.lang-trigger:active {
  transform: translateY(1px);
}

.lang-word {
  display: block;
  flex: none;
}
</style>
