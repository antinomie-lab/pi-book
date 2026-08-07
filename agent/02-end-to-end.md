# 第 2 章 · 一次 prompt 的全程：从 prompt() 到 agent_end

上一章说了这个包是什么。这一章不谈观点，只做一件事：跟着 `agent.prompt("读一下 config.json")` 这句调用，把控制流从头到尾走一遍。走完这一章，后面每一章的模块你都会已经见过了。

## 出发：Agent.prompt

入口是 `Agent.prompt()`：

```typescript
// src/agent.ts:344（Agent.prompt）
async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
async prompt(input: string, images?: ImageContent[]): Promise<void>;
async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
	if (this.activeRun) {
		throw new Error(
			"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
		);
	}
	const messages = this.normalizePromptInput(input, images);
	await this.runPromptMessages(messages);
}
```

它做的第一件事和 AI 无关：检查 `activeRun`。**一个 Agent 实例同一时刻只跑一个 run**——想插队，走 `steer()` 或 `followUp()` 队列，这是后话。

`prompt()` 把归一化后的消息交给 `runPromptMessages`，这里能看到后续所有准备的接线方式：

```typescript
// src/agent.ts:405（Agent.runPromptMessages）
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

注意顺序：`runWithLifecycle` 包在最外层，而 `createContextSnapshot()` 和 `createLoopConfig(options)` 是 `runAgentLoop` 的实参——它们在 executor 真正执行时才求值，也就是在生命周期建立**之后**。先看这两个实参各自准备了什么。

第一件，快照上下文：

```typescript
// src/agent.ts:433（Agent.createContextSnapshot）
private createContextSnapshot(): AgentContext {
	return {
		systemPrompt: this._state.systemPrompt,
		messages: this._state.messages.slice(),
		tools: this._state.tools.slice(),
	};
}
```

注意消息数组是**浅拷贝**——循环会往里推新消息，但替换不了调用方手里那个数组的引用。

第二件，装配循环配置（`src/agent.ts:441`）——把 `Agent` 实例上的回调和两个队列的 drain 函数打包成 `AgentLoopConfig`：

```typescript
// src/agent.ts:441（Agent.createLoopConfig，删减）
private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
	// ...
	return {
		model: this._state.model,
		reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
		// ...
		toolExecution: this.toolExecution,
		beforeToolCall: this.beforeToolCall,
		afterToolCall: this.afterToolCall,
		// ...
		convertToLlm: this.convertToLlm,
		transformContext: this.transformContext,
		getApiKey: this.getApiKey,
		getSteeringMessages: async () => {
			// ...
			return this.steeringQueue.drain();
		},
		getFollowUpMessages: async () => this.followUpQueue.drain(),
	};
}
```

两个实参准备好了。回到外层：`runWithLifecycle` 建立一个 `AbortController`、登记 `activeRun`、置 `isStreaming = true`，然后才执行 executor——也就是在上面引过的那段里，求值两个实参、调用 `runAgentLoop`：

```typescript
// src/agent.ts:482（Agent.runWithLifecycle，删减）
private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
	if (this.activeRun) {
		throw new Error("Agent is already processing.");
	}

	const abortController = new AbortController();
	let resolvePromise = () => {};
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	this.activeRun = { promise, resolve: resolvePromise, abortController };

	this._state.isStreaming = true;
	// ...
	try {
		await executor(abortController.signal);   // ← 快照、装配、runAgentLoop 都发生在这里
	} catch (error) {
		await this.handleRunFailure(error, abortController.signal.aborted);
	} finally {
		this.finishRun();
	}
}
```

### 结算与 waitForIdle：旁观者的等待

`promise`/`resolvePromise` 这三行是一个"手动引爆的 Promise"：`new Promise` 的 executor 是同步执行的，所以构造完成的瞬间，`resolvePromise` 就拿到了这个 Promise 的 resolve 函数。这个 Promise 的用途要拆成三个问题看。

**它什么时候 resolve？** 看 `runWithLifecycle` 的结构：`executor` 跑完 → `finally` 里的 `finishRun()` → `resolvePromise()` 被调用。这个 Promise 的 resolve 时刻就是"run 彻底结束"的时刻，本章称之为**结算**——它比 `agent_end` 事件发出的时刻要晚，晚出的那一拍是什么，本节的死锁一段会拆开用到。

**谁在 await 它？** `waitForIdle()`：

```typescript
// src/agent.ts:328（Agent.waitForIdle）
waitForIdle(): Promise<void> {
	return this.activeRun?.promise ?? Promise.resolve();
}
```

没有 active run 时返回一个立即 resolve 的 Promise——"已经在 idle，不用等"。

**为什么需要它？** 毕竟 `await agent.prompt(...)` 本身也会等到结算结束（`prompt` → `runPromptMessages` → `await runWithLifecycle`，一条链下来）。区别在于**等待的人不一定是发起的人**。`prompt()` 完全可以不 await——发出去就撒手，UI 靠订阅事件更新；而另一个角落的代码（退出前的清理、测试里的断言、`reset()` 之前的护栏）需要一个"等它彻底安静"的手段，它手里没有 `prompt()` 返回的那个 Promise，只有 `agent` 引用。`waitForIdle()` 就是为这种"旁观者等待"准备的公开告示牌：Promise 挂出来谁都能等，resolve 的扳机只留给收尾的 `finishRun()`（`src/agent.ts:529`，本章"收尾"一节有完整引文）——**等待的人很多，宣布结束的人只有一个。**

**它在哪里被调用？** 这个包自己的生产代码里没有调用点——`waitForIdle()` 是纯公开 API。仓库里的真实用法有三类。一是测试，断言前等落定：

```typescript
// test/agent.test.ts:246（删减）
const promptPromise = agent.prompt("hello");
const idlePromise = agent.waitForIdle().then(() => {
	idleResolved = true;
});
// ……10ms 后断言 idleResolved 仍为 false（订阅者里的 barrier 还没放行）
```

二是 SDK 用户的非交互脚本：`prompt()` 不 await，发完事件驱动 UI，最后统一等安静（`packages/coding-agent/docs/sdk.md` 的示例就是这么用的）。三是下游包装层的 abort 流程——按了停止，必须等它真的安静才能返回：

```typescript
// packages/coding-agent/src/core/agent-session.ts:1541（仓库根起，AgentSession.abort）
async abort(): Promise<void> {
	this.abortRetry();
	this.agent.abort();
	await this.waitForIdle();
}
```

注意这里等的是 `AgentSession.waitForIdle()`，不是 `Agent` 的那个——它是 session 层自己重新实现的：

```typescript
// packages/coding-agent/src/core/agent-session.ts:1547（仓库根起，AgentSession.waitForIdle）
async waitForIdle(): Promise<void> {
	if (this.isIdle) {
		return;
	}
	await this._getIdleWaitPromise();
}
```

`AgentHarness` 同样有自己的版本。为什么下游不直接委托 `agent.waitForIdle()`？因为每层的"安静"定义不同：session 层的 idle 不止看 agent run，还有自己的重试、持久化等状态要算进去。所以它们用**同一个模式**各答各的——`_getIdleWaitPromise` 就是又一个手动引爆的 Promise：

```typescript
// packages/coding-agent/src/core/agent-session.ts:568（仓库根起，AgentSession._getIdleWaitPromise，删减）
private _getIdleWaitPromise(): Promise<void> {
	if (!this._idleWaitPromise) {
		this._idleWaitPromise = new Promise((resolve) => {
			this._resolveIdleWait = resolve;   // 同一个模式：构造时把 resolve 拿出来存着
		});
	}
	return this._idleWaitPromise;
}
```

**同一个问题，每一层都要重新回答一遍"我这层的安静是什么意思"**；模式被复制，答案不能复用。第 8、9 章会看到这两层各自的答案。

**那 `Agent.waitForIdle()` 本身为什么需要存在？** 包内没人调用它，不是冗余的证据，是"库"的正常形态——公共 API 的调用方本来就在库外。而它必须存在的理由是："run 是否彻底结算"是 `Agent` 的**私有知识**。`activeRun` 是私有字段，外部能观察到的最晚信号是 `agent_end` 事件——但事件发出 ≠ 监听器跑完，拿它当结算信号就早了一个身位。库不把这个答案挂出来，外部就只能猜错。

**保证的反面：在监听器里 await 它，会死锁。** 同一条结算语义，站错位置就是陷阱。把依赖关系摊开：监听器里 `await agent.waitForIdle()`，等的是结算；而结算在等你——`processEvents` 逐个 `await` 监听器（引文见后面「emit 的另一头」一节的推模式部分），你不 return，`executor` 就不算跑完，`activeRun.promise` 就不 resolve；你又在等它 resolve——环闭合了。不需要线程参与，Promise 依赖成环就够了，而且没有任何超时或 abort 能打破它：这个 run 永久挂起，`waitForIdle()` 和 `prompt()` 都永不 settle。注意这不只是 `agent_end` 监听器的问题——任何事件的监听器里调都一样，因为只要 run 没结束，`activeRun.promise` 的 resolve 条件里就含着"当前这个监听器 return"。harness 层的设计文档把这个坑明确写了出来：

> listeners/hooks currently receive no facade; if they close over the raw harness and call settlement APIs such as `waitForIdle()` during the active run, they can deadlock. A future facade should expose `runWhenIdle()` instead.
>
> —— `docs/agent-harness.md:18`（仓库根起）

`runWhenIdle()` 的出路在于换一个方向，签名里就能看到用法：

```typescript
// docs/harness-v2.md:730（仓库根起，设计文档）
runWhenIdle(callback: () => void | Promise<void>): Promise<void>;   // runtime-only
```

你把回调传进去，自己的监听器正常 return，结算照常完成；链走完后 harness 再来调这个回调，返回的 Promise 等回调跑完才 resolve——从登记那一刻起，你就不在依赖环里。注意它目前只是计划：v1、v2 两稿设计文档里都只有这一行签名，代码里尚无实现。一句话记住这条边界：**`waitForIdle()` 是旁观者的工具，参与者碰不得。**

### 插叙：executor 与 signal 两个模式

`runWithLifecycle` 的签名里有两个值得展开的模式，它们在后文（尤其第 14 章）会反复出现。

**模式一：executor 回调（"你带活儿来，我管前后"）。** `runWithLifecycle` 自己不干活，它收一个函数 `(signal) => Promise<void>` 当参数。为什么不让它直接调用 `runAgentLoop`？因为有两个调用方想共用同一套"前后手续"，但干的活不一样——`runPromptMessages` 跑 `runAgentLoop`，`runContinuation` 跑 `runAgentLoopContinue`（`src/agent.ts:421`）：

```typescript
// src/agent.ts:421（Agent.runContinuation）
private async runContinuation(): Promise<void> {
	await this.runWithLifecycle(async (signal) => {
		await runAgentLoopContinue(
			this.createContextSnapshot(),
			this.createLoopConfig(),
			(event) => this.processEvents(event),
			signal,
			this.streamFunction,
		);
	});
}
```

把"活"抽象成参数，前后的手续（建 controller、登记、置状态、兜异常、收尾）就只写一份。这个模式有时叫"模板方法"或"环绕执行"，本质是把**不变的括号**和**可变的内容**分开。

**模式二：AbortController / AbortSignal（"遥控器与电线"）。** 这是 Web 标准 API，Node 内置，和 TypeScript 无关。规则很简单：

- `new AbortController()` 造出一个**遥控器**，持有者随时可以按 `.abort()`。
- 每个 controller 带一根"电线" `controller.signal`（`AbortSignal`），可以任意往下传。拿到 signal 的人不能按按钮，只能**听**：轮询 `signal.aborted`，或注册 `signal.addEventListener("abort", ...)`。

所以这是一个单向的取消广播：**只有创建者能取消，所有下游只能服从。** 看 `runWithLifecycle` 里 signal 的旅程：controller 在这里创建，signal 交给 executor → executor 传给 `runAgentLoop` → 循环再传给 `streamFn`（取消 HTTP 请求）和每个工具的 `execute()`（终止正在跑的命令）。而按按钮的手在别处：

```typescript
// src/agent.ts:319（Agent.abort）
/** Abort the current run, if one is active. */
abort(): void {
	this.activeRun?.abortController.abort();
}
```

你在 UI 上点"停止"→ `agent.abort()` → controller 按下。注意 `abort()` 本身没有任何队列或时机判断——它就是同步按按钮，所以"什么时候停"不取决于循环转到哪，而取决于**听到广播的三方各自多快响应**。分三个时刻看：

**正在流式输出（模型还在说）。** signal 在发请求时就交进了 `streamFn`：

```typescript
// src/agent-loop.ts:308（streamAssistantResponse 内）
const response = await streamFunction(config.model, llmContext, {
	...config,
	apiKey: resolvedApiKey,
	signal,
});
```

HTTP 层立刻断流，按 `StreamFn` 契约（第 4 章），这次请求以一条 `stopReason: "aborted"` 的 assistant 消息收尾。循环随即走骨架里那个 `error || aborted` 分支：发 `turn_end`、发 `agent_end`、整个 run 返回——**不等这个 turn 走完**。

**正在执行工具（比如 bash 还在跑）。** 循环不硬杀工具：signal 在 `execute()` 的参数里（本章"执行工具"一节的引文可见），怎么响应是工具自己的事——内置 bash 会杀掉子进程（第 12 章）。循环这一侧的承诺是"不再开新工作"：prepare 阶段有检查，已按下的 signal 直接把还没开工的工具调用变成错误结果：

```typescript
// src/agent-loop.ts:644（prepareToolCall 内）
if (signal?.aborted) {
	return {
		kind: "immediate",
		result: createErrorToolResult("Operation aborted"),
		isError: true,
	};
}
```

顺序执行时，每跑完一个工具也检查一次，按了就中断本批剩余的：

```typescript
// src/agent-loop.ts:478（executeToolCallsSequential 内）
if (signal?.aborted) {
	break;
}
```

**正在 turn 与 turn 之间。** 下一圈调 `streamFn` 时带上的还是那根已按下的 signal，于是立刻落入第一种情况——这个"空转的一圈"不产生真实请求。

三个时刻有一个共同点：**abort 结束的是整个 run，不是当前 turn。** 骨架里那个分支是 `return` 不是 `continue`——ESC 的语义是"这个 run 到此为止"，两条队列也不再 poll。而且事件序列依然完整：`turn_end`、`agent_end` 照发，监听器照等，`waitForIdle()` 照常 resolve——取消不是拔电源，是以最快的速度走完一条正常的收尾路径。

最后注意 signal 在签名里大多是可选的（`AbortSignal | undefined`）——裸循环允许在没有取消需求的环境下跑，所以下游检查一律写成 `signal?.aborted`。

## agent 循环的两层结构

`runAgentLoop` 先把 prompt 消息追加进上下文，发出 `agent_start`、`turn_start` 和 prompt 自己的 `message_start`/`message_end`，然后把控制权交给真正的引擎 `runLoop`：

```typescript
// src/agent-loop.ts:95（删减）
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}
```

那么 `runLoop` 这个"真正的引擎"里，循环到底在哪里？先说清楚"循环"指什么。日常说的"agent 循环"是**模型 → 工具 → 模型**的往复：模型产出工具调用，工具结果喂回模型，模型再产出，直到没有工具调用为止。这个往复在代码里不是递归，是迭代——`runLoop` 里的一个 `while`。而 `runLoop` 里其实有**两个** `while`，这就是"两层结构"的字面出处。把真实代码摆出来（只折叠两处与循环结构无关的函数体）：

```typescript
// src/agent-loop.ts:155（折叠 prepareNextTurn 块——它是岔路不是主干，见本节"岔路"专节；其余逐行保真）
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// ...（"length" 截断守卫，见本章"执行工具"一节）
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			// ...（prepareNextTurn：两圈之间换快照的岔路，折叠，见下文专节）

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}
```

### 插叙：消息的三件套与内容块

分析这段骨架之前，先补一课 LLM 应用的基本数据结构——骨架里的 `message`、`toolResults`、`pendingMessages` 全都是它。整个对话历史就是一个 `Message` 数组，而 `Message` 只有三种角色：

```typescript
// packages/ai/src/types.ts:442（仓库根起）
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

