import ch0 from "@book/00-start-here.md?raw";
import ch1 from "@book/01-what-it-is.md?raw";
import ch2 from "@book/02-end-to-end.md?raw";

export const chapters = [
  {
    id: "00",
    num: 0,
    kicker: "写在前面",
    title: "从这里开始",
    subtitle: "给新来的你：一张小地图",
    md: ch0,
  },
  {
    id: "01",
    num: 1,
    title: "它是什么",
    subtitle: "一个被做成库的 agent 循环",
    md: ch1,
  },
  {
    id: "02",
    num: 2,
    title: "一次 prompt 的全程",
    subtitle: "从 prompt() 到 agent_end",
    md: ch2,
    // the runLoop skeleton is the chapter's most re-referenced listing —
    // pin it by default so its commentary can be read against it
    pin: "src/agent-loop.ts:155",
  },
];

export function getChapter(id) {
  return chapters.find((c) => c.id === id);
}
