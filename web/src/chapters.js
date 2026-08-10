import ch0zh from "@book/00-start-here.md?raw";
import ch1zh from "@book/01-what-it-is.md?raw";
import ch2zh from "@book/02-end-to-end.md?raw";

import ch0en from "@book/en/00-start-here.md?raw";
import ch1en from "@book/en/01-what-it-is.md?raw";
import ch2en from "@book/en/02-end-to-end.md?raw";

import ch0es from "@book/es/00-start-here.md?raw";
import ch1es from "@book/es/01-what-it-is.md?raw";
import ch2es from "@book/es/02-end-to-end.md?raw";

const bodies = {
  zh: { "00": ch0zh, "01": ch1zh, "02": ch2zh },
  en: { "00": ch0en, "01": ch1en, "02": ch2en },
  es: { "00": ch0es, "01": ch1es, "02": ch2es },
};

/** Per-locale chapter chrome (titles). Body markdown is selected by locale. */
const meta = {
  zh: [
    {
      id: "00",
      num: 0,
      kicker: "写在前面",
      title: "从这里开始",
      subtitle: "给新来的你：一张小地图",
    },
    {
      id: "01",
      num: 1,
      title: "它是什么",
      subtitle: "一个被做成库的 agent 循环",
    },
    {
      id: "02",
      num: 2,
      title: "一次 prompt 的全程",
      subtitle: "从 prompt() 到 agent_end",
      pin: "src/agent-loop.ts:155",
    },
  ],
  en: [
    {
      id: "00",
      num: 0,
      kicker: "Before we begin",
      title: "Start here",
      subtitle: "A small map for newcomers",
    },
    {
      id: "01",
      num: 1,
      title: "What it is",
      subtitle: "An agent loop packaged as a library",
    },
    {
      id: "02",
      num: 2,
      title: "One prompt, end to end",
      subtitle: "From prompt() to agent_end",
      pin: "src/agent-loop.ts:155",
    },
  ],
  es: [
    {
      id: "00",
      num: 0,
      kicker: "Antes de empezar",
      title: "Empieza aquí",
      subtitle: "Un mapa pequeño para quienes llegan",
    },
    {
      id: "01",
      num: 1,
      title: "Qué es",
      subtitle: "Un bucle de agente empaquetado como biblioteca",
    },
    {
      id: "02",
      num: 2,
      title: "Un prompt de punta a punta",
      subtitle: "De prompt() a agent_end",
      pin: "src/agent-loop.ts:155",
    },
  ],
};

export function getChapters(locale = "zh") {
  const list = meta[locale] ?? meta.zh;
  const md = bodies[locale] ?? bodies.zh;
  return list.map((c) => ({
    ...c,
    md: md[c.id],
  }));
}

export function getChapter(id, locale = "zh") {
  return getChapters(locale).find((c) => c.id === id);
}
