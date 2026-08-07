const PI_PREFIX = "/pi";

function redirectToPiRoot(url) {
  return Response.redirect(new URL(`${PI_PREFIX}/`, url).toString(), 308);
}

export default {
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === PI_PREFIX) {
      return redirectToPiRoot(url);
    }

    if (url.pathname.startsWith(`${PI_PREFIX}/`)) {
      // With a Worker Route, fetching the incoming request continues to the
      // proxied origin configured by the books.antinomie.org DNS record.
      return fetch(request);
    }

    return new Response("Book not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