三种角色对应对话协议的三个动作：**user 说**，**assistant 做**，**toolResult 把工具结果喂回去**。循环的"模型 → 工具 → 模型"往复，落到数据上就是 assistant 消息和 toolResult 消息在数组里交替追加。各自的长相（字段有删减，留的是主干）：

```typescript
// packages/ai/src/types.ts:402 / :408 / :424（仓库根起，删减）
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	stopReason: StopReason;   // 这一轮为什么停：说完 / 要调工具 / 出错 / 被截断……
	// ...（api / provider / model / usage / errorMessage 等元数据）
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;   // 回指 assistant 消息里那个 ToolCall 块的 id
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}
```

三种角色，到顶了——system prompt 不在这个数组里，它是 `Context` 的独立字段，每次请求单独随附。至于应用想要第四种角色（通知、摘要标记）怎么办，那是第 4 章的支点问题，这里先记住"LLM 只认这三种角色"。

注意 `AssistantMessage.content` 的类型：**不是字符串，是内容块数组**。一条 assistant 消息是若干块的序列，每块三选一：

```typescript
// packages/ai/src/types.ts:347 / :353 / :369（仓库根起，删减）
export interface TextContent {
	type: "text";
	text: string;
	// ...
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	// ...
}

export interface ToolCall {
	type: "toolCall";
	id: string;                        // 供 toolResult 回指
	name: string;                      // 要调哪个工具
	arguments: Record<string, any>;    // 模型生成的参数
	// ...
}
```

