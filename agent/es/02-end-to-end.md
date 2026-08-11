# Capítulo 2 · El recorrido completo de un prompt: de prompt() a agent_end

El capítulo anterior explicó qué es este paquete. Este no habla de opiniones: solo hace una cosa: seguir la llamada `agent.prompt("读一下 config.json")` y recorrer el flujo de control de principio a fin. Al terminar este capítulo, ya habrás visto cada módulo de los capítulos siguientes.

## Salida: Agent.prompt

La entrada es `Agent.prompt()`:

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

Lo primero que hace no tiene nada que ver con la IA: comprueba `activeRun`. **Una instancia de Agent solo ejecuta un run a la vez** — si quieres colarte, usa las colas `steer()` o `followUp()`; eso viene después.

`prompt()` entrega los mensajes normalizados a `runPromptMessages`, donde se ve cómo se cablean todos los preparativos posteriores:

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

Observa el orden: `runWithLifecycle` envuelve por fuera, y `createContextSnapshot()` y `createLoopConfig(options)` son argumentos de `runAgentLoop` — se evalúan cuando el executor se ejecuta de verdad, es decir **después** de que el ciclo de vida esté montado. Primero veamos qué prepara cada uno de esos dos argumentos.

Primero, una instantánea del contexto:

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

Fíjate en que el array de mensajes es una **copia superficial** — el bucle le empujará mensajes nuevos, pero no puede reemplazar la referencia que tiene el llamador.

Segundo, ensamblar la configuración del bucle (`src/agent.ts:441`) — empaquetar los callbacks de la instancia `Agent` y las funciones drain de las dos colas en un `AgentLoopConfig`:

```typescript
// src/agent.ts:441 (Agent.createLoopConfig, recortado)
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

Los dos argumentos ya están listos. Volvamos al exterior: `runWithLifecycle` crea un `AbortController`, registra `activeRun`, pone `isStreaming = true`, y solo entonces ejecuta el executor — es decir, en el fragmento citado arriba, evalúa los dos argumentos y llama a `runAgentLoop`:

```typescript
// src/agent.ts:482 (Agent.runWithLifecycle, recortado)
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
		await executor(abortController.signal);   // ← la instantánea, el ensamblaje y runAgentLoop ocurren aquí
	} catch (error) {
		await this.handleRunFailure(error, abortController.signal.aborted);
	} finally {
		this.finishRun();
	}
}
```

### Liquidación y waitForIdle: la espera del espectador

Esas tres líneas de `promise`/`resolvePromise` son una «Promise detonada a mano»: el executor de `new Promise` se ejecuta de forma síncrona, así que en el instante en que termina la construcción, `resolvePromise` ya tiene la función resolve de esa Promise. El uso de esa Promise hay que leerlo como tres preguntas.

**¿Cuándo se resuelve?** Mira la estructura de `runWithLifecycle`: termina el `executor` → `finishRun()` en el `finally` → se llama a `resolvePromise()`. El momento de resolve de esta Promise es el momento en que «el run ha terminado del todo»; este capítulo lo llama **liquidación** — llega más tarde que el evento `agent_end`, y ese latido de más se usa en el apartado de deadlock de esta sección.

**¿Quién la await?** `waitForIdle()`:

```typescript
// src/agent.ts:328 (Agent.waitForIdle)
waitForIdle(): Promise<void> {
	return this.activeRun?.promise ?? Promise.resolve();
}
```

Si no hay active run, devuelve una Promise que se resuelve al instante — «ya está en idle, no hace falta esperar».

**¿Por qué hace falta?** Al fin y al cabo, `await agent.prompt(...)` también espera hasta la liquidación (`prompt` → `runPromptMessages` → `await runWithLifecycle`, toda la cadena). La diferencia es que **quien espera no tiene por qué ser quien lanzó**. Puedes no await `prompt()` — lo disparas y sueltas; la UI se actualiza suscribiéndose a eventos; y en otro rincón del código (limpieza antes de salir, aserciones en tests, la barandilla antes de `reset()`) hace falta un medio de «esperar a que se quede del todo en silencio», y esa mano no tiene la Promise que devolvió `prompt()`, solo la referencia a `agent`. `waitForIdle()` es el tablón público para esa «espera del espectador»: la Promise se cuelga y cualquiera puede esperar; el gatillo del resolve solo lo tiene el `finishRun()` de cierre (`src/agent.ts:529`; la sección «cierre» de este capítulo cita el fragmento completo) — **hay muchos que esperan; solo uno anuncia el final.**

**¿Dónde se llama?** En el código de producción del propio paquete no hay puntos de llamada — `waitForIdle()` es API pública pura. En el repositorio hay tres usos reales. Uno: tests, esperar a que asiente antes de asertar:

```typescript
// test/agent.test.ts:246 (recortado)
const promptPromise = agent.prompt("hello");
const idlePromise = agent.waitForIdle().then(() => {
	idleResolved = true;
});
// ... tras 10ms asertar que idleResolved sigue en false (el barrier del suscriptor aún no ha soltado)
```

Dos: scripts no interactivos de usuarios del SDK: no await `prompt()`, se dispara y la UI va por eventos, y al final se espera el silencio de golpe (el ejemplo de `packages/coding-agent/docs/sdk.md` lo usa así). Tres: el flujo de abort de capas envoltorio aguas abajo — si pulsas parar, hay que esperar a que de verdad se calle antes de volver:

```typescript
// packages/coding-agent/src/core/agent-session.ts:1541 (desde la raíz del repo, AgentSession.abort)
async abort(): Promise<void> {
	this.abortRetry();
	this.agent.abort();
	await this.waitForIdle();
}
```

Fíjate en que aquí se espera `AgentSession.waitForIdle()`, no el de `Agent` — es una reimplementación propia de la capa session:

```typescript
// packages/coding-agent/src/core/agent-session.ts:1547 (desde la raíz del repo, AgentSession.waitForIdle)
async waitForIdle(): Promise<void> {
	if (this.isIdle) {
		return;
	}
	await this._getIdleWaitPromise();
}
```

`AgentHarness` tiene también su propia versión. ¿Por qué aguas abajo no delegan directamente en `agent.waitForIdle()`? Porque cada capa define «silencio» de forma distinta: el idle de session no solo mira el agent run, también cuenta con reintentos, persistencia y demás estado propio. Así que usan **el mismo patrón** y cada una responde lo suyo — `_getIdleWaitPromise` es otra Promise detonada a mano:

```typescript
// packages/coding-agent/src/core/agent-session.ts:568 (desde la raíz del repo, AgentSession._getIdleWaitPromise, recortado)
private _getIdleWaitPromise(): Promise<void> {
	if (!this._idleWaitPromise) {
		this._idleWaitPromise = new Promise((resolve) => {
			this._resolveIdleWait = resolve;   // el mismo patrón: al construir, sacar resolve y guardarlo
		});
	}
	return this._idleWaitPromise;
}
```

**La misma pregunta, y cada capa tiene que volver a responder «qué significa silencio en mi capa»**; el patrón se copia, la respuesta no se reutiliza. Los capítulos 8 y 9 verán la respuesta de cada una de esas dos capas.

**¿Y por qué necesita existir `Agent.waitForIdle()` en sí?** Que nadie lo llame dentro del paquete no es prueba de redundancia: es la forma normal de una «biblioteca» — los llamadores de la API pública están fuera. Y el motivo por el que debe existir es: «si el run se ha liquidado del todo» es **conocimiento privado** de `Agent`. `activeRun` es un campo privado; la señal observable más tardía desde fuera es el evento `agent_end` — pero emitir el evento ≠ que hayan terminado los listeners; usarlo como señal de liquidación se adelanta un cuerpo. Si la biblioteca no cuelga esa respuesta, el exterior solo puede adivinar mal.

**El reverso de la garantía: await dentro de un listener, y hay deadlock.** La misma semántica de liquidación, mal colocada, es una trampa. Despliega la dependencia: en un listener `await agent.waitForIdle()`, esperas la liquidación; y la liquidación te espera a ti — `processEvents` hace `await` a cada listener uno a uno (cita en la parte de modo push de la sección «el otro extremo de emit»), si no return, el `executor` no cuenta como terminado, `activeRun.promise` no se resuelve; y tú estás esperando que se resuelva — el anillo se cierra. No hace falta hilos: basta un ciclo de dependencias entre Promises, y ningún timeout ni abort lo rompe: ese run queda colgado para siempre, y ni `waitForIdle()` ni `prompt()` hacen settle nunca. Ojo: no es solo un problema de listeners de `agent_end` — en el listener de cualquier evento ocurre lo mismo, porque mientras el run no termine, la condición de resolve de `activeRun.promise` incluye «que este listener haga return». El documento de diseño de la capa harness deja el foso escrito con claridad:

> listeners/hooks currently receive no facade; if they close over the raw harness and call settlement APIs such as `waitForIdle()` during the active run, they can deadlock. A future facade should expose `runWhenIdle()` instead.
>
> — `docs/agent-harness.md:18` (desde la raíz del repo)

La salida de `runWhenIdle()` es cambiar de dirección; la firma ya enseña el uso:

```typescript
// docs/harness-v2.md:730 (desde la raíz del repo, documento de diseño)
runWhenIdle(callback: () => void | Promise<void>): Promise<void>;   // runtime-only
```

Tú pasas el callback, tu listener hace return con normalidad, la liquidación termina como toca; cuando la cadena acaba, el harness llama ese callback, y la Promise que devolvió solo se resuelve cuando el callback termina — desde el instante del registro, ya no estás en el anillo de dependencias. Ojo: por ahora es solo un plan: en los borradores de diseño v1 y v2 solo está esta línea de firma; en el código aún no hay implementación. Una frase para recordar el límite: **`waitForIdle()` es herramienta del espectador; el participante no debe tocarla.**

### Digresión: dos patrones, executor y signal

En la firma de `runWithLifecycle` hay dos patrones que merecen desplegarse; reaparecerán una y otra vez más adelante (sobre todo en el capítulo 13).

**Patrón uno: callback executor («tú traes el trabajo, yo gestiono el antes y el después»).** `runWithLifecycle` no hace el trabajo: recibe una función `(signal) => Promise<void>` como parámetro. ¿Por qué no llama directamente a `runAgentLoop`? Porque hay dos llamadores que quieren compartir el mismo «trámite de antes y después», pero hacen trabajos distintos — `runPromptMessages` ejecuta `runAgentLoop`, `runContinuation` ejecuta `runAgentLoopContinue` (`src/agent.ts:421`):

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

Al abstraer el «trabajo» en un parámetro, el trámite de antes y después (crear el controller, registrar, poner estado, atrapar excepciones, cerrar) se escribe una sola vez. A veces se llama «método plantilla» o «ejecución envolvente»; la esencia es separar **el paréntesis invariable** del **contenido variable**.

**Patrón dos: AbortController / AbortSignal («el mando a distancia y el cable»).** Es API estándar de la Web, integrada en Node, y no tiene nada que ver con TypeScript. La regla es sencilla:

- `new AbortController()` fabrica un **mando a distancia**; quien lo tiene puede pulsar `.abort()` en cualquier momento.
- Cada controller trae un «cable» `controller.signal` (`AbortSignal`), que se puede pasar hacia abajo a voluntad. Quien recibe el signal no puede pulsar el botón: solo puede **escuchar**: consultar `signal.aborted`, o registrar `signal.addEventListener("abort", ...)`.

Así que es una difusión unidireccional de cancelación: **solo el creador puede cancelar; todo lo de aguas abajo solo puede obedecer.** Mira el viaje del signal en `runWithLifecycle`: el controller se crea aquí, el signal se entrega al executor → el executor lo pasa a `runAgentLoop` → el bucle lo pasa a `streamFn` (cancelar la petición HTTP) y al `execute()` de cada herramienta (terminar el comando en marcha). Y la mano que pulsa el botón está en otro sitio:

```typescript
// src/agent.ts:319 (Agent.abort)
/** Abort the current run, if one is active. */
abort(): void {
	this.activeRun?.abortController.abort();
}
```

Pulsa «parar» en la UI → `agent.abort()` → el controller se pulsa. Fíjate en que `abort()` no tiene ninguna cola ni juicio de momento — es pulsar el botón de forma síncrona, así que «cuándo se para» no depende de en qué punto va el bucle, sino de **lo rápido que responda cada una de las tres partes que oyen la difusión**. Tres momentos:

**Está emitiendo en streaming (el modelo aún habla).** El signal ya se entregó a `streamFn` al hacer la petición:

```typescript
// src/agent-loop.ts:308 (dentro de streamAssistantResponse)
const response = await streamFunction(config.model, llmContext, {
	...config,
	apiKey: resolvedApiKey,
	signal,
});
```

La capa HTTP corta el flujo al instante; según el contrato de `StreamFn` (capítulo 3), esa petición se cierra con un mensaje assistant de `stopReason: "aborted"`. El bucle entra de inmediato en la rama `error || aborted` del esqueleto: emite `turn_end`, emite `agent_end`, y el run entero vuelve — **sin esperar a que termine ese turn**.

**Está ejecutando una herramienta (por ejemplo bash aún corre).** El bucle no mata la herramienta a la fuerza: el signal va en los parámetros de `execute()` (se ve en la cita de la sección «ejecutar herramientas» de este capítulo); cómo responder es cosa de la herramienta — el bash integrado mata el subproceso (capítulo 11). La promesa del lado del bucle es «no abrir trabajo nuevo»: en la fase prepare hay una comprobación; si el signal ya está pulsado, convierte las llamadas a herramientas aún no arrancadas en resultados de error:

```typescript
// src/agent-loop.ts:644 (dentro de prepareToolCall)
if (signal?.aborted) {
	return {
		kind: "immediate",
		result: createErrorToolResult("Operation aborted"),
		isError: true,
	};
}
```

En ejecución secuencial, tras cada herramienta también se comprueba una vez; si está pulsado, se interrumpe el resto del lote:

```typescript
// src/agent-loop.ts:478 (dentro de executeToolCallsSequential)
if (signal?.aborted) {
	break;
}
```

**Está entre turn y turn.** La siguiente vuelta a `streamFn` lleva el mismo signal ya pulsado, así que cae al instante en el primer caso — esa «vuelta en vacío» no produce una petición real.

Los tres momentos tienen un punto en común: **abort termina el run entero, no el turn actual.** Esa rama del esqueleto es `return`, no `continue` — la semántica de ESC es «este run termina aquí»; las dos colas tampoco hacen más poll. Y la secuencia de eventos sigue completa: `turn_end` y `agent_end` se emiten igual, los listeners esperan igual, `waitForIdle()` se resuelve igual — cancelar no es arrancar el enchufe: es recorrer a toda velocidad un camino de cierre normal.

Por último, fíjate en que el signal en las firmas suele ser opcional (`AbortSignal | undefined`) — el bucle desnudo permite correr en entornos sin necesidad de cancelación, así que las comprobaciones aguas abajo se escriben siempre como `signal?.aborted`.

## La estructura de dos capas del bucle de agente

`runAgentLoop` primero añade los mensajes del prompt al contexto, emite `agent_start`, `turn_start` y el `message_start`/`message_end` del propio prompt, y luego entrega el control al motor de verdad, `runLoop`:

```typescript
// src/agent-loop.ts:95 (recortado)
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

