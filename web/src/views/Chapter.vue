<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import { chapters, getChapter } from "../chapters";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);

const md = new MarkdownIt({
  html: false,
  linkify: false,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch {
        /* fall through to escaped output */
      }
    }
    return "";
  },
});

/* stable, shareable heading ids — stamped at render time so deep links
 * survive later edits to the surrounding text */
function slugify(text) {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[`'"]/g, "")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "sec"
  );
}

md.core.ruler.push("heading-anchors", (state) => {
  const used = new Map();
  for (let i = 0; i < state.tokens.length; i++) {
    const t = state.tokens[i];
    if (t.type !== "heading_open") continue;
    const level = Number(t.tag.slice(1));
    if (level < 2 || level > 4) continue;
    const inline = state.tokens[i + 1];
    const base = slugify(inline?.content ?? "");
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    t.attrSet("id", n ? `${base}-${n}` : base);
  }
});

const route = useRoute();
const chapter = computed(
  () => getChapter(route.params.id) ?? chapters[0],
);
const html = computed(() => md.render(chapter.value.md));

const idx = computed(() => chapters.indexOf(chapter.value));
const prev = computed(() => chapters[idx.value - 1]);
const next = computed(() => chapters[idx.value + 1]);

/* scroll progress → circular dial (one full circumference per chapter) */
const progress = ref(0);

/* floating TOC: heading ids are stamped post-render, scroll-spy follows */
const toc = ref([]);
const activeId = ref("");

/* the full moon for h2 markers — paper-coloured craters keep the solid
 * disc from reading as a list bullet. Shared by body headings (prepended
 * into the anchor by buildToc) and the floating TOC (v-html). */
const FULL_MOON_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle class="moon-disc" cx="8" cy="8" r="7.2"/>' +
  '<circle class="moon-crater" cx="5.6" cy="6.2" r="1.6"/>' +
  '<circle class="moon-crater" cx="10.4" cy="10.4" r="1.1"/>' +
  "</svg>";

function buildToc() {
  const heads = bodyRef.value?.querySelectorAll("h2[id], h3[id], h4[id]") ?? [];
  toc.value = [...heads].map((h) => {
    // the level marker IS the anchor — a real <a> as the heading's first
    // child, so the moon-phase hover morph lives on a clickable element
    const a = document.createElement("a");
    a.className = "head-anchor";
    a.href = `#${h.id}`;
    a.title = "本节链接";
    a.setAttribute("aria-label", "本节链接");
    // h2's moon needs punched-out craters — beyond what CSS shapes can do
    if (h.tagName === "H2") a.innerHTML = FULL_MOON_SVG;
    h.prepend(a);
    return { id: h.id, text: h.textContent, level: h.tagName.toLowerCase() };
  });
}

function updateActive() {
  const y = window.scrollY + 140;
  let current = "";
  for (const item of toc.value) {
    const el = document.getElementById(item.id);
    if (el && el.offsetTop <= y) current = item.id;
  }
  // TOC highlight keeps a sensible default before the first heading…
  activeId.value = current || (toc.value[0]?.id ?? "");
  // …but the address bar mirrors the section actually under the reader's
  // eye, no click needed. replaceState: zero history entries, no scroll.
  const base = window.location.pathname + window.location.search;
  const target = current ? `${base}#${encodeURIComponent(current)}` : base;
  if (window.location.href !== new URL(target, window.location.origin).href) {
    history.replaceState(null, "", target);
  }
}

/* land on a deep link (#anchor) after the markdown has rendered */
function scrollToHash() {
  if (!route.hash) return;
  const el = document.getElementById(
    decodeURIComponent(route.hash.slice(1)),
  );
  el?.scrollIntoView({ block: "start", behavior: "instant" });
}

function onScroll() {
  const el = document.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  progress.value = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
  updateActive();
}
onMounted(() => {
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});
onUnmounted(() => window.removeEventListener("scroll", onScroll));
watch(() => route.params.id, () => onScroll());

