# Reading the architecture of pi-agent-core

An agent loop, packaged as a library.

> Source: [中文](../README.md) · Sibling: [Español](../es/README.md). Chinese is the sole content source; translation conventions are in [TRANSLATION.md](../TRANSLATION.md).

This book starts from the code and explains how `@earendil-works/pi-agent-core` is put together: what it promises, what it refuses, and where its fulcrums are.

> **Baseline: commit `cd20a8d2e` (main, v0.83.0+219)**
>
> The whole book tracks this commit on the pi repository's main branch. Code citations are written as `file:line`, with paths relative to `packages/agent/`. Line numbers drift as the code evolves; trust the file contents.

## Assumptions about the reader

You can read TypeScript and know the basic ideas of an LLM API (messages, tool calls, streaming). You do not need prior familiarity with the pi repository.

## How the book is organized

**Whole → parts → cross-cutting.**

Part One builds a correct mental model of the whole system, without touching implementation detail. Part Two unfolds each component in dependency order—each chapter depends only on the ones before it. Part Three takes up questions that belong to no single component.

### Part One · The whole

When you finish these three chapters, you should be able to draw the system from memory.

0. [Start here](00-start-here.md)
1. [What it is: an agent loop packaged as a library](01-what-it-is.md)
2. [One prompt, end to end: from prompt() to agent_end](02-end-to-end.md)

### Part Two · The parts

(In progress; chapters appear as they are written)

### Part Three · Cross-cutting

(In progress)

## Conventions

The main text only says what can be read out of the code. Citations are uniformly written as `file:line`, and **every `file:line` citation is accompanied, right there, by the corresponding code excerpt**—you never need to open an editor to check a reference.

Outside the main text, three structures recur throughout the book:

- **Aside** (`###` level, within a chapter): fills in background you may be missing but that has nothing to do with pi itself—platform API patterns, LLM message shapes. Skipping them does not break the main line.
- **Detour** (`###` level, within a chapter): a self-contained side branch folded out of a main-text citation, expanded here. It is part of the main line; only its place on the page is deferred. Detours can hold material denser than the chapter's average—precisely because they are skippable, the over-dense paragraphs live in Detours.
- **Why not** (end of chapter): uses design docs or git history from the repository to answer "why wasn't this written more simply?"

## Out of scope

- The internals of `packages/ai` (provider directories, model metadata)—this book treats it only as "a downstream that implements the `StreamFn` contract."
- `packages/tui`, `packages/coding-agent`—they are consumers of this library, not the protagonists of this book.
- `docs/harness.md` (the v1 design doc) has been explicitly deprecated by the repository; it appears only in historical footnotes.
