<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import LanguageSwitcher from "./components/LanguageSwitcher.vue";
import { useLocale } from "./i18n/locale.js";

const THEME_KEY = "pi-book-theme";
const route = useRoute();
const { t } = useLocale();
const isHome = computed(() => route.name === "home");
const isDark = ref(document.documentElement.dataset.theme === "dark");
let colorSchemeQuery;

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  isDark.value = theme === "dark";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#111114" : "#fbfbf9");
}

function toggleTheme() {
  const theme = isDark.value ? "light" : "dark";
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The visual switch still works when storage is unavailable.
  }
}

function syncSystemTheme(event) {
  if (!storedTheme()) applyTheme(event.matches ? "dark" : "light");
}

onMounted(() => {
  colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  colorSchemeQuery.addEventListener("change", syncSystemTheme);
});

onUnmounted(() => {
  colorSchemeQuery?.removeEventListener("change", syncSystemTheme);
});
</script>

<template>
  <header v-if="!isHome" class="topbar">
    <RouterLink to="/" class="brand">
      <span class="brand-pi">π</span>
      <span>{{ t.brand }}</span>
    </RouterLink>
  </header>
  <div class="chrome-controls" :class="{ 'on-home': isHome }">
    <LanguageSwitcher />
    <button
      type="button"
      class="theme-toggle"
      :aria-label="isDark ? t.themeToLight : t.themeToDark"
      :title="isDark ? t.themeToLight : t.themeToDark"
      :aria-pressed="isDark"
      @click="toggleTheme"
    >
      <span class="theme-orb" aria-hidden="true"></span>
    </button>
  </div>
  <RouterView />
</template>

<style scoped>
.chrome-controls {
  position: fixed;
  top: 18px;
  right: 32px;
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 10px;
}

.chrome-controls :deep(.theme-toggle) {
  position: static;
  top: auto;
  right: auto;
}

.chrome-controls.on-home {
  /* home already has a repo link at top-right; keep controls clear of it */
  right: 78px;
}

@media (max-width: 640px) {
  .chrome-controls {
    right: 16px;
    gap: 8px;
  }
  .chrome-controls.on-home {
    right: 58px;
  }
}
</style>