Entonces, ¿dónde está el bucle dentro de ese «motor de verdad» `runLoop`? Primero aclara qué significa «bucle». El «bucle de agente» de cada día es el vaivén **modelo → herramienta → modelo**: el modelo produce llamadas a herramientas, los resultados se alimentan de vuelta al modelo, el modelo vuelve a producir, hasta que no hay más llamadas. Ese vaivén en el código no es recursión: es iteración — un `while` dentro de `runLoop`. Y dentro de `runLoop` hay en realidad **dos** `while`; de ahí el sentido literal de «estructura de dos capas». Pongamos el código real (solo se pliegan dos cuerpos de función ajenos a la estructura del bucle):

```typescript
// src/agent-loop.ts:155 (bloque prepareNextTurn plegado — es un desvío, no el tronco; ver la sección "Desvío" de esta parte; el resto línea a línea fiel)
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
				// ... (guardia de truncamiento "length"; ver la sección "ejecutar herramientas" de este capítulo)
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

			// ... (prepareNextTurn: desvío de cambiar instantánea entre dos vueltas; plegado; ver sección más abajo)

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

### Digresión: el trío de mensajes y los bloques de contenido

Antes de analizar este esqueleto, una lección de las estructuras de datos básicas de una aplicación LLM — `message`, `toolResults` y `pendingMessages` del esqueleto son todas ella. Toda la historia del diálogo es un array de `Message`, y `Message` solo tiene tres roles:

```typescript
// packages/ai/src/types.ts:442 (desde la raíz del repo)
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

Los tres roles corresponden a las tres acciones del protocolo de diálogo: **user habla**, **assistant hace**, **toolResult alimenta el resultado de la herramienta de vuelta**. El vaivén «modelo → herramienta → modelo» del bucle, en datos, es ir añadiendo al array mensajes assistant y toolResult de forma alternada. Su aspecto (campos recortados; se deja el tronco):

```typescript
// packages/ai/src/types.ts:402 / :408 / :424 (desde la raíz del repo, recortado)
export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	stopReason: StopReason;   // por qué paró esta ronda: terminó de hablar / quiere llamar herramientas / error / truncado…
	// ... (metadatos: api / provider / model / usage / errorMessage, etc.)
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;   // apunta de vuelta al id del bloque ToolCall en el mensaje assistant
	toolName: string;
	content: (TextContent | ImageContent)[];
	isError: boolean;
	timestamp: number;
}
```

Tres roles, y punto — el system prompt no está en este array: es un campo independiente de `Context`, y se adjunta por separado en cada petición. En cuanto a qué hacer si la aplicación quiere un cuarto rol (notificaciones, marcas de resumen), eso es el problema del punto de apoyo del capítulo 3; aquí basta recordar «el LLM solo reconoce estos tres roles».

Fíjate en el tipo de `AssistantMessage.content`: **no es una cadena, es un array de bloques de contenido**. Un mensaje assistant es una secuencia de varios bloques; cada bloque es una de tres opciones:

```typescript
// packages/ai/src/types.ts:347 / :353 / :369 (desde la raíz del repo, recortado)
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
	id: string;                        // para que toolResult apunte de vuelta
	name: string;                      // qué herramienta llamar
	arguments: Record<string, any>;    // parámetros generados por el modelo
	// ...
}
```

