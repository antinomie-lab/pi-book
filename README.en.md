<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README.es.md">Español</a>
</p>

# Pi Agent

A workspace for a Chinese architecture book about `packages/agent` in the [pi](https://github.com/earendil-works/pi) repository.

> An agent loop, packaged as a library.

This book starts from the code and explains how `@earendil-works/pi-agent-core` is put together: what it promises, what it refuses, and where the fulcrums are. The whole book tracks pi's `main` branch at commit `cd20a8d2e`. Code citations use the `file:line` form, each with an inline quotation—so readers can verify any claim without opening an editor.

**Languages:** The Chinese manuscript lives in [`agent/`](agent/README.md) and is the sole content source. English and Spanish translations live in [`agent/en/`](agent/en/README.md) and [`agent/es/`](agent/es/README.md). The language switcher is in the top-right corner of the web reader.

## Ways to read

| Format | Entry | Best for |
| --- | --- | --- |
| 🌐 Web reader | [books.antinomie.org/pi](https://books.antinomie.org/pi) | Immersive reading with highlighted code citations; switchable between ZH / EN / ES |
| 📥 Markdown | [agent/](agent/README.md) · [en](agent/en/README.md) · [es](agent/es/README.md) | Downloading locally to read alongside the source and ask questions with AI tools such as Claude or Cursor |

## Reader assumptions

You can read TypeScript and know the basic concepts of LLM APIs—messages, tool calls, and streaming. You do not need prior familiarity with the pi repository.

## Organization

**Whole → parts → cross-cutting.**

- **Part One · The whole** (two chapters published): builds a correct mental model of the entire system without touching implementation details. When you finish this part, you should be able to draw the system from memory.
- **Part Two · The parts**: unfolds each component in dependency order—each chapter depends only on the ones before it.
- **Part Three · Cross-cutting**: takes up questions that belong to no single component.

The table of contents lists only published chapters. Later chapters will be added as they are written.

## Workspace layout

- `agent/` — the Chinese manuscript and **sole content source**. Translations live in `agent/en/` and `agent/es/`. See [agent/README.md](agent/README.md) and [agent/TRANSLATION.md](agent/TRANSLATION.md).
- `web/` — the reader (Vite + Vue). It renders the Chinese manuscript and translations under `agent/` and stores no prose of its own.

  ```bash
  cd web && npm install && npm run dev
  ```

## Conventions

Citation rules, the three card components (Aside / Detour / Why not), and the book's out-of-scope topics are documented in the “Conventions” section of [agent/en/README.md](agent/en/README.md).
