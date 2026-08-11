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

Al salir el proceso, todo se resetea. La persistencia existe, pero vive en la capa harness (capítulo 9), y es un modelo de «añadir entradas a un árbol» — el bucle central no sabe nada de ello.

**Rechazo cuatro: el núcleo no toca las APIs de runtime.** En los siete archivos de la raíz de `src/` no hay ningún `node:fs` ni `node:child_process`. Todo el acceso a archivos y shell queda empujado detrás de una interfaz (`ExecutionEnv`, se detalla en el capítulo 3); la única implementación Node está aislada en `harness/env/nodejs.ts`.

El campo `exports` de `package.json` corta este límite en tres caras públicas:

```json
// package.json — exports (recortado)
".":                              "./dist/index.js",
"./node":                         "./dist/node.js",
"./experimental":                 "./dist/experimental.js",
"./experimental/session/testing": "./dist/harness/experimental/session/testing/index.js"
```

| Entrada | Contenido | Promesa implícita |
|---|---|---|
| `.` | capa núcleo + casi todo el harness | sin ningún import de `node:*`; corre en el navegador |
| `./node` | `NodeExecutionEnv` | el único binding de Node, opt-in explícito |
| `./experimental` | `experimental/session/` | en desarrollo, el contrato puede cambiar |

Este corte no es una comodidad de empaquetado, es una declaración de arquitectura: **«qué parte del código se atreve a tocar las APIs de runtime» se eleva a la altura del límite del paquete**. Que la entrada principal pueda correr en el navegador no descansa en la disciplina de la documentación, sino en que `node:fs` físicamente no existe en todo el cierre de dependencias de la entrada principal — y no es retórica: en todo el paquete (salvo los tests) hay un solo archivo que importa `node:*`, y es este:

```typescript
// src/harness/env/nodejs.ts:1 (bloque de imports, recortado: otras cinco líneas de node:* y ../types.ts)
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
```

Así, el núcleo de este paquete puede correr en el navegador — `src/proxy.ts` está preparado precisamente para eso.

## La otra cara de los rechazos: modelo, almacenamiento, runtime

Tres de los cuatro rechazos dejan un hueco que se puede sustituir entero, y la forma de sustituirlo es distinta en cada caso:

1. **streamFn**: toda la dependencia del bucle hacia la capa de modelo es la forma de una función (citada en el «rechazo uno» de este capítulo, `src/types.ts:28`). Cambiar de biblioteca de provider, cambiar de proxy, cambiar a un mock: todo es pasar una función distinta. Esto es «sustitución por inyección».
2. **Backend de Session**: el contrato es una interfaz de cinco métodos:

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

El repositorio trae de serie dos implementaciones, JSONL y en memoria, y en experimental hay un juego de tests de conformidad para validar backends de terceros (capítulo 14). Esto es «sustitución por interfaz».

3. **ExecutionEnv**: la interfaz de capacidades para todas las operaciones de archivos/shell (se detalla en el capítulo 3). La implementación Node es una; en el navegador se puede cambiar por un entorno de ejecución remoto. Esto es «sustitución por capacidad».

Las tres formas de sustitución corresponden a tres intensidades de acoplamiento: la inyección de funciones es la más floja (se puede cambiar en cada llamada), la implementación de interfaz queda en el medio (se fija en la construcción), y la interfaz de capacidades es la más pesada (todo el comportamiento de la capa de herramientas se apoya en ella).

## Un bucle: dos composiciones

El malentendido más fácil con este paquete es: ¿qué relación hay entre la clase `Agent` y la clase `AgentHarness`? ¿Herencia? ¿Envoltorio?

Ninguna de las dos. Mira la dirección de las dependencias:

```
agent-loop.ts  (runAgentLoop — bucle sin estado, 792 líneas)
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

Fíjate en que la forma de ambas llamadas es casi idéntica — contexto, configuración del bucle, callback de eventos, señal, función de stream — pero el origen de los parámetros es del todo distinto: `Agent` aporta un snapshot en memoria; `AgentHarness` aporta un snapshot por turno (`turnState`). `AgentHarness` no es una subclase de `Agent` ni su envoltorio: es otra capa de composición sobre el mismo primitivo de bucle, solo que compone mucho más — persistencia, compresión, hooks, la compuerta de exclusión mutua entre las operaciones grandes.

¿Por qué conviven dos capas? Porque su «peso» es distinto. Para embeber un panel de chat, basta con `Agent`; para construir un coding agent, usa `AgentHarness`. El bucle en sí es uno solo: esa es la primera virtud estructural de este paquete. **Las funciones complejas se obtienen por composición; el bucle no se vuelve más complejo.**

## El mapa de archivos: todo el paquete de un vistazo

La sección anterior mostró el esqueleto de tres capas; ahora alejamos la cámara un paso más para ver el mapa de archivos de toda la arquitectura. Este mapa dibuja las **relaciones lógicas**: qué módulos hay y a qué capa pertenece cada uno. Algunos nombres ya los has visto (`Agent`, `runAgentLoop`, `StreamFn`), otros todavía no (session, compaction, tools). En el próximo capítulo seguiremos una llamada de principio a fin, y ahí verás para qué sirve cada uno concretamente.

```diagram-filemap
                        ┌─────────────────────────┐
                        │   @earendil-works/pi-ai │  (otro paquete: providers, tipos Model)
                        └───────────┬─────────────┘
                                    │ solo tipos + la forma de StreamFn
        ┌───────────────────────────┼─────────────────────────────────────────────┐
        │                           ▲                                             │
        │  ┌──────────────────────────────────────────────────────┐               │
        │  │ capa núcleo (raíz de src/, ~2.3k líneas)             │               │
        │  │  types.ts ── cimiento de tipos                       │               │
        │  │  agent-loop.ts ── bucle sin estado                   │               │
        │  │  agent.ts ── clase Agent (envoltorio con estado)      │               │
        │  │  stream-fn.ts / proxy.ts                             │               │
        │  └───────▲──────────────────▲───────────────────────────┘               │
        │          │                  │                                           │
        │  ┌───────┴──────────────────┴───────────────────────────┐               │
        │  │ capa harness (src/harness/, ~10k líneas)             │               │
        │  │  agent-harness.ts ── AgentHarness                    │               │
        │  │  types.ts ── centro de tipos del harness             │               │
        │  │  messages.ts ── roles de mensaje personalizados      │               │
        │  │  session/ ── persistencia (árbol de entries + JSONL) │               │
        │  │  compaction/ ── compresión de contexto               │               │
        │  │  tools/ ── las cuatro herramientas integradas        │               │
        │  │  skills.ts / prompt-templates.ts                     │               │
        │  │  env/nodejs.ts ── la única implementación Node       │ ← ./node      │
        │  │  experimental/session/ ── sesiones persistentes v2   │               │  ← ./experimental
        │  └──────────────────────────────────────────────────────┘               │
        └─────────────────────────────────────────────────────────────────────────┘
```

(Las flechas indican la dirección de los imports y apuntan al lado del que se depende — las regularidades de esa dirección son cosa de la próxima sección.)

La lista de exports de la entrada principal es el índice de este mapa — el trío del núcleo va primero, luego los submódulos del harness se exportan por nombre; el contenido de `./node` y `./experimental` queda fuera a propósito:

```typescript
// src/index.ts:1 (recortado)
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

## Desacoplo: el core no conoce al harness

La sección anterior era un mapa lógico y respondía «qué hay»; esta solo mira las **relaciones de import** y responde «quién depende de quién» (se omiten los paquetes externos):

```diagram-deps
capa núcleo                              capa harness

types.ts   ◀╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  harness/types.ts
            (el harness toma los tipos del núcleo: import type vía el barrel de salida, borrado al compilar)
   ▲                                        ▲
stream-fn.ts                             session/ · compaction/ · tools/
   ▲                                        ▲
agent-loop.ts  ◀━━━━━━━━━━━━━━━━━━━━━━━  agent-harness.ts
                (el único import de valor desde la capa núcleo es la función runAgentLoop)
   ▲
agent.ts
(una envoltura del bucle)
```