Los bloques se ordenan según el orden de producción del modelo, así que un mensaje puede «pensar un tramo, decir un tramo, llamar a dos herramientas», todo mezclado en el mismo array. Aquí hay que romper una intuición que trae el nombre: `message` suena a «una frase», pero en realidad es el contenedor de **todo el contenido de una ronda de salida del modelo** — la unidad es la «ronda», no la «frase». Con esa forma, el `filter` de la cita del esqueleto se entiende bien: **«¿tiene el modelo trabajo que hacer en este paso?» = «¿hay en este array algún bloque `type: "toolCall"`?»**. Los bloques de texto y de pensamiento no entran en el conducto de herramientas: son solo contenido del diálogo, y se quedan en el array entrando al contexto con el mensaje.

### Bucle interior: una vuelta = un turn

Ahora se puede responder «dónde hay bucle». **Una vuelta del `while` interior = un turn**: inyectar mensajes colados (si hay) → llamar una vez al modelo → ejecutar herramientas (si hay) → `turn_end`. Su condición de salida `hasMoreToolCalls || pendingMessages.length > 0` se lee «el modelo no pidió herramientas nuevas, y nadie se coló» — el «el agent ha terminado» de cada día, en el código, es que esa condición pase a falsa.

Al inicio de cada vuelta se reemite un `turn_start` — **salvo la primera**. El flag `firstTurn` de la cita es para eso: el `turn_start` de la primera vuelta ya lo emitió `runAgentLoop` antes de entrar en `runLoop` (el `src/agent-loop.ts:110` citado arriba); si no se frena, el suscriptor vería dos `turn_start` seguidos. Ese flag no tiene otro uso: es pura deduplicación de eventos.

Si has oído el paradigma clásico de agent ReAct (Reason + Act), el bucle interior es eso — solo que aquí el nombre es más llano: **Reason** es el mensaje assistant que produce `streamAssistantResponse` (los eventos de flujo `thinking_*` son el propio proceso de razonamiento desplegándose ante tus ojos), **Act** es entregar los bloques toolCall del mensaje a `executeToolCalls`, **Observe** es empujar el mensaje toolResult a `currentContext.messages` — y de vuelta al inicio del círculo, el modelo razona otra ronda sobre todas las observaciones hasta ahora. pi-agent-core no inventó un paradigma nuevo: lo que hace es desmontar una vuelta de ReAct en una docena de eventos y hooks observables, interceptables y cancelables.

### Cuándo se para el bucle de agente: tres formas de parar

La condición de salida del bucle interior tiene dos partes, y ambas tienen que cumplirse a la vez: el modelo no pidió herramientas nuevas en esta ronda (`hasMoreToolCalls` es falso), y nadie se coló (`pendingMessages` está vacío) — es decir, el instante en que el `while (hasMoreToolCalls || pendingMessages.length > 0)` del esqueleto pasa a falso. Esa es la salida normal. Además el bucle tiene dos caminos de parada anticipada: el cierre elegante del callback del host `shouldStopAfterTurn`, y la parada incondicional de `abort()`. Esta sección mira una a una esas tres formas de parar.

#### Lo decide toolCall: salida normal y bandera de terminación

Aquí hay un punto fácil de malinterpretar que conviene dejar claro: **la salida normal del bucle es que el modelo «deje de llamar herramientas»; no tiene que ver con izar la bandera.** Mira la forma del bloque de herramientas en la cita: tras `hasMoreToolCalls = false`, solo si `toolCalls.length > 0` se entra en el bloque de ejecución y solo entonces puede volver a `true`. Cuando el modelo produce un mensaje de texto puro, se salta todo el if, la bandera se queda en `false`, y el bucle sale. Así que la iniciativa del final siempre está en manos del modelo — si cree que la tarea está hecha, habla directamente; izar la bandera solo cubre el caso especial de «la última acción resulta ser una llamada a herramienta», y se ahorra la ronda en la que el modelo no tiene nada que decir. Es una optimización, no el mecanismo de terminación.

La regla de actualización de `hasMoreToolCalls` merece una mirada, porque es el interruptor del «vaivén»: al inicio de cada vuelta se pone incondicionalmente a `false` (por defecto no hay siguiente vuelta), y tras ejecutar herramientas se pone de nuevo según `!executedToolBatch.terminate`. ¿Cuándo es `false` ese `terminate`? La función de juicio solo tiene tres líneas:

```typescript
// src/agent-loop.ts:582
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}
```

Lee palabra a palabra la condición de la cita: en este lote, **cada** (`every`) resultado de herramienta tiene `terminate` **exactamente igual a** `true`. El tipo de ese campo es `boolean | undefined` — la igualdad estricta `=== true` hace que «no se escribió el campo» (`undefined`, el caso de la gran mayoría de herramientas) cuente con claridad como no izar la bandera. Con las dos condiciones apiladas, el umbral es muy alto, así que el caso de `terminate` en `false` (el bucle continúa) es la gran mayoría:

1. **Ninguna herramienta izó la bandera** — `terminate` es un hint opcional en el resultado de la herramienta; la gran mayoría de herramientas nunca lo ponen; ese es el `false` más habitual. La definición de esta bandera en el tipo:

```typescript
// src/types.ts:364 (dentro de AgentToolResult)
/**
 * Hint that the agent should stop after the current tool batch.
 * Early termination only happens when every finalized tool result in the batch sets this to true.
 */
terminate?: boolean;
```

2. **Lote mixto** — de tres herramientas dos izaron la bandera y una no; `every` no se cumple, el lote entero continúa (la semántica es «la bandera solo vale con unanimidad», para que una herramienta no corte unilateralmente un lote que otra aún necesita seguir procesando);
3. **Camino del guardia de truncamiento** — el lote que devuelve `failToolCallsFromTruncatedMessage` tiene hardcodeado continuar:

```typescript
// src/agent-loop.ts:405 (retorno de failToolCallsFromTruncatedMessage)
return { messages, terminate: false };
```

Porque el sentido del lote entero es «que el modelo reenvíe una vez»; claro que hay que volver al bucle.

Al revés, `terminate: true` solo aparece cuando **cada resultado de herramienta del lote iza la bandera de forma explícita**. Y la decisión de «izar o no» es del **autor de la herramienta**, no del modelo — la bandera se escribe en el resultado de la herramienta; lo que `execute()` devuelva, eso es. El papel del modelo es solo **elegir qué herramienta llamar** (el autor puede guiarlo con el prompt para llamar a la herramienta terminal en el momento justo); el host, a su vez, puede izar o retirar la bandera en la fase finalize con `afterToolCall`. Tres capas, cada una un tramo: **el autor define la semántica, el modelo elige el momento, el host se reserva el veto.**

¿Qué herramienta izaría la bandera? En el repositorio hay un ejemplo real (en el ejemplo de extensión del paquete hermano `packages/coding-agent`); el comentario de cabecera del archivo deja el motivo muy claro:

```typescript
// packages/coding-agent/examples/extensions/structured-output.ts:1 (desde la raíz del repo)
/**
 * Structured Output Tool
 *
 * Demonstrates `terminate: true` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */
```

El escenario es este: el usuario quiere una respuesta estructurada (un resumen al estilo JSON, una lista de action items); el modelo entrega la respuesta **como parámetros de la llamada a la herramienta** — `headline`, `summary`, `actionItems` van en los parámetros. Lo único que tiene que hacer la herramienta es recibirlos y guardarlos:

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

Esa es la semántica de izar la bandera: **«el resultado de la herramienta es la respuesta final; no queda trabajo posterior para el modelo.»** Si no se iza, el bucle llamará otra vez al modelo como de costumbre — el modelo solo puede forzar un párrafo más frente a una confirmación de «ya guardado», y esa ronda de LLM es puro desperdicio (el «paying for an extra follow-up LLM turn» del encabezado del archivo es exactamente esa factura). Por eso la descripción de la herramienta en este ejemplo insiste en decirle al modelo «después de llamar, no hables más» (`promptGuidelines`, mismo archivo :24-27), y `terminate: true` lo fija a nivel de mecanismo.

Hay un segundo acceso a izar la bandera: la herramienta no la iza, y el hook `afterToolCall` la iza por ella en la fase finalize — en la fusión campo a campo de `finalizeExecutedToolCall` está `terminate: afterResult.terminate ?? result.terminate` (se ve en la cita de la sección «ejecutar herramientas» de este capítulo). Así «si terminar antes» pasa a ser una decisión que el host puede interceptar, no solo un hardcode del autor de la herramienta.

La pregunta al revés deja el asunto del todo claro: **¿qué resultado de herramienta no es la respuesta final?** La respuesta: casi todas las herramientas de este bucle. Mira las cuatro integradas (el capítulo 11 las detalla): el resultado de `read` es un trozo de contenido de archivo — no es la respuesta, es **material**; el modelo tiene que leerlo para responder «qué hace esta función»; el resultado de `bash` al correr tests es un montón de salida — el modelo tiene que verlo para saber qué línea arreglar; el resultado de `edit` es un diff — el modelo tiene que confirmar que el cambio está bien antes de decidir el siguiente paso. El flujo de información de estas herramientas es **bidireccional**: los parámetros son la instrucción que da el modelo; el resultado es la observación que se alimenta de vuelta; el valor del bucle está en el vaivén «observar → decidir → actuar de nuevo».

