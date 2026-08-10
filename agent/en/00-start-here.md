# Start here

Hello, newcomer.

The door you just pushed open leads into a book still being written. Its protagonist is a small library called pi-agent-core: not LangChain, but an agent loop that refuses to become a framework—modules are bricks; composition is architecture. This book wants only one thing: to walk the source with you from end to end, until you can close your eyes and draw its shape.

## How to move through this place

The main hall is not large. For now it holds only two chapters of prose: Chapter 1 answers "what it is"; Chapter 2 follows a single `prompt()` and walks the control flow all the way through. Many rooms still stand empty. Come back once a week and there will be one more chapter.

You need no harness. Walk in order. Every chapter assumes you have read the ones before it—just as this page assumes you have only just arrived.

## Quiet machinery along the way

The path has a few quiet fixtures. You do not need to learn them; they make sense when you meet them. Two are tucked a little deeper, and deserve a word first:

Hover any heading and the small circle to its left shifts through moon phases—half-moon turns, sectors tick—click it, and that section's link lands in the address bar, ready to share. You need not click: wherever you read, the address bar follows.

Hover a code block and a thumbtack floats into the top-right corner—click it, and that snippet pins into a small pane in the screen's corner: you keep reading the commentary, and it stays there with you; click the thumbtack again, or the × on the pane, and it goes home. Overlong blocks have one more habit: linger a moment on hover, and they expand just far enough to finish reading.

Words alone prove nothing—here is a piece for you to try. Hover it, and click its thumbtack:

```typescript
// Demo: click the thumbtack in the top-right corner to pin me
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

Some chapters pin a block for you the moment you enter—Chapter 2's runLoop skeleton, for example. That is not decoration; it is that chapter's landmark. Later commentary points back to it again and again. Look up whenever you like, and you will not lose your way in a long chapter.

If a sentence makes you want to see the original yourself, click the citation—every claim in the book links back to the line in the repository where it was born. The book itself lives in the repository too: [`agent/en/00-start-here.md:42`](https://github.com/antinomie-lab/pi-book/blob/main/agent/en/00-start-here.md#L42). If something went wrong, come point it out.

## One request

Read slowly. This book is in no hurry. It grows by one chapter a week.

When you are ready, go in here: [Chapter 1 · What it is](/chapter/01).
