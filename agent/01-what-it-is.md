# 第 1 章 · 它是什么：一个被做成库的 agent 循环

## 从一个场景开始

你在写一个应用，想在里面嵌入一个能"自己干活"的 AI agent：你给它一句话，它调模型，模型说要调工具，它执行工具，把结果喂回模型，如此往复，直到模型说"完了"。中间每一步你都想实时看到——文字是一个字一个字流出来的，工具是一个一个执行的——因为你要把这些渲染到 UI 上。

这就是 `pi-agent-core` 要解决的全部问题。它的 README 用一句话概括："Stateful agent with tool execution and event streaming"（`README.md:2`）。

拆开看，它给你三样东西：

1. **一个 agent 循环**（`src/agent-loop.ts`）：prompt 进来，事件流出去，中间是"调模型 → 执行工具 → 再调模型"的往复。
2. **一层状态**（`src/agent.ts`）：`Agent` 类替你持有对话历史、当前正在流的消息、正在执行的工具，让你在任意时刻都能回答"它现在到哪一步了"。
3. **一套装备**（`src/harness/`）：持久化会话、上下文压缩、内置的文件/shell 工具、skill 加载——把"能跑的循环"变成"能上线 coding agent 的循环"。

## 它拒绝做什么

理解一个库，边界和能力同样重要。`pi-agent-core` 有四条明确的拒绝，每一条都能从代码里核实。

**拒绝一：不认识任何模型厂商。** 全仓库搜不到一个 provider 的名字。循环拿到的模型接口是一个函数类型：

```typescript
// src/types.ts:28
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

它只约定形状：给我 `Model` 和 `Context`，还我一个事件流。谁来提供这个函数？隔壁的 `@earendil-works/pi-ai`——那是另一个包，有自己的 provider 目录和模型元数据。本包对它的唯一依赖就是这几个类型。

**拒绝二：不碰 UI。** 包里没有一行渲染代码。它对外沟通的方式只有一种：发事件。全部事件就是一个可辨识联合，十种：

```typescript
// src/types.ts:422
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; /* ... */ }
	| { type: "tool_execution_end"; /* ... */ };
```

文字流、工具进度、生命周期，全在这十种里。你想画成终端、网页还是日志文件，是你的事。

**拒绝三：核心不做持久化。** `Agent` 类的对话历史就是一个内存数组：

```typescript
// src/agent.ts:71
let tools = initialState?.tools?.slice() ?? [];
let messages = initialState?.messages?.slice() ?? [];
```

进程退出，一切归零。持久化存在，但它在 harness 层（第 9 章），而且是"追加条目到树"的模型——核心循环对此一无所知。

**拒绝四：核心不碰运行时 API。** 在 `src/` 根目录的七个文件里，没有任何 `node:fs`、`node:child_process`。全部文件和 shell 访问都被逼到一个接口后面（`ExecutionEnv`，第 3 章细讲），唯一的 Node 实现被隔离在 `harness/env/nodejs.ts`。

`package.json` 的 `exports` 字段把这个边界切成了三个公开面：

```json
// package.json — exports（删减）
".":                              "./dist/index.js",
"./node":                         "./dist/node.js",
"./experimental":                 "./dist/experimental.js",
"./experimental/session/testing": "./dist/harness/experimental/session/testing/index.js"
```

| 入口 | 内容 | 隐含承诺 |
|---|---|---|
| `.` | 核心层 + harness 几乎全部 | 不含任何 `node:*` import，浏览器可跑 |
| `./node` | `NodeExecutionEnv` | 唯一的 Node 绑定，显式 opt-in |
| `./experimental` | `experimental/session/` | 进行中，契约可以变 |

这个切分不是打包便利，是架构声明：**"哪部分代码敢碰运行时 API"被提升到了包边界的高度**。主入口能给浏览器用这件事，不靠文档自觉，靠的是 `node:fs` 在整个主入口的依赖闭包里物理不存在——这不是修辞：全包（测试除外）import 了 `node:*` 的文件只有一个，就是它：

```typescript
// src/harness/env/nodejs.ts:1（import 块，删减：另外五行 node:* 与 ../types.ts）
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
```

所以这个包的核心可以跑在浏览器里——`src/proxy.ts` 就是为此准备的。

## 拒绝的另一面：模型、存储、运行时

四条拒绝里的三条，都留下了一个可以整个换掉的位置，替换方式各不相同：

1. **streamFn**：循环对模型层的全部依赖是一个函数形状（本章「拒绝一」引过，`src/types.ts:28`）。换 provider 库、换代理、换 mock，都是传一个不同的函数进来。这是"注入替换"。
2. **Session 后端**：契约是一个接口，五个方法：

```typescript
// src/harness/session/repository.ts:22
export interface SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> extends AsyncDisposable {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}
```

仓库里自带 JSONL 和内存两个实现，experimental 里还有一套 conformance 测试用来验收第三方后端（第 14 章）。这是"接口替换"。

3. **ExecutionEnv**：所有文件/shell 操作的能力接口（第 3 章细讲）。Node 实现是一种，浏览器里可以换成远程执行环境。这是"能力替换"。

三种替换方式对应三种耦合强度：函数注入最松（每次调用都可以换），接口实现居中（构造时定），能力接口最重（整个工具层的行为都建立在它上面）。

## 一个循环：两种组合

这个包最容易产生的误解是：`Agent` 类和 `AgentHarness` 类是什么关系？继承？包装？

都不是。看依赖方向：

```
agent-loop.ts  (runAgentLoop —— 无状态循环，792 行)
    ▲                    ▲
    │                    │