Herramientas como `structured_output` son **unidireccionales**: los parámetros mismos son el producto acabado (el modelo ya pensó al lanzar la llamada); el resultado de la herramienta es solo un acuse de «ya guardado» — si se alimenta de nuevo al modelo, el modelo no tiene nada que decir. Así que para decidir si una herramienta debe izar la bandera basta una frase: **cuando ese toolResult vuelve a manos del modelo, ¿le queda al modelo algo con sentido que hacer?** Si sí, es una herramienta normal; si no, es una herramienta terminal.

¿Hay casos en los que de verdad no para? Sí, pero el origen no es «la herramienta no iza la bandera», sino que **el modelo no para de emitir llamadas a herramientas** — leer archivos una y otra vez, correr tests una y otra vez sin dar en el clavo. Esa barandilla del descontrol no está en el bucle, está fuera: `agent.abort()` (la persona pulsa parar), `shouldStopAfterTurn` (el host decide tras cada turn si cerrar con elegancia, por ejemplo si el contexto está a punto de llenarse), y la salida directa con `stopReason: "error"` cuando falla la petición al modelo. Ojo: este paquete no trae un «número máximo de rondas» integrado — deja esa política entera al host, expresada vía `shouldStopAfterTurn`.

#### shouldStopAfterTurn: cierre elegante en el borde del turn

`shouldStopAfterTurn` es el canal formal del host para expresar «cierre elegante»; conviene dejar claro cómo funciona. Es un callback opcional de `AgentLoopConfig`; se llama tras cada `turn_end` y antes de hacer poll a las dos colas (justo en la posición de la cita del esqueleto), y recibe toda la información del turn que acaba de terminar:

```typescript
// src/types.ts:121 (recortado)
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

Si devuelve `true`, el bucle emite `agent_end` y sale — ni siquiera mira las colas de steering y follow-up; si devuelve `false` o no devuelve, todo sigue igual.

«No mirar las dos colas» es en sí una decisión de diseño, solo que no está escrita con if/else, sino con la **posición**. Cabe imaginar otra escritura: antes de salir, mirar la cola — «si hay mensajes colados, ¿sigo parando o no?» — y entonces la lógica de parada se enreda con la de las colas, y nacen ramas combinatorias del tipo «quiere parar pero hay mensajes», «no para pero la cola está vacía». La solución de pi es mantener el modelo de problemas lo más simple posible: **cada callback responde solo una pregunta; las que no se le hicieron se dejan para el siguiente run.** `shouldStopAfterTurn` solo responde «¿parar o no?»; si dice parar, el bucle hace `return` — esa línea de `return` está antes del poll de steering (`pendingMessages = (await config.getSteeringMessages?.()) || []`), y el poll de follow-up está aún más atrás, fuera del bucle interior; las dos líneas de poll ni siquiera llegan a ejecutarse. Y un poll no ejecutado no es anular: el drain no ocurrió, los mensajes siguen en la cola del propio host, y el siguiente run los puede tomar igual.

Así cada punto de decisión tiene código de una sola línea, y la corrección no depende de ningún juicio combinatorio. El orden mismo es semántica: primero preguntar «¿parar?», después «¿hay alguien en cola?». El sentido entero de las dos colas es hacer que el run **continúe** — steering es añadir trabajo a mitad de camino, follow-up es añadirlo al terminar —; si el host acaba de decir parar, preguntar a la cola sería autocontradictorio: un mensaje en cola forzaría la vuelta que el host acaba de vetar.

¿Y dónde está el «cuerpo de la función»? **No en este paquete.** Es la costura entre el bucle y el host: el bucle solo tiene el punto de llamada; la lógica de juicio la aporta por completo el host. La clase `Agent` la expone como una propiedad pública asignable, y al ensamblar la envuelve y la mete en el config:

```typescript
// src/agent.ts:456 (dentro de Agent.createLoopConfig)
shouldStopAfterTurn: shouldStopAfterTurn
	? async (context) => await shouldStopAfterTurn(context, this.signal)
	: undefined,
```

Esa capa de envoltorio solo hace una cosa: alimentar a tu callback con un signal de más; si no lo configuraste, se pasa `undefined`, y el `?.` del lado del bucle hace corto circuito a «no parar». Así que cómo es de verdad el cuerpo de la función es cosa de la aplicación — por ejemplo «estimar el número de tokens del contexto actual; si supera el umbral, devolver `true`», una implementación típica del escenario de gestión de contexto:

```typescript
// ilustración: si el contexto supera el umbral, pedir cierre elegante (código del lado de la app, no está en el repo pi)
function roughTokens(messages: AgentMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += JSON.stringify(m.content).length;
	}
	return Math.ceil(chars / 4);   // estimación gruesa: ~4 caracteres ≈ 1 token
}

agent.shouldStopAfterTurn = ({ context }) => {
	return roughTokens(context.messages) > 150_000;
};
```

El bucle se para tras esta vuelta; el host toma el relevo para comprimir o resumir, y abre el siguiente run con el nuevo contexto — los mensajes de cola saltados siguen en la cola, y el primer poll del nuevo run los puede tomar.

Este ejemplo tiene tres detalles más que conviene dejar claros.

- **Umbral**: 150k es un valor de ejemplo; en la práctica se fija según la context window del modelo — por ejemplo, en un modelo de ventana 200k hay que reservar espacio para la salida y el system prompt, y pisar el freno hacia los 150k.
- **Estimación**: `roughTokens` es una estimación gruesa por número de caracteres; una implementación real usaría el tokenizer del modelo correspondiente (la compaction del harness tiene el conteo formal de tokens; capítulo 10).
- **Granularidad**: solo actúa en el borde del turn — ese es el sentido de «elegante»: no corta un turn a medias, sino que espera a que esta vuelta quede completa en el saco y entonces para. Si quieres no parar y cambiar el contexto dentro del run para seguir, ese es el desvío de `prepareNextTurn` (sección «Desvío» de este capítulo).

La diferencia con abort está en **quién grita y cuándo**: abort es un pulso externo fuerte en cualquier momento, con efecto inmediato; `shouldStopAfterTurn` es el bucle preguntando en el borde del turn «¿quieres parar con dignidad aquí?» — el escenario típico es que el contexto está a punto de llenarse, y el host lo hace parar en esta vuelta para tomar el relevo con compresión o resumen. Junto con el `prepareNextTurn` de la sección «Desvío» más adelante en este capítulo, son un par de pomos: uno pregunta «¿parar?», el otro «¿cambio el equipo de la siguiente vuelta?». El contrato sigue siendo «el fallo se convierte en valor»: no se puede lanzar excepciones, o se rompe la secuencia de eventos (capítulo 3).

#### abort: salida incondicional

La granularidad de `agent.abort()` merece subrayarse otra vez en el contexto de las «salidas»: **abort termina el run entero, no el turn actual.** No pasa por ninguna de las condiciones de esta sección — no mira `hasMoreToolCalls`, no espera a `shouldStopAfterTurn`, las dos colas tampoco hacen más poll; el signal hace que la petición al modelo en curso (o la siguiente) se cierre con `stopReason: "aborted"`, y da de lleno en la rama de `return` del esqueleto. Cómo se para en cada uno de los tres momentos tras pulsar el botón ya se desglosó en la digresión «executor y signal»; aquí basta recordar que es **la única salida incondicional** — las demás salidas de esta sección preguntan «¿seguir?»; solo abort no pregunta.

### Bucle exterior: alargar la vida por follow-up

**Una vuelta del `while (true)` exterior = un lote de follow-up.** Cuando el interior se agota, el bucle debería terminar, pero primero pregunta a la cola de follow-up: si alguien hace cola de «de paso, haz otra cosa», las mete en `pendingMessages`, hace `continue` y deja que el interior vuelva a girar; si no, `break`. La razón entera de existir del exterior es esa pregunta.

La forma de consumir `pendingMessages` también merece un vistazo fino, porque es el punto donde confluyen las dos colas. El bloque de inyección hace tres cosas: emitir `message_start`/`message_end` uno a uno (para el suscriptor, la secuencia de eventos de un mensaje colado es idéntica a la de uno normal), empujar a `currentContext` y `newMessages` (la siguiente petición al modelo lo verá), y luego vaciar el array (como máximo se inyecta un lote por vuelta; cuántas van en un lote lo decide el mode de la cola, `one-at-a-time` o `all`; capítulo 5). Fíjate en el punto de inyección: **antes de llamar al modelo** — el mensaje colado entra siempre al contexto antes de la siguiente respuesta del modelo. Y cuando el exterior alarga la vida asignando `followUpMessages` a `pendingMessages`, usa exactamente el mismo conducto de inyección: **steering y follow-up comparten un solo mecanismo; la diferencia solo está en el momento del poll** — uno pregunta tras cada turn, el otro solo cuando de verdad va a parar.

¿Por qué hacen falta dos capas, y no un while grande? Porque el **momento de comprobación** de las dos colas es distinto: steering hay que mirarlo tras cada turn (el usuario se cuela en cualquier momento mientras el agent trabaja); follow-up solo se mira en el punto de «el agent de verdad va a parar». Si se funden en un solo bucle, hay que expresar dos momentos en la misma condición, y el código echa banderas raras; dos while, cada uno un momento, y la condición se lee como la semántica del negocio misma.

Otra cosa: cómo se pasa el estado entre iteraciones. `currentContext`, `newMessages` y `config` son parámetros o bindings locales de `runLoop`; cada vuelta los modifica in situ (empuja mensajes, cambia la instantánea), y la siguiente sigue usándolos. Sin recursión no hay problema de profundidad de pila, ni el coste de copia de «cada capa de llamada con su propio contexto» — **la máquina de estados del bucle es plana**.

¿La «modificación in situ» llega fuera del bucle? Hay que mirar los dos arrays por separado. `newMessages` sí — y es **a propósito**: `runAgentLoop` lo crea (`[...prompts]`), se lo entrega a `runLoop` para que lo rellene, y al terminar hace `return` del mismo array al llamador (ver la cita de `runAgentLoop` al inicio de esta sección); empujar mensajes in situ es precisamente el canal de devolución del resultado. `currentContext.messages` no: al construir el contexto, `runAgentLoop` levantó otro array (`[...context.messages, ...prompts]`); da igual cuántas se empujen dentro del bucle, el `context.messages` del llamador no se mueve.

Merece pararse un momento en la firma de estos seis parámetros — son toda la interfaz del bucle hacia fuera. `prompts` y el valor de retorno son `AgentMessage[]`; `signal` es un `AbortSignal` opcional; `streamFn` es el `StreamFn` citado en el capítulo 1 (`src/types.ts:28`). Quedan tres:

```typescript
// src/agent-loop.ts:25 — salida de eventos; acepta sync y async
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