const R = 26;
const CIRC = 2 * Math.PI * R;
const dash = computed(() => CIRC * (1 - progress.value));

/*
 * Code block expansion: only blocks whose content actually overflows the
 * column get the treatment, and only after the pointer has rested on them
 * for a beat — brushing past a block never triggers it.
 */
const EXPAND_DELAY = 260;
const bodyRef = ref(null);
const timers = new WeakMap();

/*
 * Pinned code blocks: a pin button floats on every block; pinning clones
 * the block into a fixed mini-window stack at the top-right. collapsed it
 * shows only the first lines; hovering the window expands it fully, so a
 * long listing stays consultable while its commentary scrolls by.
 */
const pinned = ref([]);
const pinnedEls = new Map(); // source <pre> -> pin id
let pinSeq = 0;

function togglePin(pre) {
  const existing = pinnedEls.get(pre);
  if (existing !== undefined) {
    unpin(existing);
    return;
  }
  const id = ++pinSeq;
  const clone = pre.cloneNode(true);
  clone.classList.remove("expanded");
  clone.querySelector(".pin-btn")?.remove();
  pinnedEls.set(pre, id);
  pinned.value.push({ id, outer: clone.outerHTML });
  pre.classList.add("pinned");
}

function unpin(id) {
  pinned.value = pinned.value.filter((p) => p.id !== id);
  for (const [el, pid] of pinnedEls) {
    if (pid === id) {
      pinnedEls.delete(el);
      el.classList.remove("pinned");
      // dismissing the chapter's default pin is remembered for the session
      if (chapter.value.pin && el.textContent.includes(chapter.value.pin))
        pinDeclined.add(chapter.value.id);
      break;
    }
  }
}

/* chapters can declare a listing to be pinned by default (the marker is a
 * substring of the block's text, e.g. its provenance comment) */
const pinDeclined = new Set();

function applyDefaultPin() {
  const marker = chapter.value.pin;
  if (!marker || pinDeclined.has(chapter.value.id)) return;
  const pre = [...bodyRef.value.querySelectorAll("pre")].find((p) =>
    p.textContent.includes(marker),
  );
  if (pre) togglePin(pre);
}

/* --- pinned card expand/collapse ---
 * Width and height are measured and transitioned in real pixels: animating
 * max-height toward an oversized 72vh target compresses the easing curve
 * into the first frames, which is what made the old CSS-only version stutter.
 */
const PIN_DWELL = 180; // ms of hover before a card starts opening
const pinTimers = new Map(); // card el -> timeout id

function onPinEnter(e) {
  const el = e.currentTarget;
  clearTimeout(pinTimers.get(el));
  pinTimers.set(
    el,
    setTimeout(() => expandPin(el), PIN_DWELL),
  );
}

function onPinLeave(e) {
  const el = e.currentTarget;
  clearTimeout(pinTimers.get(el));
  collapsePin(el);
}

function expandPin(el) {
  if (el.classList.contains("open")) return;
  // remember the resting width once — mid-collapse re-entries must not
  // capture a half-shrunk value as the resting width
  if (!el.dataset.collapsedWidth)
    el.dataset.collapsedWidth = String(el.offsetWidth);
  const pre = el.querySelector("pre");
  const codeWidth = pre ? pre.scrollWidth + 32 : el.scrollWidth; // 32 = padding
  const targetW = Math.min(codeWidth, window.innerWidth * 0.52, 900);
  const targetH = Math.min(el.scrollHeight, window.innerHeight * 0.72);
  el.classList.add("open");
  el.style.width = `${Math.max(targetW, el.offsetWidth)}px`;
  el.style.maxHeight = `${targetH}px`;
  el.addEventListener("transitionend", function done(ev) {
    if (ev.propertyName !== "max-height" || !el.classList.contains("open"))
      return;
    el.removeEventListener("transitionend", done);
    el.classList.add("settled"); // only now allow scrollbars, no mid-flight reflow
  });
}

