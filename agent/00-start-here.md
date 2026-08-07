# 从这里开始

你好，新来的朋友。

你推门进来的地方，是一本还在写作中的书。它的主角是一个叫 pi-agent-core 的小库：它不是 LangChain，而是一个拒绝成为框架的 agent 循环——模块即积木，组合即架构。这本书想做的事只有一件：陪你把它的源码从头到尾走一遍，走到你能闭上眼睛画出它的形状。

## 这个地方怎么走

正厅不大，目前只摆了两章正文：第 1 章回答"它是什么"，第 2 章跟着一次 `prompt()` 把控制流走完全程。后面还空着很多房间，一周来一趟，就会多一章。

不用带装备，按顺序走就好。每一章都默认你读过前面——就像这一页，默认你刚刚才到。

## 路上的小机关

这条路修了一些安静的设施，不用学，遇到自然就懂。有两件藏得比较深，值得先说一声：

悬浮到任意标题上，它左边的小圆会变换月相——半月翻身，扇区转格——点它，这一节的链接就进了地址栏，可以直接分享给别人。其实不点也行：你读到哪儿，地址栏就跟到哪儿。

悬浮到代码块上，右上角会浮出一枚图钉——点它，这段代码就钉进了屏幕角落的小视窗：你往下读解读，它一直在那儿陪着；再点一次图钉，或点视窗上的 ×，它就回去了。太长的代码块还有一个脾气：悬浮停留片刻，它会自己展开到刚好读完。

口说无凭，这段就是给你试的——悬浮上来，点它的图钉：

```typescript
// 演示：点右上角的图钉，把我钉上去
async function simpleLoop(messages, model, tools) {
  while (true) {
    const response = await callModel(model, messages, tools);
    messages.push(response);
    if (response.stopReason !== "toolUse") {
      return messages;
    }
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(toolCall);
      messages.push(result);
    }
  }
}
```

还有些章节，一进门就替你钉好了一段代码——比如第 2 章的 runLoop 骨架。那不是装饰，是那一章的路标：后文的解读会反复回指它，你随时抬头就能对照，不会在长章里迷路。

如果某段话你想亲眼看看原文，点一下出处——书里的每个论断，都链回仓库里它出生的那一行。这本书自己也躺在仓库里：[`agent/00-start-here.md:42`](https://github.com/antinomie-lab/pi-book/blob/main/agent/00-start-here.md#L42)，写岔了欢迎来挑错。

## 一句嘱咐

慢慢读。这本书不赶时间，每周只长一章。

准备好了，就从这里进去：[第 1 章 · 它是什么](/chapter/01)。
