# Chapter 2 · One prompt end to end: from prompt() to agent_end

The previous chapter said what this package is. This chapter has no opinions—just one job: follow the call `agent.prompt("读一下 config.json")` and walk the control flow from start to finish. By the end of this chapter, every module in the chapters ahead will already be familiar.

## Departure: Agent.prompt

The entry point is `Agent.prompt()`:

```typescript
// src/agent.ts:344 (Agent.prompt)
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

The first thing it does has nothing to do with AI: it checks `activeRun`. **A single Agent instance runs only one run at a time**—to cut in line, use the `steer()` or `followUp()` queues; more on that later.

`prompt()` hands the normalized messages to `runPromptMessages`, where you can see how all subsequent preparation is wired:

```typescript
// src/agent.ts:405 (Agent.runPromptMessages)
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

Note the order: `runWithLifecycle` wraps the outside, while `createContextSnapshot()` and `createLoopConfig(options)` are arguments to `runAgentLoop`—they are evaluated only when the executor actually runs, that is, **after** the lifecycle is set up. Look at what each of those two arguments prepares.

First, snapshot the context:

```typescript
// src/agent.ts:433 (Agent.createContextSnapshot)
private createContextSnapshot(): AgentContext {
	return {
		systemPrompt: this._state.systemPrompt,
		messages: this._state.messages.slice(),
		tools: this._state.tools.slice(),
	};
}
```

Note that the messages array is a **shallow copy**—the loop will push new messages into it, but it cannot replace the caller's array reference.

Second, assemble the loop config (`src/agent.ts:441`)—pack the callbacks on the `Agent` instance and the drain functions for the two queues into an `AgentLoopConfig`:

```typescript
// src/agent.ts:441 (Agent.createLoopConfig, trimmed)
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

Both arguments are ready. Back to the outer layer: `runWithLifecycle` creates an `AbortController`, registers `activeRun`, sets `isStreaming = true`, and only then runs the executor—which, in the snippet quoted above, evaluates the two arguments and calls `runAgentLoop`:

```typescript
// src/agent.ts:482 (Agent.runWithLifecycle, trimmed)
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
		await executor(abortController.signal);   // ← snapshot, assemble, and runAgentLoop all happen here
	} catch (error) {
		await this.handleRunFailure(error, abortController.signal.aborted);
	} finally {
		this.finishRun();
	}
}
```

### Settlement and waitForIdle: waiting as a bystander

Those three lines with `promise`/`resolvePromise` are a "manually detonated Promise": the `new Promise` executor runs synchronously, so the moment construction finishes, `resolvePromise` already holds that Promise's resolve function. The Promise's purpose is best seen as three questions.

**When does it resolve?** Look at the structure of `runWithLifecycle`: `executor` finishes → `finishRun()` in `finally` → `resolvePromise()` is called. The moment this Promise resolves is the moment the "run is thoroughly over," which this chapter calls **settlement**—it comes later than when the `agent_end` event is emitted; what that extra beat is for will matter in the deadlock section below.

**Who awaits it?** `waitForIdle()`:

```typescript
// src/agent.ts:328 (Agent.waitForIdle)
waitForIdle(): Promise<void> {
	return this.activeRun?.promise ?? Promise.resolve();
}
```

When there is no active run, it returns an immediately resolved Promise—"already idle, no need to wait."

**Why is it needed?** After all, `await agent.prompt(...)` itself also waits until settlement (`prompt` → `runPromptMessages` → `await runWithLifecycle`, one chain). The difference is that **the waiter is not necessarily the initiator**. `prompt()` need not be awaited at all—fire and forget, let the UI update via event subscriptions; meanwhile code in another corner (cleanup before exit, assertions in tests, a guard before `reset()`) needs a way to "wait until it is thoroughly quiet," and it does not hold the Promise returned by `prompt()`, only an `agent` reference. `waitForIdle()` is the public notice board for that "bystander wait": hang the Promise out so anyone can wait, and leave the resolve trigger solely to finishing `finishRun()` (`src/agent.ts:529`; the "wrap-up" section of this chapter has the full quote)—**many wait; only one announces the end.**

**Where is it called?** There is no call site in this package's own production code—`waitForIdle()` is a pure public API. Real usage in the repo falls into three kinds. First, tests, waiting to settle before asserting:

```typescript
// test/agent.test.ts:246 (trimmed)
const promptPromise = agent.prompt("hello");
const idlePromise = agent.waitForIdle().then(() => {
	idleResolved = true;
});
// ... after 10ms assert idleResolved is still false (the barrier in the subscriber has not released yet)
```

Second, non-interactive scripts by SDK users: do not await `prompt()`, drive the UI with events, and finally wait for quiet in one place (the example in `packages/coding-agent/docs/sdk.md` does exactly this). Third, abort flows in downstream wrapper layers—after Stop is pressed, you must wait until it is truly quiet before returning:

```typescript
// packages/coding-agent/src/core/agent-session.ts:1541 (from repo root, AgentSession.abort)
async abort(): Promise<void> {
	this.abortRetry();
	this.agent.abort();
	await this.waitForIdle();
}
```

Note that what is awaited here is `AgentSession.waitForIdle()`, not `Agent`'s—session reimplements it at its own layer:

```typescript
// packages/coding-agent/src/core/agent-session.ts:1547 (from repo root, AgentSession.waitForIdle)
async waitForIdle(): Promise<void> {
	if (this.isIdle) {
		return;
	}
	await this._getIdleWaitPromise();
}
```

`AgentHarness` likewise has its own version. Why don't downstream layers simply delegate to `agent.waitForIdle()`? Because each layer's definition of "quiet" differs: session-layer idle looks at more than the agent run—retries, persistence, and other state count too. So they each answer with **the same pattern**—`_getIdleWaitPromise` is another manually detonated Promise:

```typescript
// packages/coding-agent/src/core/agent-session.ts:568 (from repo root, AgentSession._getIdleWaitPromise, trimmed)
private _getIdleWaitPromise(): Promise<void> {
	if (!this._idleWaitPromise) {
		this._idleWaitPromise = new Promise((resolve) => {
			this._resolveIdleWait = resolve;   // same pattern: pull resolve out and stash it at construction
		});
	}
	return this._idleWaitPromise;
}
```

**The same question, and every layer must answer again what "quiet" means at that layer**; the pattern is copied, the answer cannot be reused. Chapters 8 and 9 will show each layer's answer.

**So why must `Agent.waitForIdle()` itself exist?** That nobody inside the package calls it is not evidence of redundancy—it is the normal shape of a "library": callers of the public API live outside the library. The reason it must exist is that "whether the run has thoroughly settled" is **private knowledge** of `Agent`. `activeRun` is a private field; the latest signal outsiders can observe is the `agent_end` event—but emitting an event ≠ finishing the listeners, so treating it as a settlement signal is one beat early. If the library does not hang this answer out, outsiders can only guess wrong.

**The flip side of the guarantee: awaiting it inside a listener deadlocks.** The same settlement semantics, standing in the wrong place, become a trap. Lay out the dependency: inside a listener, `await agent.waitForIdle()` waits for settlement; settlement is waiting for you—`processEvents` `await`s listeners one by one (see the push-mode part of the later "the other end of emit" section), and until you return, `executor` is not done, so `activeRun.promise` does not resolve; you are waiting for it to resolve—the cycle closes. No threads required; a Promise dependency cycle is enough, and no timeout or abort can break it: this run hangs forever, and neither `waitForIdle()` nor `prompt()` ever settles. Note this is not only an `agent_end` listener problem—calling it from any event's listener is the same, because as long as the run has not ended, the resolve condition for `activeRun.promise` includes "this current listener returns." The harness-layer design doc spells the pit clearly:

> listeners/hooks currently receive no facade; if they close over the raw harness and call settlement APIs such as `waitForIdle()` during the active run, they can deadlock. A future facade should expose `runWhenIdle()` instead.
>
> — `docs/agent-harness.md:18` (from repo root)

`runWhenIdle()`'s way out is to reverse the direction; the signature itself shows the usage:

```typescript
// docs/harness-v2.md:730 (from repo root, design doc)
runWhenIdle(callback: () => void | Promise<void>): Promise<void>;   // runtime-only
```

You pass the callback in, your listener returns normally, settlement completes as usual; after the chain finishes the harness calls that callback, and the returned Promise resolves only after the callback finishes—from the moment you register, you are no longer in the dependency cycle. Note it is still only a plan: both the v1 and v2 design drafts have only this one-line signature; there is no implementation in code yet. Remember the boundary in one sentence: **`waitForIdle()` is a bystander's tool; participants must not touch it.**

### Aside: two patterns—executor and signal

The signature of `runWithLifecycle` holds two patterns worth unpacking; they show up again and again later (especially Chapter 13).

**Pattern one: the executor callback ("you bring the work; I handle before and after").** `runWithLifecycle` does no work itself; it takes a function `(signal) => Promise<void>` as an argument. Why not have it call `runAgentLoop` directly? Because two callers want to share the same "before/after paperwork" but do different work—`runPromptMessages` runs `runAgentLoop`, `runContinuation` runs `runAgentLoopContinue` (`src/agent.ts:421`):

```typescript
// src/agent.ts:421 (Agent.runContinuation)
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