块按模型产出的顺序排列，所以一条消息可以"想一段、说一段、调两个工具"，全部混排在同一个数组里。这里要破除一个命名带来的直觉：`message` 听起来像"一句话"，实际上它是**模型一轮输出的全部内容**的容器——"轮"才是它的单位，不是"句"。有了这个形状，骨架引文里那个 `filter` 就好懂了：**"模型这一步有没有要干活" = "这个数组里有没有 `type: "toolCall"` 的块"**。文本块和思考块不进工具管线，它们只是对话内容，留在数组里随消息一起进上下文。

### 内层循环：转一圈 = 一个 turn

现在可以回答"哪里有循环"了。**内层 `while` 转一圈 = 一个 turn**：注入插队消息（如果有）→ 调一次模型 → 执行工具（如果有）→ `turn_end`。它的退出条件 `hasMoreToolCalls || pendingMessages.length > 0` 读作"模型没要新工具，也没人插队"——日常说的"agent 跑完了"，在代码里就是这个条件变假。

每圈开头补发一个 `turn_start`——**除了第一圈**。引文里的 `firstTurn` 旗标就是干这个的：第一圈的 `turn_start` 在进 `runLoop` 之前已经由 `runAgentLoop` 发过了（上面引过的 `src/agent-loop.ts:110`），如果不压住，订阅者会看到两个挨着的 `turn_start`。这个旗标没有别的用途，纯粹是事件去重。

如果你听过 ReAct（Reason + Act）这个经典 agent 范式，内层循环就是它——只是这里的名字更朴素：**Reason** 是 `streamAssistantResponse` 产出的那条 assistant 消息（`thinking_*` 流事件就是推理过程本身在你眼前展开），**Act** 是消息里的 toolCall 块交给 `executeToolCalls`，**Observe** 是 toolResult 消息推进 `currentContext.messages`——然后回到圈首，模型基于迄今为止的全部观察再推理一轮。pi-agent-core 没有发明新范式，它做的是把 ReAct 的一圈拆成可观察、可拦截、可取消的十来个事件和钩子。

### agent 循环什么时候停：三种停法

内层循环的退出条件有两个，必须同时成立：模型这一轮没要新工具（`hasMoreToolCalls` 为假），并且没有人插队（`pendingMessages` 为空）——也就是骨架里 `while (hasMoreToolCalls || pendingMessages.length > 0)` 变假的那一刻。这是正常退出。此外循环还有两条提前停止的路径：宿主回调 `shouldStopAfterTurn` 的优雅收尾，和 `abort()` 的无条件停止。这一节按这三种停法逐个看。

#### 由 toolCall 决定：正常出口与终止旗

这里有个容易误读的地方值得说破：**循环的正常出口是模型"不再调用工具"，跟举旗无关。** 看引文里工具块的形状：`hasMoreToolCalls = false` 之后，只有 `toolCalls.length > 0` 才会进执行块、才可能被置回 `true`。模型产出一条纯文本消息时，if 块整个跳过，旗标保持 `false`，循环退出。所以结束的主动权始终在模型手里——它觉得任务完成，就直接说话；举旗只覆盖"最后一个动作恰好是工具调用"的特例，省掉模型没话找话的那一轮。它是优化，不是终止机制。

`hasMoreToolCalls` 的更新规则值得看一眼，因为它就是"往复"的开关：每圈开头先无条件置 `false`（默认没有下一圈），执行完工具后按 `!executedToolBatch.terminate` 置回。那这个 `terminate` 什么时候是 `false`？判定函数只有三行：

```typescript
// src/agent-loop.ts:582
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```

把引文里的判定条件逐词读出来：这批里**每一个**（`every`）工具结果的 `terminate` 都**恰好等于** `true`。这个字段的类型是 `boolean | undefined`——`=== true` 的严格相等让"没写这个字段"（`undefined`，也就是绝大多数工具的情况）明确算作不举旗。两个条件叠加，门槛非常高，因此 `terminate` 为 `false`（循环继续）的情形是绝大多数：

1. **没有任何工具举旗**——`terminate` 是工具结果上一个可选的 hint，绝大多数工具从不设置它，这是最常见的 `false`。这面旗在类型里的定义：

```typescript
// src/types.ts:364（AgentToolResult 内）
/**
 * Hint that the agent should stop after the current tool batch.
 * Early termination only happens when every finalized tool result in the batch sets this to true.
 */
terminate?: boolean;
```

2. **混合批次**——三个工具里两个举了旗、一个没举，`every` 不成立，整批继续（语义是"旗子只有全票通过才生效"，防的是某个工具单方面掐断别人还需要后续处理的批次）；
3. **截断守卫路径**——`failToolCallsFromTruncatedMessage` 返回的批次硬编码了继续：

```typescript
// src/agent-loop.ts:405（failToolCallsFromTruncatedMessage 的返回）
return { messages, terminate: false };
```

因为整批的意义就是"让模型重发一遍"，当然要循环回去。

反过来说，`terminate: true` 只在**这批每个工具结果都显式举旗**时出现。而"举不举旗"这个决策本身，是**工具作者**的，不是模型的——旗子写在工具结果上，`execute()` 返回什么就是什么。模型的角色只是**选择调用哪个工具**（工具作者可以用 prompt 引导它在对的时机调用终点工具），宿主则可以用 `afterToolCall` 在 finalize 阶段代举或撤旗。三层各管一段：**作者定义语义、模型选择时机、宿主保留否决权。**

什么工具会举旗？仓库里有一个真实例子（在兄弟包 `packages/coding-agent` 的扩展示例里），它的文件头注释把动机写得很明白：

```typescript
// packages/coding-agent/examples/extensions/structured-output.ts:1（仓库根起）
/**
 * Structured Output Tool
 *
 * Demonstrates `terminate: true` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */
```

场景是这样的：用户要一个结构化答案（JSON 式的总结、行动项列表），模型把答案**作为工具调用的参数**交出来——`headline`、`summary`、`actionItems` 都在参数里。工具要做的只是收下并存起来：

```typescript
// packages/coding-agent/examples/extensions/structured-output.ts:34
async execute(_toolCallId, params) {
	return {
		content: [{ type: "text", text: `Saved structured output: ${params.headline}` }],
		details: {
			headline: params.headline,
			summary: params.summary,
			actionItems: params.actionItems,
		} satisfies StructuredOutputDetails,
		terminate: true,
	};
},
```

这就是举旗的语义：**"工具结果就是最终答案，没有后续工作需要模型做了。"** 如果不举旗，循环会照例再调一次模型——模型只能对着一个"已保存"的确认硬着头皮再说一段话，那轮 LLM 调用纯粹是浪费（文件头里 "paying for an extra follow-up LLM turn" 说的就是这笔钱）。所以这个例子的工具描述里特意叮嘱模型"调用后就别再说话了"（`promptGuidelines`，同文件 :24-27），`terminate: true` 则是在机制层面把这件事落实。

举旗还有第二个入口：工具自己不举，`afterToolCall` 钩子在 finalize 阶段替它举——`finalizeExecutedToolCall` 的逐字段合并里有 `terminate: afterResult.terminate ?? result.terminate`（本章"执行工具"一节的引文里可见）。这让"是否提前结束"变成宿主可以拦截的决策，不只是工具作者的硬编码。

反过来问一句能把这件事彻底想透：**什么工具结果不是最终答案？** 答案是这个循环里的几乎全部工具。看内置的四个（第 12 章细讲）：`read` 的结果是一段文件内容——它不是答案，是**材料**，模型要读完才能回答"这个函数是干什么的"；`bash` 跑测试的结果是一堆输出——模型要看了才知道该修哪行；`edit` 的结果是 diff——模型要确认改对了才决定下一步。这些工具的信息流向是**双向**的：参数是模型下达的指令，结果是回喂给模型的观察，循环的价值就在"观察 → 决策 → 再行动"的往复里。

而 `structured_output` 这类工具是**单向**的：参数本身就是成品（模型在发起调用时已经想完了），工具结果只是一张"已存好"的回执——回执再喂给模型，模型无话可说。所以判断一个工具该不该举旗，一句话就够：**这条 toolResult 回到模型手里之后，模型还有没有有意义的事可做？** 有，就是普通工具；没有，就是终点工具。

