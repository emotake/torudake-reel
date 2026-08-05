import worker from "./dist/server/index.js";
import { setRuntimeEnvironment } from "./cloudflare-pages-env-shim.mjs";

const pagesWorker = {
  async fetch(request, env, context) {
    setRuntimeEnvironment(env);
    const url = new URL(request.url);

    // Pages is a public origin, not the OpenAI Sites dispatcher. Never forward
    // client-supplied identity headers from this entry point, even if a Pages
    // environment variable is accidentally configured to trust Sites auth.
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith("oai-authenticated-user-")) headers.delete(name);
    }
    const sanitizedRequest = new Request(request, { headers });

    // Cloudflare Pages advanced mode sends every request through _worker.js.
    // Vinext's generated worker assumes its hashed client assets are served
    // before the worker (the Workers Static Assets default), so forward those
    // files explicitly when running on Pages.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname.startsWith("/assets/")
    ) {
      return withSecurityHeaders(
        await env.ASSETS.fetch(sanitizedRequest),
        url,
      );
    }

    return withSecurityHeaders(
      await worker.fetch(sanitizedRequest, env, context),
      url,
    );
  },
};

export default pagesWorker;

function withSecurityHeaders(response, url) {
  const headers = new Headers(response.headers);
  const isPrivatePath =
    url.pathname === "/account" ||
    url.pathname.startsWith("/account/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/internal/");
  const isNonCanonicalHost = url.hostname !== "torudake-reel.pages.dev";
  if (isPrivatePath || isNonCanonicalHost) {
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(self)",
  );
  headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
    );
  }
  if (url.protocol === "https:") {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