```typescript
// src/types.ts:406 — el "diálogo actual" a ojos del bucle
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}
```

`config: AgentLoopConfig` (`src/types.ts:144`) es el bloque más grande — modelo, compuertas, hooks, polling de colas, todo está ahí; el capítulo 5 lo desmonta campo a campo. Aquí basta recordar la división: `context` es **datos** (qué decir), `config` es **comportamiento** (cómo decirlo, qué hacer al terminar), `emit` es **salida** (a quién se lo dices).

### Desvío: cambiar la instantánea entre dos vueltas (prepareNextTurn)

El bloque que se plegó en la cita del tronco, ahora se despliega. Tras cada `turn_end` y antes del siguiente poll de steering, da al host una oportunidad de «cambiar el equipo de la siguiente vuelta».

Una verdad primero: este desvío es el jefe oculto del capítulo — contrato, adaptación e implementación atraviesan tres capas, más un choque de nombres e instalación apilada; la dificultad está por encima de la media del capítulo. Si no puedes, sigue adelante: la línea principal se completa igual; tras subir de nivel en los capítulos siguientes puedes volver a pelearlo. Las secciones siguientes bajan a cada capa; primero el mapa:

- **Capa del bucle de agente** (`agent-loop.ts`): define el contrato — pregunta una vez al terminar cada vuelta; la instantánea que vuelve se fusiona campo a campo con `??`;
- **Capa Agent** (`agent.ts`): expone el contrato como dos propiedades públicas asignables; al ensamblar las normaliza a la firma única que reconoce el bucle;
- **Capa host** (coding-agent / harness): la implementación de verdad — instalación apilada, o reconstruir la instantánea tras persistir a disco.

Primero el contrato de la capa del bucle de agente:

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

La pregunta que responde es: **a mitad de un run, ¿qué hace el host si quiere cambiar el contexto, el modelo o la intensidad de pensamiento?**

Dos detalles semánticos que conviene recordar. Uno, la forma de fusión: cada campo de la instantánea puede faltar; si falta, `??` cae al valor actual — el host puede cambiar solo el modelo y no tocar el contexto, o al revés. Dos, `thinkingLevel: "off"` se traduce de forma explícita a `reasoning: undefined`, porque el contrato aguas abajo (`SimpleStreamOptions`) expresa el apagado con «no hay campo reasoning», no con `"off"` — ese ternario de tres capas es alinear vocabularios.

El momento también importa: el reemplazo ocurre tras `turn_end` y antes del poll de steering. Eso significa que aunque la siguiente vuelta sea para responder a un mensaje colado, ya usa la instantánea nueva — colarse no hace que el host pierda la oportunidad de cambiar de equipo.

#### Costura: dos nombres, un adaptador

La capa Agent del mapa. El nombre `prepareNextTurn` aparece en esta capa en tres sitios, y `prepareNextTurnWithContext` en dos; no son la misma cosa. Separen primero los tres sitios:

- **Entrada**: las dos claves homónimas de `AgentOptions`—donde el host pasa las funciones al construir `Agent`;
- **Ranura**: las dos propiedades públicas de la instancia `Agent` (`src/agent.ts:197`, cita abajo)—`Agent` solo define la firma, no aporta implementación; la implementación viene de fuera, por eso la llamamos ranura;
- **Salida**: la clave única `prepareNextTurn` de `AgentLoopConfig`—al ensamblar se normaliza desde la ranura (cita abajo).

La entrada es el paquete de parámetros del constructor: el constructor de `Agent` solo recibe un argumento, de tipo `AgentOptions`, y esas dos claves homónimas viven en ese tipo:

```typescript
// src/agent.ts:216 (inicio del constructor de Agent)
constructor(options: AgentOptions) {
	// Older compiled consumers may omit options or streamFn even though the current API requires them.
	const runtimeOptions: Partial<AgentOptions> = options ?? {};
```

De la entrada a la ranura es la copia rutinaria del constructor, el mismo trato que cualquier callback:

```typescript
// src/agent.ts:229 (dentro del constructor de Agent)
this.prepareNextTurn = runtimeOptions.prepareNextTurn;
this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
```

`runtimeOptions` es el alias defensivo de la cita de firma de arriba—el comentario del código fuente deja claro contra quién se defiende: los artefactos compilados antiguos pueden no pasar options en absoluto. Además de pasarla en la construcción, el host puede en tiempo de ejecución saltarse la entrada y asignar directamente a la ranura para reemplazar—coding-agent va por esa vía, véase más abajo.

La declaración de la ranura:

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

La diferencia entre las dos ranuras está solo en el primer parámetro: la versión antigua solo da signal; la nueva da además la información del turn que acaba de terminar; el valor de retorno es idéntico—esa instantánea de tres campos que al inicio del Desvío se fusiona campo a campo con `??`. Al ensamblar, `Agent` lee esas dos ranuras y las normaliza al nombre único de la salida:

```typescript
// src/agent.ts:459 (dentro de Agent.createLoopConfig, el literal del objeto que se hace return — es decir AgentLoopConfig; el resto de claves plegado, las de la cita de ensamblaje al inicio del capítulo)
return {
	// ... (model, convertToLlm, sondeo de cola y demás claves)
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

Que convivan dos nombres es por compatibilidad: la firma de la propiedad pública antigua no se puede cambiar a secas (CHANGELOG 0.80.3 registra esa historia); quien necesita la información del turn usa la nueva. El «adaptador» del título es precisamente este envoltorio: las dos firmas que da el host y la firma única que pide el bucle de agente no coinciden, y él hace de traductor en medio—hacia el bucle siempre expone la forma `(context)`; hacia dentro mira cuál hay en la ranura: la nueva reenvía `context`, la antigua tira `context` y solo pasa `signal`.

Al leer esta cita, vuelvan a mirar esos tres sitios: la línea divisoria ya se ve en la cita. El literal del objeto del `return` es **`AgentLoopConfig`**—a la izquierda `prepareNextTurn:` es su clave (**salida**), y el bucle la llama con context (la cita del inicio del Desvío); mientras que `this.prepareNextTurnWithContext` / `this.prepareNextTurn` dentro del cuerpo de la función son las ranuras de la **instancia `Agent`**, y solo se leen con el valor actual de la ranura cuando el bucle las llama cada vuelta. Así que «se define citándose a sí misma» no se sostiene: la clave que se define pertenece a `AgentLoopConfig`, las propiedades que se leen pertenecen a `Agent`—dos tipos, dos objetos, solo chocaron los nombres; si `this.prepareNextTurn` también fuera una clave de ese literal, ahí sí habría autorreferencia. Y la ranura ya está cargada en la construcción o en tiempo de ejecución; aquí solo se envuelve una capa para normalizar.

#### Implementación: apilar y reconstruir

Más abajo, a la capa host. En este repositorio el gancho tiene dos implementaciones reales, y el camino es justo el opuesto: coding-agent apila una capa y cada vuelta relee systemPrompt, lista de herramientas, modelo e intensidad de pensamiento—

```typescript
// packages/coding-agent/src/core/agent-session.ts:526 (desde la raíz del repo, AgentSession._installAgentNextTurnRefresh)
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

La asignación reemplaza por completo la función que ya hubiera en la ranura, así que la instalación de coding-agent no es un reemplazo simple, sino **apilar una capa**: primero captura el valor antiguo en `previousPrepareNextTurnWithContext`; la función nueva lo llama primero, pone su instantánea debajo, y luego sobrescribe y refresca cuatro campos—los valores se leen todos al momento desde `state`, así que un cambio a mitad del run entra en vigor en la siguiente vuelta. (`this.agent.state` pasa por el accesor público de `Agent`, y es el mismo objeto que `this._state` en la cita de agent.ts. El accesor es azúcar sintáctica de Typescript; detalle en la sección «emit al otro lado»)

