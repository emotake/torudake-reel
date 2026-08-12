import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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
  let canceled = false;
  const request = new Request("https://example.test/api", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
      },
      cancel() {
        canceled = true;
      },
    }),
    duplex: "half",
  });
  await assert.rejects(
    readRequestBodyWithLimit(request, 100),
    RequestBodyTooLargeError,
  );
  assert.equal(canceled, true, "the oversized upload stream is canceled early");
});

test("account authentication also caps a chunked body without Content-Length", async () => {
  const { readAuthJson } = await import("../lib/account-auth-http.ts");
  const request = new Request("https://example.test/api/account/passkey", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.enqueue(new Uint8Array(40 * 1024));
        controller.close();
      },
    }),
    duplex: "half",
  });
  await assert.rejects(
    readAuthJson(request),
    (error) =>
      error?.code === "authentication_payload_too_large" &&
      error?.status === 413,
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

test("API routes do not use unbounded Request body readers", async () => {
  const files = await collectTypeScriptFiles(
    new URL("../app/api/", import.meta.url),
  );
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /await\s+request\.(?:json|text|formData|arrayBuffer)\s*\(/,
      `${file.pathname} must use the shared streaming body cap`,
    );
  }
});

async function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(child);
    }
  }
  return files;
}
