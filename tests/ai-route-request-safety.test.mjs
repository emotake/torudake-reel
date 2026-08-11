import assert from "node:assert/strict";
import test from "node:test";

globalThis.__cloudflareEnv = { OPENAI_API_KEY: "test-key" };

const [{ POST: scriptPost }, { POST: speechPost }, { POST: transcribePost }] =
  await Promise.all([
    import("../app/api/narration/script/route.ts"),
    import("../app/api/narration/speech/route.ts"),
    import("../app/api/transcribe/route.ts"),
  ]);

for (const [name, handler] of [
  ["narration script", scriptPost],
  ["narration speech", speechPost],
  ["transcription", transcribePost],
]) {
  test(`${name} authenticates before parsing an untrusted body`, async () => {
    const response = await handler(
      new Request(`https://torudake-reel.pages.dev/api/${name}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "999999999",
        },
        body: "{}",
      }),
    );
    assert.equal(response.status, 401);
  });
}

test("the production enforcement bypass is restricted to local or test runtimes", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/usage-enforcement.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /testBypassIsSafe/);
  assert.match(source, /isNodeTestRuntime\(\) \|\| isLocalTestRequest\(request\)/);
  assert.doesNotMatch(source, /return usageEnv\.USAGE_ENFORCEMENT_TEST_MODE !==/);
});

test("transcription stops its upstream request when the browser disconnects", async () => {
  globalThis.__cloudflareEnv.USAGE_ENFORCEMENT_TEST_MODE = "codex-test-only";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
    });
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "voice.mp3", {
      type: "audio/mpeg",
    }));
    const controller = new AbortController();
    const pending = transcribePost(
      new Request("https://example.test/api/transcribe", {
        method: "POST",
        body: form,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 10);
    const response = await pending;
    assert.equal(response.status, 499);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv.USAGE_ENFORCEMENT_TEST_MODE;
  }
});
