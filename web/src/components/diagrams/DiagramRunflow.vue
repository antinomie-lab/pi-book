<script setup>
/* diagram-runflow — the call-flow figure of chapter 02. The chapter's
 * skeleton is two nested loops, and the site's vocabulary is the circle,
 * so the figure draws what the ASCII cannot: runLoop as a ring. One lap
 * of the ring = one turn; the four decision gates ascend the left side;
 * a follow-up "yes" takes the outer arc for another lap. The blue bead
 * rides at streamFn, echoing the chapter head's orbiting bead. */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useLocale } from "../../i18n/locale.js";

const { t, locale } = useLocale();
const rf = computed(() => t.value.runflow ?? {});

const CX = 340;
const CY = 270;
const R = 105;

/* θ in degrees, 0 = top, clockwise (the flow's direction) */
function pol(deg, r = R) {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

function pt(deg, r = R) {
  return pol(deg, r).map((n) => n.toFixed(1)).join(",");
}

/* arrowheads on the circumference, tangent to the ring. NOTE the
 * rotation is θ, not θ+90: with y down and θ measured clockwise from
 * the top, the flow's tangent is (cosθ, sinθ) — rotate() uses the same
 * convention. (+90 produced heads parked across the ring like ticks.) */
const RING_HEADS = [47, 105, 170, 215, 355].map((deg) => {
  const [x, y] = pol(deg);
  return { x: x.toFixed(1), y: y.toFixed(1), rot: deg };
});

const [sx, sy] = pol(70); // streamFn station
const [tx, ty] = pol(140); // tools station
const [ex, ey] = pol(200); // turn_end station
const GATES = [
  { name: "prepareNextTurn?", deg: 230 },
  { name: "shouldStopAfterTurn?", deg: 258 },
  { name: "steering?", deg: 288 },
  { name: "follow-up?", deg: 318 },
].map((g) => {
  const [x, y] = pol(g.deg);
  return { ...g, x: x.toFixed(1), y: y.toFixed(1) };
});

const outerArcStart = pt(318, 125);

/* the corridor down from the entry chain hugs the chain's end — the
 * chain's width varies by locale, so measure it rather than guess */
const chainRef = ref(null);
const dropX = ref(622);

async function measureChain() {
  await nextTick();
  const el = chainRef.value;
  if (el) {
    const b = el.getBBox();
    dropX.value = Math.ceil(b.x + b.width) + 10;
  }
}

onMounted(measureChain);
watch(locale, measureChain);
</script>

<template>
  <figure class="runflow">
    <svg viewBox="0 0 710 460" role="img" aria-label="runLoop call flow">
      <defs>
        <marker
          id="rf-head"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>

      <!-- entry chain: prompt() → … → runAgentLoop, then down the right
           corridor and into the ring -->
      <text class="rf-chain" x="60" y="52" ref="chainRef"
        >prompt()<tspan class="rf-a"> → </tspan>runPromptMessages<tspan class="rf-a"> → </tspan>runWithLifecycle<tspan class="rf-a"> → </tspan
        ><tspan class="rf-key">runAgentLoop</tspan><tspan class="rf-n">{{ rf.snapAssembly }}</tspan>
      </text>
      <path
        class="rf-edge"
        :d="`M ${dropX} 62 V 172 H 390`"
        marker-end="url(#rf-head)"
      />

      <!-- the ring itself = runLoop -->
      <circle :cx="CX" :cy="CY" :r="R" class="rf-ring" />
      <path
        v-for="h in RING_HEADS"
        :key="h.rot"
        class="rf-head"
        d="M0,-4 L7,0 L0,4 z"
        :transform="`translate(${h.x},${h.y}) rotate(${h.rot})`"
      />

      <!-- the outer arc: follow-up says yes → another lap -->
      <path
        class="rf-edge"
        :d="`M ${outerArcStart} A 125 125 0 0 1 ${CX},${CY - 125}`"
        marker-end="url(#rf-head)"
      />
      <text class="rf-note" x="283" y="146" text-anchor="end">{{
        rf.outerLap
      }}</text>

      <!-- stations on the ring -->
      <circle :cx="sx" :cy="sy" r="5" class="rf-bead" />
      <text class="rf-label" :x="sx + 16" :y="sy + 4"
        >streamFn<tspan class="rf-n">{{ rf.streaming }}</tspan></text
      >
      <text class="rf-sub" :x="sx + 16" :y="sy + 20"
        >transformContext → convertToLlm</text
      >

      <circle :cx="tx" :cy="ty" r="3" class="rf-dot" />
      <text class="rf-label" :x="tx + 10" :y="ty + 24"
        >prepare → execute → finalize</text
      >
      <text class="rf-sub" :x="tx + 10" :y="ty + 40">{{ rf.toolPipeline }}</text>

      <circle :cx="ex" :cy="ey" r="3" class="rf-dot" />
      <text class="rf-label" :x="ex - 10" :y="ey + 8" text-anchor="end"
        >turn_end</text
      >

      <!-- the four decision gates, ascending -->
      <g v-for="g in GATES" :key="g.name">
        <circle :cx="g.x" :cy="g.y" r="3.5" class="rf-gate" />
        <text
          class="rf-label"
          :x="g.x - 11"
          :y="Number(g.y) + 4"
          text-anchor="end"
          >{{ g.name }}</text
        >
      </g>

      <!-- the ring's name and unit -->
      <text class="rf-center" :x="CX" :y="CY - 4" text-anchor="middle"
        >runLoop</text
      >
      <text class="rf-sub" :x="CX" :y="CY + 16" text-anchor="middle">{{
        rf.centerSub
      }}</text>

      <!-- exit: every gate said no — the drop arrow itself is the "→",
           so the chain centres under it without a leading glyph (long
           locales would overflow the viewBox otherwise) -->
      <path class="rf-edge" d="M 340 380 V 414" marker-end="url(#rf-head)" />
      <text class="rf-chain" x="340" y="438" text-anchor="middle"
        >agent_end<tspan class="rf-a"> → </tspan
        >{{ rf.awaitListeners }}<tspan class="rf-a"> → </tspan>finishRun</text
      >
    </svg>
  </figure>
</template>

<style scoped>
.runflow {
  margin: 36px 0 28px;
  user-select: none;
}

.runflow svg {
  display: block;
  width: 100%;
  height: auto;
}

.rf-ring {
  fill: none;
  stroke: var(--ink-faint);
  stroke-width: 1.5;
}

.rf-edge {
  fill: none;
  stroke: var(--ink-faint);
  stroke-width: 1.5;
}

.rf-head {
  fill: var(--ink-faint);
}

.rf-chain,
.rf-label {
  font-family: var(--mono);
  font-size: 12px;
  fill: var(--ink-soft);
}

.rf-chain {
  font-size: 12.5px;
}

.rf-a {
  fill: var(--ink-faint);
  padding: 0 0.35em;
}

.rf-n {
  fill: var(--ink-faint);
}

.rf-note,
.rf-sub {
  font-family: var(--sans);
  font-size: 10.5px;
  fill: var(--ink-faint);
}

.rf-sub {
  font-family: var(--mono);
}

.rf-key {
  fill: var(--accent);
}

/* the bead rides at streamFn — the loop's heartbeat, in the site's blue */
.rf-bead {
  fill: var(--accent);
}

.rf-dot {
  fill: var(--ink-soft);
}

/* gates are questions — hollow, not solid */
.rf-gate {
  fill: var(--paper);
  stroke: var(--ink-soft);
  stroke-width: 1.2;
}

.rf-center {
  font-family: var(--mono);
  font-size: 13.5px;
  font-weight: 700;
  fill: var(--ink);
}
</style>
