<script setup>
/* DiagramEdgeH — the fluid horizontal connector of the engine's
 * rich-block library (ADR-0001). Where DiagramArrow has a fixed `len`,
 * this one stretches to fill its grid/flex track, so a cross-boundary
 * edge actually reaches both nodes instead of floating between them.
 * Head at the tip, shaft starting at the head's base; `dashed` marks
 * edges erased at compile time; colour is currentColor. */
defineProps({
  dir: { type: String, default: "left" }, // left | right
  dashed: { type: Boolean, default: false },
});
</script>

<template>
  <span class="d-edgeh" :class="{ dashed }" aria-hidden="true">
    <span v-if="dir === 'left'" class="d-edgeh-head left"></span>
    <span class="d-edgeh-shaft"></span>
    <span v-if="dir === 'right'" class="d-edgeh-head right"></span>
  </span>
</template>

<style scoped>
.d-edgeh {
  display: flex;
  align-items: center;
  width: 100%;
  color: var(--ink-faint);
}

.d-edgeh-shaft {
  flex: 1;
  height: 1.5px;
  background: currentColor;
}

.dashed .d-edgeh-shaft {
  background: repeating-linear-gradient(
    to right,
    currentColor 0 4px,
    transparent 4px 8px
  );
}

.d-edgeh-head {
  flex: none;
  width: 0;
  height: 0;
  border: 4.5px solid transparent;
}

.d-edgeh-head.left {
  border-right-color: currentColor;
}

.d-edgeh-head.right {
  border-left-color: currentColor;
}
</style>