Dos hojas no aparecen en el dibujo: `env/nodejs.ts` y `experimental/` solo son referenciadas por sus respectivos archivos de entrada (`node.ts` / `experimental.ts`) — en el cierre de dependencias de la entrada principal, físicamente no existen.

El grafo de dependencias es casi un árbol, y **todas las flechas apuntan corriente arriba**. Dos detalles merecen una pausa:

- `harness/types.ts` toma los tipos del núcleo a través del barrel de salida `../index.ts`, y con `import type` — la línea entera se borra al compilar y no constituye dependencia en runtime. Dentro del harness solo se toca la cara pública del núcleo:

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

- Los tres subdirectorios session, compaction y tools **no se importan entre sí** — cualquier cosa que haya que compartir tiene que subir antes a `harness/types.ts`; las dependencias horizontales quedan recogidas por ese centro.

Dos hechos sobre la dirección, y ahora toca dar las pruebas.

**Ningún archivo del harness importa `agent.ts`.** «Un bucle: dos composiciones» demostró por las relaciones de llamada que las dos clases no dependen la una de la otra; la prueba en las relaciones de import es aún más directa — en el propio bloque de imports de `AgentHarness`, el único valor tomado de la capa núcleo es `runAgentLoop`; todo lo demás está en su propio directorio:

```typescript
// src/harness/agent-harness.ts:11 (bloque de imports, recortado: pi-ai y dos imports de tipo; los imports de valor van completos)
import { runAgentLoop } from "../agent-loop.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import { compact, DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "./compaction/compaction.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { formatSkillInvocation } from "./skills.ts";
import { AgentHarnessError, /* ... */, toError } from "./types.ts";
```

Lo contrario también se puede verificar por uno mismo: busca `from "../agent.ts"` en todo `src/harness/` y hay cero resultados.

**`agent.ts` tampoco sabe que el harness existe.** La capa superior depende de la inferior; la inferior no sabe nada de la superior. Si quisieras borrar todo el directorio harness, no tendrías que tocar ni un import de la capa núcleo — salvo la lista de exports de `src/index.ts`.

## Resumen del capítulo

- `pi-agent-core` es una biblioteca de bucle de agente: tres capas — bucle, estado y equipo.
- No conoce proveedores de modelos, no toca la UI, el núcleo no hace persistencia y el núcleo no toca las APIs de runtime.
- `Agent` y `AgentHarness` son dos capas de composición sobre el mismo primitivo de bucle; no dependen la una de la otra.
- Las tres entradas de exports declaran el límite de runtime: la entrada principal no tiene `node:*`, el binding de Node es opt-in explícito y lo experimental queda aislado aparte.
- streamFn, el backend de Session y ExecutionEnv son tres puntos reemplazables, correspondientes a las sustituciones por inyección, por interfaz y por capacidad.
- El grafo de dependencias es casi un árbol con todas las flechas corriente arriba: `types.ts` es el cimiento, el bucle encima, las dos clases con estado lado a lado, y los submódulos del harness solo comparten `harness/types.ts` en horizontal.

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

> **¿Por qué no hacer que AgentHarness herede de Agent o lo envuelva?** En cuanto lo haces, cada decisión de arquitectura de `Agent` se mete en el harness: los mensajes solo viven en un array en memoria y desaparecen al salir el proceso; cada evento no se da por terminado hasta que los suscriptores hacen await uno a uno; cada run queda atado a un AbortController. Y el harness necesita justo la otra: los mensajes se proyectan desde el árbol de la sesión (capítulo 9), los eventos primero caen a disco y luego se reparten, y operaciones como correr un turn, compactar o cambiar de rama solo dejan pasar una a la vez (un campo `phase` hace de mutex: si no está en `idle`, se rechaza). El peso de los dos ciclos de vida está demasiado lejos el uno del otro: heredar es soldarlos, y la composición permite que cada uno tenga su propia complejidad — `agent-loop.ts` se queda en 792 líneas, y el harness crece libre hasta las 10k. `docs/agent-harness.md` le da exactamente esa posición: «the orchestration layer above the low-level agent loop» — la capa de orquestación sobre el bucle, con todo un ciclo de vida propio.
