<script setup>
/**
 * Language menu adapted from trove/cn Menu + Button primitives
 * (https://www.trovecn.dev/docs/components/menu): icon trigger, radio group
 * for the active locale, spring-ish popup. Built in Vue to match this reader.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useLocale } from "../i18n/locale.js";

const { locale, locales, t, setLocale } = useLocale();

const open = ref(false);
const rootRef = ref(null);
const menuRef = ref(null);
const triggerRef = ref(null);
const activeIndex = ref(-1);

const currentLabel = computed(
  () => locales.find((l) => l.code === locale.value)?.native ?? locale.value,
);

function close() {
  open.value = false;
  activeIndex.value = -1;
}

function toggle() {
  open.value = !open.value;
  if (open.value) {
    activeIndex.value = locales.findIndex((l) => l.code === locale.value);
    nextTick(() => menuRef.value?.querySelector('[role="menuitemradio"]')?.focus());
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

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = (activeIndex.value + delta + locales.length) % locales.length;
    activeIndex.value = next;
    menuRef.value
      ?.querySelectorAll('[role="menuitemradio"]')
      [next]?.focus();
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
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointer);
  document.removeEventListener("keydown", onKeydown);
});

watch(locale, () => {
  // keep menu selection in sync if locale changes elsewhere
  activeIndex.value = locales.findIndex((l) => l.code === locale.value);
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
      <svg class="lang-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        />
      </svg>
      <span class="lang-code">{{ currentLabel }}</span>
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
  gap: 7px;
  height: 34px;
  padding: 0 12px 0 10px;
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

.lang-icon {
  width: 15px;
  height: 15px;
  flex: none;
}

.lang-code {
  font-weight: 600;
  max-width: 5.5em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
