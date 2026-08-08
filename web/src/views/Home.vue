<script setup>
import { chapters } from "../chapters";

const PI_DIGITS = "3.14159265358979323846264338327950288";
</script>

<template>
  <main class="home">
    <!-- repo link, top-right — same ring vocabulary as the brand mark -->
    <a
      href="https://github.com/antinomie-lab/pi-book"
      class="repo-link"
      target="_blank"
      rel="noopener"
      title="GitHub 仓库"
      aria-label="GitHub 仓库"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        />
      </svg>
    </a>

    <!-- concentric rings, the orbit of the agent loop -->
    <div class="ring ring-1 orbit-slow"></div>
    <div class="ring ring-2 orbit"></div>
    <div class="ring ring-3 ring-accent orbit"></div>
    <div class="ring ring-4"></div>

    <section class="hero rise">
      <p class="kicker">pi-agent-core · 源码导读</p>
      <h1 class="title">
        <span class="pi-glyph">π</span>-agent
        <em>book</em>
      </h1>
      <p class="lede">
        它不是 LangChain。<br />
        一个拒绝成为框架的 agent 循环。<br />
        模块即积木，组合即架构。
      </p>
      <p class="digits" aria-hidden="true">{{ PI_DIGITS }}</p>
    </section>

    <nav class="toc">
      <RouterLink
        v-for="c in chapters"
        :key="c.id"
        :to="`/chapter/${c.id}`"
        class="toc-item"
      >
        <span class="toc-num">
          <svg viewBox="0 0 72 72" class="toc-ring" aria-hidden="true">
            <circle cx="36" cy="36" r="33" class="toc-ring-bg" />
            <circle cx="36" cy="36" r="33" class="toc-ring-arc" />
          </svg>
          <span class="toc-num-text">{{ c.id }}</span>
        </span>
        <span class="toc-meta">
          <span class="toc-title">{{ c.title }}</span>
          <span class="toc-sub">{{ c.subtitle }}</span>
        </span>
        <span class="toc-arrow">→</span>
      </RouterLink>
    </nav>

    <footer class="colophon">
      <span>预览版 · 已收录 2 章 · 持续更新中</span>
    </footer>
  </main>
</template>

<style scoped>
.home {
  position: relative;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px 48px;
  overflow: hidden;
}

/* --- repo link (top-right, mirrors the chapter-page brand position) --- */
.repo-link {
  position: absolute;
  top: 18px;
  right: 32px;
  z-index: 10;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1.5px solid var(--ink);
  border-radius: 50%;
  color: var(--ink);
  transition:
    background 0.3s,
    color 0.3s,
    transform 0.3s;
}

.repo-link svg {
  width: 17px;
  height: 17px;
  fill: currentColor;
}

.repo-link:hover {
  background: var(--ink);
  color: var(--paper);
  transform: rotate(180deg);
}

/* --- rings --- */
.ring-1 {
  width: 140vmin;
  height: 140vmin;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
}
.ring-2 {
  width: 96vmin;
  height: 96vmin;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  border-style: dashed;
}
.ring-3 {
  width: 62vmin;
  height: 62vmin;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  border-width: 2px;
  animation-direction: reverse;
}
.ring-4 {
  width: 20vmin;
  height: 20vmin;
  top: 12%;
  right: 8%;
}

/* --- hero --- */
.hero {
  position: relative;
  text-align: center;
  max-width: 640px;
}

.kicker {
  font-size: 12px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 28px;
}

.title {
  font-family: var(--serif);
  font-size: clamp(48px, 9vw, 92px);
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.01em;
}

.title em {
  display: block;
  font-style: normal;
  font-size: 0.32em;
  letter-spacing: 0.5em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-top: 12px;
  font-family: var(--sans);
  font-weight: 400;
}

.pi-glyph {
  color: var(--accent);
}

.lede {
  margin-top: 28px;
  font-size: 17px;
  color: var(--ink-soft);
}

.digits {
  margin-top: 20px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.35em;
  color: var(--ink-faint);
  white-space: nowrap;
  overflow: hidden;
  mask-image: linear-gradient(90deg, #000 55%, transparent);
}

/* --- toc --- */
.toc {
  position: relative;
  margin-top: 72px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(520px, 100%);
}

.toc-item {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 18px 24px;
  background: var(--surface-glass);
  backdrop-filter: blur(6px);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition:
    border-color 0.3s,
    transform 0.3s,
    box-shadow 0.3s;
}

.toc-item:hover {
  border-color: var(--ink);
  transform: translateY(-3px);
  box-shadow: 0 14px 40px -18px var(--shadow);
}

.toc-num {
  position: relative;
  width: 56px;
  height: 56px;
  flex: none;
  display: grid;
  place-items: center;
}

.toc-ring {
  position: absolute;
  inset: 0;
  transform: rotate(-90deg);
}

.toc-ring-bg {
  fill: none;
  stroke: var(--line);
  stroke-width: 2;
}

.toc-ring-arc {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 207.3; /* 2πr ≈ 207.3 */
  stroke-dashoffset: 207.3;
  transition: stroke-dashoffset 0.6s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.toc-item:hover .toc-ring-arc {
  stroke-dashoffset: 0;
}

.toc-num-text {
  font-family: var(--serif);
  font-size: 20px;
}

.toc-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.toc-title {
  font-weight: 700;
  font-size: 16px;
}

.toc-sub {
  font-size: 13px;
  color: var(--ink-faint);
}

.toc-arrow {
  color: var(--ink-faint);
  transition:
    transform 0.3s,
    color 0.3s;
}

.toc-item:hover .toc-arrow {
  transform: translateX(4px);
  color: var(--accent);
}

/* --- colophon --- */
.colophon {
  position: relative;
  margin-top: 88px;
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--ink-faint);
  letter-spacing: 0.06em;
}
</style>
