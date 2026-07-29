import assert from "node:assert/strict";
import test from "node:test";

test("turns an audio transcription into timestamped captions", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.headers?.Authorization, "Bearer test-key");
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("model"), "whisper-1");
      assert.equal(init.body.get("response_format"), "verbose_json");
      assert.deepEqual(
        init.body.getAll("timestamp_granularities[]"),
        ["segment", "word"],
      );

      return Response.json({
        duration: 4.5,
        language: "ja",
        text: "これは字幕です。次の字幕です。",
        segments: [
          { start: 0, end: 2, text: "これは字幕です。" },
          { start: 2, end: 4.5, text: "次の字幕です。" },
        ],
        words: [
          { start: 0, end: 0.6, word: "これは" },
          { start: 0.6, end: 2, word: "字幕です。" },
          { start: 2, end: 3, word: "次の" },
          { start: 3, end: 4.5, word: "字幕です。" },
        ],
      });
    }

    return nativeFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([0, 0, 0, 24])], "voice.wav", {
        type: "audio/wav",
      }),
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: formData,
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.language, "ja");
    assert.equal(payload.duration, 4.5);
    assert.deepEqual(
      payload.segments.map(({ start, end, text }) => ({ start, end, text })),
      [
        { start: 0, end: 2, text: "これは字幕です。" },
        { start: 2, end: 4.5, text: "次の字幕です。" },
      ],
    );
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("explains when the OpenAI API credit is exhausted", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      return Response.json(
        {
          error: {
            code: "insufficient_quota",
            type: "insufficient_quota",
            message: "You exceeded your current quota.",
          },
        },
        {
          status: 429,
          headers: { "x-request-id": "test-request-id" },
        },
      );
    }

    return nativeFetch(input);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("quota-test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([0, 0, 0, 24])], "voice.mp4", {
        type: "video/mp4",
      }),
    );

    const response = await worker.fetch(
      new Request("http://localhost/api/transcribe", {
        method: "POST",
        body: formData,
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );

    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.match(payload.error, /API利用枠が不足/);
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});
