<script setup>
/* DiagramEdgeV — the fluid vertical counterpart of DiagramEdgeH.
 * Stretches to fill its grid/flex track, so the shaft is exactly as
 * long as the gap it bridges (a row interrupted by a note yields a
 * genuinely longer arrow). Head at the tip, shaft starting at the
 * head's base; colour is currentColor. */
defineProps({
  dir: { type: String, default: "up" }, // up | down
  dashed: { type: Boolean, default: false },
});
</script>

<template>
  <span class="d-edgev" :class="{ dashed }" aria-hidden="true">
    <span v-if="dir === 'up'" class="d-edgev-head up"></span>
    <span class="d-edgev-shaft"></span>
    <span v-if="dir === 'down'" class="d-edgev-head down"></span>
  </span>
</template>

<style scoped>
.d-edgev {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 9px;
  height: 100%;
  color: var(--ink-faint);
}

.d-edgev-shaft {
  flex: 1;
  width: 1.5px;
  background: currentColor;
}

.dashed .d-edgev-shaft {
  background: repeating-linear-gradient(
    to bottom,
    currentColor 0 4px,
    transparent 4px 8px
  );
}

.d-edgev-head {
  flex: none;
  width: 0;
  height: 0;
  border: 4.5px solid transparent;
}

.d-edgev-head.up {
  border-bottom-color: currentColor;
}

.d-edgev-head.down {
  border-top-color: currentColor;
}
</style>