Abstract the "work" into a parameter, and the before/after paperwork (create controller, register, set state, catch errors, wrap up) is written once. This pattern is sometimes called "template method" or "around execution"; the essence is separating the **invariant brackets** from the **variable contents**.

**Pattern two: AbortController / AbortSignal ("remote and wire").** This is a Web standard API, built into Node, unrelated to TypeScript. The rules are simple:

- `new AbortController()` creates a **remote**; the holder can press `.abort()` at any time.
- Each controller carries a "wire" `controller.signal` (`AbortSignal`) that can be passed arbitrarily downward. Whoever holds the signal cannot press the button—only **listen**: poll `signal.aborted`, or register `signal.addEventListener("abort", ...)`.

So this is a one-way cancel broadcast: **only the creator can cancel; all downstream can only obey.** Follow the signal's journey in `runWithLifecycle`: the controller is created here, the signal is handed to the executor → the executor passes it to `runAgentLoop` → the loop passes it on to `streamFn` (cancel the HTTP request) and each tool's `execute()` (stop a running command). The hand that presses the button is elsewhere:

```typescript
// src/agent.ts:319 (Agent.abort)
/** Abort the current run, if one is active. */
abort(): void {
	this.activeRun?.abortController.abort();
}
```

You click "Stop" in the UI → `agent.abort()` → the controller is pressed. Note that `abort()` itself has no queue or timing judgment—it is a synchronous button press, so "when it stops" does not depend on where the loop has turned, but on **how fast each of the three parties that hear the broadcast responds**. View it at three moments:

**While streaming (the model is still speaking).** The signal was already handed into `streamFn` when the request was made:

```typescript
// src/agent-loop.ts:308 (inside streamAssistantResponse)
const response = await streamFunction(config.model, llmContext, {
	...config,
	apiKey: resolvedApiKey,
	signal,
});
```

The HTTP layer cuts the stream immediately; by the `StreamFn` contract (Chapter 3), this request ends with an assistant message whose `stopReason: "aborted"`. The loop then takes the `error || aborted` branch in the skeleton: emit `turn_end`, emit `agent_end`, return from the whole run—**without waiting for this turn to finish**.

**While executing a tool (e.g. bash still running).** The loop does not hard-kill the tool: the signal is in `execute()`'s arguments (see the quote in this chapter's "Executing tools" section); how to respond is the tool's own business—built-in bash kills the child process (Chapter 11). The loop's promise on its side is "open no new work": prepare has a check; an already-pressed signal turns not-yet-started tool calls into error results:

```typescript
// src/agent-loop.ts:644 (inside prepareToolCall)
if (signal?.aborted) {
	return {
		kind: "immediate",
		result: createErrorToolResult("Operation aborted"),
		isError: true,
	};
}
```

In sequential execution, after each tool finishes there is another check; if pressed, the rest of the batch is interrupted:

```typescript
// src/agent-loop.ts:478 (inside executeToolCallsSequential)
if (signal?.aborted) {
	break;
}
```

**Between turns.** The next lap still carries that already-pressed signal into `streamFn`, so it falls immediately into the first case—this "idle lap" produces no real request.

The three moments share one point: **abort ends the whole run, not the current turn.** That branch in the skeleton is `return`, not `continue`—ESC means "this run ends here"; the two queues are no longer polled. And the event sequence stays complete: `turn_end` and `agent_end` still fire, listeners still wait, `waitForIdle()` still resolves—cancel is not pulling the plug; it is finishing a normal wrap-up path as fast as possible.

Finally, note that signal is usually optional in signatures (`AbortSignal | undefined`)—the bare loop may run in environments with no cancel need, so downstream checks are always written `signal?.aborted`.

## The agent loop's two-layer structure

`runAgentLoop` first appends the prompt messages into the context, emits `agent_start`, `turn_start`, and the prompt's own `message_start`/`message_end`, then hands control to the real engine `runLoop`:

```typescript
// src/agent-loop.ts:95 (trimmed)
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

So where in this "real engine" `runLoop` is the loop? First clarify what "loop" means. Everyday talk of the "agent loop" is the **model → tools → model** round trip: the model produces tool calls, tool results are fed back to the model, the model produces again, until there are no more tool calls. That round trip is not recursion in the code—it is iteration, a `while` inside `runLoop`. And `runLoop` actually has **two** `while`s; that is the literal origin of the "two-layer structure." Here is the real code (only two function bodies unrelated to loop structure are collapsed):

```typescript
// src/agent-loop.ts:155 (prepareNextTurn block collapsed—it is a Detour, not the trunk; see this section's "Detour" subsection; otherwise line-faithful)
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
				// ... ("length" truncation guard; see this chapter's "Executing tools" section)
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

			// ... (prepareNextTurn: Detour that swaps the snapshot between laps; collapsed; see the dedicated subsection below)

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

### Aside: the message trio and content blocks

Before analyzing this skeleton, fill in a lesson on the basic data structures of LLM apps—`message`, `toolResults`, and `pendingMessages` in the skeleton are all of them. The whole conversation history is a `Message` array, and `Message` has only three roles:

```typescript
// packages/ai/src/types.ts:442 (from repo root)
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

The three roles map to the three moves of the dialogue protocol: **user speaks**, **assistant acts**, **toolResult feeds tool results back**. The loop's "model → tools → model" round trip, in data terms, is assistant messages and toolResult messages alternating as appends to the array. Their shapes (fields trimmed; the trunk remains):

```typescript
// packages/ai/src/types.ts:402 / :408 / :424 (from repo root, trimmed)
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	stopReason: StopReason;   // why this turn stopped: finished speaking / wants tools / error / truncated …
	// ... (metadata: api / provider / model / usage / errorMessage, etc.)
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;   // points back to that ToolCall block's id in the assistant message
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}
```

Three roles, and that is the ceiling—the system prompt is not in this array; it is a separate field on `Context`, attached with each request. As for what to do if an application wants a fourth role (notifications, summary markers), that is a fulcrum question for Chapter 3; for now remember "the LLM only recognizes these three roles."

Note the type of `AssistantMessage.content`: **not a string, but an array of content blocks**. One assistant message is a sequence of blocks, each one of three:

```typescript
// packages/ai/src/types.ts:347 / :353 / :369 (from repo root, trimmed)
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
	id: string;                        // for toolResult to point back
	name: string;                      // which tool to call
	arguments: Record<string, any>;    // model-generated arguments
	// ...
}
```

Blocks are ordered as the model produced them, so one message can "think a bit, say a bit, call two tools," all interleaved in the same array. Here one intuition from naming needs breaking: `message` sounds like "one sentence," but it is actually a container for **the model's entire output for one turn**—"turn" is the unit, not "sentence." With that shape, the `filter` in the skeleton quote makes sense: **"whether the model has work to do this step" = "whether this array has any block with `type: "toolCall"`"**. Text and thinking blocks do not enter the tool pipeline; they are only dialogue content, left in the array to ride into context with the message.

### Inner loop: one lap = one turn

Now we can answer "where is the loop." **One lap of the inner `while` = one turn**: inject cut-in messages (if any) → call the model once → execute tools (if any) → `turn_end`. Its exit condition `hasMoreToolCalls || pendingMessages.length > 0` reads as "the model asked for no new tools, and nobody cut in"—everyday talk of "the agent is done" is, in code, this condition becoming false.

At the start of each lap, emit another `turn_start`—**except the first lap**. The `firstTurn` flag in the quote is for that: the first lap's `turn_start` was already emitted by `runAgentLoop` before entering `runLoop` (the `src/agent-loop.ts:110` quoted above); without suppressing it, subscribers would see two adjacent `turn_start`s. The flag has no other use—pure event deduplication.

If you have heard of ReAct (Reason + Act), the classic agent paradigm, the inner loop is exactly that—only the names here are plainer: **Reason** is the assistant message produced by `streamAssistantResponse` (`thinking_*` stream events are the reasoning process unfolding before your eyes), **Act** is handing the toolCall blocks in the message to `executeToolCalls`, **Observe** is pushing toolResult messages into `currentContext.messages`—then back to the top of the lap, the model reasons another round from all observations so far. pi-agent-core did not invent a new paradigm; it split one ReAct lap into a dozen or so observable, interceptable, cancelable events and hooks.

### When the agent loop stops: three ways to stop

The inner loop's exit condition has two parts that must both hold: this round the model asked for no new tools (`hasMoreToolCalls` is false), and nobody cut in (`pendingMessages` is empty)—the moment `while (hasMoreToolCalls || pendingMessages.length > 0)` in the skeleton becomes false. That is the normal exit. The loop also has two early-stop paths: graceful wrap-up via the host callback `shouldStopAfterTurn`, and unconditional stop via `abort()`. This section takes the three stop ways one by one.

#### Decided by toolCall: the normal exit and the terminate flag

Here is a misreading worth clearing: **the loop's normal exit is the model "no longer calling tools," unrelated to raising a flag.** Look at the shape of the tool block in the quote: after `hasMoreToolCalls = false`, only when `toolCalls.length > 0` do we enter the execution block and possibly set it back to `true`. When the model produces a pure-text message, the whole if is skipped, the flag stays `false`, and the loop exits. So the initiative to end always sits with the model—when it thinks the task is done, it just speaks; raising a flag only covers the special case where "the last action happens to be a tool call," sparing a round where the model has nothing useful to say. It is an optimization, not a termination mechanism.

The update rule for `hasMoreToolCalls` is worth a glance, because it is the switch for the "round trip": at the start of each lap it is unconditionally set to `false` (default: no next lap), then after tools run it is set back from `!executedToolBatch.terminate`. When is that `terminate` `false`? The decision function is only three lines:

```typescript
// src/agent-loop.ts:582
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```

Read the condition in the quote word by word: **every** (`every`) tool result in this batch has `terminate` **exactly equal to** `true`. That field's type is `boolean | undefined`—strict equality `=== true` makes "field not written" (`undefined`, the case for the vast majority of tools) count clearly as not raising the flag. With both conditions stacked, the bar is very high, so `terminate` being `false` (loop continues) is the vast majority:

1. **No tool raises the flag**—`terminate` is an optional hint on the tool result; most tools never set it; this is the most common `false`. The flag's definition in the type:

```typescript
// src/types.ts:364 (inside AgentToolResult)
/**
 * Hint that the agent should stop after the current tool batch.
 * Early termination only happens when every finalized tool result in the batch sets this to true.
 */
terminate?: boolean;
```

2. **Mixed batch**—two of three tools raised the flag, one did not; `every` fails, the whole batch continues (the semantics: "the flag takes effect only by unanimous vote," preventing one tool from unilaterally cutting off a batch others still need further processing for);
3. **Truncation-guard path**—the batch returned by `failToolCallsFromTruncatedMessage` hard-codes continue:

```typescript
// src/agent-loop.ts:405 (return of failToolCallsFromTruncatedMessage)
return { messages, terminate: false };
```

because the whole point of that batch is "make the model resend," so of course the loop must go back.

Conversely, `terminate: true` appears only when **every tool result in the batch explicitly raises the flag**. And whether to raise the flag is the **tool author's** decision, not the model's—the flag is written on the tool result; whatever `execute()` returns is what it is. The model's role is only to **choose which tool to call** (the author can guide it via prompt to call an end tool at the right time); the host can raise or lower the flag at finalize via `afterToolCall`. Three layers each own a stretch: **the author defines the semantics, the model chooses the timing, the host keeps veto power.**

What tools raise the flag? The repo has a real example (in an extension example in the sibling package `packages/coding-agent`); its file-header comment states the motive clearly:

```typescript
// packages/coding-agent/examples/extensions/structured-output.ts:1 (from repo root)
/**
 * Structured Output Tool
 *
 * Demonstrates `terminate: true` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */
