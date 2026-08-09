# Capítulo 1 · Qué es: un bucle de agente convertido en biblioteca

## Empezar por un escenario

Estás escribiendo una aplicación y quieres embeber un AI agent que «haga el trabajo solo»: le das una frase, llama al modelo, el modelo pide invocar herramientas, él las ejecuta, vuelve a alimentar el resultado al modelo, y así en bucle hasta que el modelo dice «listo». Quieres ver en tiempo real cada paso intermedio — el texto llega letra a letra, las herramientas se ejecutan una a una — porque vas a renderizarlo en la UI.

Eso es todo el problema que resuelve `pi-agent-core`. Su README lo resume en una frase: «Stateful agent with tool execution and event streaming» (`README.md:2`).

Desglosado, te da tres cosas:

1. **Un bucle de agente** (`src/agent-loop.ts`): entra un prompt, sale un flujo de eventos; en medio, el ir y venir de «llamar al modelo → ejecutar herramientas → volver a llamar al modelo».
2. **Una capa de estado** (`src/agent.ts`): la clase `Agent` mantiene por ti el historial de conversación, el mensaje que se está emitiendo en streaming y las herramientas en ejecución, de modo que en cualquier momento puedas responder «¿en qué paso está ahora?».
3. **Un conjunto de equipo** (`src/harness/`): sesiones persistentes, compresión de contexto, herramientas integradas de archivos/shell, carga de skills — convierte el «bucle que puede correr» en el «bucle que puede poner en producción un coding agent».

## Lo que se niega a hacer

Para entender una biblioteca, el límite importa tanto como la capacidad. `pi-agent-core` tiene cuatro rechazos explícitos; cada uno se puede verificar en el código.

**Rechazo uno: no conoce ningún proveedor de modelos.** En todo el repositorio no aparece el nombre de un solo provider. La interfaz de modelo que recibe el bucle es un tipo función:

```typescript
// src/types.ts:28
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

Solo estipula la forma: dame un `Model` y un `Context`, y te devuelvo un flujo de eventos. ¿Quién aporta esa función? El paquete de al lado, `@earendil-works/pi-ai` — otro paquete, con su propio directorio de providers y metadatos de modelos. La única dependencia de este paquete hacia él son esos tipos.

**Rechazo dos: no toca la UI.** En el paquete no hay ni una línea de código de renderizado. Su única forma de comunicarse hacia fuera es emitir eventos. Todos los eventos son una unión discriminada, diez variantes:

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

Flujo de texto, progreso de herramientas, ciclo de vida: todo cabe en esas diez. Si lo pintas como terminal, página web o archivo de log, es cosa tuya.

**Rechazo tres: el núcleo no hace persistencia.** El historial de conversación de la clase `Agent` es simplemente un array en memoria:

```typescript
// src/agent.ts:71
let tools = initialState?.tools?.slice() ?? [];
let messages = initialState?.messages?.slice() ?? [];
```

Al salir el proceso, todo se resetea. La persistencia existe, pero vive en la capa harness (capítulo 10), y es un modelo de «añadir entradas a un árbol» — el bucle central no sabe nada de ello.

**Rechazo cuatro: el núcleo no toca las APIs de runtime.** En los siete archivos de la raíz de `src/` no hay ningún `node:fs` ni `node:child_process`. Todo el acceso a archivos y shell queda empujado detrás de una interfaz (`ExecutionEnv`, se detalla en el capítulo 4); la única implementación Node está aislada en `harness/env/nodejs.ts` y se exporta por la entrada aparte `./node`:

```json
// package.json — exports (recortado)
".":              { "import": "./dist/index.js" },
"./node":         { "import": "./dist/node.js" },
"./experimental": { "import": "./dist/experimental.js" }
```

Así, el núcleo de este paquete puede correr en el navegador — `src/proxy.ts` está preparado precisamente para eso.

## Tres capas, no una

El malentendido más fácil con este paquete es: ¿qué relación hay entre la clase `Agent` y la clase `AgentHarness`? ¿Herencia? ¿Envoltorio?

Ninguna de las dos. Mira la dirección de las dependencias:

```
agent-loop.ts  (runAgentLoop —— bucle sin estado, 792 líneas)
    ▲                    ▲
    │                    │
agent.ts           harness/agent-harness.ts
(clase Agent,      (clase AgentHarness,
 588 líneas)         1185 líneas)
```

`Agent` y `AgentHarness` **llaman ambas directamente a `runAgentLoop`**; entre ellas no hay ninguna relación de llamada. Del lado de `Agent`:

```typescript
// src/agent.ts:409 (dentro de Agent.runPromptMessages)
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

Del lado de `AgentHarness`:

```typescript
// src/harness/agent-harness.ts:658 (dentro de AgentHarness.executeTurn)
return await runAgentLoop(
	messages,
	this.createContext(turnState, beforeResult?.systemPrompt),
	this.createLoopConfig(getTurnState, setTurnState),
	(event) => this.handleAgentEvent(event, signal),
	signal,
	this.createStreamFn(getTurnState),
);
```

Fíjate en que la forma de ambas llamadas es casi idéntica — contexto, configuración del bucle, callback de eventos, señal, función de stream — pero el origen de los parámetros es del todo distinto: `Agent` aporta un snapshot en memoria; `AgentHarness` aporta un snapshot por turno (`turnState`). `AgentHarness` no es una subclase de `Agent` ni su envoltorio: es otra capa de composición sobre el mismo primitivo de bucle, solo que compone mucho más — persistencia, compresión, hooks, máquina de estados de fases.

¿Por qué conviven dos capas? Porque su «peso» es distinto. Para embeber un panel de chat, basta con `Agent`; para construir un coding agent, usa `AgentHarness`. El bucle en sí es uno solo: esa es la primera virtud estructural de este paquete. **Las funciones complejas se obtienen por composición; el bucle no se vuelve más complejo.**

## Resumen del capítulo

- `pi-agent-core` es una biblioteca de bucle de agente: tres capas — bucle, estado y equipo.
- No conoce proveedores de modelos, no toca la UI, el núcleo no hace persistencia y el núcleo no toca las APIs de runtime.
- `Agent` y `AgentHarness` son dos capas de composición sobre el mismo primitivo de bucle; no dependen la una de la otra.

En el siguiente capítulo dejamos de hablar de posicionamiento y seguimos una llamada real a `prompt()` para recorrer el bucle de punta a punta.

## ¿Por qué no?

> **¿Por qué no depender directamente de pi-ai?** `src/stream-fn.ts` esboza la respuesta. El host puede instalar una función de stream por defecto:
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
> El comentario deja clara la motivación (`src/stream-fn.ts:9`): el catálogo de modelos tiende a hincharse (cada proveedor, cada modelo, cada precio), mientras que el contrato del bucle solo necesita la forma de una función. Depender de un tipo, no de un catálogo: esa es la razón de existir de `StreamFn`.