¿De dónde viene el valor antiguo? En el propio camino de ensamblaje de coding-agent en realidad no lo hay—su sdk interno, al hacer `new Agent`, no pasa esa propiedad, así que `AgentSession` siempre se enfrenta a una ranura vacía; lo que se defiende es que un usuario del SDK haya puesto su propia función en la ranura antes de que `AgentSession` tome el control (las opciones del constructor aceptan esas dos propiedades; véase la sección «Costura» anterior)—esa captura es precisamente para no perder esa vía.

La implementación de harness es otro estilo: cada vuelta primero vuelca a disco las escrituras diferidas acumuladas durante el run, y luego reconstruye la instantánea entera desde la session:

```typescript
// src/harness/agent-harness.ts:527 (dentro de AgentHarness.createLoopConfig, recortado)
prepareNextTurn: async () => {
	await this.flushPendingSessionWrites();
	const nextTurnState = await this.createTurnState();
	setTurnState(nextTurnState);   // para que el lado de eventos y hooks también vea la instantánea nueva
	return {
		context: this.createContext(nextTurnState),
		model: nextTurnState.model,
		thinkingLevel: nextTurnState.thinkingLevel,
	};
},
```

#### Otro uso: compresión dentro del run

¿Y la compresión? Como host, la elección de coding-agent es **hacerla entre runs**—el camino de shouldStopAfterTurn en «Cuándo se para el bucle de agente»: parar en esta vuelta, el host comprime, abrir un run nuevo (el capítulo 10 lo detalla). Pero «no interrumpir el run y cambiar el contexto dentro de la vuelta» es precisamente la capacidad exclusiva de este gancho—la biblioteca deja ese camino a los hosts que lo necesiten, así:

```typescript
// Esquema: compresión dentro del run (código del lado de la aplicación, no está en el repo de pi — coding-agent pone la compresión entre runs, véase arriba)
agent.prepareNextTurnWithContext = async ({ context }) => {
	if (roughTokens(context.messages) <= 150_000) {
		return undefined;   // aún no hace falta cambiar: devolver undefined y el bucle sigue con el contexto actual
	}
	const summary = await summarize(context.messages);   // lógica de compresión propia del host
	return {
		context: {
			...context,
			messages: [summaryMessage(summary), ...keepRecentTurns(context.messages)],
		},
	};
};
```

`roughTokens` reutiliza la función de estimación de la sección shouldStopAfterTurn; `summarize`, `summaryMessage` y `keepRecentTurns` son implementaciones propias del host—el gancho solo tiene un trabajo: devolver la instantánea nueva. Una nota sobre la escritura de parámetros: `({ context })` desestructura el objeto del primer parámetro—el `nextTurnContext` que el bucle ensambla en la cita del tronco (cuatro campos: `message`/`toolResults`/`context`/`newMessages`), y saca el campo `context`; la implementación de coding-agent elige nombrar el objeto entero `turn` y luego tomar `turn.context`, mismo tipo, dos escrituras. El nombre de propiedad es la versión nueva con Context: si se escribiera la antigua `prepareNextTurn`, el callback recibiría signal y no se podría desestructurar `context`—ese tropiezo es justo el origen de los dos nombres de la sección «Costura: dos nombres, un adaptador».

### emit al otro lado: quién recibe

`emit` es solo un parámetro de tipo función, así que "cómo se reciben los eventos" no tiene una respuesta única: el receptor es lo que el llamador pasa. En este paquete hay dos llamadores, que corresponden a dos modos de recepción.

**Primero, la clase `Agent`**: pasa `(event) => this.processEvents(event)` (`src/agent.ts:414`, véase la cita de `runPromptMessages` más arriba). El evento se reduce primero en `state`, y luego se hace await de cada suscriptor — esa cadena tiene cita completa en la sección "Cierre" de este capítulo. Es el modo "empuje": el bucle te empuja activamente, y tu listener forma parte de la liquidación del bucle.

**Segundo, el `agentLoop()` desnudo**: no pasa un listener; empuja los eventos a un `EventStream` y deja que el llamador tire con `for await`:

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

Fíjate: la implementación de `emit` aquí es solo una línea `stream.push(event)`, y delante de `runAgentLoop` no hay `await` — el bucle corre en segundo plano y la función devuelve el stream al llamador de inmediato. `EventStream` es un envoltorio "cola asíncrona + iterador" que ofrece pi-ai: el productor hace push, el consumidor saca uno a uno con `for await`; al llegar a `agent_end` la iteración termina y entrega el `AgentMessage[]` final. Esa condición de fin se define en los dos callbacks de `createAgentStream` — el primero decide "¿es este el último?", el segundo toma el resultado del último:

```typescript
// src/agent-loop.ts:145
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}
```

La diferencia entre ambos modos de recepción se resume en una pregunta: **si tu manejo de eventos es lento, ¿el bucle se detiene a esperarte?**

**Modo tirar: no espera.** Recibes el extremo de lectura de una cola; el bucle solo hace push y sigue — la siguiente llamada al LLM, la siguiente ejecución de herramienta, no se ralentizan por tu velocidad de consumo. Tu `for await` es un reloj independiente:

```typescript
// Tirar: el bucle corre en segundo plano; tú sacas a tu ritmo
for await (const event of agentLoop(prompts, context, config, signal, streamFn)) {
	await render(event);   // Si vas lento, los eventos se acumulan en la cola; el bucle no te mira
}
```

**Modo empujar: espera.** Registras el listener en `Agent`. Aquí no hay cola — cada vez que el bucle produce un evento, la cadena de llamadas llega hasta ti: `emit()` → `processEvents()` → tu listener, y cada eslabón es `await`:

```typescript
// src/agent.ts:250 (Agent.subscribe) — solo mete el listener en un Set; lo que devuelve es la función de baja
subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
	this.listeners.add(listener);
	return () => this.listeners.delete(listener);
}

// Tu lado:
agent.subscribe(async (event) => {
	await render(event);
});

// src/agent.ts:584 (dentro de Agent.processEvents, recortado; cita completa en la sección "Cierre" de este capítulo) — el lado del bucle:
for (const listener of this.listeners) {
	await listener(event, signal);   // Mientras no hagas return, el bucle no emite el siguiente evento
}
```

Así que tu tiempo de procesamiento es un tramo en la línea temporal del bucle: si vas lento, todo el run va lento; si no terminas, el siguiente evento no llega.

Cada modo paga algo y gana algo. El modo tirar paga la **garantía de orden y liquidación** — mientras procesas el evento N, el bucle puede ir ya por el N+50; preguntas del tipo "¿en qué paso estamos?" no tienen respuesta autoritativa en modo tirar; a cambio ganas **desacoplamiento**: puedes agrupar, filtrar, reenviar, persistir, e incluso consumir despacio después de que el run haya terminado.

El modo empujar es al revés: paga **velocidad** (un listener lento arrastra todo el run) y gana **garantías**. Conviene enumerar qué garantías son — todas las compra ese "await uno a uno" de dos líneas. Cada una con un ejemplo de "así puedes escribir":

**El flujo de eventos que ves es la línea temporal del bucle.** Mientras todos los oyentes del evento N no hayan terminado, el N+1 no se emite. Así que "actual" tiene sentido — al procesar `message_update`, todos los eventos anteriores ya se han aplicado; no hay ventana de "no alcanzo":

```typescript
// La UI puede aplicar incrementos in situ, sin preocuparse por desorden ni huecos
agent.subscribe((event) => {
	if (event.type === "message_update") {
		ui.replaceLastMessage(event.message);   // El update anterior ya está garantizado renderizado
	}
});
```

**`state` y los eventos siempre coinciden.** Primero una relación de nombres: el `agent.state` que lees en el listener y el `this._state` de las citas anteriores son **el mismo objeto** — el accessor público devuelve el campo interno tal cual:

```typescript
// src/agent.ts:260 (accessor state de Agent)
get state(): AgentState {
	return this._state;
}
```

("Accessor" es azúcar sintáctico de JS/TS: `get state() {...}` se declara como método pero se usa como campo — escribes `agent.state`, sin paréntesis; solo hay `get` y no `set`, así que hacia fuera es de solo lectura.)

`processEvents` primero reduce el evento en `state` y luego llama a los listeners (en la cita de "Cierre" se ve ese orden), así que al leer `agent.state` en el listener obtienes necesariamente el estado **después** de ese evento; no hace falta sincronizar a mano:

```typescript
agent.subscribe((event) => {
	if (event.type === "message_end") {
		agent.state.messages.at(-1) === event.message;   // Siempre true: la reducción ocurre antes de llamarte
	}
});
```

**Tu trabajo asíncrono cuenta en la liquidación del run.** Escrituras a BD y peticiones de red que awaitas en el listener entran en la definición de "run terminado" — `waitForIdle()` no resuelve hasta que el último listener de `agent_end` haya terminado (sección anterior «Liquidación y waitForIdle»). Así que hacer efectos secundarios en el listener es seguro:

```typescript
agent.subscribe(async (event) => {
	if (event.type === "agent_end") {
		await db.save(event.messages);   // Si va lento da igual: el bucle espera
	}
});

await agent.prompt("Resume este archivo");   // Al retornar, db.save ya ha terminado con garantía
```

