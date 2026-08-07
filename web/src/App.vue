<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const isHome = computed(() => route.name === "home");
</script>

<template>
  <header v-if="!isHome" class="topbar">
    <RouterLink to="/" class="brand">
      <span class="brand-pi">π</span>
      <span>pi-agent book</span>
    </RouterLink>
  </header>
  <RouterView />
</template>
