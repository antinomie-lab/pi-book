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
const box = ref({ ...LANG_WORDS[locale.value] });
const initialD = LANG_WORDS[locale.value].d;
let morph = null;
let boxTween = null;

/* the pill glides to the new word's width alongside the spring */
function tweenBox(target) {
  if (boxTween) cancelAnimationFrame(boxTween);
  const from = { ...box.value };
  const t0 = performance.now();
  const DUR = 450;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / DUR);
    const e = 1 - Math.pow(1 - p, 3);
    box.value = {
      w: from.w + (target.w - from.w) * e,
      minY: from.minY + (target.minY - from.minY) * e,
      h: from.h + (target.h - from.h) * e,
    };
    if (p < 1) boxTween = requestAnimationFrame(step);
  };
  boxTween = requestAnimationFrame(step);
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
  if (boxTween) cancelAnimationFrame(boxTween);
});

watch(locale, (code) => {
  const target = LANG_WORDS[code];
  if (target) {
    morph?.morphTo(target.d, "smooth");
    tweenBox(target);
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
      :width="box.w"
      :height="box.h"
      :viewBox="`0 ${box.minY} ${box.w} ${box.h}`"
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
