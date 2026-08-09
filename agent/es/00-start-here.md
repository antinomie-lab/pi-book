# Empieza aquí

Hola, bienvenido.

Has entrado en un libro que aún se está escribiendo. Su protagonista es una biblioteca pequeña llamada pi-agent-core: no es LangChain, sino un bucle de agente que se niega a convertirse en un framework — los módulos son ladrillos; la composición es la arquitectura. Este libro solo quiere una cosa: acompañarte a recorrer su código fuente de punta a punta, hasta que puedas cerrar los ojos y dibujar su forma.

## Cómo moverse por este lugar

El vestíbulo no es grande: por ahora solo hay dos capítulos de cuerpo principal. El capítulo 1 responde «qué es»; el capítulo 2 sigue una llamada a `prompt()` y recorre todo el flujo de control. Quedan muchas habitaciones vacías; si vuelves una vez a la semana, habrá un capítulo más.

No hace falta traer equipo: basta con ir en orden. Cada capítulo asume que has leído los anteriores — como esta página asume que acabas de llegar.

## Pequeños mecanismos del camino

Este camino tiene unas cuantas instalaciones silenciosas: no hay que aprenderlas; al encontrarlas se entienden solas. Dos están un poco más escondidas y merece la pena mencionarlas primero:

Si pasas el cursor por cualquier título, el pequeño círculo a su izquierda cambia de fase lunar — la media luna se da la vuelta, el sector avanza un paso —; al hacer clic, el enlace de esa sección entra en la barra de direcciones y puedes compartirlo. En realidad no hace falta hacer clic: a medida que lees, la barra de direcciones te sigue.

Si pasas el cursor por un bloque de código, en la esquina superior derecha aparece una chincheta — al hacer clic, ese fragmento queda fijado en una ventanita en la esquina de la pantalla: mientras lees la explicación más abajo, sigue ahí acompañándote; si vuelves a pulsar la chincheta, o la × de la ventanita, se va. Los bloques demasiado largos tienen además un genio propio: si dejas el cursor un instante, se expanden solos hasta lo justo para leerlos enteros.

Mejor probarlo que creerlo — pasa el cursor y pulsa su chincheta:

```typescript
// Demo: pulsa la chincheta de la esquina superior derecha para fijarme
async function simpleLoop(messages, model, tools) {
  while (true) {
    const response = await callModel(model, messages, tools);
    messages.push(response);
    if (response.stopReason !== "toolUse") {
      return messages;
    }
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(toolCall);
      messages.push(result);
    }
  }
}
```

En algunos capítulos, al entrar ya te encuentran con un fragmento fijado — por ejemplo, el esqueleto de runLoop del capítulo 2. No es decoración: es la señal de ese capítulo. Las explicaciones posteriores vuelven a señalarlo una y otra vez; puedes mirar arriba en cualquier momento y contrastar, sin perderte en un capítulo largo.

Si quieres ver con tus ojos el original de un párrafo, pulsa la fuente — cada afirmación del libro enlaza a la línea del repositorio donde nació. Este libro también vive en el repositorio: [`agent/00-start-here.md:42`](https://github.com/antinomie-lab/pi-book/blob/main/agent/00-start-here.md#L42); si algo está mal, ven a corregirlo.

## Un consejo

Lee despacio. Este libro no tiene prisa: solo crece un capítulo a la semana.

Cuando estés listo, entra por aquí: [Capítulo 1 · Qué es](/chapter/01).
