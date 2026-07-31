import assert from "node:assert/strict";
import test from "node:test";

const workerEnv = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const workerContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function loadWorker(testName) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(testName, `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

test("sends five distinct voice characters at natural fixed speeds", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  try {
    const worker = await loadWorker("narration-voices");
    const styles = ["bright", "calm", "tempo", "refined", "comedy"];

    for (const style of styles) {
      const response = await worker.fetch(
        new Request("http://localhost/api/narration/speech", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            script: "同じ台本で声の違いを確認します。",
            style,
          }),
        }),
        workerEnv,
        workerContext,
      );
      assert.equal(response.status, 200);
    }

    assert.deepEqual(
      requests.map((request) => request.body.voice),
      ["coral", "cedar", "nova", "onyx", "ash"],
    );
    assert.deepEqual(
      requests.map((request) => request.body.speed),
      [1, 0.99, 1.06, 0.97, 1.04],
    );
    assert.equal(
      new Set(requests.map((request) => request.body.instructions)).size,
      5,
    );
    assert.ok(
      requests.every((request) =>
        request.body.instructions.includes(
          "台本にない語句、相づち、笑い声、効果音を追加せず",
        ),
      ),
    );
    assert.ok(
      requests.every(
        (request) =>
          request.url === "https://api.openai.com/v1/audio/speech" &&
          request.body.model === "gpt-4o-mini-tts" &&
          request.body.instructions.length >= 70,
      ),
    );
    assert.match(requests[2].body.instructions, /成人のポップボイス/);
    assert.match(
      requests[4].body.instructions,
      /明るくエネルギッシュな成人のオリジナル話者/,
    );
    assert.match(
      requests[4].body.instructions,
      /特定の実在人物の声質、話速、笑い方、口癖、決め台詞、間合いを模倣しない/,
    );
    assert.doesNotMatch(
      requests.map((request) => request.body.instructions).join("\n"),
      /萌えアニメ|関西ツッコミ|明石家|さんま/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("uses the matching HD fallback voice when the primary model is unavailable", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 1) {
      return Response.json(
        {
          error: {
            code: "model_not_found",
            type: "invalid_request_error",
            message: "model not found",
          },
        },
        { status: 410 },
      );
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };

  try {
    const worker = await loadWorker("narration-fallback");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "深く静かな声で読みます。",
          style: "refined",
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].model, "tts-1-hd");
    assert.equal(requests[1].voice, "onyx");
    assert.equal(requests[1].speed, 0.97);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});
