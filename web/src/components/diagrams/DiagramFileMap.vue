<script setup>
/* diagram-filemap — the first rich-block instance of ADR-0001.
 * Structure (module lists, layering) is locale-invariant and lives here;
 * every human-readable label comes from messages.js `filemap`. */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useLocale } from "../../i18n/locale.js";
import { getChapters } from "../../chapters.js";
import DiagramArrow from "./DiagramArrow.vue";

const { t, locale } = useLocale();

const CORE = [
  { id: "core-types", name: "types.ts" },
  { id: "core-agent-loop", name: "agent-loop.ts" },
  { id: "core-agent", name: "agent.ts" },
  { id: "core-stream-fn", name: "stream-fn.ts / proxy.ts" },
];

const HARNESS = [
  { id: "h-agent-harness", name: "agent-harness.ts" },
  { id: "h-types", name: "types.ts" },
  { id: "h-messages", name: "messages.ts" },
  { id: "h-session", name: "session/" },
  { id: "h-compaction", name: "compaction/" },
  { id: "h-tools", name: "tools/" },
  { id: "h-skills", name: "skills.ts / prompt-templates.ts" },
  { id: "h-env-node", name: "env/nodejs.ts" },
  { id: "h-experimental", name: "experimental/session/" },
];

const fm = computed(() => t.value.filemap ?? {});
const published = computed(
  () => new Set(getChapters(locale.value).map((c) => c.num)),
);

function info(id) {
  return fm.value.modules?.[id] ?? {};
}

/* a module is navigable only when its chapter is actually on the site —
 * everything else reports "in progress" instead of a dead link */
function target(id) {
  const ch = info(id).chapter;
  if (ch == null || !published.value.has(ch)) return null;
  return `/chapter/${String(ch).padStart(2, "0")}`;
}

const hovered = ref(null);

/* with nothing hovered the caption describes the diagram itself, never a
 * stale half of the last module. Scrolling can strand `hovered` (the
 * chip slides out from under the cursor without a mouseleave), so any
 * scroll also returns the caption to its idle state */
const caption = computed(() => {
  const id = hovered.value;
  if (!id) return { name: "", desc: fm.value.captionDefault ?? "", hint: fm.value.captionHint ?? "", idle: true };
  const m = info(id);
  const name = [...CORE, ...HARNESS].find((x) => x.id === id)?.name ?? "";
  const hint =
    m.chapter == null
      ? ""
      : target(id)
        ? fm.value.chapterHint?.(m.chapter)
        : fm.value.chapterSoon?.(m.chapter);
  return { name, desc: m.desc ?? "", hint, idle: false };
});

function clearHover() {
  hovered.value = null;
}

onMounted(() => window.addEventListener("scroll", clearHover, { passive: true }));
onUnmounted(() => window.removeEventListener("scroll", clearHover));
</script>

<template>
  <figure class="filemap" @mouseleave="hovered = null">
    <div class="fm-external">
      <span class="fm-name">@earendil-works/pi-ai</span>
      <span class="fm-note">{{ fm.externalNote }}</span>
    </div>

    <div class="fm-edge">
      <DiagramArrow />
      <span class="fm-edge-label">{{ fm.externalEdge }}</span>
    </div>

    <div class="fm-package">
      <span class="fm-boundary">{{ fm.packageBoundary }}</span>

      <div class="fm-layer">
        <p class="fm-layer-head">
          <strong>{{ fm.coreTitle }}</strong>
          <span>{{ fm.coreNote }}</span>
        </p>
        <div class="fm-chips">
          <component
            :is="target(m.id) ? 'RouterLink' : 'span'"
            v-for="m in CORE"
            :key="m.id"
            v-bind="target(m.id) ? { to: target(m.id) } : {}"
            class="fm-chip"
            :class="{ link: !!target(m.id) }"
            @mouseenter="hovered = m.id"
            @focus="hovered = m.id"
            @blur="hovered = null"
            >{{ m.name }}</component
          >
        </div>
      </div>

      <div class="fm-edge fm-edge-mid" aria-hidden="true">
        <DiagramArrow :len="22" />
        <DiagramArrow :len="22" />
      </div>

      <div class="fm-layer">
        <p class="fm-layer-head">
          <strong>{{ fm.harnessTitle }}</strong>
          <span>{{ fm.harnessNote }}</span>
        </p>
        <div class="fm-chips">
          <component
            :is="target(m.id) ? 'RouterLink' : 'span'"
            v-for="m in HARNESS"
            :key="m.id"
            v-bind="target(m.id) ? { to: target(m.id) } : {}"
            class="fm-chip"
            :class="{ link: !!target(m.id) }"
            @mouseenter="hovered = m.id"
            @focus="hovered = m.id"
            @blur="hovered = null"
            ><span>{{ m.name }}</span
            ><span v-if="info(m.id).tag" class="fm-chip-tag">{{
              info(m.id).tag
            }}</span></component
          >
        </div>
      </div>
    </div>

    <figcaption class="fm-caption" :class="{ idle: caption.idle }">
      <span v-if="caption.name" class="fm-caption-name">{{
        caption.name
      }}</span>
      <span v-if="caption.desc" class="fm-caption-desc">{{
        caption.desc
      }}</span>
      <span v-if="caption.hint" class="fm-caption-hint">{{
        caption.hint
      }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.filemap {
  margin: 36px 0 28px;
  font-family: var(--sans);
  user-select: none;
}

/* the other package — dashed, outside the boundary */
.fm-external {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 12px;
  max-width: 520px;
  margin: 0 auto;
  padding: 10px 18px;
  border: 1.5px dashed var(--line);
  border-radius: 10px;
}

.fm-external .fm-name {
  white-space: nowrap;
}

.fm-name {
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink);
}