那有没有真的停不下来的情况？有，但来源不是"工具不举旗"，而是**模型一直发工具调用**——反复读文件、反复跑测试却不得要领。这种失控的护栏不在循环里，在循环外：`agent.abort()`（人按停止）、`shouldStopAfterTurn`（宿主在每个 turn 后判断要不要优雅收尾，比如上下文快满了）、以及模型请求失败时 `stopReason: "error"` 的直接退出。注意这个包没有内置"最大轮数"——它把这类策略完整留给了宿主，经 `shouldStopAfterTurn` 表达。

#### shouldStopAfterTurn：turn 边界上的优雅收尾

`shouldStopAfterTurn` 是宿主表达"优雅收尾"的正式通道，值得说清它怎么工作。它是 `AgentLoopConfig` 上的可选回调，每个 `turn_end` 之后、poll 两条队列之前被调用（就是骨架引文里的那个位置），拿到的是刚结束这个 turn 的全部信息：

```typescript
// src/types.ts:121（删减）
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. */
	newMessages: AgentMessage[];
}
```

返回 `true`，循环发 `agent_end` 退出——连 steering 和 follow-up 队列都不再看；返回 `false` 或不返回，一切照旧。

"不看两条队列"本身就是一种设计决策，只不过它不是用 if/else 写出来的，而是用**位置**写出来的。可以设想另一种写法：退出前先看看队列——"有插队消息的话，还停不停？"——这样停止逻辑就和队列逻辑纠缠在一起，长出"要停但有消息""不停但队列为空"之类的组合分支。pi 的解法是让问题模型保持最简单：**每个回调只回答一个问题，没被问到的问题留给下一个 run。** `shouldStopAfterTurn` 只回答"要不要停"；说停，循环就 `return`——`return` 那行在 steering poll（`pendingMessages = (await config.getSteeringMessages?.()) || []`）之前，follow-up poll 还在内层循环之外、更靠后的位置，两行 poll 根本轮不到执行。而没被执行的 poll 不等于作废：drain 没发生，消息还躺在宿主自己的队列里，下一个 run 照样取得到。

所以每个决策点的代码都短得只有一行，正确性却不依赖任何组合判断。顺序本身也是语义：先问"要不要停"，再问"有没有人排队"。两条队列存在的全部意义是让 run **继续**——steering 是中途加活，follow-up 是结束后加活——宿主刚说了停，再去问队列就是自相矛盾：一条排队消息会强行开出宿主刚刚否决的那一圈。

那"函数体"在哪？**不在这个包里。** 这是循环和宿主之间的接缝：循环只有调用点，判断逻辑完全由宿主提供。`Agent` 类把它暴露成一个公开的可赋值属性，装配时包一层塞进 config：

```typescript
// src/agent.ts:456（Agent.createLoopConfig 内）
shouldStopAfterTurn: shouldStopAfterTurn
	? async (context) => await shouldStopAfterTurn(context, this.signal)
	: undefined,
```

这层包装只做一件事：给你的回调多喂一根 signal；你没设置，就传 `undefined`，循环侧的 `?.` 直接短路成"不停"。所以真正的函数体长什么样是应用的事——比如"估算当前上下文 token 数，超过阈值返回 `true`"，就是上下文管理场景的典型实现：

```typescript
// 示意：上下文超过阈值就请求优雅收尾（应用侧代码，不在 pi 仓库里）
function roughTokens(messages: AgentMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += JSON.stringify(m.content).length;
	}
	return Math.ceil(chars / 4);   // 约 4 字符 ≈ 1 token 的粗估
}

agent.shouldStopAfterTurn = ({ context }) => {
	return roughTokens(context.messages) > 150_000;
};
```

循环停在这一圈之后，宿主接手做压缩或总结，再用新上下文开下一个 run——被跳过的队列消息还躺在队列里，新 run 的第一次 poll 就能取到。

这个例子还有三个细节值得说清。

- **阈值**：150k 是示例值，实际按模型的 context window 定——比如 200k 窗口的模型，要预留输出和系统提示的空间，在 150k 左右踩刹车。
- **估算**：`roughTokens` 是字符数粗估，真实实现会用对应模型的 tokenizer（harness 的 compaction 有正式的 token 统计，第 11 章）。
- **粒度**：它只在 turn 边界生效——这正是"优雅"的含义，不会半途掐断一个 turn，而是等这一圈完整落袋后才停。如果想不停下来、直接在 run 内换掉上下文继续跑，那是 `prepareNextTurn` 那条岔路（本章"岔路"一节）。

它和 abort 的差别在**谁来喊、什么时候喊**：abort 是外部随时强按，立刻生效；`shouldStopAfterTurn` 是循环在 turn 边界上主动来问，问的是"要不要体面地停在这"——典型场景是上下文快满了，宿主让它停在这一圈，好接手做压缩或总结。和本章后面"岔路"一节的 `prepareNextTurn` 放在一起看，它们是一对旋钮：一个问"要不要停"，一个问"下一圈换不换装备"。契约照旧是"失败变成值"：不许抛异常，否则事件序列就断了（第 4 章）。

#### abort：无条件出口

`agent.abort()` 的粒度值得在"出口"的语境里再强调一次：**abort 结束的是整个 run，不是当前 turn。** 它不走这一节讲的任何一个条件——不看 `hasMoreToolCalls`，不等 `shouldStopAfterTurn`，两条队列也不再 poll；signal 让正在进行（或下一次）的模型请求以 `stopReason: "aborted"` 收尾，直接命中骨架里那个 `return` 的分支。按下按钮后三种时刻各自怎么停，前面「插叙：executor 与 signal」一节已经拆过；在这里只要记住它是**唯一的无条件出口**——这一节的其他出口都在问"要不要继续"，只有 abort 不问。

### 外层循环：为 follow-up 续命

**外层 `while (true)` 转一圈 = 一批 follow-up。** 内层耗尽后，循环本来该结束了，但先问一句 follow-up 队列：有人排队"顺便再做一件事"，就把它们塞进 `pendingMessages`，`continue` 回去让内层再转；没有，`break`。外层存在的全部理由就是这一问。

`pendingMessages` 的消费方式也值得细看，因为它是两条队列汇流的地方。注入块做三件事：逐条发 `message_start`/`message_end`（对订阅者来说，插队消息和普通消息的事件序列完全一样）、推进 `currentContext` 和 `newMessages`（下一个模型请求能看到它）、然后清空数组（每圈最多注入一批，一批几条由队列的 mode 决定，`one-at-a-time` 还是 `all`，第 6 章讲）。注意注入点在**调模型之前**——插队消息永远赶在模型的下一次回应前进入上下文。而外层续命时把 `followUpMessages` 赋给 `pendingMessages`，走的正是这同一条注入管线：**steering 和 follow-up 共用一套机制，区别只在 poll 的时机**——一个在每个 turn 后问，一个在真要停的时候才问。

为什么需要两层，而不是一个大 while？因为两种队列的**检查时机**不同：steering 在每个 turn 之后都要看（用户在 agent 工作时随时插话），follow-up 只能在"agent 真的要停了"的点才看。合并成一个循环，就得在同一个条件里表达两种时机，代码会长出奇怪的旗标；两层 while 各管一种时机，条件读起来就是业务语义本身。

另外注意状态是怎么在迭代间传递的：`currentContext`、`newMessages`、`config` 都是 `runLoop` 的参数或局部绑定，每圈就地修改（推消息、换快照），下一圈接着用。不用递归，就没有栈的深度问题，也没有"每层调用各持一份上下文"的拷贝开销——**循环的状态机是平铺的**。

"就地修改"会不会改到循环外面去？两个数组要分开看。`newMessages` 会——而且是**故意**的：`runAgentLoop` 把它新建出来（`[...prompts]`）交给 `runLoop` 填充，跑完把同一个数组 `return` 给调用方（见本节开头 `runAgentLoop` 的引文），就地推消息正是结果回传的通道。`currentContext.messages` 则不会：`runAgentLoop` 建上下文时另起了新数组（`[...context.messages, ...prompts]`），循环往里推多少条，调用方手里的 `context.messages` 都纹丝不动。

值得把这六个参数的签名停下来看一眼——它们是循环对外的全部接口。`prompts` 和返回值都是 `AgentMessage[]`；`signal` 是个可选的 `AbortSignal`；`streamFn` 是第 1 章引过的 `StreamFn`（`src/types.ts:28`）。剩下三个：

