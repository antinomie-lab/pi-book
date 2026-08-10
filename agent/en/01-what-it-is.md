# Chapter 1 · What it is: an agent loop packaged as a library

## Start from a scene

You are writing an application and want to embed an AI agent that can "do the work itself": you give it a sentence, it calls the model, the model asks for a tool, it runs the tool, feeds the result back to the model, and so on, until the model says "done." You want to see every step in real time—text streaming out character by character, tools executing one by one—because you need to render all of it into a UI.

That is the whole problem `pi-agent-core` sets out to solve. Its README puts it in one sentence: "Stateful agent with tool execution and event streaming" (`README.md:2`).

Taken apart, it gives you three things:

1. **An agent loop** (`src/agent-loop.ts`): a prompt comes in, a stream of events goes out, and in between is the back-and-forth of "call the model → run tools → call the model again."
2. **A layer of state** (`src/agent.ts`): the `Agent` class holds the conversation history, the message currently streaming, and the tools in flight, so that at any moment you can answer "where is it now?"
3. **A harness** (`src/harness/`): session persistence, context compaction, built-in file/shell tools, skill loading—turning "a loop that can run" into "a loop that can ship as a coding agent."

## What it refuses to do

To understand a library, boundaries matter as much as capabilities. `pi-agent-core` has four clear refusals, each one verifiable from the code.

**Refusal one: it knows no model vendor.** Search the whole repository and you will not find a provider name. The model interface the loop receives is a function type:

```typescript
// src/types.ts:28
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

It only contracts the shape: give me a `Model` and a `Context`, and I give you back an event stream. Who supplies that function? The neighboring `@earendil-works/pi-ai`—a separate package, with its own provider directory and model metadata. This package's only dependency on it is these few types.

**Refusal two: it does not touch UI.** There is not a single line of rendering code in the package. It speaks to the outside world in only one way: by emitting events. The full set of events is a discriminated union of ten kinds:

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

Text streaming, tool progress, lifecycle—all ten of them. Whether you draw that as a terminal, a web page, or a log file is your affair.

**Refusal three: the core does not persist.** The `Agent` class's conversation history is just an in-memory array:

```typescript
// src/agent.ts:71
let tools = initialState?.tools?.slice() ?? [];
let messages = initialState?.messages?.slice() ?? [];
```

When the process exits, everything resets. Persistence exists, but it lives in the harness layer (Chapter 10), and its model is "append entries to a tree"—the core loop knows nothing about it.

**Refusal four: the core does not touch runtime APIs.** Across the seven files at the root of `src/`, there is no `node:fs`, no `node:child_process`. All file and shell access is forced behind an interface (`ExecutionEnv`, covered in detail in Chapter 4); the sole Node implementation is isolated in `harness/env/nodejs.ts` and exported through a separate `./node` entry:

```json
// package.json — exports (trimmed)
".":              { "import": "./dist/index.js" },
"./node":         { "import": "./dist/node.js" },
"./experimental": { "import": "./dist/experimental.js" }
```

So the core of this package can run in a browser—`src/proxy.ts` is prepared for exactly that.

## Three layers, not one

The easiest misunderstanding about this package is: what is the relationship between the `Agent` class and the `AgentHarness` class? Inheritance? Wrapping?

Neither. Look at the direction of the dependencies:

```
agent-loop.ts  (runAgentLoop — a stateless loop, 792 lines)
    ▲                    ▲
    │                    │
agent.ts           harness/agent-harness.ts
(Agent class,      (AgentHarness class,
 588 lines)         1185 lines)
```

`Agent` and `AgentHarness` **both call `runAgentLoop` directly**; they have no call relationship with each other. On the `Agent` side:

```typescript
// src/agent.ts:409 (inside Agent.runPromptMessages)
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

On the `AgentHarness` side:

```typescript
// src/harness/agent-harness.ts:658 (inside AgentHarness.executeTurn)
return await runAgentLoop(
	messages,
	this.createContext(turnState, beforeResult?.systemPrompt),
	this.createLoopConfig(getTurnState, setTurnState),
	(event) => this.handleAgentEvent(event, signal),
	signal,
	this.createStreamFn(getTurnState),
);
```

Notice that the shape of the two calls is almost the same—context, loop config, event callback, signal, stream function—but the sources of the arguments are entirely different: `Agent` supplies an in-memory snapshot; `AgentHarness` supplies a per-turn snapshot (`turnState`). `AgentHarness` is not a subclass of `Agent`, nor a wrapper around it: it is another composition over the same loop primitive, only with far more composed in—persistence, compaction, hooks, a phase state machine.

Why keep both layers? Because they are "heavy" in different ways. Embed a chat panel and `Agent` is enough; build a coding agent and use `AgentHarness`. There is only one loop. That is this package's first structural virtue: **complex capability is composed in; the loop itself does not grow more complex.**

## Chapter summary

- `pi-agent-core` is an agent-loop library: loop, state, and harness in three layers.
- It knows no model vendor, does not touch UI, does not persist in the core, and does not touch runtime APIs in the core.
- `Agent` and `AgentHarness` are two compositions over the same loop primitive; they do not depend on each other.

Next chapter we stop talking about positioning. We follow a real `prompt()` call and walk the loop from start to finish.

## Why not

> **Why not depend on pi-ai directly?** `src/stream-fn.ts` gives the outline of the answer. A host can install a default stream function:
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
> The comment states the motive (`src/stream-fn.ts:9`): a model catalog will swell (every vendor, every model, every price), while the loop's contract needs only a function shape. Depend on a type, not on a catalog—that is why `StreamFn` exists.