Eso es el significado concreto de la frase del capítulo 1: "`Agent` es un envoltorio del bucle". La elección depende de si necesitas esa garantía: para UI normalmente sí — el render necesita un `state` coherente, la escritura a BD necesita una barrera de liquidación → elige empujar (`Agent`); para pipelines normalmente no — reenviar el flujo de eventos a logs, analítica u otro sistema, eres solo de paso → elige tirar (`agentLoop()` desnudo).

En contraste, la firma de `runWithLifecycle` es mucho más pequeña — no gestiona datos ni comportamiento, solo el ciclo de vida:

```typescript
// src/agent.ts:482
private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void>
```

Entra un executor, sale una Promise de "ya terminó"; el registro de `activeRun`, el volteo de `isStreaming`, el fallback ante fallos y el `finishRun()` final quedan todos detrás de esa firma pequeña. Mirando las dos firmas juntas, ahí está toda la costura entre la clase `Agent` y el bucle: **el bucle pide datos, comportamiento y salida; la capa de envoltorio solo pide un cuerpo de ejecución.**

## Llamar al modelo: dos compuertas

La acción central del bucle interior es `streamAssistantResponse`:

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

### Pasar las compuertas: primero transformar, luego traducir

Antes de enviar realmente la petición, los mensajes pasan por dos compuertas:

```typescript
// src/agent-loop.ts:289
let messages = context.messages;
if (config.transformContext) {
	messages = await config.transformContext(messages, signal);   // AgentMessage[] → AgentMessage[]
}

// Convert to LLM-compatible messages (AgentMessage[] → Message[])
const llmMessages = await config.convertToLlm(messages);
```

- `transformContext` (opcional): opera directamente sobre el array de mensajes del lado agent — recortar mensajes viejos, inyectar contexto externo. Entrada y salida son `AgentMessage[]`.
- `convertToLlm` (obligatorio): traduce `AgentMessage` al `Message` del lado LLM. El LLM solo conoce tres roles: `user`/`assistant`/`toolResult`; tus tipos de mensaje personalizados (p. ej. "notificación", "resumen de compresión") o se convierten o se filtran.

Estas dos compuertas son uno de los diseños más importantes del libro; el capítulo 3 las desarrolla. Aquí basta recordar: **el cuerpo del bucle habla solo `AgentMessage` de principio a fin; la traducción ocurre únicamente en el límite de la llamada al LLM** — eso mismo está escrito en el comentario de cabecera del archivo:

```typescript
// src/agent-loop.ts:1
/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */
```

### Reflujo: un mensaje toma forma in situ

Pasadas las compuertas, se llama a `streamFn` y empiezan a volver eventos. El bucle mantiene con esos eventos de flujo un "mensaje en formación" (`partialMessage`), lo actualiza in situ y a la vez reenvía a los suscriptores:

```typescript
// src/agent-loop.ts:314 (dentro de streamAssistantResponse)
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

Aquí hay **dos grupos de eventos**; hay que distinguirlos. Las etiquetas `case` son eventos de **entrada** — los que devuelve el flujo del modelo, de tipo `AssistantMessageEvent`, los "eventos de flujo" de arriba; los tres grupos corresponden a cuerpo, pensamiento y argumentos de tool call; `message_update` es un evento de **salida** — un miembro de la unión `AgentEvent`, lo que el bucle envía a los suscriptores. Entrada y salida: este código traduce eventos de entrada en eventos de salida.

Que nueve tipos puedan compartir un mismo cuerpo de función se explica en la definición de `AssistantMessageEvent`: cada uno de los nueve miembros de incremento lleva un snapshot `partial` **completo** — no un delta, sino "el mensaje entero hasta ahora" (los terminales `done`/`error` llevan directamente el mensaje final):

```typescript
// packages/ai/src/types.ts:510 (desde la raíz del repositorio)
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

Así el bucle no necesita distinguir de qué grupo viene: `partialMessage = event.partial` sustituye el conjunto y actualiza in situ — la última celda que se sobrescribe es justo la que `start` hizo `push` como placeholder. El guard `if (partialMessage)` protege frente a flujos que no cumplen: el comentario de tipos dice "Streams should emit `start` before partial updates"; en una implementación correcta `start` llega primero; si un incremento se adelanta, no hay dónde ponerlo y se salta. ¿Dónde quedó la diferencia entre los tres grupos? En el campo `assistantMessageEvent` del evento de salida — que el nombre del campo coincida con el tipo de entrada no es casualidad; su tipo es precisamente el de arriba:

```typescript
// src/types.ts:432 (un miembro de la unión AgentEvent; la barra vertical es "o")
| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
```

El suscriptor mira `message_update.assistantMessageEvent.type` y sabe qué grupo está fluyendo — la UI usa eso para renderizar el incremento como cuerpo, bloque de pensamiento en gris, o argumentos de tool call.

Al recibir `done` (o `error`), `response.result()` obtiene el mensaje final: en el caso normal sustituye la celda que ocupó `start`; si ni siquiera llegó `start` (`addedPartial` sigue en `false` — el mismo tipo de flujo irregular que guarda `if (partialMessage)`), hace un `push` nuevo y reemite `message_start` (dos `if` en lugar de meter la reemisión en el `else` es solo estilo; son equivalentes — al final de la misma función, la rama de respaldo cuando el bucle termina con normalidad sí está escrita junta). Por último se emite `message_end`, `return finalMessage`, y esta ronda de llamada al modelo termina. Esta función emite solo los tres a nivel de mensaje; el origen de los demás niveles de `AgentEvent` se detalla en la sección «Cierre» de este capítulo.

## Ejecutar herramientas: primero preparar, luego disparar

Si el mensaje assistant lleva bloques de contenido `toolCall`, se entra en la ejecución de herramientas. En la entrada hay un guard fácil de pasar por alto:

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

Cuando la salida se corta por el límite de tokens, los argumentos de cada tool call pueden ser JSON incompleto. **Se marcan todos como error; no se ejecuta ninguno**, y se deja que el modelo los reenvíe. El texto del error le dice la causa directamente al modelo:

```typescript
// src/agent-loop.ts:395 (dentro de failToolCallsFromTruncatedMessage)
result: createErrorToolResult(
	`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
),
```

En el caso normal se entra en `executeToolCalls` (`src/agent-loop.ts:411`); cada tool call sigue una tubería de tres tramos. Aquí basta seguir la vía principal; el contrato completo de la tubería queda para el capítulo 6.

**Primer tramo, prepare**: encontrar la herramienta, pasar la capa de compatibilidad `prepareArguments`, validar argumentos contra el schema, preguntar a `beforeToolCall` si deja pasar. Si no se encuentra la herramienta, se convierte de inmediato en un resultado de error "ya terminado":

```typescript
// src/agent-loop.ts:607 (dentro de prepareToolCall)
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
	return {
		kind: "immediate",
		result: createErrorToolResult(`Tool ${toolCall.name} not found`),
		isError: true,
	};
}
```

`beforeToolCall` tiene derecho a interceptar. Es un slot opcional: solo se pregunta si existe; al preguntar se entrega el mensaje assistant, el tool call, los argumentos validados y el contexto actual, y se recibe un `BeforeToolCallResult` — devolver `undefined` (o un objeto vacío) es dejar pasar; `block: true` es bloquear; `reason` pasa a ser el texto del resultado de error:

```typescript
// src/types.ts:61
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}
```

El lugar de la llamada (la comprobación intermedia de `signal?.aborted` es el puesto de guardia habitual de la sección «abort: salida incondicional»):

```typescript
// src/agent-loop.ts:619 (dentro de prepareToolCall)
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

**Segundo tramo, execute**: llamar a `execute()` de la herramienta. Si la herramienta lanza, no importa — se captura y se envuelve como resultado con `isError: true`:

```typescript
// src/agent-loop.ts:675 (dentro de executePreparedToolCall, recortado)
try {
	const result = await prepared.tool.execute(
		prepared.toolCall.id,
		prepared.args as never,
		signal,
		(partialResult) => { /* se convierte en evento tool_execution_update */ },
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

**Tercer tramo, finalize**: preguntar a `afterToolCall` si quiere reescribir el resultado — le entrega el resultado actual y la bandera de error, recibe un parche, y sobrescribe campo a campo; los campos no aportados conservan el valor original. Si el hook lanza, también hay red de seguridad, el mismo trato que en el tramo execute: se envuelve como `isError: true`:

```typescript
// src/agent-loop.ts:717 (dentro de finalizeExecutedToolCall)
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

Paralelo o secuencial depende de la configuración y de lo que declare cada herramienta:

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

Por defecto parallel — todas las herramientas se preparan una a una primero (`beforeToolCall` se invoca en orden de declaración), luego las que pasan se ejecutan concurrentemente; `tool_execution_end` se emite en **orden de finalización**; pero los mensajes toolResult que caen en el flujo de mensajes siguen el **orden de declaración** del mensaje assistant:

```typescript
// src/agent-loop.ts:540 (dentro de executeToolCallsParallel)
const orderedFinalizedCalls = await Promise.all(
	finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
);
const messages: ToolResultMessage[] = [];
for (const finalized of orderedFinalizedCalls) {   // orderedFinalizedCalls conserva el orden de declaración
	const toolResultMessage = createToolResultMessage(finalized);
	await emitToolResultMessage(toolResultMessage, emit);
	messages.push(toolResultMessage);
}
```