agent.ts           harness/agent-harness.ts
(Agent 类,         (AgentHarness 类,
 588 行)            1185 行)
```

`Agent` 和 `AgentHarness` **都直接调用 `runAgentLoop`**，它们彼此之间没有调用关系。`Agent` 这一侧：

```typescript
// src/agent.ts:409（Agent.runPromptMessages 内）
private async runPromptMessages(
	messages: AgentMessage[],
	options: { skipInitialSteeringPoll?: boolean } = {},
): Promise<void> {
	await this.runWithLifecycle(async (signal) => {
		await runAgentLoop(
			messages,
			this.createContextSnapshot(),
			this.createLoopConfig(options),
			(event) => this.processEvents(event),
			signal,
			this.streamFunction,
		);
	});
}
```

`AgentHarness` 这一侧：

```typescript
// src/harness/agent-harness.ts:658（AgentHarness.executeTurn 内）
return await runAgentLoop(
	messages,
	this.createContext(turnState, beforeResult?.systemPrompt),
	this.createLoopConfig(getTurnState, setTurnState),
	(event) => this.handleAgentEvent(event, signal),
	signal,
	this.createStreamFn(getTurnState),
);
```

注意两段调用的形状几乎一样——上下文、循环配置、事件回调、信号、流函数——但参数的来源完全不同：`Agent` 给的是内存快照，`AgentHarness` 给的是 per-turn 快照（`turnState`）。`AgentHarness` 不是 `Agent` 的子类，也不是它的包装：它是同一循环原语之上的另一层组合，只是组合进去的东西多得多——持久化、压缩、hook、大操作之间的互斥门禁。

为什么要并存两层？因为它们的"重"不一样。嵌入一个聊天面板，用 `Agent` 就够；造一个 coding agent，用 `AgentHarness`。循环本体只有一份，这是这个包结构上的第一美德：**复杂功能是组合出来的，不是循环变复杂了。**

## 文件图：整个包的全貌

上一节看了三层骨架，现在把镜头再拉远一档，看一下整个架构的文件图。这张图画的是**逻辑关系**：有哪些模块、各属于哪一层。名字有些你已经见过（`Agent`、`runAgentLoop`、`StreamFn`），有些还没有（session、compaction、tools）。下一章跟着一次调用跑完全程，你就会看到它们具体有什么用了。

```diagram-filemap
                        ┌─────────────────────────┐
                        │   @earendil-works/pi-ai │  (另一个包：provider、Model 类型)
                        └───────────┬─────────────┘
                                    │ 只有类型 + StreamFn 形状
        ┌───────────────────────────┼───────────────────────────┐
        │                           ▲                           │
        │  ┌──────────────────────────────────────┐             │
        │  │ 核心层（src/ 根目录，~2.3k 行）        │             │
        │  │  types.ts ── 类型定义                 │             │
        │  │  agent-loop.ts ── 无状态循环          │             │
        │  │  agent.ts ── Agent 类（存储状态，负责 run 的收尾逻辑）  │             │
        │  │  stream-fn.ts / proxy.ts             │             │
        │  └───────▲──────────────────▲────────────┘             │
        │          │                  │                          │
        │  ┌───────┴──────────────────┴────────────┐             │
        │  │ harness 层（src/harness/，~10k 行）     │             │
        │  │  agent-harness.ts ── AgentHarness      │             │
        │  │  types.ts ── harness 的类型定义           │             │
        │  │  messages.ts ── 自定义消息角色          │             │
        │  │  session/ ── 持久化（entry 树 + JSONL） │             │
        │  │  compaction/ ── 上下文压缩              │             │
        │  │  tools/ ── 内置的四个基本工具                  │             │
        │  │  skills.ts / prompt-templates.ts      │             │
        │  │  env/nodejs.ts ── 唯一的 Node 实现      │  ← ./node   │
        │  │  experimental/session/ ── v2 版本的持久化会话   │  ← ./experimental │
        │  └──────────────────────────────────────┘             │
        └───────────────────────────────────────────────────────┘
```

（箭头为 import 方向，指向被依赖的一方——这个方向本身的规律，是下一节的事。）

主入口的导出列表就是这张图的目录——核心三件套打头，然后是 harness 的各子模块按名导出，`./node` 和 `./experimental` 的内容刻意不在其中：

```typescript
// src/index.ts:1（删减）
export * from "./agent.ts";
export * from "./agent-loop.ts";
export * from "./harness/agent-harness.ts";
export * from "./harness/messages.ts";
export { JsonlSessionRepository, /* ... */ } from "./harness/session/jsonl-repo.ts";
export * from "./harness/skills.ts";
export * from "./harness/tools/index.ts";
export * from "./harness/types.ts";
export * from "./proxy.ts";
export * from "./types.ts";
```

## 解耦：core 不认识 harness

上一节是逻辑图，回答"有什么"；这一节只看 **import 关系**，回答"谁依赖谁"（外部包略去）：

```diagram-deps
核心层                                   harness 层

