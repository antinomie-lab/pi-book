<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README.es.md">Español</a>
</p>

# Pi Agent

El espacio de trabajo de un libro de arquitectura en chino sobre `packages/agent` del repositorio [pi](https://github.com/earendil-works/pi).

> Un bucle de agente, convertido en biblioteca.

Este libro parte del código para explicar cómo está construido `@earendil-works/pi-agent-core`: qué promete, qué rechaza y dónde están sus puntos de apoyo. Todo el libro corresponde al commit `cd20a8d2e` de la rama `main` de pi. Las citas de código se escriben como `archivo:línea` y cada una incluye el fragmento correspondiente, de modo que se puede comprobar cualquier afirmación sin abrir un editor.

**Idiomas:** El manuscrito chino está en [`agent/`](agent/README.md) y es la única fuente de contenido. Las traducciones al inglés y al español están en [`agent/en/`](agent/en/README.md) y [`agent/es/`](agent/es/README.md). El selector de idioma se encuentra en la esquina superior derecha del lector web.

## Formas de leer

| Formato | Entrada | Ideal para |
| --- | --- | --- |
| 🌐 Lector web | [books.antinomie.org/pi](https://books.antinomie.org/pi) | Lectura inmersiva con citas de código resaltadas y selección entre ZH / EN / ES |
| 📥 Markdown | [agent/](agent/README.md) · [en](agent/en/README.md) · [es](agent/es/README.md) | Descargar el libro para leerlo junto al código fuente y hacer preguntas con herramientas de IA como Claude o Cursor |

## Supuestos sobre el lector

Sabes leer TypeScript y conoces los conceptos básicos de las APIs de LLM —messages, tool calls y streaming—. No hace falta conocer previamente el repositorio pi.

## Organización

**Del todo a las partes, y luego lo transversal.**

- **Primera parte · El todo** (dos capítulos publicados): construye una imagen correcta del sistema completo sin entrar en detalles de implementación. Al terminar esta parte, deberías poder dibujar el sistema de memoria.
- **Segunda parte · Las partes**: desarrolla cada componente en orden de dependencias; cada capítulo solo depende de los anteriores.
- **Tercera parte · Lo transversal**: trata problemas que no pertenecen a ningún componente aislado.

El índice solo enumera los capítulos publicados. Los siguientes se añadirán a medida que se escriban.

## Estructura del espacio de trabajo

- `agent/` — el manuscrito chino y la **única fuente de contenido**. Las traducciones están en `agent/en/` y `agent/es/`. Consulta [agent/README.md](agent/README.md) y [agent/TRANSLATION.md](agent/TRANSLATION.md).
- `web/` — el lector (Vite + Vue). Renderiza el manuscrito chino y las traducciones bajo `agent/`, sin almacenar contenido propio.

  ```bash
  cd web && npm install && npm run dev
  ```

## Convenciones

Las reglas de citación, los tres componentes de tarjeta (Digresión / Desvío / ¿Por qué no?) y los temas fuera del alcance del libro se documentan en la sección «Convenciones» de [agent/es/README.md](agent/es/README.md).