function collapsePin(el) {
  if (!el.classList.contains("open")) return;
  el.classList.remove("open", "settled");
  el.style.maxHeight = "116px";
  el.style.width = `${el.dataset.collapsedWidth}px`;
  el.addEventListener("transitionend", function done(ev) {
    if (ev.propertyName !== "max-height" || el.classList.contains("open"))
      return;
    el.removeEventListener("transitionend", done);
    el.style.width = ""; // hand width back to the flex stack
    el.style.maxHeight = "";
    delete el.dataset.collapsedWidth;
  });
}

function onPreEnter(e) {
  const pre = e.currentTarget;
  timers.set(
    pre,
    setTimeout(() => expandPre(pre), EXPAND_DELAY),
  );
}

function onPreLeave(e) {
  const pre = e.currentTarget;
  clearTimeout(timers.get(pre));
  collapsePre(pre);
}

/*
 * measured-pixel expansion: transition from the current rendered width to
 * the longest line's width, both in px. interruptions reverse smoothly —
 * offsetWidth reads the mid-animation computed width, so a re-entry just
 * continues from wherever the block currently is.
 */
function expandPre(pre) {
  if (pre.classList.contains("expanded")) return;
  // remember the resting width once — mid-collapse re-entries must not
  // capture a half-shrunk value as the resting width
  if (!pre.dataset.restWidth) pre.dataset.restWidth = String(pre.offsetWidth);
  const target = Math.min(pre.scrollWidth, window.innerWidth - 96);
  if (target <= pre.offsetWidth + 2) return; // nothing to gain
  pre.classList.add("expanded");
  pre.style.width = `${pre.offsetWidth}px`;
  void pre.offsetWidth; // commit the start width before moving to the target
  pre.style.width = `${Math.max(target, Number(pre.dataset.restWidth))}px`;
}

function collapsePre(pre) {
  if (!pre.classList.contains("expanded")) return;
  pre.classList.remove("expanded");
  pre.style.width = `${pre.dataset.restWidth}px`;
  pre.addEventListener("transitionend", function done(ev) {
    if (ev.propertyName !== "width" || pre.classList.contains("expanded"))
      return;
    pre.removeEventListener("transitionend", done);
    pre.style.width = ""; // hand width back to the column
    delete pre.dataset.restWidth;
  });
}

function setupCodeBlocks() {
  const blocks = bodyRef.value?.querySelectorAll("pre") ?? [];
  for (const pre of blocks) {
    if (pre.closest("blockquote")) continue; // quoted code stays inside its card
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin-btn";
    pin.title = "钉在右上角";
    pin.setAttribute("aria-label", "钉在右上角");
    // thumbtack glyph: Lucide "pin" (ISC), verbatim
    pin.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(pre);
    });
    pre.appendChild(pin);
    if (pre.scrollWidth <= pre.clientWidth + 2) continue; // fits already — nothing to expand
    pre.addEventListener("mouseenter", onPreEnter);
    pre.addEventListener("mouseleave", onPreLeave);
  }
}

function teardownCodeBlocks() {
  const blocks = bodyRef.value?.querySelectorAll("pre") ?? [];
  for (const pre of blocks) {
    clearTimeout(timers.get(pre));
    pre.classList.remove("expanded");
    pre.style.width = "";
    delete pre.dataset.restWidth;
    pre.removeEventListener("mouseenter", onPreEnter);
    pre.removeEventListener("mouseleave", onPreLeave);
    pre.querySelector(".pin-btn")?.remove();
    pre.classList.remove("pinned");
  }
}

/*
 * evidence links: the book's citations become clickable, pointing at the
 * book's baseline commit on GitHub.
 * - prose inline code `src/x.ts:12` (package-relative) and
 *   `packages/…` / `docs/…` / `test/…` paths (repo-root) → blob view
 * - `// path:line` header comments inside code listings → same
 * - backticked commit hashes, `issue #N` / `PR #N` in prose → GitHub
 */
const REPO = "https://github.com/earendil-works/pi";
const BASELINE = "cd20a8d2e555fb747780c1bb00e36039657fcf35";
const SRC_PATH =
  /^(?:(packages|docs|test)\/|src\/)[\w./-]+?\.[a-z0-9]+(?::\d+(?:-\d+)?)?$/;

