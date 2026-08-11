<script setup>
/* DiagramArrow — the connector primitive of the engine's rich-block
 * library (ADR-0001). Head at the very tip; the shaft starts exactly at
 * the head's base, never poking through. Direction is `dir` (a diagonal
 * arrow is just a rotated vertical one — pass the angle via `dir` +
 * CSS transform if ever needed), length is `len`, and `dashed` marks
 * edges that don't exist at runtime (type-only imports). The arrow
 * draws in currentColor: parents dye it with a class. */
import { computed } from "vue";

const props = defineProps({
  len: { type: Number, default: 18 },
  dir: { type: String, default: "up" }, // up | right | down | left
  dashed: { type: Boolean, default: false },
});

const ANGLES = { up: 0, right: 90, down: 180, left: -90 };

const horizontal = computed(() => props.dir === "left" || props.dir === "right");

/* the layout box follows the axis; the inner span keeps the arrow's
 * local "up" geometry and is simply rotated into place */
const boxStyle = computed(() =>
  horizontal.value
    ? { width: `${props.len}px`, height: "9px" }
    : { width: "9px", height: `${props.len}px` },
);

const innerStyle = computed(() => ({
  height: `${props.len}px`,
  transform: `translate(-50%, -50%) rotate(${ANGLES[props.dir] ?? 0}deg)`,
}));
</script>

<template>
  <span class="d-arrow" :style="boxStyle" aria-hidden="true">
    <span class="d-arrow-i" :class="{ dashed }" :style="innerStyle"></span>
  </span>
</template>

<style scoped>
.d-arrow {
  position: relative;
  display: inline-block;
  flex: none;
  color: var(--ink-faint);
}

.d-arrow-i {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 9px;
}

.d-arrow-i::before {
  content: "";
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  border: 4.5px solid transparent;
  border-bottom-color: currentColor;
}

.d-arrow-i::after {
  content: "";
  position: absolute;
  top: 4.5px;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 1.5px;
  background: currentColor;
}

/* a dashed shaft marks an edge that is erased at compile time */
.d-arrow-i.dashed::after {
  background: repeating-linear-gradient(
    to bottom,
    currentColor 0 4px,
    transparent 4px 8px
  );
}
</style>
