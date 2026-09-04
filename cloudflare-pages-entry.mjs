import worker from "./dist/server/index.js";
import { setRuntimeEnvironment } from "./cloudflare-pages-env-shim.mjs";

const PUBLIC_MEDIA_PREFIXES = ["/demo/", "/campaign/"];
const PUBLIC_MEDIA_CACHE_CONTROL =
  "public, max-age=86400, stale-while-revalidate=604800";
const RETIRED_PUBLIC_MEDIA_PATHS = new Set([
  "/demo/voices/party.wav",
  "/demo/voices/party-v2.wav",
  "/demo/voices/party-v3.wav",
  "/demo/voices/party-v4.wav",
  "/demo/voices/party-v5.wav",
  "/demo/voices/party-v6.wav",
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const pagesWorker = {
  async fetch(request, env, context) {
    setRuntimeEnvironment(env);
    const url = new URL(request.url);
    const requestId = requestIdentifier(
      request.headers.get("x-request-id"),
    );
    const correlationId = requestIdentifier(
      request.headers.get("x-correlation-id"),
      requestId,
    );

    // Pages is a public origin, not the OpenAI Sites dispatcher. Never forward
    // client-supplied identity headers from this entry point, even if a Pages
    // environment variable is accidentally configured to trust Sites auth.
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith("oai-authenticated-user-")) headers.delete(name);
    }
    headers.set("x-request-id", requestId);
    headers.set("x-correlation-id", correlationId);
    const sanitizedRequest = new Request(request, { headers });

    let response;
    try {
      const publicMediaPathname = safelyDecodePathname(url.pathname);
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        RETIRED_PUBLIC_MEDIA_PATHS.has(publicMediaPathname)
      ) {
        response = new Response(null, {
          status: 410,
          headers: {
            "Cache-Control": "no-store, max-age=0",
            "Cloudflare-CDN-Cache-Control": "no-store",
            "Content-Length": "0",
            "X-Robots-Tag": "noindex",
          },
        });
      } else if (
        // Pages static assets currently answer Range requests with 200. Keep
        // public demo and campaign media in the Worker route so browsers can seek
        // without downloading from the beginning, while continuing to source the
        // immutable bytes from the Pages asset namespace.
        (request.method === "GET" || request.method === "HEAD") &&
        PUBLIC_MEDIA_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
      ) {
        response = await servePublicMedia(sanitizedRequest, env);
      } else if (
        // Cloudflare Pages advanced mode sends every request through _worker.js.
        // Vinext's generated worker assumes its hashed client assets are served
        // before the worker (the Workers Static Assets default), so forward those
        // files explicitly when running on Pages.
        (request.method === "GET" || request.method === "HEAD") &&
        url.pathname.startsWith("/assets/")
      ) {
        response = await env.ASSETS.fetch(sanitizedRequest);
      } else {
        response = await worker.fetch(sanitizedRequest, env, context);
      }
    } catch (error) {
      console.error(
        runtimeLog(request, url, requestId, correlationId, {
          event: "unhandled_request_exception",
          status: 500,
          errorName: error instanceof Error ? error.name : "NonErrorThrown",
        }),
      );
      response = Response.json(
        { error: "Internal server error.", requestId },
        { status: 500 },
      );
    }

    if (response.status >= 500) {
      console.error(
        runtimeLog(request, url, requestId, correlationId, {
          event: "http_server_error",
          status: response.status,
        }),
      );
    }
    return withSecurityHeaders(
      response,
      url,
      { requestId, correlationId },
    );
  },
};

export default pagesWorker;

export function resolveSingleByteRange(value, size) {
  if (value === null) return { kind: "full" };
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "invalid" };

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return { kind: "invalid" };
  }

  const parseInteger = (text) => {
    if (!text) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
  };
  const requestedStart = parseInteger(match[1]);
  const requestedEnd = parseInteger(match[2]);

  if (Number.isNaN(requestedStart) || Number.isNaN(requestedEnd)) {
    return { kind: "invalid" };
  }

  if (requestedStart === null) {
    if (requestedEnd === null || requestedEnd <= 0) {
      return { kind: "invalid" };
    }
    return {
      kind: "partial",
      start: Math.max(0, size - requestedEnd),
      end: size - 1,
    };
  }

  if (requestedStart >= size) return { kind: "invalid" };
  const end =
    requestedEnd === null ? size - 1 : Math.min(requestedEnd, size - 1);
  if (end < requestedStart) return { kind: "invalid" };

  return { kind: "partial", start: requestedStart, end };
}