function blobUrl(ref) {
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
  const p = m[1].startsWith("src/") ? `packages/agent/${m[1]}` : m[1];
  const lines = m[2] ? `#L${m[2]}${m[3] ? `-L${m[3]}` : ""}` : "";
  return `${REPO}/blob/${BASELINE}/${p}${lines}`;
}

function srcLink(href, className = "src-ref") {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = className;
  return a;
}

function linkifySourceRefs(root) {
  // prose inline code: `src/agent.ts:344`, `docs/agent-harness.md:18`, hashes
  for (const code of root.querySelectorAll("code:not(pre code)")) {
    const text = code.textContent.trim();
    if (SRC_PATH.test(text)) {
      const a = srcLink(blobUrl(text));
      code.replaceWith(a);
      a.appendChild(code);
    } else if (/^[0-9a-f]{7,40}$/.test(text)) {
      // the corpus only uses bare backticked hashes for commit refs
      const a = srcLink(`${REPO}/commit/${text}`);
      code.replaceWith(a);
      a.appendChild(code);
    }
  }

  // `// path:line` comments inside highlighted listings
  const COMMENT_REF =
    /^(\/\/\s*)((?:(?:packages|docs|test)\/|src\/)[\w./-]+?\.[a-z0-9]+(?::\d+(?:-\d+)?)?)/;
  for (const span of root.querySelectorAll("pre .hljs-comment")) {
    if (span.childElementCount) continue; // only text-only comment spans
    const m = COMMENT_REF.exec(span.textContent);
    if (!m) continue;
    const a = srcLink(blobUrl(m[2]));
    a.textContent = m[2];
    span.textContent = span.textContent.slice(m[0].length);
    span.prepend(m[1], a);
  }

  // `issue #N` / `PR #N` in prose text nodes
  const ISSUE_REF = /\b(issue|PR)\s+#(\d+)\b/g;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest("pre, code, a"))
        return NodeFilter.FILTER_REJECT;
      return ISSUE_REF.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const hits = [];
  while (walker.nextNode()) hits.push(walker.currentNode);
  for (const node of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of node.nodeValue.matchAll(ISSUE_REF)) {
      frag.append(node.nodeValue.slice(last, m.index));
      const a = srcLink(
        `${REPO}/${m[1] === "PR" ? "pull" : "issues"}/${m[2]}`,
      );
      a.textContent = m[0];
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  }
}

/* "为什么不去" questions get the card + ? ring; every other blockquote
 * stays a plain quotation with a left rule */
function classifyBlockquotes(root) {
  for (const bq of root.querySelectorAll("blockquote")) {
    const first = bq.firstElementChild?.textContent.trim() ?? "";
    if (first.startsWith("为什么")) bq.classList.add("is-question");
  }
}

onMounted(() =>
  nextTick(() => {
    buildToc();
    setupCodeBlocks();
    classifyBlockquotes(bodyRef.value);
    linkifySourceRefs(bodyRef.value);
    applyDefaultPin();
    updateActive();
    scrollToHash();
  }),
);
onUnmounted(teardownCodeBlocks);
watch(html, async () => {
  teardownCodeBlocks();
  pinned.value = [];
  pinnedEls.clear();
  for (const t of pinTimers.values()) clearTimeout(t);
  pinTimers.clear();
  await nextTick();
  buildToc();
  setupCodeBlocks();
  classifyBlockquotes(bodyRef.value);
  linkifySourceRefs(bodyRef.value);
  applyDefaultPin();
  updateActive();
  scrollToHash();
});
</script>

