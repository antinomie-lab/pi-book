# Lectura de la arquitectura de pi-agent-core

Un bucle de agente, convertido en biblioteca.

> Fuente: [中文](../README.md) · Hermano: [English](../en/README.md). El chino es la única fuente de contenido; las convenciones de traducción están en [TRANSLATION.md](../TRANSLATION.md).

Este libro parte del código para explicar cómo está construido `@earendil-works/pi-agent-core`: qué promete, qué rechaza y dónde están sus puntos de apoyo.

> **Línea base: commit `cd20a8d2e` (main, v0.83.0+219)**
>
> Todo el libro corresponde a este commit en la rama main del repositorio pi. Las citas de código se escriben como `archivo:línea`, con rutas relativas a `packages/agent/`. Los números de línea pueden desplazarse a medida que evoluciona el código; prima el contenido del archivo.

## Supuestos sobre el lector

Sabes leer TypeScript y conoces los conceptos básicos de las APIs de LLM (messages, tool calls, streaming). No hace falta que conozcas de antemano el repositorio pi.

## Organización

**Del todo a las partes, y luego lo transversal.**

La primera parte construye una imagen correcta del sistema completo, sin entrar en detalles de implementación. La segunda desglosa cada pieza en orden de dependencias: cada capítulo solo depende de los anteriores. La tercera trata problemas que no pertenecen a ninguna pieza aislada.

### Primera parte · El todo

Tras leer estos tres capítulos, deberías poder dibujar el sistema de memoria.

0. [Empieza aquí](00-start-here.md)
1. [Qué es: un bucle de agente convertido en biblioteca](01-what-it-is.md)
2. [El recorrido completo de un prompt: de prompt() a agent_end](02-end-to-end.md)

### Segunda parte · Las partes

(En redacción; los capítulos se añaden a medida que se escriben)

### Tercera parte · Lo transversal

(En redacción)

## Convenciones

El texto principal solo habla de lo que se puede leer en el código. Las citas se escriben de forma uniforme como `archivo:línea`, y **cada cita `archivo:línea` va acompañada in situ del fragmento correspondiente** — no necesitas abrir el editor para comprobar ninguna referencia.

Fuera del cuerpo principal, el libro usa tres estructuras que reaparecen con frecuencia:

- **Digresión** (nivel `###`, dentro del capítulo): aporta un fondo que quizá te falte, pero que no es propio de pi — patrones de APIs de plataforma, estructura de mensajes de LLM. Saltarlas no rompe el hilo principal.
- **Desvío** (nivel `###`, dentro del capítulo): una rama autocontenida que se plegó en la cita principal y aquí se desarrolla. Forma parte del hilo, solo que su posición se aplazó. Un desvío admite contenido por encima de la dificultad media del capítulo: precisamente porque se puede saltar, los párrafos de mayor densidad viven en los desvíos.
- **¿Por qué no?** (al final del capítulo): usa documentos de diseño del repositorio o el historial de git para responder «por qué aquí no se escribió de forma más simple».

## Fuera de alcance

- La implementación interna de `packages/ai` (directorio de providers, metadatos de modelos) — este libro solo la trata como «el downstream que cumple el contrato `StreamFn`».
- `packages/tui`, `packages/coding-agent` — son consumidores de esta biblioteca, no los protagonistas del libro.
- `docs/harness.md` (documento de diseño v1) está explícitamente deprecado en el repositorio; solo aparece en notas históricas a pie de página.
