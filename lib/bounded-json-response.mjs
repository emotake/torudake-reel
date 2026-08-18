const DEFAULT_MAX_JSON_BYTES = 64 * 1024;

/**
 * Reads a JSON response without allowing an untrusted peer to allocate an
 * unbounded string. This helper is Web-API-only so the same implementation can
 * run in Node.js release tooling and in the account-deletion Worker.
 */
export async function readBoundedJsonResponse(
  response,
  { maxBytes = DEFAULT_MAX_JSON_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer.");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxBytes
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("JSON response exceeds the configured byte limit.");
    }
  }

  if (!response.body) {
    throw new Error("JSON response body is missing.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("JSON response contained an invalid byte stream.");
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("JSON response exceeds the configured byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