<template>
  <main class="chapter">
    <!-- fixed circular progress dial -->
    <RouterLink to="/" class="dial" title="回到目录">
      <svg viewBox="0 0 64 64" class="dial-svg">
        <circle cx="32" cy="32" :r="R" class="dial-bg" />
        <circle
          cx="32"
          cy="32"
          :r="R"
          class="dial-arc"
          :style="{ strokeDashoffset: dash }"
        />
      </svg>
      <span class="dial-num">{{ chapter.dial ?? chapter.id }}</span>
    </RouterLink>

    <!-- pinned code blocks: mini windows, hover to fully expand -->
    <div v-if="pinned.length" class="pinned-stack">
      <div
        v-for="p in pinned"
        :key="p.id"
        class="pinned-card"
        @mouseenter="onPinEnter"
        @mouseleave="onPinLeave"
      >
        <button
          class="pinned-close"
          type="button"
          aria-label="取消钉住"
          @click="unpin(p.id)"
        >
          ×
        </button>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="pinned-body" v-html="p.outer"></div>
      </div>
    </div>

    <!-- floating table of contents -->
    <nav v-if="toc.length" class="toc-rail" aria-label="本节目录">
      <p class="toc-rail-title">目录</p>
      <a
        v-for="item in toc"
        :key="item.id"
        class="toc-link"
        :class="[item.level, { active: item.id === activeId }]"
        :href="`#${item.id}`"
      >
        <span
          class="toc-marker"
          aria-hidden="true"
          v-html="item.level === 'h2' ? FULL_MOON_SVG : ''"
        ></span>
        <span class="toc-text">{{ item.text }}</span>
      </a>
    </nav>

    <header class="chapter-head rise">
      <p class="chapter-kicker">
        {{ chapter.kicker ?? `第 ${chapter.num} 章` }}
      </p>
      <div class="chapter-head-row">
        <span class="head-circle" aria-hidden="true">
          <span class="head-circle-num">{{ chapter.dial ?? chapter.id }}</span>
          <span class="head-circle-orbit">
            <span class="head-circle-dot"></span>
          </span>
        </span>
        <div>
          <h1 class="chapter-title">{{ chapter.title }}</h1>
          <p class="chapter-sub">{{ chapter.subtitle }}</p>
        </div>
      </div>
    </header>

    <article ref="bodyRef" class="chapter-body rise" v-html="html"></article>

    <nav class="chapter-nav" aria-label="章节导航">
      <RouterLink
        v-if="prev"
        :to="`/chapter/${prev.id}`"
        class="chapter-nav-link"
      >
        <span class="nav-circle" aria-hidden="true">←</span>
        <span class="nav-meta">
          <span class="nav-kicker">
            上一章 · {{ prev.kicker ?? `第 ${prev.num} 章` }}
          </span>
          <span class="nav-title">{{ prev.title }}</span>
        </span>
      </RouterLink>
      <span v-else></span>
      <RouterLink
        v-if="next"
        :to="`/chapter/${next.id}`"
        class="chapter-nav-link next"
      >
        <span class="nav-meta">
          <span class="nav-kicker">
            下一章 · {{ next.kicker ?? `第 ${next.num} 章` }}
          </span>
          <span class="nav-title">{{ next.title }}</span>
        </span>
        <span class="nav-circle" aria-hidden="true">→</span>
      </RouterLink>
    </nav>
  </main>
</template>

<style scoped>
.chapter {
  position: relative;
  padding-top: 72px;
}

/* --- prev / next chapter ---
 * text links flanked by thin rings; the ring takes the accent on hover,
 * same vocabulary as the heading markers. */
.chapter-nav {
  max-width: 720px;
  margin: 0 auto;
  padding: 28px 24px 96px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  gap: 24px;
}

.chapter-nav-link {
  display: flex;
  align-items: center;
  gap: 14px;
  text-decoration: none;
  color: var(--ink);
}

.chapter-nav-link.next {
  margin-left: auto;
  text-align: right;
}

.nav-circle {
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1.5px solid var(--ink-faint);
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  color: var(--ink-soft);
  transition:
    border-color 0.25s,
    color 0.25s;
}

.chapter-nav-link:hover .nav-circle {
  border-color: var(--accent);
  color: var(--accent);
}

.nav-kicker {
  display: block;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--ink-faint);
}