```typescript
// src/agent-loop.ts:25 —— 事件出口，同步异步都收
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

```typescript
// src/types.ts:406 —— 循环眼中的"当前对话"
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}
```

`config: AgentLoopConfig`（`src/types.ts:144`）是最大的一块——模型、闸门、hook、队列轮询全在里面，第 6 章会逐个字段拆开。这里先记住分工：`context` 是**数据**（说什么），`config` 是**行为**（怎么说、说完做什么），`emit` 是**出口**（说给谁听）。

### 岔路：两圈之间换快照（prepareNextTurn）

主干引文里折叠掉的那块，现在展开。它在每个 `turn_end` 之后、下一次 poll steering 之前，给宿主一个"换掉下一圈的装备"的机会。

先说句实话：这条岔路是本章的隐藏 boss——契约、适配、实现横跨三层，外加命名撞车和叠加安装，难度在本章平均线之上。打不过可以先走，主线照样通关；读完后面几章升了级再回来打也行。后面几节依次落到每一层，先给地图：

- **agent 循环层**（`agent-loop.ts`）：定义契约——每圈结束问一次，返回的快照逐字段 `??` 合并；
- **Agent 层**（`agent.ts`）：把契约暴露成两个可赋值的公开属性，装配时归一成循环认识的单一签名；
- **宿主层**（coding-agent / harness）：真正实现——叠加安装，或落盘后重建快照。

先看 agent 循环层的契约：

```typescript
// src/agent-loop.ts:226
const nextTurnContext = {
	message,
	toolResults,
	context: currentContext,
	newMessages,
};
const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
if (nextTurnSnapshot) {
	currentContext = nextTurnSnapshot.context ?? currentContext;
	config = {
		...config,
		model: nextTurnSnapshot.model ?? config.model,
		reasoning:
			nextTurnSnapshot.thinkingLevel === undefined
				? config.reasoning
				: nextTurnSnapshot.thinkingLevel === "off"
					? undefined
					: nextTurnSnapshot.thinkingLevel,
	};
}
```

它回答的问题是：**一个 run 跑到一半，宿主想换上下文、换模型、换思考强度怎么办？**

两个语义细节值得记住。一是合并方式：快照的每个字段都可缺省，缺省就 `??` 回落到当前值——宿主可以只换模型不动上下文，反之亦然。二是 `thinkingLevel: "off"` 被显式翻译成 `reasoning: undefined`，因为下游（`SimpleStreamOptions`）的契约是用"没有 reasoning 字段"而不是 `"off"` 来表达关闭——这个三层三元表达式就是在做词汇表对齐。

时机也有讲究：替换发生在 `turn_end` 之后、steering poll 之前。这意味着哪怕下一圈是为了回应一条插队消息，用的也已经是新快照——插队不会让宿主失去换装备的机会。

#### 接缝：两个名字，一个适配器

地图里的 Agent 层。`prepareNextTurn` 这个名字在这一层出现在三个位置、`prepareNextTurnWithContext` 出现在两个，指的都不是同一个东西。先把三个位置分开：

- **入口**：`AgentOptions` 的两个同名键——宿主构造 `Agent` 时把函数传进来的地方；
- **槽位**：`Agent` 实例上的两个公开属性（`src/agent.ts:197`，引文在下）——`Agent` 只定义签名、自己不提供实现，实现由外部传入，所以我们叫它槽位；
- **出口**：`AgentLoopConfig` 的单一键 `prepareNextTurn`——装配时由槽位归一而来（引文在下）。

入口就是构造函数的参数包：`Agent` 的构造函数只收一个参数，类型叫 `AgentOptions`，那两个同名键就在这个类型里：

```typescript
// src/agent.ts:216（Agent 构造函数开头）
constructor(options: AgentOptions) {
	// Older compiled consumers may omit options or streamFn even though the current API requires them.
	const runtimeOptions: Partial<AgentOptions> = options ?? {};
```

从入口到槽位是构造函数的例行拷贝，和所有回调一个待遇：

```typescript
// src/agent.ts:229（Agent 构造函数内）
this.prepareNextTurn = runtimeOptions.prepareNextTurn;
this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
```

`runtimeOptions` 就是上面签名引文里那个防御性别名——源码注释交代了防的是谁：旧的编译产物可能根本不传 options。除了构造时传，宿主还能在运行时绕过入口、直接给槽位赋值替换——coding-agent 走的就是这条，见下。

槽位的声明：

```typescript
// src/agent.ts:197
public prepareNextTurn?: (
	signal?: AbortSignal,
) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
public prepareNextTurnWithContext?: (
	context: PrepareNextTurnContext,
	signal?: AbortSignal,
) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
```

两个槽位的差别只有第一个参数：旧版只给 signal，新版多给刚结束的 turn 信息；返回值完全相同——就是岔路开头引文里被逐字段 `??` 合并的那个三字段快照。装配时 `Agent` 读这两个槽位，归一成出口处的单一名字：

```typescript
// src/agent.ts:459（Agent.createLoopConfig 内，return 的对象字面量——即 AgentLoopConfig；其余键折叠，就是本章开头装配引文里那些）
return {
	// ...（model、convertToLlm、队列轮询等键）
	prepareNextTurn:
		this.prepareNextTurnWithContext || this.prepareNextTurn
			? async (context) => {
					if (this.prepareNextTurnWithContext) {
						return await this.prepareNextTurnWithContext(context, this.signal);
					}
					return await this.prepareNextTurn?.(this.signal);
				}
			: undefined,
};
```

两个名字并存的原因是兼容性：旧版公开属性的签名不能直接改（CHANGELOG 0.80.3 记了这段历史），需要 turn 信息的人用新版。标题里的"适配器"指的就是这段包装：宿主给的两种签名和 agent 循环要的一种签名对不上，它在中间做翻译——对循环始终暴露 `(context)` 形态，对内看槽位里装的是哪个，新版把 `context` 递过去，旧版扔掉 `context` 只递 `signal`。

读这段引文时回望那三个位置，分界线现在在引文里能看见了：`return` 的这个对象字面量是 **`AgentLoopConfig`**——左边 `prepareNextTurn:` 是它的键（**出口**），循环用 context 调它（岔路开头的引文）；而函数体里的 `this.prepareNextTurnWithContext` / `this.prepareNextTurn` 是 **`Agent` 实例**的槽位，每圈被循环调用时才去读槽里的当前值。所以"定义之前引用了自己"不成立：被定义的键属于 `AgentLoopConfig`，被读的属性属于 `Agent`——两个类型、两个对象，只是名字撞了；如果 `this.prepareNextTurn` 也是这个字面量的键，那才真是自己引用自己。槽位又早在构造或运行时就装好，这里只是包一层做归一。

#### 实现：叠加与重建

再往下到宿主层。本仓库里这个钩子有两个真实实现，路子恰好相反：coding-agent 叠加一层，每圈重读 systemPrompt、工具列表、模型和思考强度——

```typescript
// packages/coding-agent/src/core/agent-session.ts:526（仓库根起，AgentSession._installAgentNextTurnRefresh）
private _installAgentNextTurnRefresh(): void {
	const previousPrepareNextTurnWithContext =
		this.agent.prepareNextTurnWithContext ??
		(this.agent.prepareNextTurn
			? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
			: undefined);
	this.agent.prepareNextTurnWithContext = async (turn, signal) => {
		const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
		const previousContext = previousSnapshot?.context ?? turn.context;
		return {
			...previousSnapshot,
			context: {
				...previousContext,
				systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
				tools: this.agent.state.tools.slice(),
			},
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		};
	};
}
```

赋值会整体替换槽里已有的函数，所以 coding-agent 的安装不是简单替换、而是**叠加一层**：先把旧值捕获进 `previousPrepareNextTurnWithContext`，新函数先调它、把它的快照垫在底下，再覆盖刷新四个字段——值全部从 `state` 现读，所以 run 中途的切换，下一圈生效。（`this.agent.state` 走 `Agent` 的公开访问器，和 agent.ts 引文里的 `this._state` 是同一个对象。访问器是 Typescript 中的语法糖，详细介绍请见「emit 的另一头」一节）

旧值从哪来？在 coding-agent 自己的装配路径里其实不会有——它的 sdk 内部 `new Agent` 时没传这个属性，`AgentSession` 必然面对空槽；防的是 SDK 用户在 `AgentSession` 接手之前给槽位设过自己的函数（构造函数选项接受这两个属性，见前面「接缝」一节）——这份捕获就是把那种路径也保住。

harness 的实现是另一个风格：每圈先把 run 期间积压的延迟写入落盘，再从 session 重建整份快照：

```typescript
// src/harness/agent-harness.ts:527（AgentHarness.createLoopConfig 内，删减）
prepareNextTurn: async () => {
	await this.flushPendingSessionWrites();
	const nextTurnState = await this.createTurnState();
	setTurnState(nextTurnState);   // 让事件和 hook 侧看到的也是新快照
	return {
		context: this.createContext(nextTurnState),
		model: nextTurnState.model,
		thinkingLevel: nextTurnState.thinkingLevel,
	};
},
```

#### 还能这么用：run 内压缩

那压缩呢？作为宿主，coding-agent 的选择是**在 run 间做**——就是前面「agent 循环什么时候停」里 shouldStopAfterTurn 那条路：停在这一圈，宿主压缩，开新 run（第 11 章细讲）。但"不中断 run、在圈内把上下文换掉"正是这个钩子独占的能力——库把这条路留给了需要它的宿主，长这样：

```typescript
// 示意：run 内压缩（应用侧代码，不在 pi 仓库里——coding-agent 把压缩放在 run 间做，见上）
agent.prepareNextTurnWithContext = async ({ context }) => {
	if (roughTokens(context.messages) <= 150_000) {
		return undefined;   // 还不用换：返回 undefined，循环沿用当前上下文
	}
	const summary = await summarize(context.messages);   // 宿主自己的压缩逻辑
	return {
		context: {
			...context,
			messages: [summaryMessage(summary), ...keepRecentTurns(context.messages)],
		},
	};
};
```

`roughTokens` 沿用前面 shouldStopAfterTurn 一节的估算函数；`summarize`、`summaryMessage`、`keepRecentTurns` 都是宿主自己的实现——钩子的职责只有一件事：把新快照递回去。参数写法说明一下：`({ context })` 解构的是第一个参数对象——就是主干引文里循环组装的 `nextTurnContext`（`message`/`toolResults`/`context`/`newMessages` 四字段），取出其中的 `context` 字段；coding-agent 的实现选择给整个对象起名 `turn` 再取 `turn.context`，同一类型、两种写法。属性名用的是带 Context 的新版：写成旧版 `prepareNextTurn` 的话，回调收到的是 signal，解构不出 `context`——这个坑就是「接缝：两个名字，一个适配器」一节那两个名字的由来。

### emit 的另一头：谁在接收

`emit` 只是一个函数参数，所以"事件如何被接收"没有唯一答案——接收方是调用方传进来的。这个包里有两个调用方，对应两种接收方式。

**第一种，`Agent` 类**：传的是 `(event) => this.processEvents(event)`（`src/agent.ts:414`，见上文 `runPromptMessages` 的引文）。事件先归约进 `state`，再逐个 await 订阅者——这条链路在本章"收尾"一节有完整引文。这是"推送"模式：循环主动推给你，你的监听器是循环结算的一部分。

**第二种，裸 `agentLoop()`**：不传监听器，而是把事件推进一个 `EventStream`，让调用方自己用 `for await` 拉：

```typescript
// src/agent-loop.ts:31
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}
```

注意这里的 `emit` 实现只有一行 `stream.push(event)`，而且 `runAgentLoop` 前面没有 `await`——循环在后台跑，函数立刻把 stream 还给调用方。`EventStream` 是 pi-ai 提供的一个"异步队列 + 迭代器"包装：生产者 push，消费者 `for await` 逐条取出；取到 `agent_end` 时迭代结束，并交出最终的 `AgentMessage[]`。这个终止条件就定义在 `createAgentStream` 的两个回调里——第一个判断"这是不是最后一条"，第二个从最后一条里取结果：

```typescript
// src/agent-loop.ts:145
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}
```

两种接收方式的差别，用一个问题就能问出来：**你的事件处理很慢的时候，循环会不会停下来等你？**

**拉模式：不等。** 你拿到的是一个队列的读取端，循环只管往里 push，然后继续跑它的——下一个 LLM 调用、下一个工具执行，都不会因为你的消费速度而放慢。你的 `for await` 是独立的时钟：

```typescript
// 拉：循环在后台跑，你按自己的节奏取
for await (const event of agentLoop(prompts, context, config, signal, streamFn)) {
	await render(event);   // 你慢，事件就在队列里堆着；循环不回头看你
}
```

**推模式：等。** 你把监听器注册给 `Agent`。这里没有队列——循环每产生一个事件，就沿着一条调用链走到你：`emit()` → `processEvents()` → 你的监听器，而且每一环都是 `await` 的：

```typescript
// src/agent.ts:250（Agent.subscribe）—— 只是把监听器塞进一个 Set，返回的是退订函数
subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
	this.listeners.add(listener);
	return () => this.listeners.delete(listener);
}

