# books.antinomie.org gateway

Cloudflare Worker gateway for books published below `books.antinomie.org`.

The current route table exposes the Pi book at `/pi/`. The proxied DNS record
for `books.antinomie.org` remains the Pi Vercel project origin, so Pi requests
continue to that origin with their paths unchanged.

Deploy from this directory:

```bash
npx wrangler@latest deploy
```
