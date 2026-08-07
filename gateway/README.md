# books.antinomie.org gateway

Cloudflare Worker gateway for books published below `books.antinomie.org`.

The root site is served from the `antinomie-lab/books` GitHub Pages project.
The Worker removes the public `/books/` project-site prefix while proxying it:

| Public path | Upstream |
| --- | --- |
| `/` and all non-book paths | `https://antinomie-lab.github.io/books/` |
| `/pi` | Permanent redirect to `/pi/` |
| `/pi/*` | Existing Pi Vercel origin from the proxied DNS record |

`BOOKS_ORIGIN` is a non-secret Wrangler variable so the root host can move
without changing the routing code. The proxied DNS record for
`books.antinomie.org` remains the Pi Vercel project origin, allowing Pi
requests to continue upstream with their paths unchanged.

Deploy from this directory:

```bash
npx wrangler@latest deploy
```