/* semantic annotations — they carry part of the chapter's argument, so
 * they sit one shade above pure metadata (boundary label, line counts) */
.fm-note {
  font-size: 12px;
  color: var(--ink-soft);
}

/* arrows point at the depended-upon side (import direction) */
.fm-edge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 2px 0;
}

.fm-edge-label {
  font-size: 11.5px;
  color: var(--ink-soft);
}

/* the package boundary */
.fm-package {
  position: relative;
  border: 1.5px solid var(--line);
  border-radius: 14px;
  padding: 18px 16px 14px;
  margin-top: 2px;
}

.fm-boundary {
  position: absolute;
  top: -9px;
  left: 18px;
  padding: 0 8px;
  background: var(--paper);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-faint);
}

/* each layer is its own rounded box nested in the package frame —
 * the nesting is the diagram's whole point (mirrors the ASCII) */
.fm-layer {
  border: 1.5px solid var(--line);
  border-radius: 12px;
  padding: 12px 16px 16px;
}

/* connectors between the layer boxes: a centred, symmetric pair —
 * fixed pixel gaps drift off-centre when chips wrap, percentages don't */
.fm-edge-mid {
  flex-direction: row;
  justify-content: center;
  gap: 18%;
  padding: 0;
}

.fm-layer-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 10px;
  font-size: 12.5px;
}

.fm-layer-head strong {
  color: var(--ink);
  font-weight: 700;
}

.fm-layer-head span {
  color: var(--ink-faint);
  font-size: 11.5px;
}

.fm-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* capsules — the site's --radius vocabulary; blue marks what is clickable,
 * exactly as sparingly as everywhere else */
.fm-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--paper);
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-soft);
  text-decoration: none;
  transition:
    border-color 0.2s,
    color 0.2s,
    background 0.2s;
}

.fm-chip:hover,
.fm-chip:focus-visible {
  border-color: var(--ink-faint);
  color: var(--ink);
  outline: none;
}

.fm-chip.link {
  cursor: pointer;
}

.fm-chip.link:hover,
.fm-chip.link:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.fm-chip-tag {
  font-size: 10.5px;
  color: var(--ink-faint);
}

.fm-caption {
  min-height: 1.9em;
  margin-top: 10px;
  text-align: center;
  font-size: 12.5px;
  color: var(--ink-soft);
}

/* the idle caption is the diagram's own statement, not a dimmed leftover
 * — only the operation hint inside it (fm-caption-hint) stays faint */
.fm-caption.idle {
  color: var(--ink-soft);
}

.fm-caption-name {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  margin-right: 8px;
}

.fm-caption-hint {
  margin-left: 8px;
  color: var(--ink-faint);
}

.fm-caption-hint::before {
  content: "·";
  margin-right: 8px;
}

@media (max-width: 640px) {
  .fm-external {
    flex-direction: column;
    gap: 2px;
    max-width: none;
  }
}</style>
