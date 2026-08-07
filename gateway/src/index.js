const PI_PREFIX = "/pi";

function redirectToPiRoot(url) {
  return Response.redirect(new URL(`${PI_PREFIX}/`, url).toString(), 308);
}

function getBooksOriginUrl(url, origin) {
  const relativePath = url.pathname.replace(/^\/+/, "");
  const target = new URL(relativePath, origin);
  target.search = url.search;
  return target;
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === PI_PREFIX) {
      return redirectToPiRoot(url);
    }

    if (url.pathname.startsWith(`${PI_PREFIX}/`)) {
      // With a Worker Route, fetching the incoming request continues to the
      // proxied origin configured by the books.antinomie.org DNS record.
      return fetch(request);
    }

    const target = getBooksOriginUrl(url, env.BOOKS_ORIGIN);
    return fetch(target.toString(), request);
  },
};