.nav-title {
  display: block;
  margin-top: 5px;
  font-family: var(--serif);
  font-size: 18px;
  color: var(--ink);
  transition: color 0.25s;
}

.chapter-nav-link:hover .nav-title {
  color: var(--accent);
}

/* --- progress dial --- */
.dial {
  position: fixed;
  right: 28px;
  bottom: 28px;
  z-index: 60;
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  background: var(--paper-glass);
  backdrop-filter: blur(8px);
  border-radius: 50%;
  transition: transform 0.3s;
}

.dial:hover {
  transform: scale(1.08);
}

.dial-svg {
  position: absolute;
  inset: 0;
  transform: rotate(-90deg);
}

.dial-bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 2.5;
}

.dial-arc {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 163.36; /* 2π × 26 */
  transition: stroke-dashoffset 0.15s linear;
}

.dial-num {
  font-family: var(--serif);
  font-size: 18px;
}

/* --- header --- */
.chapter-head {
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 24px 0;
}

.chapter-kicker {
  font-size: 12px;
  letter-spacing: 0.3em;
  color: var(--ink-faint);
  margin-bottom: 20px;
}

.chapter-head-row {
  display: flex;
  align-items: center;
  gap: 24px;
}

.head-circle {
  position: relative;
  flex: none;
  width: 72px;
  height: 72px;
  border: 1.5px solid var(--ink);
  border-radius: 50%;
  display: grid;
  place-items: center;
}

/* chapter number at the center; the blue bead rides the circumference —
 * one full orbit = one chapter, against the fixed cores of h2 sections */
.head-circle-num {
  font-family: var(--serif);
  font-size: 20px;
  color: var(--ink);
}

.head-circle-orbit {
  position: absolute;
  inset: 0;
  animation: orbit 14s linear infinite;
}

.head-circle-dot {
  position: absolute;
  top: 0;
  left: 50%;
  translate: -50% -50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
}

.chapter-title {
  font-family: var(--serif);
  font-size: clamp(30px, 5vw, 44px);
  line-height: 1.25;
  margin: 0;
}

.chapter-sub {
  margin-top: 6px;
  color: var(--ink-soft);
  font-size: 15px;
}

/* hide the markdown's own h1 (we render our own header) */
.chapter-body :deep(h1:first-child) {
  display: none;
}

/* --- pinned code windows ---
 * collapsed: 116px keyhole onto the listing's first lines, bottom-faded.
 * expansion is JS-driven (see expandPin): width and max-height transition
 * between measured pixel values, so the easing curve spans exactly the
 * distance the card actually travels.
 */
.pinned-stack {
  position: fixed;
  top: 76px;
  right: 28px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  width: 340px;
  max-width: calc(100vw - 56px);
}

.pinned-card {
  position: relative;
  max-width: 100%;
  border-radius: 14px;
  border: 1px solid var(--line);
  background: var(--code-surface);
  box-shadow: 0 14px 36px -20px var(--shadow);
  max-height: 116px;
  overflow: hidden;
  transition:
    max-height 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    width 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.35s ease;
}

/* bottom fade — the "there is more" cue in collapsed state */
.pinned-card::after {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 40px;
  background: linear-gradient(transparent, var(--code-surface) 80%);
  pointer-events: none;
  transition: opacity 0.25s ease;
}

.pinned-card.open {
  max-width: min(52vw, 900px); /* lift the stack-width cap while open */
  box-shadow: 0 24px 64px -24px var(--shadow-strong);
}

.pinned-card.open::after {
  opacity: 0;
}

/* scrollbars appear only once the growth animation has finished */
.pinned-card.settled {
  overflow: auto;
}

.pinned-card :deep(pre) {
  margin: 0;
  border: none;
  background: transparent;
  padding: 14px 16px;
  font-size: 12px;
}

.pinned-close {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--surface-glass);
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.2s,
    color 0.2s,
    border-color 0.2s;
}

.pinned-card:hover .pinned-close {
  opacity: 1;
}