// 你这一侧：
agent.subscribe(async (event) => {
	await render(event);
});

// src/agent.ts:584（Agent.processEvents 内，删减；完整引文见本章"收尾"一节）—— 循环那一侧：
for (const listener of this.listeners) {
	await listener(event, signal);   // 你不 return，循环就不发下一个事件
}
```

所以你的处理时间是循环时间线上的一段：你慢，整个 run 就慢；你不完，下一个事件不会来。

各赔上一样东西，各换来一样东西。拉模式赔了**顺序与结算保证**——你处理第 N 个事件时，循环可能已经跑到第 N+50 个，"当前进行到哪一步"这类问题在拉模式下没有权威答案；换来的是**解耦**：你可以批量、过滤、转发、落盘，甚至在 run 结束后才慢慢消费。

推模式反过来：赔了**速度**（慢监听器拖慢整个 run），换来的是**保证**。保证具体是哪几条，值得逐一点出来——它们全是上面那两行"逐个 await"买来的。每条配一个"所以它允许你这样写"的例子：

**你看到的事件流就是循环的时间线。** 第 N 个事件的所有听众结束前，第 N+1 个不会发出。所以"当前"是有意义的——处理 `message_update` 时，此前的每个事件都已经应用完毕，不存在"追不上"的窗口：

```typescript
// UI 可以就地应用增量，不用考虑乱序和缺口
agent.subscribe((event) => {
	if (event.type === "message_update") {
		ui.replaceLastMessage(event.message);   // 上一个 update 保证已经渲染过
	}
});
```

**`state` 和事件永远一致。** 先交代一个命名关系：监听器里读的 `agent.state` 和前文引文里的 `this._state` 是**同一个对象**——公开访问器原样返回内部字段：

```typescript
// src/agent.ts:260（Agent 的 state 访问器）
get state(): AgentState {
	return this._state;
}
```

（"访问器"是 JS/TS 的语法糖：`get state() {...}` 声明像方法，使用却像字段——写 `agent.state`，不带括号；只有 `get` 没有 `set`，所以对外只读。）

`processEvents` 先把事件归约进 `state`、再调监听器（"收尾"一节的引文里能看到这个顺序），所以监听器里读 `agent.state`，拿到的一定是这个事件**之后**的状态，不需要自己做同步：

```typescript
agent.subscribe((event) => {
	if (event.type === "message_end") {
		agent.state.messages.at(-1) === event.message;   // 恒为 true：归约发生在调你之前
	}
});
```

**你的异步工作计入 run 的结算。** 监听器里 await 的写库、网络请求，全被算进"run 结束"的定义——`waitForIdle()` 要等最后一个 `agent_end` 监听器跑完才 resolve（前面「结算与 waitForIdle」一节）。所以在监听器里做副作用是安全的：

```typescript
agent.subscribe(async (event) => {
	if (event.type === "agent_end") {
		await db.save(event.messages);   // 慢也没关系，循环会等
	}
});

await agent.prompt("总结一下这个文件");   // 返回时，db.save 保证已完成
```

这就是第 1 章那句"`Agent` 是循环的一种包装"的具体含义。选哪个取决于你要不要那个保证：做 UI 通常要——渲染需要一致的 `state`、写库需要结算屏障，选推（`Agent`）；做管道通常不要——把事件流转发到日志、分析、另一个系统，你只是过客，选拉（裸 `agentLoop()`）。

与之对照，`runWithLifecycle` 的签名小得多——它不管数据和行为，只管生命周期：

```typescript
// src/agent.ts:482
private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void>
```

一个 executor 进去，一个"跑完了"的 Promise 出来；`activeRun` 的登记、`isStreaming` 的翻转、失败兜底、最终的 `finishRun()`，全都藏在这个小签名后面。两个签名放在一起看，就是 `Agent` 类与循环之间的全部接缝：**循环要数据、行为和出口；包装层只要一个执行体。**

## 调模型：两道闸门

内层循环的核心动作是 `streamAssistantResponse`：

```typescript
// src/agent-loop.ts:281
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
```

### 过闸：先变换，再翻译

在真正发出请求之前，消息要过两道闸门：

```typescript
// src/agent-loop.ts:289
let messages = context.messages;
if (config.transformContext) {
	messages = await config.transformContext(messages, signal);   // AgentMessage[] → AgentMessage[]
}

