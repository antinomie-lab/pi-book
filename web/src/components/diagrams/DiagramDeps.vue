<script setup>
/* diagram-deps — the dependency-direction figure of chapter 01
 * ("解耦：core 不认识 harness"). Unlike the file map, the protagonists
 * here are the edges: every arrow points upstream, the dashed one is a
 * type-only import erased at compile time, and the single accent arrow
 * is the figure's thesis — the only value that crosses the boundary is
 * runAgentLoop, the loop itself (blue belongs to the loop, per DESIGN).
 * No hover interactions: every annotation lives on the canvas. */
import { computed } from "vue";
import { useLocale } from "../../i18n/locale.js";
import DiagramEdgeV from "./DiagramEdgeV.vue";
import DiagramEdgeH from "./DiagramEdgeH.vue";

const { t } = useLocale();
const d = computed(() => t.value.deps ?? {});
</script>

<template>
  <figure class="deps">
    <div class="deps-grid">
      <span class="deps-layer" style="grid-column: 1; grid-row: 1">{{
        d.coreTitle
      }}</span>
      <span class="deps-layer" style="grid-column: 3; grid-row: 1">{{
        d.harnessTitle
      }}</span>

      <!-- row 1: types — the dashed type-only edge -->
      <span class="deps-node" style="grid-column: 1; grid-row: 2">types.ts</span>
      <span class="deps-bridge" style="grid-column: 2; grid-row: 2">
        <DiagramEdgeH dashed />
      </span>
      <span class="deps-node" style="grid-column: 3; grid-row: 2"
        >harness/types.ts</span
      >
      <span class="deps-edge-note" style="grid-column: 2; grid-row: 3">{{
        d.typeEdgeNote
      }}</span>

      <!-- column-internal upstream arrows: fluid — the shaft is exactly
           as long as the gap it bridges. The first leg also covers the
           type-edge note's row, so its length matches the real distance -->
      <span class="deps-varrow" style="grid-column: 1; grid-row: 3 / 5"
        ><DiagramEdgeV
      /></span>
      <span class="deps-varrow" style="grid-column: 3; grid-row: 3 / 5"
        ><DiagramEdgeV
      /></span>

      <span class="deps-node" style="grid-column: 1; grid-row: 5"
        >stream-fn.ts</span
      >
      <span class="deps-node" style="grid-column: 3; grid-row: 5"
        >session/ · compaction/ · tools/</span
      >

      <span class="deps-varrow" style="grid-column: 1; grid-row: 6"
        ><DiagramEdgeV
      /></span>
      <span class="deps-varrow" style="grid-column: 3; grid-row: 6"
        ><DiagramEdgeV
      /></span>

      <!-- row 3: the single value import — the figure's thesis -->
      <span class="deps-node" style="grid-column: 1; grid-row: 7"
        >agent-loop.ts</span
      >
      <span class="deps-bridge" style="grid-column: 2; grid-row: 7">
        <DiagramEdgeH class="deps-value-edge" />
      </span>
      <span class="deps-node" style="grid-column: 3; grid-row: 7"
        >agent-harness.ts</span
      >
      <span class="deps-edge-note" style="grid-column: 2; grid-row: 8"
        >{{ d.valueEdgeNotePre }}
        <span class="deps-edge-fn">{{ d.valueEdgeNoteFn }}</span>
        {{ d.valueEdgeNotePost }}</span
      >

      <!-- this leg also covers the note row's height, so it is genuinely
           longer than the others — as it should be -->
      <span class="deps-varrow" style="grid-column: 1; grid-row: 8 / 10"
        ><DiagramEdgeV
      /></span>

      <span class="deps-node" style="grid-column: 1; grid-row: 10">
        agent.ts
        <span class="deps-node-note">{{ d.agentNote }}</span>
      </span>
    </div>

    <figcaption class="deps-caption">{{ d.captionDefault }}</figcaption>
  </figure>
</template>

<style scoped>
.deps {
  margin: 36px 0 28px;
  font-family: var(--sans);
  user-select: none;
}

/* node columns shrink-wrap their widest label; the middle track is
 * fluid, so the cross edges span the real distance and reach both
 * nodes. The whole figure stays narrower than the text column — a
 * sparse diagram reads empty, a compact one reads deliberate */
.deps-grid {
  display: grid;
  grid-template-columns: auto minmax(120px, 1fr) auto;
  align-items: center;
  row-gap: 4px;
  column-gap: 12px;
  max-width: 620px;
  margin: 0 auto;
}

.deps-layer {
  text-align: center;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink);
  margin-bottom: 6px;
}

/* nodes are quiet rounded boxes — a dependency graph needs visible
 * nodes, but the 999px capsule is the file map's "interactive chip";
 * these are inert, so they get a plainer corner */
.deps-node {
  justify-self: center;
  text-align: center;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink-soft);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 5px 12px;
}

.deps-node-note {
  display: block;
  margin-top: 2px;
  font-family: var(--sans);
  font-size: 11.5px;
  color: var(--ink-faint);
}

.deps-varrow {
  justify-self: center;
  align-self: stretch;
  min-height: 34px;
}

.deps-bridge {
  justify-self: stretch;
  align-self: center;
}

/* edge notes get their own grid row directly under the edge — stacking
 * them inside the arrow's cell would push the arrow off the node midline */
.deps-edge-note {
  justify-self: center;
  font-size: 11.5px;
  color: var(--ink-soft);
  text-align: center;
  line-height: 1.5;
  max-width: 220px;
}

/* the thesis edge: the only value crossing the boundary is the loop
 * itself — the site's single blue belongs to it */
.deps-value-edge {
  color: var(--accent);
}

.deps-edge-fn {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
}

.deps-caption {
  margin-top: 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-soft);
}
</style>
