<script setup>
/**
 * Language menu adapted from trove/cn Menu + Button primitives
 * (https://www.trovecn.dev/docs/components/menu): icon trigger, radio group
 * for the active locale, spring-ish popup. Built in Vue to match this reader.
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useLocale } from "../i18n/locale.js";
import { createMorph } from "morphicons/dom";
import { LANG_WORDS } from "../i18n/lang-words.js";

const { locale, locales, t, setLocale } = useLocale();

const open = ref(false);
const rootRef = ref(null);
const menuRef = ref(null);
const triggerRef = ref(null);
const activeIndex = ref(-1);

/* the trigger label is the locale's own name as glyph outlines, morphing
 * between words on switch (morphicons on a raw path; fill-rule evenodd
 * keeps counters hollow regardless of vertex order) */
const wordRef = ref(null);
const box = ref({ ...LANG_WORDS[locale.value] });
const initialD = LANG_WORDS[locale.value].d;
let morph = null;
let boxTween = null;

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

function close() {
  open.value = false;
  activeIndex.value = -1;
}

function focusItem(index) {
  activeIndex.value = index;
  menuRef.value?.querySelectorAll('[role="menuitemradio"]')[index]?.focus();
}

function toggle() {
  open.value = !open.value;
  if (open.value) {
    // menu radio pattern: focus lands on the checked item
    const checked = locales.findIndex((l) => l.code === locale.value);
    nextTick(() => focusItem(checked === -1 ? 0 : checked));
  }
}

function pick(code) {
  setLocale(code);
  close();
  triggerRef.value?.focus();
}

function onDocPointer(e) {
  if (!open.value) return;
  if (rootRef.value && !rootRef.value.contains(e.target)) close();
}

function onKeydown(e) {
  if (!open.value) {
    if (
      (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") &&
      document.activeElement === triggerRef.value
    ) {
      e.preventDefault();
      toggle();
    }
    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    close();
    triggerRef.value?.focus();
    return;
  }

  if (e.key === "Tab") {
    close();
    return;
  }

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = (activeIndex.value + delta + locales.length) % locales.length;
    focusItem(next);
    return;
  }

  if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    focusItem(e.key === "Home" ? 0 : locales.length - 1);
    return;
  }

  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    const item = locales[activeIndex.value];
    if (item) pick(item.code);
  }
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointer);
  document.addEventListener("keydown", onKeydown);
  morph = createMorph(wordRef.value, initialD);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointer);
  document.removeEventListener("keydown", onKeydown);
  morph?.destroy();
  if (boxTween) cancelAnimationFrame(boxTween);
});

watch(locale, (code) => {
  // keep menu selection in sync if locale changes elsewhere
  activeIndex.value = locales.findIndex((l) => l.code === code);
  const target = LANG_WORDS[code];
  if (target) {
    morph?.morphTo(target.d, "smooth");
    tweenBox(target);
  }
});
</script>

<template>
  <div ref="rootRef" class="lang-switch">
    <button
      ref="triggerRef"
      type="button"
      class="lang-trigger"
      :aria-label="t.languageMenu"
      :title="t.languageMenu"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
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

    <Transition name="lang-pop">
      <div
        v-if="open"
        ref="menuRef"
        class="lang-menu"
        role="menu"
        :aria-label="t.language"
      >
        <button
          v-for="(item, i) in locales"
          :key="item.code"
          type="button"
          class="lang-item"
          role="menuitemradio"
          :aria-checked="item.code === locale"
          :tabindex="i === activeIndex ? 0 : -1"
          @mouseenter="activeIndex = i"
          @click="pick(item.code)"
        >
          <span class="lang-radio" aria-hidden="true">
            <span v-if="item.code === locale" class="lang-radio-dot"></span>
          </span>
          <span class="lang-native">{{ item.native }}</span>
          <span class="lang-short">{{ item.code.toUpperCase() }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.lang-switch {
  position: relative;
}

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
  font-size: 12px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    border-color 0.25s,
    background 0.25s,
    transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.lang-trigger:hover,
.lang-trigger[aria-expanded="true"] {
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

.lang-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 80;
  min-width: 168px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 18px 40px -22px var(--shadow-strong);
  transform-origin: top right;
}

.lang-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
}

.lang-item:hover,
.lang-item:focus-visible {
  background: var(--accent-soft);
  outline: none;
}

.lang-item[aria-checked="true"] {
  color: var(--accent);
}

.lang-radio {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--control-border);
  border-radius: 50%;
  display: grid;
  place-items: center;
  flex: none;
}

.lang-item[aria-checked="true"] .lang-radio {
  border-color: var(--accent);
}

.lang-radio-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.lang-native {
  flex: 1;
  font-weight: 600;
}

.lang-short {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}

.lang-pop-enter-active,
.lang-pop-leave-active {
  transition:
    opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.lang-pop-enter-from,
.lang-pop-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}
</style>