// Convert to LLM-compatible messages (AgentMessage[] → Message[])
const llmMessages = await config.convertToLlm(messages);
```

- `transformContext`（可选）：直接操作 agent 侧的消息数组——剪掉老消息、注入外部上下文。输入输出都是 `AgentMessage[]`。
- `convertToLlm`（必需）：把 `AgentMessage` 翻译成 LLM 侧的 `Message`。LLM 只认识 `user`/`assistant`/`toolResult` 三种角色，你的自定义消息类型（比如"通知""压缩摘要"）要么被转换，要么被过滤掉。

这两道闸门是全书最重要的设计之一，第 4 章会展开。这里只需要记住：**循环本体从头到尾只说 `AgentMessage`，翻译只发生在 LLM 调用边界上**——这句话就写在文件头注释里：

```typescript
// src/agent-loop.ts:1
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
```

### 回流：一条消息就地成形

过了闸门，调 `streamFn`，事件开始回流。循环拿着流事件维护一份"正在成形的消息"（`partialMessage`），就地更新，同时向订阅者转发：

```typescript
// src/agent-loop.ts:314（streamAssistantResponse 内）
let partialMessage: AssistantMessage | null = null;
let addedPartial = false;

for await (const event of response) {
	switch (event.type) {
		case "start":
			partialMessage = event.partial;
			context.messages.push(partialMessage);
			addedPartial = true;
			await emit({ type: "message_start", message: { ...partialMessage } });
			break;

		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			if (partialMessage) {
				partialMessage = event.partial;
				context.messages[context.messages.length - 1] = partialMessage;
				await emit({
					type: "message_update",
					assistantMessageEvent: event,
					message: { ...partialMessage },
				});
			}
			break;

		case "done":
		case "error": {
			const finalMessage = await response.result();
			if (addedPartial) {
				context.messages[context.messages.length - 1] = finalMessage;
			} else {
				context.messages.push(finalMessage);
			}
			if (!addedPartial) {
				await emit({ type: "message_start", message: { ...finalMessage } });
			}
			await emit({ type: "message_end", message: finalMessage });
			return finalMessage;
		}
	}
}
```

这里有**两组事件**，先分清。case 标签是**进站**事件——模型流回来的，类型是 `AssistantMessageEvent`，就是上文说的"流事件"，三组分别对应正文、思考过程、工具调用参数；`message_update` 是**出站**事件——`AgentEvent` 联合类型的一个成员，循环发给订阅者的。一进一出，这段代码负责把进站事件翻译成出站事件。

九种能共用一个函数体，原因写在 `AssistantMessageEvent` 的定义里：九个增量成员个个带一份**完整的** `partial` 快照——不是增量，是"到目前为止的整条消息"（终结的 `done`/`error` 则直接带最终消息）：

```typescript
// packages/ai/src/types.ts:510（仓库根起）
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
```

所以循环不需要分辨来的是哪一组：`partialMessage = event.partial` 整体换上，就地更新——覆盖的最后一格正是 `start` 时 `push` 进去占位的那个。`if (partialMessage)` 的守卫防的是不守规矩的流：类型注释写明 "Streams should emit `start` before partial updates"，正常实现里 `start` 一定先来；万一增量抢跑，没处放就跳过。三组的差别去哪了？塞进出站事件的 `assistantMessageEvent` 字段——字段名和进站类型同名不是巧合，它的类型就是上面那个：

```typescript
// src/types.ts:432（AgentEvent 联合类型的一个成员，竖线是"或"）
| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
```

订阅者看 `message_update.assistantMessageEvent.type` 就能分辨正在流的是哪一组——UI 据此把增量渲染成正文、灰阶的思考块，还是工具调用的参数。

收到 `done`（或 `error`），`response.result()` 取出最终消息：正常情况它替换 `start` 时占的那一格；万一之前连 `start` 都没来过（`addedPartial` 还是 `false`——和上面 `if (partialMessage)` 的守卫防的是同一种不守规矩的流），就新 `push` 一格并补发 `message_start`（拆成两个 `if` 而不是把补发合写进 `else`，只是写法习惯，两者等价——同一函数末尾、循环正常结束的兜底分支就是合写的）。最后 `message_end` 发出，`return finalMessage`，这一轮模型调用结束。这个函数发出的只是消息级的三种；`AgentEvent` 其他层级的来源，到本章「收尾」一节清点。

## 执行工具：先准备，再开火

assistant 消息里如果带着 `toolCall` 内容块，就进入工具执行。入口处有一个容易漏掉的守卫：

```typescript
// src/agent-loop.ts:208
// A "length" stop means the output was cut off by the token limit, so
// every tool call in the message may carry truncated arguments. Fail
// them all instead of executing potentially borked calls.
const executedToolBatch =
	message.stopReason === "length"
		? await failToolCallsFromTruncatedMessage(toolCalls, emit)
		: await executeToolCalls(currentContext, message, config, signal, emit);