types.ts   ◀╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  harness/types.ts
            （harness 引核心类型：import type 经出口桶，编译后擦除）
   ▲                                        ▲
stream-fn.ts                             session/ · compaction/ · tools/
   ▲                                        ▲
agent-loop.ts  ◀━━━━━━━━━━━━━━━━━━━━━━━  agent-harness.ts
                （从核心层值导入的只有 runAgentLoop 这一个函数）
   ▲
agent.ts
（循环的一种包装）
```

两片叶子没画进去：`env/nodejs.ts` 和 `experimental/` 只被各自的入口文件（`node.ts` / `experimental.ts`）引用——主入口的依赖闭包里，它们物理不存在。

依赖图近乎一棵树，而且**箭头全部指向上游**。两处细节值得停顿：

- `harness/types.ts` 引核心类型走的是 `../index.ts` 出口桶，而且是 `import type`——编译后整行擦除，运行时不构成依赖。harness 内部也只碰核心的公共面：

```typescript
// src/harness/types.ts:12
import type {
	AgentEvent,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AgentToolUpdateCallback,
	QueueMode,
	ThinkingLevel,
} from "../index.ts";
```

- session、compaction、tools 三个子目录**互不 import**——任何要共享的东西都得先上浮到 `harness/types.ts`，横向依赖被这个枢纽收拢。

两个方向性的事实，现在可以给证据了。

**harness 里没有任何文件 import `agent.ts`。** 「一个循环：两种组合」从调用关系证明了两个类互不依赖；import 关系上的证据更直接——`AgentHarness` 自己的 import 块，从核心层拿的值只有一个 `runAgentLoop`，其余全在自己目录里：

```typescript
// src/harness/agent-harness.ts:11（import 块，删减：pi-ai 与两处 type 导入；值导入全引）
import { runAgentLoop } from "../agent-loop.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { formatSkillInvocation } from "./skills.ts";
import { AgentHarnessError, /* ... */, toError } from "./types.ts";
```

反面也可以自己验证：在整个 `src/harness/` 里 grep `from "../agent.ts"`，零命中。

**`agent.ts` 也不知道 harness 的存在。** 上层依赖下层，下层对上层一无所知。想删掉整个 harness 目录，核心层一个 import 都不用改——`src/index.ts` 的导出列表除外。

## 一章小结

- `pi-agent-core` 是一个 agent 循环库：循环、状态、装备三层。
- 它不认识模型厂商、不碰 UI、核心不做持久化、核心不碰运行时 API。
- `Agent` 和 `AgentHarness` 是同一循环原语上的两层组合，互不依赖。
- 三个 export 入口声明了运行时边界：主入口无 `node:*`，Node 绑定显式 opt-in，实验品单独隔离。
- streamFn、Session 后端、ExecutionEnv 是三个可替换点，对应注入、接口、能力三种替换方式。
- 依赖图近乎一棵树，箭头全部朝上游：`types.ts` 是地基，循环在其上，两个状态类并排，harness 各子模块只横向共享 `harness/types.ts`。

下一章我们不再谈定位，跟着一次真实的 `prompt()` 调用，把循环从头到尾走一遍。

## 为什么不去

> **为什么不直接依赖 pi-ai？** `src/stream-fn.ts` 给出了答案的雏形。宿主可以安装一个默认流函数：
>
> ```typescript
> // src/stream-fn.ts:5
> /**
>  * Configure the fallback used by Agent and low-level loops when callers omit streamFn.
>  *
>  * Hosts that provide a default model runtime can install its stream function here
>  * without making pi-agent-core depend on a provider catalog or compatibility layer.
>  */
> export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
> 	defaultStreamFn = streamFn;
> }
> ```
>
> 注释写明了动机（`src/stream-fn.ts:9`）：模型目录是会膨胀的（每家厂商、每个模型、每项定价），而循环的契约只需要一个函数形状。依赖一个类型，而不是依赖一个目录，这就是 `StreamFn` 存在的原因。

> **为什么不让 AgentHarness 继承或包装 Agent？** 一旦那样做，`Agent` 的每个架构决策就都进了 harness ：消息只活在内存数组里，进程退出就没了；每个事件要等订阅者逐个 await 才算完；每次运行都绑死一个 AbortController。而 harness 要的恰恰是另一套：消息要从 session 树投影（第 9 章），事件要先落盘再分发，跑 turn、压缩、切分支这些操作同一时刻只放行一个（一个 `phase` 字段当互斥锁：非 `idle` 就拒）。两套生命周期的重量差得太远，继承是把它们焊死，组合才能有各自的 complexity——`agent-loop.ts` 停在 792 行，harness 自由长到 10k 行。`docs/agent-harness.md` 给它的定位也是这个："the orchestration layer above the low-level agent loop"——循环之上的编排层，自带一整个生命周期。
