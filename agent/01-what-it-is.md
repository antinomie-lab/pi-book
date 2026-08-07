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

进程退出，一切归零。持久化存在，但它在 harness 层（第 10 章），而且是"追加条目到树"的模型——核心循环对此一无所知。

**拒绝四：核心不碰运行时 API。** 在 `src/` 根目录的七个文件里，没有任何 `node:fs`、`node:child_process`。全部文件和 shell 访问都被逼到一个接口后面（`ExecutionEnv`，第 4 章细讲），唯一的 Node 实现被隔离在 `harness/env/nodejs.ts`，通过单独的 `./node` 入口导出：

```json
// package.json — exports（删减）
".":              { "import": "./dist/index.js" },
"./node":         { "import": "./dist/node.js" },
"./experimental": { "import": "./dist/experimental.js" }
```

所以这个包的核心可以跑在浏览器里——`src/proxy.ts` 就是为此准备的。

## 三层而不是一层

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

注意两段调用的形状几乎一样——上下文、循环配置、事件回调、信号、流函数——但参数的来源完全不同：`Agent` 给的是内存快照，`AgentHarness` 给的是 per-turn 快照（`turnState`）。`AgentHarness` 不是 `Agent` 的子类，也不是它的包装：它是同一循环原语之上的另一层组合，只是组合进去的东西多得多——持久化、压缩、hook、phase 状态机。

为什么要并存两层？因为它们的"重"不一样。嵌入一个聊天面板，用 `Agent` 就够；造一个 coding agent，用 `AgentHarness`。循环本体只有一份，这是这个包结构上的第一美德：**复杂功能是组合出来的，不是循环变复杂了。**

## 一章小结

- `pi-agent-core` 是一个 agent 循环库：循环、状态、装备三层。
- 它不认识模型厂商、不碰 UI、核心不做持久化、核心不碰运行时 API。
- `Agent` 和 `AgentHarness` 是同一循环原语上的两层组合，互不依赖。

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