```

输出被 token 上限截断时，每个工具调用的参数都可能是残缺的 JSON。**全部标记为错误，一个都不执行**，让模型自己重新发一遍。错误消息的措辞直接把原因告诉模型：

```typescript
// src/agent-loop.ts:395（failToolCallsFromTruncatedMessage 内）
result: createErrorToolResult(
	`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
),
```

正常情况下，进入 `executeToolCalls`（`src/agent-loop.ts:411`），每个工具调用走三段管线。这里跟一遍主路就够，管线的完整契约留给第 7 章。

**第一段，prepare**：找到工具、跑 `prepareArguments` 兼容层、按 schema 校验参数、问 `beforeToolCall` 是否放行。找不到工具直接变成"立即完成"的错误结果：

```typescript
// src/agent-loop.ts:607（prepareToolCall 内）
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
	return {
		kind: "immediate",
		result: createErrorToolResult(`Tool ${toolCall.name} not found`),
		isError: true,
	};
}
```

`beforeToolCall` 有权拦截。它是可选槽位，有才问；问的时候递上 assistant 消息、工具调用、校验后的参数和当前上下文，拿回一个 `BeforeToolCallResult`——返回 `undefined`（或空对象）就是放行，`block: true` 才拦，`reason` 成为错误结果的文本：

```typescript
// src/types.ts:61
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}
```

调用现场（中间那次 `signal?.aborted` 检查是「abort：无条件出口」一节讲过的常规岗哨）：

```typescript
// src/agent-loop.ts:619（prepareToolCall 内）
if (config.beforeToolCall) {
	const beforeResult = await config.beforeToolCall(
		{
			assistantMessage,
			toolCall,
			args: validatedArgs,
			context: currentContext,
		},
		signal,
	);
	if (signal?.aborted) {
		return {
			kind: "immediate",
			result: createErrorToolResult("Operation aborted"),
			isError: true,
		};
	}
	if (beforeResult?.block) {
		return {
			kind: "immediate",
			result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
			isError: true,
		};
	}
}
```

**第二段，execute**：调工具的 `execute()`。工具抛异常没关系——抓住，包成 `isError: true` 的结果：

```typescript
// src/agent-loop.ts:675（executePreparedToolCall 内，删减）
try {
	const result = await prepared.tool.execute(
		prepared.toolCall.id,
		prepared.args as never,
		signal,
		(partialResult) => { /* 转成 tool_execution_update 事件 */ },
	);
	// ...
	return { result, isError: false };
} catch (error) {
	// ...
	return {
		result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
		isError: true,
	};
}
```

**第三段，finalize**：问 `afterToolCall` 要不要改写结果——它递上当前的结果和错误旗，拿回一个补丁，逐字段覆盖，没提供的字段保持原值。hook 自己抛异常也有兜，和 execute 段一个待遇，包成 `isError: true`：

```typescript
// src/agent-loop.ts:717（finalizeExecutedToolCall 内）
let result = executed.result;
let isError = executed.isError;

if (config.afterToolCall) {
	try {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				...result,
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
				usage: afterResult.usage ?? result.usage,
				terminate: afterResult.terminate ?? result.terminate,
			};
			isError = afterResult.isError ?? isError;
		}
	} catch (error) {
		result = createErrorToolResult(error instanceof Error ? error.message : String(error));
		isError = true;
	}
}
```

并行还是顺序，取决于配置和工具自己的声明：

```typescript
// src/agent-loop.ts:419
const hasSequentialToolCall = toolCalls.some(
	(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
);
if (config.toolExecution === "sequential" || hasSequentialToolCall) {
	return executeToolCallsSequential(/* ... */);
}
return executeToolCallsParallel(/* ... */);
```

默认 parallel——所有工具先逐个 prepare（`beforeToolCall` 按声明顺序被调用），然后放行的并发执行，`tool_execution_end` 按**完成顺序**发出；但落到消息流里的 toolResult 消息仍按 assistant 消息里的**声明顺序**排列：

```typescript
// src/agent-loop.ts:540（executeToolCallsParallel 内）
const orderedFinalizedCalls = await Promise.all(
	finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
);
const messages: ToolResultMessage[] = [];
for (const finalized of orderedFinalizedCalls) {   // orderedFinalizedCalls 保持声明顺序
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	messages.push(toolResultMessage);
}
```

只要批量里有一个工具声明了 `executionMode: "sequential"`，整批退化为逐个执行。工具结果变成 `toolResult` 消息进上下文，`turn_end` 发出，一个 turn 结束。

## 收尾：事件如何落地

`AgentEvent` 的事件分属四个层级，不同层级各有来源：

```
run      agent_start · agent_end  ← 骨架（「agent 循环的两层结构」）
turn     turn_start · turn_end  ← 骨架，内层循环每圈
message  message_start · message_update · message_end  ← 回流（assistant）· 注入（prompt、插队、follow-up）
tool     tool_execution_start · _update · _end  ← 工具管线（「执行工具」）
```

四个层级的事件全都流过 `Agent.processEvents`。它做两件事：先把事件**归约**进状态（`message_end` 把消息推进 `state.messages`，`tool_execution_start` 把 id 加进 `pendingToolCalls`），然后**逐个 await 所有订阅者**：

```typescript
// src/agent.ts:540（Agent.processEvents 内，删减）
private async processEvents(event: AgentEvent): Promise<void> {
	switch (event.type) {
		case "message_end":
			this._state.streamingMessage = undefined;
			this._state.messages.push(event.message);
			break;
		case "tool_execution_start": { /* pendingToolCalls.add(...) */ }
		// ...
	}

	const signal = this.activeRun?.abortController.signal;
	if (!signal) {
		throw new Error("Agent listener invoked outside active run");
	}
	for (const listener of this.listeners) {
		await listener(event, signal);
	}
}
```

前面「emit 的另一头」说过，"逐个 await"是 `Agent` 和裸循环之间最实质的差别——订阅者的异步处理是 run 结算的一部分。这里看到的是它的收尾形态：`agent_end` 发出 ≠ run 结束；所有 `agent_end` 监听器跑完，`finishRun()` 清掉运行时状态，`waitForIdle()` 才 resolve：

```typescript
// src/agent.ts:525（Agent.finishRun 内）
private finishRun(): void {
	this._state.isStreaming = false;
	this._state.streamingMessage = undefined;
	this._state.pendingToolCalls = new Set<string>();
	this.activeRun?.resolve();
	this.activeRun = undefined;
}
```

这意味着你可以放心地在 `agent_end` 监听器里写数据库——循环会等你。

## 一章小结

一次 `prompt()` 的全程：

```
prompt() → runPromptMessages → runWithLifecycle → runAgentLoop(快照, 装配) → runLoop
  ├─ transformContext → convertToLlm → streamFn（流式）
  ├─ prepare → execute → finalize（工具三段管线）
  ├─ turn_end → prepareNextTurn? → shouldStopAfterTurn? → steering?
  └─ follow-up? → 外层再来一圈
→ agent_end → await 所有监听器 → finishRun
```

turn 结束后的四个决策点，按代码里的询问顺序（对照骨架引文 `src/agent-loop.ts:226-272`）：

1. `prepareNextTurn`——换不换下一圈的装备？见"岔路"一节。
2. `shouldStopAfterTurn`——要不要体面地停？见"agent 循环什么时候停"。
3. steering poll——有没有人插队？有则注入，内层再转一圈；见"内层循环"（与 follow-up 的对比在"外层循环"）。
4. follow-up poll——真要停了，有没有人留了后话？有则外层续命；见"外层循环"。

四个都落空，发 `agent_end`，`runLoop` 返回。abort 不在这条链上：它不等 turn 结束，随时生效（见"agent 循环什么时候停"的 abort 小节）。

下一章把这一章路过的所有模块摆到一张图上，讲清楚谁依赖谁、依赖方向为什么是这个方向。

## 为什么不去

> **为什么并发 `prompt()` 直接抛错，而不是自动排队等上一轮？** 因为自动排队会把"想插队还是想等结束"的决策藏起来——而这正是 steer 和 followUp 两种语义的分野（见下一张）。库的选择是把决策显式化：流式期间再调 `prompt()` 就 throw，错误信息直接把三条出路报给你（CHANGELOG 0.32.0："preventing race conditions and corrupted state"）：
>
> ```typescript
> // src/agent.ts:347（Agent.prompt 内）
> if (this.activeRun) {
> 	throw new Error(
> 		"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
> 	);
> }
> ```

> **为什么队列拆成 steer / followUp 两条，而不是一个 `queueMessage`？** 因为旧名字撒谎：`queueMessage()` 名为"排队"，实际行为是插队——运行中发来的消息在工具间隙就注入，而用户对 "queue" 的期待是"等 agent 真正结束后按序处理"。issue #403 的标题就叫 "Queued Messages vs Steering: Mental Model Conflict"：*"When a user types a message while the agent is working, it's called 'queued' but actually functions as a steering/interrupt mechanism."* 两种语义共用一个名字，两边都被误解；拆开之后各得其所——`steer()` 打断当前 run，`followUp()` 等 agent 将要停止才投递（commit `d0a4c3702`，CHANGELOG 0.32.0）。注入管线本身仍共用一条，就是「外层循环：为 follow-up 续命」一节那句"steering 和 follow-up 共用一套机制"。

> **为什么 `shouldStopAfterTurn` 不是加强版 abort？** abort 立刻切断 provider 流、`stopReason` 变 `aborted`；这个回调等当前 turn 完整结束、`turn_end` 发出之后，在 poll 队列和下一次 LLM 调用之前退出——不动流、不取消运行中的工具、不改 `stopReason`。动机写在 JSDoc 里：context 快满时体面收束（另一个真实场景是服务关停时的交接，issue #4118）：
>
> ```typescript
> // src/types.ts:208（AgentLoopConfig.shouldStopAfterTurn 的 JSDoc，删减：行为细节与契约两句）
>  * Called after each turn fully completes and `turn_end` has been emitted.
>  * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
>  * without starting another LLM call.
>  * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
> ```

> **为什么 emit 要逐个 await 订阅者，而不是 fire-and-forget？** 因为监听器的典型工作是落盘、flush——推出去不等，run 返回时写入可能还没完成。所以订阅者的异步处理被算进 run 的结算：`agent_end` 只代表"循环不再发事件"，idle 要等它的监听器全部 settle。这个语义是 commit `9022a5b5e` 修出来的——此前监听器的 Promise 没人等：
>
> ```typescript
> // src/agent.ts:241（Agent.subscribe 的 JSDoc，删减：开头一句与 abort signal 一句）
>  * Listener promises are awaited in subscription order and are included in
>  * the current run's settlement.
>  *
>  * `agent_end` is the final emitted event for a run, but the agent does not
>  * become idle until all awaited listeners for that event have settled.
> ```

> **为什么并行执行还要分 prepare / execute 两段，而不是每个工具调用自成一条异步任务？** 因为 `beforeToolCall` 需要看到完整的一批：权限系统常常要按"这条 assistant 消息总共想干什么"来决策，而不是逐个孤立判断。顺序 prepare 保证了 hook 看到的顺序和模型声明的顺序一致；并发只发生在"放行之后"。注释里把这个契约写死了：
>
> ```typescript
> // src/types.ts:36
> // - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
> //   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
> //   while tool-result message artifacts are emitted later in assistant source order.
> ```
>
> 两种顺序各管各的——事件流服务于"尽快让 UI 更新"，消息流服务于"让转写可重放"。

> **为什么不执行"抢救"回来的截断工具调用？** 输出被 token 上限截断时，流式累积的半截参数会被一个"尽力抢救"的 JSON 解析器补全——补全后能解析、能过 schema 校验，但可能**悄悄不完整**：少的是哪个字段，无从分辨。所以整批一个都不执行，让模型自己重发（PR #6285；评审中还否掉过一个更细粒度的方案——给 `ToolCall` 加 `malformedArguments` 字段、把判断推给调用方）：
>
> ```typescript
> // src/agent-loop.ts:374（failToolCallsFromTruncatedMessage 的注释）
> /**
>  * Fail all tool calls from an assistant message that was truncated by the
>  * output token limit. Streamed tool-call arguments are finalized with a
>  * best-effort JSON salvage parser, so a truncated message can yield tool calls
>  * whose arguments parse and validate but are silently incomplete. None of them
>  * are safe to execute; report each as an error so the model can re-issue them.
>  */
> ```
