export class RequestBodyTooLargeError extends Error {
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(`Request body exceeds ${maximumBytes} bytes.`);
    this.name = "RequestBodyTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

function declaredContentLength(request: Request) {
  const rawValue = request.headers.get("content-length");
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function readRequestBodyWithLimit(
  request: Request,
  maximumBytes: number,
) {
  const declaredLength = declaredContentLength(request);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new RequestBodyTooLargeError(maximumBytes);
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("request_body_too_large").catch(() => undefined);
        throw new RequestBodyTooLargeError(maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function parseJsonBodyWithLimit<T>(
  request: Request,
  maximumBytes: number,
) {
  const bytes = await readRequestBodyWithLimit(request, maximumBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as T;
}

export async function parseFormDataBodyWithLimit(
  request: Request,
  maximumBytes: number,
) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new TypeError("Expected multipart form data.");
  }
  const bytes = await readRequestBodyWithLimit(request, maximumBytes);
  return new Response(bytes, {
    headers: { "Content-Type": contentType },
  }).formData();
}

export function createUpstreamAbortSignal(
  requestSignal: AbortSignal,
  timeoutMilliseconds: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) {
    abortFromRequest();
  } else {
    requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Upstream request timed out.", "TimeoutError"));
  }, timeoutMilliseconds);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", abortFromRequest);
    },
  };
}