async function servePublicMedia(request, env) {
  const rangeHeader = request.headers.get("range");
  const assetHeaders = new Headers(request.headers);

  if (rangeHeader !== null) {
    for (const name of [
      "accept-encoding",
      "if-match",
      "if-modified-since",
      "if-none-match",
      "if-range",
      "if-unmodified-since",
      "range",
    ]) {
      assetHeaders.delete(name);
    }
    assetHeaders.set("accept-encoding", "identity");
  }

  const assetRequest = new Request(request.url, {
    headers: assetHeaders,
    method: rangeHeader === null ? request.method : "GET",
  });
  const assetResponse = await env.ASSETS.fetch(assetRequest);
  const responseHeaders = new Headers(assetResponse.headers);

  if (!assetResponse.ok || assetResponse.status !== 200) {
    return new Response(
      request.method === "HEAD" ? null : assetResponse.body,
      {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: responseHeaders,
      },
    );
  }

  responseHeaders.set("Accept-Ranges", "bytes");
  responseHeaders.set("Cache-Control", PUBLIC_MEDIA_CACHE_CONTROL);

  if (rangeHeader === null) {
    return new Response(
      request.method === "HEAD" ? null : assetResponse.body,
      {
        status: 200,
        statusText: assetResponse.statusText,
        headers: responseHeaders,
      },
    );
  }

  let sourceBytes = null;
  const contentLengthHeader = responseHeaders.get("content-length");
  let size =
    contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
  if (!Number.isSafeInteger(size) || size < 0) {
    sourceBytes = new Uint8Array(await assetResponse.arrayBuffer());
    size = sourceBytes.byteLength;
  }

  const range = resolveSingleByteRange(rangeHeader, size);
  if (range.kind !== "partial") {
    if (!sourceBytes) await assetResponse.body?.cancel();
    responseHeaders.set("Content-Range", `bytes */${size}`);
    responseHeaders.set("Content-Length", "0");
    return new Response(null, { status: 416, headers: responseHeaders });
  }

  const contentLength = range.end - range.start + 1;
  responseHeaders.set(
    "Content-Range",
    `bytes ${range.start}-${range.end}/${size}`,
  );
  responseHeaders.set("Content-Length", String(contentLength));

  let body = null;
  if (request.method !== "HEAD") {
    if (sourceBytes) {
      body = sourceBytes.subarray(range.start, range.end + 1);
    } else if (assetResponse.body) {
      body = sliceByteStream(assetResponse.body, range.start, range.end);
    }
  } else {
    if (!sourceBytes) await assetResponse.body?.cancel();
  }

  return new Response(body, { status: 206, headers: responseHeaders });
}

function sliceByteStream(source, start, end) {
  const reader = source.getReader();
  let sourceOffset = 0;
  let remaining = end - start + 1;

  return new ReadableStream({
    async pull(controller) {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("Static media ended before its declared size."));
          return;
        }

        const chunk =
          value instanceof Uint8Array ? value : new Uint8Array(value);
        const chunkStart = sourceOffset;
        const chunkEnd = chunkStart + chunk.byteLength;
        sourceOffset = chunkEnd;

        if (chunkEnd <= start) continue;

        const localStart = Math.max(0, start - chunkStart);
        const localEnd = Math.min(chunk.byteLength, end + 1 - chunkStart);
        if (localEnd > localStart) {
          const slice = chunk.subarray(localStart, localEnd);
          remaining -= slice.byteLength;
          controller.enqueue(slice);
        }

        if (remaining === 0) {
          controller.close();
          await reader.cancel();
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function requestIdentifier(value, fallback = "") {
  const normalized = value?.trim() ?? "";
  if (REQUEST_ID_PATTERN.test(normalized)) return normalized;
  return fallback || crypto.randomUUID();
}

function safelyDecodePathname(pathname) {
  let decoded = pathname;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function runtimeLog(request, url, requestId, correlationId, fields) {
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    severity: "error",
    service: "torudake-reel",
    component: "runtime",
    requestId,
    correlationId,
    method: request.method,
    path: url.pathname,
    cfRay: request.headers.get("cf-ray")?.slice(0, 128) || undefined,
    ...fields,
  };
}

function withSecurityHeaders(response, url, identifiers = {}) {
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
  if (identifiers.requestId) {
    headers.set("X-Request-Id", identifiers.requestId);
  }
  if (identifiers.correlationId) {
    headers.set("X-Correlation-Id", identifiers.correlationId);
  }
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(self)",
  );
  headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://*.googletagmanager.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://*.google-analytics.com https://*.googletagmanager.com",
        "font-src 'self' data:",
        "media-src 'self' blob:",
        "connect-src 'self' blob: https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
        "upgrade-insecure-requests",
      ].join("; "),
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
