<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README.es.md">Español</a>
</p>

# Pi Agent

一本中文架构书的工作区。对象是 [pi](https://github.com/earendil-works/pi) 仓库的 `packages/agent`。

> 一个 agent 循环，被做成一个库。

这本书从代码出发，讲清楚 `@earendil-works/pi-agent-core` 是怎么搭起来的：它承诺什么、拒绝什么、支点在哪里。全书对应 pi 仓库 main 分支的 commit `cd20a8d2e`。代码引用写成 `文件:行号`，每个引用就地附上引文——读者不需要打开编辑器，就能核对书里任何一处论断。

**多语言：** 中文原稿在 [`agent/`](agent/README.md)（唯一内容源头）。英文与西班牙文译本在 [`agent/en/`](agent/en/README.md) 与 [`agent/es/`](agent/es/README.md)。Web 阅读器右上角可切换语言。

## 阅读方式

| 方式 | 入口 | 适合场景 |
| --- | --- | --- |
| 🌐 Web 在线版 | [books.antinomie.org/pi](https://books.antinomie.org/pi) | 沉浸式阅读，代码引文高亮；可切换中 / EN / ES |
| 📥 Markdown 版 | [agent/](agent/README.md) · [en](agent/en/README.md) · [es](agent/es/README.md) | 下载到本地，配合 AI（Claude / Cursor 等）边读边问、对照源码 |

## 读者假设

你会读 TypeScript，知道 LLM API 的基本概念（messages、tool calls、streaming），不需要事先了解 pi 仓库。

## 组织方式

**整体 → 局部 → 横切。**

- **第一部分 · 整体**（已发布两章）：建立对整个系统的正确认知，不碰实现细节。读完这部分，你应该能凭记忆把这个系统画出来。
- **第二部分 · 局部**：逐个部件展开，顺序是依赖顺序——每章只依赖它前面的章。
- **第三部分 · 横切**：处理那些不属于任何单一部件的问题。

目录只列已发布的章节，后续章节随写随添。

## 工作区布局

- `agent/` —— 书的原稿（中文），**唯一的内容源头**。译本在 `agent/en/`、`agent/es/`。可见 [agent/README.md](agent/README.md) 与 [agent/TRANSLATION.md](agent/TRANSLATION.md)。
- `web/` —— 阅读器（Vite + Vue）。渲染 `agent/` 下的中文原稿与译本，不存放正文内容。

  ```bash
  cd web && npm install && npm run dev
  ```

## 体例

引文规则、三种卡片组件（插叙 / 岔路 / 为什么不去），范围之外，都写在 [agent/README.md](agent/README.md) 的「体例」一节。
