import assert from "node:assert/strict";
import test from "node:test";

const {
  createUpstreamAbortSignal,
  parseFormDataBodyWithLimit,
  parseJsonBodyWithLimit,
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} = await import("../lib/request-safety.ts");

test("rejects a declared request body before reading it", async () => {
  const request = new Request("https://example.test/api", {
    method: "POST",
    headers: { "Content-Length": "1000" },
    body: "small",
  });
  await assert.rejects(
    readRequestBodyWithLimit(request, 100),
    RequestBodyTooLargeError,
  );
});

test("stops a chunked body as soon as the actual byte limit is exceeded", async () => {
  const request = new Request("https://example.test/api", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
        controller.close();
      },
    }),
    duplex: "half",
  });
  await assert.rejects(
    readRequestBodyWithLimit(request, 100),
    RequestBodyTooLargeError,
  );
});

test("parses bounded JSON and multipart bodies", async () => {
  const json = await parseJsonBodyWithLimit(
    new Request("https://example.test/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }),
    1024,
  );
  assert.deepEqual(json, { ok: true });

  const source = new FormData();
  source.set("value", "safe");
  const formRequest = new Request("https://example.test/api", {
    method: "POST",
    body: source,
  });
  const parsed = await parseFormDataBodyWithLimit(formRequest, 4096);
  assert.equal(parsed.get("value"), "safe");
});

test("combines caller cancellation with a bounded upstream timeout", async () => {
  const caller = new AbortController();
  const callerBound = createUpstreamAbortSignal(caller.signal, 1_000);
  caller.abort(new DOMException("cancelled", "AbortError"));
  assert.equal(callerBound.signal.aborted, true);
  assert.equal(callerBound.didTimeOut(), false);
  callerBound.cleanup();

  const timeoutBound = createUpstreamAbortSignal(
    new AbortController().signal,
    5,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timeoutBound.signal.aborted, true);
  assert.equal(timeoutBound.didTimeOut(), true);
  timeoutBound.cleanup();
});