.pinned-close:hover {
  color: var(--ink);
  border-color: var(--ink);
}

@media (max-width: 900px) {
  .pinned-stack {
    display: none;
  }
}

/* --- floating TOC rail ---
 * one shape per level — h2 ring, h3 half disc, h4 quarter wedge — the
 * same vocabulary as the body headings, no composites. the active entry
 * draws a 360° orbit around its marker, once, and keeps it.
 */
.toc-rail {
  position: fixed;
  top: 50%;
  left: max(28px, calc(50% - 640px));
  transform: translateY(-50%);
  z-index: 40;
  width: 218px;
  max-height: 76vh;
  overflow-y: auto;
  padding: 4px 2px 4px 10px;
  margin-left: -8px; /* slack inside the clip edge: markers never hug it */
  font-size: 13px;
  line-height: 1.5;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

.toc-rail:hover {
  scrollbar-color: var(--line) transparent;
}

.toc-rail::-webkit-scrollbar {
  width: 4px;
}

.toc-rail::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 2px;
}

.toc-rail:hover::-webkit-scrollbar-thumb {
  background: var(--line);
}

.toc-rail-title {
  font-size: 11px;
  letter-spacing: 0.3em;
  color: var(--ink-faint);
  margin: 0 0 14px 2px;
}

.toc-link {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 5px 0;
  color: var(--ink-faint);
  transition: color 0.2s;
}

.toc-link:hover {
  color: var(--ink);
}

.toc-link.active {
  color: var(--accent);
}

.toc-link.h3 {
  padding-left: 20px;
}

.toc-link.h4 {
  padding-left: 40px;
}

.toc-marker {
  position: relative;
  flex: none;
  width: 13px;
  height: 13px;
  margin-top: 3px;
  border-radius: 50%;
  /* h3/h4 shapes are painted with backgrounds below; h2's crater moon
   * arrives as inline SVG (v-html), so its span stays transparent */
  background: currentColor;
  color: var(--toc-marker);
}

.toc-link.h2 .toc-marker {
  background: none;
}

.toc-marker :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.toc-marker :deep(.moon-disc) {
  fill: currentColor;
}

.toc-marker :deep(.moon-crater) {
  fill: var(--paper);
}

.toc-link:hover .toc-marker {
  color: var(--ink);
}

.toc-link.active .toc-marker {
  color: var(--accent);
}

/* markers are single shapes — crater moon / half disc / quarter wedge —
 * no border on filled ones: a transparent border makes the gradient tile
 * (origin padding-box + repeat) bleed and clip weirdly */
.toc-link.h3 .toc-marker {
  /* ◐ left half — the classic small-size "half circle" glyph */
  background: conic-gradient(
    transparent 0deg 180deg,
    currentColor 180deg 360deg
  );
}

/* h4: the quarter wedge, exactly as in the body headings — its straight
 * edges read as a slice of circle, where a full dot at this indent
 * would read as a list bullet */
.toc-link.h4 .toc-marker {
  background: conic-gradient(
    from -90deg,
    currentColor 0deg 90deg,
    transparent 90deg 360deg
  );
}

/* active: an accent orbit ring sweeps once around the marker, then stays */
.toc-link.active .toc-marker::after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  background: conic-gradient(
    var(--accent) 0deg var(--sweep),
    transparent var(--sweep) 360deg
  );
  -webkit-mask: radial-gradient(
    farthest-side,
    transparent calc(100% - 1.5px),
    #000 calc(100% - 1.5px)
  );
  mask: radial-gradient(
    farthest-side,
    transparent calc(100% - 1.5px),
    #000 calc(100% - 1.5px)
  );
  animation: toc-sweep 0.5s ease-out forwards;
}

@keyframes toc-sweep {
  from {
    --sweep: 0deg;
  }
  to {
    --sweep: 360deg;
  }
}

.toc-text {
  min-width: 0;
}

/* the rail needs the left whitespace — hide it when there isn't any */
@media (max-width: 1240px) {
  .toc-rail {
    display: none;
  }
}
</style>