```

The scenario: the user wants a structured answer (a JSON-ish summary, a list of action items); the model hands the answer **as arguments to a tool call**—`headline`, `summary`, `actionItems` are all in the parameters. All the tool does is accept and store:

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

That is the semantics of raising the flag: **"the tool result is the final answer; there is no follow-up work for the model."** Without the flag, the loop would call the model again as usual—the model could only pad another speech against a "saved" confirmation, and that LLM call would be pure waste (the file header's "paying for an extra follow-up LLM turn" is that bill). So this example's tool description specially tells the model "don't speak again after calling" (`promptGuidelines`, same file :24-27), and `terminate: true` makes it stick at the mechanism level.

There is a second entrance for the flag: the tool itself does not raise it; the `afterToolCall` hook raises it at finalize—`finalizeExecutedToolCall`'s field-by-field merge has `terminate: afterResult.terminate ?? result.terminate` (visible in the quote in this chapter's "Executing tools" section). That makes "whether to end early" a host-interceptable decision, not only a hard-code by the tool author.

Ask the reverse to think it through: **which tool results are not the final answer?** Almost every tool in this loop. Look at the four built-ins (Chapter 11 covers them in detail): `read`'s result is a stretch of file content—not an answer, but **material**; the model must finish reading before it can answer "what does this function do"; `bash` test output is a pile of output—the model must look before it knows which line to fix; `edit`'s result is a diff—the model must confirm the change was right before deciding the next step. These tools' information flow is **bidirectional**: arguments are instructions the model issued; results are observations fed back to the model; the loop's value sits in the "observe → decide → act again" round trip.

Tools like `structured_output` are **unidirectional**: the arguments themselves are the finished product (the model had already finished thinking when it initiated the call); the tool result is only a "saved" receipt—feed the receipt back to the model and it has nothing to say. So deciding whether a tool should raise the flag takes one sentence: **after this toolResult returns to the model's hands, does the model still have meaningful work to do?** If yes, ordinary tool; if no, end tool.

Is there a case that truly never stops? Yes, but the source is not "tools don't raise the flag"—it is **the model keeping issuing tool calls**—rereading files, rerunning tests without getting anywhere. The guardrail for that runaway is not inside the loop but outside: `agent.abort()` (a human presses Stop), `shouldStopAfterTurn` (the host decides after each turn whether to wrap up gracefully, e.g. context nearly full), and direct exit on `stopReason: "error"` when a model request fails. Note this package has no built-in "max turns"—it leaves that entire class of policy to the host, expressed through `shouldStopAfterTurn`.

#### shouldStopAfterTurn: graceful wrap-up at the turn boundary

`shouldStopAfterTurn` is the host's formal channel for "graceful wrap-up"; worth clarifying how it works. It is an optional callback on `AgentLoopConfig`, called after every `turn_end` and before polling the two queues (exactly that spot in the skeleton quote), receiving everything about the turn that just ended:

```typescript
// src/types.ts:121 (trimmed)
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

Return `true`, and the loop emits `agent_end` and exits—without even looking at the steering and follow-up queues; return `false` or return nothing, and everything continues as before.

"Not looking at the two queues" is itself a design decision, only it is written with **position**, not with if/else. Imagine another writing: peek at the queues before exiting—"if there are cut-in messages, still stop?"—then stop logic tangles with queue logic, sprouting combination branches like "want to stop but there are messages" / "don't stop but the queue is empty." pi's solution keeps the problem model simplest: **each callback answers only one question; questions not asked are left to the next run.** `shouldStopAfterTurn` only answers "should we stop"; if it says stop, the loop `return`s—that `return` line sits before the steering poll (`pendingMessages = (await config.getSteeringMessages?.()) || []`); the follow-up poll is still outside the inner loop, further back; the two poll lines never get to run. And a poll not run is not discarded: drain did not happen, messages still lie in the host's own queues, and the next run can still take them.

So every decision point's code is short enough to be one line, yet correctness depends on no combination judgment. Order itself is semantics: first ask "should we stop," then ask "is anyone queued." The entire point of the two queues is to let the run **continue**—steering adds work mid-flight, follow-up adds work after it would end—if the host just said stop, asking the queues again is self-contradictory: one queued message would forcibly open the lap the host just vetoed.

So where is the "function body"? **Not in this package.** This is the seam between loop and host: the loop only has the call site; the judgment logic is entirely provided by the host. The `Agent` class exposes it as a public assignable property, and at assemble time wraps it into the config:

```typescript
// src/agent.ts:456 (inside Agent.createLoopConfig)
shouldStopAfterTurn: shouldStopAfterTurn
	? async (context) => await shouldStopAfterTurn(context, this.signal)
	: undefined,
```

That wrapper does one thing: feed your callback an extra signal; if you did not set it, pass `undefined`, and the loop side's `?.` short-circuits to "don't stop." So what the real function body looks like is the application's business—e.g. "estimate current context token count; return `true` over threshold" is a typical context-management implementation:

```typescript
// sketch: request graceful wrap-up when context exceeds a threshold (application-side code, not in the pi repo)
function roughTokens(messages: AgentMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += JSON.stringify(m.content).length;
	}
	return Math.ceil(chars / 4);   // rough estimate: about 4 chars ≈ 1 token
}

agent.shouldStopAfterTurn = ({ context }) => {
	return roughTokens(context.messages) > 150_000;
};
```

The loop stops after this lap; the host takes over to compress or summarize, then opens the next run with new context—skipped queue messages still lie in the queues, and the new run's first poll can take them.

Three more details of this example are worth clarifying.