Basta con que una herramienta del lote declare `executionMode: "sequential"` para que todo el lote degrade a ejecución una a una. Los resultados de herramienta se convierten en mensajes `toolResult` en el contexto, se emite `turn_end`, y un turn termina.

## Cierre: cómo aterrizan los eventos

Los eventos de `AgentEvent` pertenecen a cuatro niveles; cada nivel tiene su origen:

```
run      agent_start · agent_end  ← esqueleto («Las dos capas del bucle de agente»)
turn     turn_start · turn_end  ← esqueleto, cada vuelta del bucle interior
message  message_start · message_update · message_end  ← reflujo (assistant)· inyección (prompt, intercalado, follow-up)
tool     tool_execution_start · _update · _end  ← tubería de herramientas («Ejecutar herramientas»)
```

Los eventos de los cuatro niveles pasan todos por `Agent.processEvents`. Hace dos cosas: primero **reduce** el evento en el estado (`message_end` mete el mensaje en `state.messages`, `tool_execution_start` añade el id a `pendingToolCalls`), y luego **hace await de cada suscriptor uno a uno**:

```typescript
// src/agent.ts:540 (dentro de Agent.processEvents, recortado)
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

En «emit al otro lado» dijimos que el "await uno a uno" es la diferencia más sustancial entre `Agent` y el bucle desnudo — el procesamiento asíncrono del suscriptor forma parte de la liquidación del run. Aquí se ve su forma de cierre: emitir `agent_end` ≠ fin del run; cuando todos los listeners de `agent_end` han terminado, `finishRun()` limpia el estado de runtime y entonces `waitForIdle()` resuelve:

```typescript
// src/agent.ts:525 (dentro de Agent.finishRun)
private finishRun(): void {
	this._state.isStreaming = false;
	this._state.streamingMessage = undefined;
	this._state.pendingToolCalls = new Set<string>();
	this.activeRun?.resolve();
	this.activeRun = undefined;
}
```

Eso significa que puedes escribir a la base de datos con tranquilidad en un listener de `agent_end` — el bucle te espera.

## Resumen del capítulo

El recorrido completo de un `prompt()`:

```
prompt() → runPromptMessages → runWithLifecycle → runAgentLoop(snapshot, ensamblaje) → runLoop
  ├─ transformContext → convertToLlm → streamFn (streaming)
  ├─ prepare → execute → finalize (tubería de herramientas en tres tramos)
  ├─ turn_end → prepareNextTurn? → shouldStopAfterTurn? → steering?
  └─ follow-up? → el bucle exterior da otra vuelta
→ agent_end → await de todos los listeners → finishRun
```

Los cuatro puntos de decisión tras el fin de un turn, en el orden en que el código pregunta (contraste con la cita del esqueleto `src/agent-loop.ts:226-272`):

1. `prepareNextTurn` — ¿cambiar el equipo de la siguiente vuelta? Véase la sección "Desvío".
2. `shouldStopAfterTurn` — ¿parar con elegancia? Véase "Cuándo se para el bucle de agente".
3. steering poll — ¿alguien se ha colado? Si sí, inyectar y el bucle interior da otra vuelta; véase "Bucle interior" (la comparación con follow-up está en "Bucle exterior").
4. follow-up poll — si de verdad se va a parar, ¿alguien dejó un mensaje posterior? Si sí, el bucle exterior prolonga; véase "Bucle exterior".

Si los cuatro fallan en vacío, se emite `agent_end` y `runLoop` retorna. abort no está en esta cadena: no espera al fin del turn; actúa en cualquier momento (véase el apartado abort de "Cuándo se para el bucle de agente").

El siguiente capítulo va al verdadero punto de apoyo de este mapa: por qué el tipo `AgentMessage` es el eje de todo el sistema, y las tres compuertas que vigilan la frontera con el LLM.

## ¿Por qué no?

> **¿Por qué un `prompt()` concurrente lanza error en lugar de encolar automáticamente hasta que termine la ronda anterior?** Porque el encolado automático ocultaría la decisión entre "quiero intercalarme" y "quiero esperar al final" — y esa es precisamente la frontera semántica entre steer y followUp (véase la siguiente tarjeta). La elección de la biblioteca es hacer la decisión explícita: si vuelves a llamar a `prompt()` mientras hay streaming, se hace throw, y el mensaje de error te da directamente las tres salidas (CHANGELOG 0.32.0: "preventing race conditions and corrupted state"):
>
> ```typescript
> // src/agent.ts:347 (dentro de Agent.prompt)
> if (this.activeRun) {
> 	throw new Error(
> 		"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
> 	);
> }
> ```

> **¿Por qué la cola se parte en steer / followUp y no en un solo `queueMessage`?** Porque el nombre antiguo mentía: `queueMessage()` se llamaba "encolar", pero su comportamiento real era intercalarse — un mensaje enviado en mitad de la ejecución se inyectaba en el hueco entre herramientas, mientras que la expectativa del usuario ante "queue" es "esperar a que el agent termine de verdad y procesar en orden". El título del issue #403 es "Queued Messages vs Steering: Mental Model Conflict": *"When a user types a message while the agent is working, it's called 'queued' but actually functions as a steering/interrupt mechanism."* Dos semánticas compartían un nombre y ambas se malentendían; al separarlas cada una encuentra su sitio — `steer()` interrumpe el run actual, `followUp()` espera a que el agent esté a punto de parar para entregar (commit `d0a4c3702`, CHANGELOG 0.32.0). La tubería de inyección en sí sigue siendo compartida: es la frase de «Bucle exterior: alargar la vida por follow-up» sobre que "steering y follow-up comparten un mismo mecanismo".

> **¿Por qué `shouldStopAfterTurn` no es un abort reforzado?** abort corta de inmediato el flujo del provider y `stopReason` pasa a `aborted`; este callback espera a que el turn actual termine por completo, tras emitir `turn_end`, y sale antes de sondear las colas y de la siguiente llamada al LLM — no toca el flujo, no cancela herramientas en curso, no cambia `stopReason`. El motivo está en el JSDoc: cerrar con elegancia cuando el context está casi lleno (otro escenario real es el traspaso al apagar un servicio, issue #4118):
>
> ```typescript
> // src/types.ts:208 (JSDoc de AgentLoopConfig.shouldStopAfterTurn, recortado: detalle de comportamiento y dos frases del contrato)
>  * Called after each turn fully completes and `turn_end` has been emitted.
>  * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
>  * without starting another LLM call.
>  * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
> ```

> **¿Por qué emit hace await de los suscriptores uno a uno en lugar de fire-and-forget?** Porque el trabajo típico del listener es persistir, flush — si empujas y no esperas, al devolver el run la escritura puede no haber terminado. Por eso el procesamiento asíncrono del suscriptor cuenta en la liquidación del run: `agent_end` solo significa "el bucle ya no emite eventos"; idle espera a que todos sus listeners hayan hecho settle. Esa semántica la corrigió el commit `9022a5b5e` — antes nadie esperaba la Promise del listener:
>
> ```typescript
> // src/agent.ts:241 (JSDoc de Agent.subscribe, recortado: la frase inicial y la del abort signal)
>  * Listener promises are awaited in subscription order and are included in
>  * the current run's settlement.
>  *
>  * `agent_end` is the final emitted event for a run, but the agent does not
>  * become idle until all awaited listeners for that event have settled.
> ```

> **¿Por qué la ejecución en paralelo sigue dividida en prepare / execute, y no cada tool call como una tarea asíncrona propia?** Porque `beforeToolCall` necesita ver el lote completo: los sistemas de permisos a menudo deciden según "qué quiere hacer en total este mensaje assistant", no caso a caso aislado. El prepare en orden garantiza que el hook ve el mismo orden que declaró el modelo; la concurrencia solo ocurre "después de dejar pasar". El comentario fija ese contrato:
>
> ```typescript
> // src/types.ts:36
> // - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
> //   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
> //   while tool-result message artifacts are emitted later in assistant source order.
> ```
>
> Cada orden sirve a lo suyo — el flujo de eventos sirve a "actualizar la UI cuanto antes"; el flujo de mensajes, a "que la transcripción sea reproducible".

> **¿Por qué no ejecutar los tool calls truncados "rescatados"?** Cuando la salida se corta por el límite de tokens, un parser JSON de "rescate best-effort" completa los argumentos a medias acumulados en streaming — tras completar pueden parsear y pasar la validación del schema, pero pueden quedar **silenciosamente incompletos**: qué campo falta, no hay forma de saberlo. Por eso no se ejecuta ninguno del lote y se deja que el modelo reenvíe (PR #6285; en revisión también se descartó un esquema más fino — añadir a `ToolCall` un campo `malformedArguments` y empujar el juicio al llamador):
>
> ```typescript
> // src/agent-loop.ts:374 (comentario de failToolCallsFromTruncatedMessage)
> /**
>  * Fail all tool calls from an assistant message that was truncated by the
>  * output token limit. Streamed tool-call arguments are finalized with a
>  * best-effort JSON salvage parser, so a truncated message can yield tool calls
>  * whose arguments parse and validate but are silently incomplete. None of them
>  * are safe to execute; report each as an error so the model can re-issue them.
>  */
> ```
