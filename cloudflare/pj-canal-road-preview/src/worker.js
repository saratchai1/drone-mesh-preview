const PREFIX = "pj-canal-road-web";
const DEFAULT_VIEWER =
  "/las-preview.html?data=assets/pj-canal-road-las-preview&name=PJ%20Canal%20Road%20Point%20Cloud";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return Response.redirect(new URL(DEFAULT_VIEWER, url.origin), 302);
    }

    const key = `${PREFIX}${decodeURIComponent(url.pathname)}`;
    const object = await env.BUCKET.get(key);
    if (!object) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("access-control-allow-origin", "*");
    headers.set("cache-control", "public, max-age=3600");

    if (!headers.has("content-type")) {
      headers.set("content-type", contentType(url.pathname));
    }

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(object.body, { headers });
  },
};

function contentType(pathname) {
  const match = pathname.toLowerCase().match(/\.[^.]+$/);
  return CONTENT_TYPES[match?.[0]] || "application/octet-stream";
}

