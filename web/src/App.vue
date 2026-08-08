<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";

const THEME_KEY = "pi-book-theme";
const route = useRoute();
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
      <span>pi-agent book</span>
    </RouterLink>
  </header>
  <button
    type="button"
    class="theme-toggle"
    :class="{ 'on-home': isHome }"
    :aria-label="isDark ? '切换为浅色模式' : '切换为深色模式'"
    :title="isDark ? '切换为浅色模式' : '切换为深色模式'"
    :aria-pressed="isDark"
    @click="toggleTheme"
  >
    <span class="theme-orb" aria-hidden="true"></span>
  </button>
  <RouterView />
</template>