- **Threshold**: 150k is an example value; set it from the model's context window in practice—e.g. for a 200k-window model, reserve room for output and the system prompt, and brake around 150k.
- **Estimate**: `roughTokens` is a character-count rough estimate; a real implementation would use the model's tokenizer (harness compaction has formal token accounting, Chapter 10).
- **Granularity**: it only takes effect at turn boundaries—that is exactly what "graceful" means; it will not cut a turn mid-way, but waits until this lap is fully in the bag before stopping. If you want not to stop, but to swap context and keep running inside the same run, that is the `prepareNextTurn` Detour (this chapter's "Detour" section).

The difference from abort is **who calls and when**: abort is an external hard press at any time, effective immediately; `shouldStopAfterTurn` is the loop actively asking at the turn boundary "shall we stop here with dignity"—typical when context is nearly full and the host wants it to stop this lap so it can take over for compression or summary. Placed next to `prepareNextTurn` in this chapter's later "Detour" section, they are a pair of knobs: one asks "should we stop," the other asks "should we change harness for the next lap." The contract remains "failure becomes a value": do not throw, or the event sequence breaks (Chapter 3).

#### abort: the unconditional exit

`agent.abort()`'s granularity is worth stressing once more in the "exits" context: **abort ends the whole run, not the current turn.** It walks none of the conditions in this section—does not look at `hasMoreToolCalls`, does not wait for `shouldStopAfterTurn`, and no longer polls the two queues; the signal makes the in-flight (or next) model request finish with `stopReason: "aborted"`, hitting the `return` branch in the skeleton directly. How each of the three moments stops after the button is pressed was already unpacked in the earlier "Aside: two patterns—executor and signal" section; here just remember it is the **only unconditional exit**—every other exit in this section asks "should we continue"; only abort does not ask.

### Outer loop: keeping the run alive for follow-up

**One lap of the outer `while (true)` = one batch of follow-up.** After the inner loop is exhausted, the loop would normally end, but first it asks the follow-up queue: if someone is queued for "one more thing while you're at it," stuff them into `pendingMessages` and `continue` so the inner loop turns again; if not, `break`. The outer loop's entire reason for existing is that one question.

How `pendingMessages` is consumed is also worth a close look, because it is where the two queues converge. The inject block does three things: emit `message_start`/`message_end` one by one (for subscribers, cut-in messages have the same event sequence as ordinary messages), push into `currentContext` and `newMessages` (the next model request can see them), then clear the array (at most one batch per lap; how many in a batch depends on the queue's mode, `one-at-a-time` or `all`, Chapter 5). Note the inject point is **before calling the model**—cut-in messages always enter context ahead of the model's next reply. And when the outer loop keeps the run alive by assigning `followUpMessages` to `pendingMessages`, it walks that same inject pipeline: **steering and follow-up share one mechanism; the only difference is when they poll**—one asks after every turn, the other only when truly about to stop.

Why two layers, not one big while? Because the two queues' **check timing** differs: steering must be looked at after every turn (the user may cut in while the agent works); follow-up may be looked at only at the point where "the agent is truly about to stop." Merge into one loop and you must express two timings in one condition; the code grows odd flags. Two whiles each own one timing; the conditions read as the business semantics themselves.

Also note how state is passed across iterations: `currentContext`, `newMessages`, and `config` are all parameters or local bindings of `runLoop`, mutated in place each lap (push messages, swap snapshots), and the next lap continues with them. No recursion, so no stack-depth problem and no "each call layer holds its own context" copy cost—**the loop's state machine is flat**.

Does "mutate in place" mutate outside the loop? The two arrays must be separated. `newMessages` does—and **on purpose**: `runAgentLoop` creates it (`[...prompts]`), hands it to `runLoop` to fill, then `return`s that same array to the caller (see the `runAgentLoop` quote at the start of this section); pushing in place is exactly the result channel. `currentContext.messages` does not: when `runAgentLoop` builds the context it starts a new array (`[...context.messages, ...prompts]`); no matter how many the loop pushes, the caller's `context.messages` does not move.

It is worth pausing on the signatures of these six parameters—they are the loop's entire external interface. `prompts` and the return value are both `AgentMessage[]`; `signal` is an optional `AbortSignal`; `streamFn` is the `StreamFn` quoted in Chapter 1 (`src/types.ts:28`). The remaining three:

```typescript
// src/agent-loop.ts:25 — event exit; accepts sync or async
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

```typescript
// src/types.ts:406 — the "current conversation" as the loop sees it
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}
```

`config: AgentLoopConfig` (`src/types.ts:144`) is the largest piece—model, gates, hooks, queue polling all live in it; Chapter 5 will unpack field by field. For now remember the division of labor: `context` is **data** (what to say), `config` is **behavior** (how to say it, what to do after saying it), `emit` is **the exit** (who hears it).

### Detour: swapping the snapshot between laps (prepareNextTurn)

The block collapsed in the trunk quote, now expanded. After every `turn_end` and before the next steering poll, it gives the host a chance to "swap the next lap's harness."

Honestly: this Detour is this chapter's hidden boss—contract, adaptation, and implementation span three layers, plus naming collisions and stacked installation; difficulty sits above the chapter average. If you cannot beat it, skip for now; the main line still clears; come back after later chapters level you up. The next few sections land on each layer in turn; first the map:

- **agent loop layer** (`agent-loop.ts`): defines the contract—ask once at the end of each lap; merge the returned snapshot field by field with `??`;
- **Agent layer** (`agent.ts`): exposes the contract as two assignable public properties; at assemble time normalizes them into the single signature the loop knows;
- **host layer** (coding-agent / harness): the real implementation—stacked installation, or rebuild the snapshot after persisting to disk.

First the agent loop layer's contract:

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

The question it answers: **mid-run, the host wants to swap context, model, or thinking strength—what then?**

Two semantic details are worth remembering. One is the merge: every field of the snapshot may be omitted; omit and `??` falls back to the current value—the host can swap only the model and leave context alone, or vice versa. Two is that `thinkingLevel: "off"` is explicitly translated to `reasoning: undefined`, because the downstream (`SimpleStreamOptions`) contract expresses off as "no reasoning field," not `"off"`—that three-layer ternary is vocabulary alignment.

Timing also matters: the swap happens after `turn_end` and before the steering poll. That means even if the next lap is to answer a cut-in message, it already uses the new snapshot—cutting in does not cost the host the chance to swap harness.

#### Seam: two names, one adapter

The Agent layer on the map. The name `prepareNextTurn` appears in three places at this layer, and `prepareNextTurnWithContext` in two—none of them the same thing. Separate the three places first:

- **Entry**: the two same-named keys on `AgentOptions`—where the host passes the functions in when constructing `Agent`;
- **Slots**: the two public properties on the `Agent` instance (`src/agent.ts:197`, citation below)—`Agent` only defines the signatures and supplies no implementation itself; the implementation is passed in from outside, so we call them slots;
- **Exit**: the single key `prepareNextTurn` on `AgentLoopConfig`—normalized from the slots at assemble time (citation below).

The entry is the constructor's options bag: `Agent`'s constructor takes only one argument, typed `AgentOptions`, and those two same-named keys live on that type:

```typescript
// src/agent.ts:216 (start of Agent constructor)
constructor(options: AgentOptions) {
	// Older compiled consumers may omit options or streamFn even though the current API requires them.
	const runtimeOptions: Partial<AgentOptions> = options ?? {};
```

From entry to slots is the constructor's routine copy, same treatment as every other callback:

```typescript
// src/agent.ts:229 (inside Agent constructor)
this.prepareNextTurn = runtimeOptions.prepareNextTurn;
this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
```

`runtimeOptions` is that defensive alias in the signature citation above—the source comment says who it guards against: older compiled consumers may not pass options at all. Besides passing at construction, the host can also bypass the entry at runtime and assign the slots directly for replacement—coding-agent takes that path; see below.

The slot declarations:

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

The only difference between the two slots is the first parameter: the old version gets only a signal; the new version also gets info about the turn that just ended; the return value is identical—that three-field snapshot merged field by field with `??` in the citation at the start of this Detour. At assemble time `Agent` reads these two slots and normalizes them into the single name at the exit:

```typescript
// src/agent.ts:459 (inside Agent.createLoopConfig, the returned object literal—i.e. AgentLoopConfig; remaining keys collapsed—those from this chapter's opening assemble citation)
return {
	// ... (model, convertToLlm, queue polling, and other keys)
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

The reason two names coexist is compatibility: the old public property's signature cannot be changed outright (CHANGELOG 0.80.3 records this history); anyone who needs turn info uses the new version. The "adapter" in the title is this wrapper: the two signatures the host supplies do not match the one signature the agent loop wants, so it translates in the middle—always exposing the `(context)` shape to the loop, and looking inward at which slot is filled; the new version forwards `context`, the old version drops `context` and forwards only `signal`.

Looking back at those three places while reading this citation, the boundary is now visible in the quote: this object literal in the `return` is **`AgentLoopConfig`**—the left-hand `prepareNextTurn:` is its key (**exit**), and the loop calls it with context (the citation at the start of this Detour); while `this.prepareNextTurnWithContext` / `this.prepareNextTurn` inside the function body are slots on the **`Agent` instance**, read for their current values only when the loop invokes them each lap. So "it references itself before it is defined" does not hold: the key being defined belongs to `AgentLoopConfig`, the properties being read belong to `Agent`—two types, two objects, only the names collide; if `this.prepareNextTurn` were also a key of this literal, that would truly be self-reference. The slots were already filled at construction or at runtime; here they are only wrapped for normalization.

#### Implementation: stacking and rebuilding

One layer down to the host. This repo has two real implementations of the hook, and the approaches are opposite: coding-agent stacks a layer, rereading systemPrompt, the tool list, model, and thinking strength every lap—

```typescript
// packages/coding-agent/src/core/agent-session.ts:526 (from repo root, AgentSession._installAgentNextTurnRefresh)
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

Assignment replaces the whole function already in the slot, so coding-agent's install is not a simple replace but **stacking a layer**: first capture the old value into `previousPrepareNextTurnWithContext`; the new function calls it first, lays its snapshot underneath, then overlays and refreshes four fields—values all read live from `state`, so a mid-run switch takes effect on the next lap. (`this.agent.state` goes through `Agent`'s public accessor, the same object as `this._state` in the agent.ts citations. Accessors are syntactic sugar in TypeScript; see the "the other end of emit" section for details.)

Where does the old value come from? On coding-agent's own assemble path there would be none—its sdk does not pass this property when it `new Agent`s internally, so `AgentSession` always faces an empty slot; what it guards against is an SDK user who set their own function on the slot before `AgentSession` takes over (the constructor options accept these two properties; see the earlier "Seam" section)—that capture is what keeps that path alive too.

harness's implementation is another style: each lap first flushes deferred writes piled up during the run to disk, then rebuilds the whole snapshot from the session:

```typescript
// src/harness/agent-harness.ts:527 (inside AgentHarness.createLoopConfig, trimmed)
prepareNextTurn: async () => {
	await this.flushPendingSessionWrites();
	const nextTurnState = await this.createTurnState();
	setTurnState(nextTurnState);   // so the event and hook sides also see the new snapshot
	return {
		context: this.createContext(nextTurnState),
		model: nextTurnState.model,
		thinkingLevel: nextTurnState.thinkingLevel,
	};
},
```

#### Another use: in-run compression

And compression? As a host, coding-agent's choice is to do it **between runs**—the `shouldStopAfterTurn` path in the earlier "When the agent loop stops" section: stop on this lap, the host compresses, start a new run (Chapter 10 covers the details). But "don't interrupt the run; swap the context inside a lap" is exactly this hook's exclusive capability—the library leaves that path for hosts that need it, looking like this:

```typescript
// Sketch: in-run compression (application-side code, not in the pi repo—coding-agent does compression between runs; see above)
agent.prepareNextTurnWithContext = async ({ context }) => {
	if (roughTokens(context.messages) <= 150_000) {
		return undefined;   // no swap needed yet: return undefined; the loop keeps the current context
	}
	const summary = await summarize(context.messages);   // the host's own compression logic
	return {
		context: {
			...context,
			messages: [summaryMessage(summary), ...keepRecentTurns(context.messages)],
		},
	};
};
```

`roughTokens` reuses the estimate function from the earlier `shouldStopAfterTurn` section; `summarize`, `summaryMessage`, and `keepRecentTurns` are all the host's own implementations—the hook's job is only one thing: hand the new snapshot back. A note on the parameter form: `({ context })` destructures the first argument object—the `nextTurnContext` the loop assembles in the trunk citation (four fields: `message` / `toolResults` / `context` / `newMessages`), pulling out the `context` field; coding-agent's implementation chooses to name the whole object `turn` and then take `turn.context`—same type, two writings. The property name used is the new Context-bearing version: written as the old `prepareNextTurn`, the callback receives a signal and cannot destructure `context`—that pit is exactly why the two names in the "Seam: two names, one adapter" section exist.

### The other end of emit: who receives

`emit` is just a function parameter, so there is no single answer to "how are events received"—the receiver is whatever the caller passes in. This package has two callers, corresponding to two receive styles.

**First, the `Agent` class**: it passes `(event) => this.processEvents(event)` (`src/agent.ts:414`; see the `runPromptMessages` citation above). Events are reduced into `state` first, then each subscriber is awaited in turn—that chain has a full citation in this chapter's "Wrapping up" section. This is a "push" model: the loop actively pushes to you, and your listener is part of the loop's settlement.

**Second, bare `agentLoop()`**: no listener is passed; instead events are pushed into an `EventStream`, and the caller pulls with `for await`:

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

Note that this `emit` implementation is a single line `stream.push(event)`, and there is no `await` before `runAgentLoop`—the loop runs in the background, and the function immediately returns the stream to the caller. `EventStream` is a pi-ai wrapper for "async queue + iterator": the producer pushes, the consumer takes items one by one with `for await`; when `agent_end` arrives the iteration ends and yields the final `AgentMessage[]`. That termination condition is defined in `createAgentStream`'s two callbacks—the first asks "is this the last item?", the second takes the result from the last item:

```typescript
// src/agent-loop.ts:145
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}
```

The difference between the two receive styles can be asked as one question: **when your event handling is slow, does the loop pause and wait for you?**

**Pull mode: no wait.** What you hold is the read end of a queue; the loop just pushes and keeps going—the next LLM call, the next tool execution, will not slow down for your consumption rate. Your `for await` is an independent clock:

```typescript
// Pull: the loop runs in the background; you take at your own pace
for await (const event of agentLoop(prompts, context, config, signal, streamFn)) {
	await render(event);   // If you're slow, events pile up in the queue; the loop doesn't look back
}
```

**Push mode: wait.** You register a listener with `Agent`. There is no queue—every time the loop produces an event, it walks a call chain to you: `emit()` → `processEvents()` → your listener, and every link is `await`ed:

```typescript
// src/agent.ts:250 (Agent.subscribe) — just stuffs the listener into a Set; returns the unsubscribe function
subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
	this.listeners.add(listener);
	return () => this.listeners.delete(listener);
}

// Your side:
agent.subscribe(async (event) => {
	await render(event);
});

// src/agent.ts:584 (inside Agent.processEvents, trimmed; full citation in this chapter's "Wrapping up") — the loop's side:
for (const listener of this.listeners) {
	await listener(event, signal);   // Until you return, the loop will not emit the next event
}
```

So your handling time is a segment on the loop's timeline: if you're slow, the whole run is slow; until you finish, the next event will not come.

Each side pays something and gets something. Pull mode gives up **ordering and settlement guarantees**—by the time you handle event N, the loop may already be at N+50, and questions like "where are we right now?" have no authoritative answer in pull mode; what you get is **decoupling**: you can batch, filter, forward, persist, even consume slowly after the run ends.

Push mode is the reverse: you give up **speed** (a slow listener slows the whole run) and get **guarantees**. Which guarantees, exactly, are worth listing one by one—they are all bought by those two lines of "await one by one." Each comes with a "so it lets you write this" example:

**The event stream you see is the loop's timeline.** Event N+1 is not emitted until every listener for event N has finished. So "current" is meaningful—when handling `message_update`, every prior event has already been applied; there is no "falling behind" window:

```typescript
// UI can apply deltas in place, without worrying about reordering or gaps
agent.subscribe((event) => {
	if (event.type === "message_update") {
		ui.replaceLastMessage(event.message);   // The previous update is guaranteed to have been rendered
	}
});
```

**`state` and events are always consistent.** First, a naming note: the `agent.state` you read in a listener and the `this._state` in earlier citations are **the same object**—the public accessor returns the internal field as-is:

```typescript
// src/agent.ts:260 (Agent's state accessor)
get state(): AgentState {
	return this._state;
}
```

("Accessor" is JS/TS syntactic sugar: `get state() {...}` is declared like a method but used like a field—you write `agent.state` with no parentheses; with only `get` and no `set`, it is read-only from outside.)

`processEvents` reduces the event into `state` first, then calls listeners (you can see that order in the "Wrapping up" citation), so when a listener reads `agent.state`, it always gets the state **after** this event—no syncing on your part:

```typescript
agent.subscribe((event) => {
	if (event.type === "message_end") {
		agent.state.messages.at(-1) === event.message;   // Always true: reduction happens before you're called
	}
});
```

**Your async work counts toward the run's settlement.** DB writes and network requests you await in a listener are all part of the definition of "run finished"—`waitForIdle()` only resolves after the last `agent_end` listener has finished (see the earlier "Settlement and waitForIdle" section). So side effects in listeners are safe:

```typescript
agent.subscribe(async (event) => {
	if (event.type === "agent_end") {
		await db.save(event.messages);   // Slow is fine; the loop will wait
	}
});

await agent.prompt("Summarize this file");   // When this returns, db.save is guaranteed done
```

That is the concrete meaning of chapter 1's "`Agent` is a wrapping of the loop." Which to choose depends on whether you need those guarantees: for UI you usually do—rendering wants consistent `state`, persistence wants a settlement barrier, so choose push (`Agent`); for pipelines you usually don't—forwarding the event stream to logs, analytics, another system, you're just a passerby, so choose pull (bare `agentLoop()`).

By contrast, `runWithLifecycle`'s signature is much smaller—it does not manage data or behavior, only lifecycle:

```typescript
// src/agent.ts:482
private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void>
```

An executor goes in, a "finished" Promise comes out; registering `activeRun`, flipping `isStreaming`, failure fallbacks, and the final `finishRun()` are all hidden behind this small signature. Looking at the two signatures together shows the entire seam between the `Agent` class and the loop: **the loop wants data, behavior, and an exit; the wrapping layer wants only an executor body.**

## Calling the model: two gates

The inner loop's core action is `streamAssistantResponse`:

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

### Through the gates: transform first, then translate

Before a request is actually sent, messages pass through two gates:

```typescript
// src/agent-loop.ts:289
let messages = context.messages;
if (config.transformContext) {
	messages = await config.transformContext(messages, signal);   // AgentMessage[] → AgentMessage[]
}

// Convert to LLM-compatible messages (AgentMessage[] → Message[])
const llmMessages = await config.convertToLlm(messages);
```

- `transformContext` (optional): operates directly on the agent-side message array—trim old messages, inject external context. Input and output are both `AgentMessage[]`.
- `convertToLlm` (required): translates `AgentMessage` into LLM-side `Message`. The LLM only knows three roles—`user` / `assistant` / `toolResult`—so your custom message types (e.g. "notification", "compression summary") are either converted or filtered out.

These two gates are among the book's most important designs; chapter 3 expands on them. Here you only need to remember: **the loop body speaks only `AgentMessage` from start to finish; translation happens only at the LLM call boundary**—and that sentence is right in the file-header comment:

```typescript
// src/agent-loop.ts:1
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
```

### Feedback: one message takes shape in place

Past the gates, call `streamFn`, and events start flowing back. The loop holds a "message in formation" (`partialMessage`) from the stream events, updates it in place, and forwards to subscribers at the same time:

```typescript
// src/agent-loop.ts:314 (inside streamAssistantResponse)
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

There are **two groups of events** here; keep them straight. The case labels are **inbound** events—what streams back from the model, typed as `AssistantMessageEvent`, the "stream events" above, three groups for body text, thinking, and tool-call arguments; `message_update` is an **outbound** event—a member of the `AgentEvent` union, what the loop sends to subscribers. In one side, out the other: this code translates inbound events into outbound events.

Nine kinds can share one function body because of how `AssistantMessageEvent` is defined: every one of the nine delta members carries a **complete** `partial` snapshot—not a delta, but "the whole message so far" (terminal `done` / `error` carry the final message directly):

```typescript
// packages/ai/src/types.ts:510 (from repo root)
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

So the loop does not need to tell which group arrived: `partialMessage = event.partial` swaps the whole thing in and updates in place—the last slot being overwritten is exactly the one `push`ed as a placeholder on `start`. The `if (partialMessage)` guard is for ill-behaved streams: the type comment says "Streams should emit `start` before partial updates"; in a correct implementation `start` always comes first; if a delta races ahead, there is nowhere to put it and it is skipped. Where did the three groups' differences go? Into the outbound event's `assistantMessageEvent` field—sharing a name with the inbound type is no coincidence; its type is exactly the one above:

```typescript
// src/types.ts:432 (a member of the AgentEvent union; the bar means "or")
| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
```

Subscribers look at `message_update.assistantMessageEvent.type` to tell which group is streaming—UI uses that to render the delta as body text, a grayed thinking block, or tool-call arguments.

On `done` (or `error`), `response.result()` takes the final message: normally it replaces the slot reserved on `start`; if even `start` never came (`addedPartial` is still `false`—the same ill-behaved stream the `if (partialMessage)` guard above defends against), it `push`es a new slot and backfills `message_start` (split into two `if`s rather than folding the backfill into the `else` is just style; they are equivalent—at the end of the same function, the fallback branch for a normal loop exit is written folded). Finally `message_end` is emitted, `return finalMessage`, and this round of model calling ends. This function emits only the three message-level kinds; sources for the other levels of `AgentEvent` are tallied in this chapter's "Wrapping up" section.

## Executing tools: prepare, then fire

If the assistant message carries `toolCall` content blocks, tool execution begins. There is an easy-to-miss guard at the entry:

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

When output is cut off by the token limit, every tool call's arguments may be incomplete JSON. **Mark them all as errors; execute none**, and let the model re-issue. The error wording tells the model the reason directly:

```typescript
// src/agent-loop.ts:395 (inside failToolCallsFromTruncatedMessage)
result: createErrorToolResult(
	`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
),
```

In the normal case, enter `executeToolCalls` (`src/agent-loop.ts:411`); each tool call walks a three-stage pipeline. Following the main path once is enough here; the pipeline's full contract is left for chapter 6.

**Stage one, prepare**: find the tool, run the `prepareArguments` compatibility layer, validate args against the schema, ask `beforeToolCall` whether to allow. A missing tool becomes an "immediately finished" error result:

```typescript
// src/agent-loop.ts:607 (inside prepareToolCall)
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
	return {
		kind: "immediate",
		result: createErrorToolResult(`Tool ${toolCall.name} not found`),
		isError: true,
	};
}
```

`beforeToolCall` may intercept. It is an optional slot—asked only if present; when asked it is given the assistant message, the tool call, the validated args, and the current context, and returns a `BeforeToolCallResult`—`undefined` (or an empty object) means allow, `block: true` blocks, and `reason` becomes the error result text:

```typescript
// src/types.ts:61
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}
```

Call site (the middle `signal?.aborted` check is the regular sentry covered in the "abort: unconditional exit" section):

```typescript
// src/agent-loop.ts:619 (inside prepareToolCall)
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

**Stage two, execute**: call the tool's `execute()`. If the tool throws, that is fine—catch it and wrap as a result with `isError: true`:

```typescript
// src/agent-loop.ts:675 (inside executePreparedToolCall, trimmed)
try {
	const result = await prepared.tool.execute(
		prepared.toolCall.id,
		prepared.args as never,
		signal,
		(partialResult) => { /* turned into a tool_execution_update event */ },
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

**Stage three, finalize**: ask `afterToolCall` whether to rewrite the result—it is given the current result and error flag, returns a patch, and fields are overwritten one by one; fields not provided keep their original values. If the hook itself throws, that is also caught, same treatment as the execute stage, wrapped as `isError: true`:

```typescript
// src/agent-loop.ts:717 (inside finalizeExecutedToolCall)
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

Parallel or sequential depends on config and each tool's own declaration:

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

Default is parallel—all tools are prepared one by one first (`beforeToolCall` is called in declaration order), then allowed ones execute concurrently, and `tool_execution_end` is emitted in **completion order**; but the toolResult messages that land in the message stream are still arranged in the **declaration order** from the assistant message:

```typescript
// src/agent-loop.ts:540 (inside executeToolCallsParallel)
const orderedFinalizedCalls = await Promise.all(
	finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
);
const messages: ToolResultMessage[] = [];
for (const finalized of orderedFinalizedCalls) {   // orderedFinalizedCalls keeps declaration order
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	messages.push(toolResultMessage);
}
```

If any tool in the batch declares `executionMode: "sequential"`, the whole batch falls back to one-by-one execution. Tool results become `toolResult` messages in context, `turn_end` is emitted, and one turn ends.

## Wrapping up: how events land

`AgentEvent` events belong to four levels, each with its own sources:

```
run      agent_start · agent_end  ← skeleton ("The agent loop's two layers")
turn     turn_start · turn_end  ← skeleton, each lap of the inner loop
message  message_start · message_update · message_end  ← feedback (assistant) · injection (prompt, steer, follow-up)
tool     tool_execution_start · _update · _end  ← tool pipeline ("Executing tools")
```

Events at all four levels flow through `Agent.processEvents`. It does two things: first **reduce** the event into state (`message_end` pushes the message onto `state.messages`, `tool_execution_start` adds the id to `pendingToolCalls`), then **await every subscriber one by one**:

```typescript
// src/agent.ts:540 (inside Agent.processEvents, trimmed)
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

As "The other end of emit" said earlier, "await one by one" is the most substantive difference between `Agent` and the bare loop—subscribers' async work is part of run settlement. What you see here is its wrapping-up form: emitting `agent_end` ≠ run finished; only after all `agent_end` listeners have run does `finishRun()` clear runtime state and `waitForIdle()` resolve:

```typescript
// src/agent.ts:525 (inside Agent.finishRun)
private finishRun(): void {
	this._state.isStreaming = false;
	this._state.streamingMessage = undefined;
	this._state.pendingToolCalls = new Set<string>();
	this.activeRun?.resolve();
	this.activeRun = undefined;
}
```

That means you can safely write to a database in an `agent_end` listener—the loop will wait for you.

## Chapter summary

The full path of one `prompt()`:

```
prompt() → runPromptMessages → runWithLifecycle → runAgentLoop(snapshot, assembly) → runLoop
  ├─ transformContext → convertToLlm → streamFn (streaming)
  ├─ prepare → execute → finalize (three-stage tool pipeline)
  ├─ turn_end → prepareNextTurn? → shouldStopAfterTurn? → steering?
  └─ follow-up? → another outer lap
→ agent_end → await all listeners → finishRun
```

The four decision points after a turn ends, in the order the code asks them (compare the skeleton citation `src/agent-loop.ts:226-272`):

1. `prepareNextTurn`—swap gear for the next lap? See the "Detour" section.
2. `shouldStopAfterTurn`—stop gracefully? See "When the agent loop stops."
3. steering poll—did anyone cut in? If so, inject and take another inner lap; see "Inner loop" (contrast with follow-up in "Outer loop").
4. follow-up poll—really about to stop: did anyone leave a postscript? If so, the outer loop continues; see "Outer loop."

If all four are empty, emit `agent_end` and `runLoop` returns. abort is not on this chain: it does not wait for turn end; it takes effect at any time (see the abort subsection of "When the agent loop stops").

The next chapter turns to this map's true fulcrum: why the `AgentMessage` type is the axis of the whole system, and the three gates guarding the LLM boundary.

## Why not

> **Why does concurrent `prompt()` throw immediately instead of auto-queuing until the previous round finishes?** Because auto-queuing would hide the decision "cut in, or wait for the end"—and that is exactly the semantic split between steer and followUp (see the next card). The library's choice is to make the decision explicit: calling `prompt()` again while streaming throws, and the error message hands you the three exits directly (CHANGELOG 0.32.0: "preventing race conditions and corrupted state"):
>
> ```typescript
> // src/agent.ts:347 (inside Agent.prompt)
> if (this.activeRun) {
> 	throw new Error(
> 		"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
> 	);
> }
> ```

> **Why split the queues into steer / followUp instead of one `queueMessage`?** Because the old name lied: `queueMessage()` said "queue" but actually cut in—messages arriving mid-run were injected at tool gaps, while users expect "queue" to mean "wait until the agent truly finishes, then process in order." Issue #403 is titled "Queued Messages vs Steering: Mental Model Conflict": *"When a user types a message while the agent is working, it's called 'queued' but actually functions as a steering/interrupt mechanism."* Two semantics sharing one name misunderstood both sides; after the split each has its place—`steer()` interrupts the current run, `followUp()` delivers only when the agent is about to stop (commit `d0a4c3702`, CHANGELOG 0.32.0). The injection pipeline itself is still shared—exactly the "steering and follow-up share one mechanism" line from "Outer loop: keeping the run alive for follow-up."

> **Why is `shouldStopAfterTurn` not a stronger abort?** abort immediately cuts the provider stream and sets `stopReason` to `aborted`; this callback waits until the current turn fully completes and `turn_end` has been emitted, then exits before polling queues and before the next LLM call—without touching the stream, canceling in-flight tools, or changing `stopReason`. The motivation is in the JSDoc: a graceful wrap-up when context is nearly full (another real scenario is handoff on service shutdown, issue #4118):
>
> ```typescript
> // src/types.ts:208 (JSDoc for AgentLoopConfig.shouldStopAfterTurn, trimmed: two sentences on behavior and contract)
>  * Called after each turn fully completes and `turn_end` has been emitted.
>  * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
>  * without starting another LLM call.
>  * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
> ```

> **Why does emit await subscribers one by one instead of fire-and-forget?** Because a listener's typical work is persist and flush—if you push and don't wait, writes may still be unfinished when the run returns. So subscribers' async work is counted in the run's settlement: `agent_end` only means "the loop will emit no more events"; idle waits until that event's listeners have all settled. This semantics was fixed in commit `9022a5b5e`—before that, nobody awaited listener Promises:
>
> ```typescript
> // src/agent.ts:241 (JSDoc for Agent.subscribe, trimmed: opening sentence and abort-signal sentence)
>  * Listener promises are awaited in subscription order and are included in
>  * the current run's settlement.
>  *
>  * `agent_end` is the final emitted event for a run, but the agent does not
>  * become idle until all awaited listeners for that event have settled.
> ```

> **Why split parallel execution into prepare / execute instead of making each tool call its own async task?** Because `beforeToolCall` needs to see the full batch: permission systems often decide from "what does this assistant message want to do overall," not from each call in isolation. Sequential prepare guarantees the order the hook sees matches the model's declaration order; concurrency only happens "after allow." The comment nails that contract:
>
> ```typescript
> // src/types.ts:36
> // - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
> //   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
> //   while tool-result message artifacts are emitted later in assistant source order.
> ```
>
> The two orders each serve their own purpose—the event stream serves "update the UI as soon as possible," the message stream serves "make the transcript replayable."

> **Why not execute "salvaged" truncated tool calls?** When output is cut off by the token limit, half-finished streamed arguments are completed by a "best-effort salvage" JSON parser—after salvage they may parse and pass schema validation, but can still be **silently incomplete**: which field is missing is unknowable. So none of the batch is executed; the model re-issues (PR #6285; review also rejected a finer-grained scheme—adding a `malformedArguments` field to `ToolCall` and pushing the judgment to the caller):
>
> ```typescript
> // src/agent-loop.ts:374 (comment on failToolCallsFromTruncatedMessage)
> /**
>  * Fail all tool calls from an assistant message that was truncated by the
>  * output token limit. Streamed tool-call arguments are finalized with a
>  * best-effort JSON salvage parser, so a truncated message can yield tool calls
>  * whose arguments parse and validate but are silently incomplete. None of them
>  * are safe to execute; report each as an error so the model can re-issue them.
>  */
> ```
