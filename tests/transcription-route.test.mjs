import assert from "node:assert/strict";
import test from "node:test";

test("turns an audio transcription into timestamped captions", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
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
      assert.equal(init.body.get("language"), "ja");
      assert.equal(init.body.get("response_format"), "verbose_json");
      assert.equal(init.body.get("chunking_strategy"), null);
      assert.equal(init.body.get("temperature"), "0");
      assert.deepEqual(
        init.body.getAll("timestamp_granularities[]"),
        ["segment"],
      );

      return Response.json({
        duration: 4.5,
        language: "ja",
        text: "これは字幕です。次の字幕です。",
        segments: [
          { start: 0, end: 2, speaker: "A", text: "これは字幕です。" },
          { start: 2, end: 4.5, speaker: "A", text: "次の字幕です。" },
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

test("uses the full transcript when timed segments are omitted", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      return Response.json({
        duration: 5,
        text: "本文だけ返っても、字幕として表示できます。",
      });
    }

    return nativeFetch(input);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("text-fallback-test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([0, 0, 0, 24])], "voice.m4a", {
        type: "audio/mp4",
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
    assert.equal(payload.silent, undefined);
    assert.ok(payload.segments.length > 0);
    assert.equal(
      payload.segments.map((segment) => segment.text).join(""),
      "本文だけ返っても、字幕として表示できます。",
    );
    assert.equal(payload.segments[0].start, 0);
    assert.equal(payload.segments.at(-1).end, 5);
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("falls back to diarization when Whisper timestamping errors", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };

  const nativeFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      const model = init.body.get("model");
      requestedModels.push(model);

      if (model === "whisper-1") {
        return Response.json(
          {
            error: {
              code: "model_error",
              type: "model_error",
              message: "The transcription model failed.",
            },
          },
          {
            status: 500,
            headers: { "x-request-id": "primary-model-error" },
          },
        );
      }

      assert.equal(model, "gpt-4o-transcribe-diarize");
      assert.equal(init.body.get("language"), "ja");
      assert.equal(init.body.get("response_format"), "diarized_json");
      assert.equal(init.body.get("chunking_strategy"), "auto");
      assert.deepEqual(init.body.getAll("timestamp_granularities[]"), []);
      return Response.json({
        duration: 5.2,
        language: "ja",
        text: "代替処理で字幕を生成しました。",
        segments: [
          {
            start: 0,
            end: 5.2,
            text: "代替処理で字幕を生成しました。",
          },
        ],
      });
    }

    return nativeFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("timed-fallback-test", `${process.pid}-${Date.now()}`);
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

    assert.equal(response.status, 200);
    assert.deepEqual(requestedModels, [
      "whisper-1",
      "gpt-4o-transcribe-diarize",
    ]);
    const payload = await response.json();
    assert.equal(payload.duration, 5.2);
    assert.equal(
      payload.segments.map((segment) => segment.text).join(""),
      "代替処理で字幕を生成しました。",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("retries a temporary timed transcription failure once", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };

  const nativeFetch = globalThis.fetch;
  let primaryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      assert.equal(init.body.get("model"), "whisper-1");
      primaryCalls += 1;
      if (primaryCalls === 1) {
        return Response.json(
          {
            error: {
              code: "server_busy",
              type: "server_error",
              message: "Please retry.",
            },
          },
          { status: 503 },
        );
      }
      return Response.json({
        duration: 3,
        language: "ja",
        text: "再試行で成功しました。",
        segments: [
          { start: 0, end: 3, speaker: "A", text: "再試行で成功しました。" },
        ],
      });
    }

    return nativeFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("timed-retry-test", `${process.pid}-${Date.now()}`);
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
    assert.equal(primaryCalls, 2);
    const payload = await response.json();
    assert.equal(
      payload.segments.map((segment) => segment.text).join(""),
      "再試行で成功しました。",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("uses a second high-accuracy pass only when requested", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };

  const nativeFetch = globalThis.fetch;
  const requestedModels = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      const model = init.body.get("model");
      requestedModels.push(model);

      if (model === "whisper-1") {
        return Response.json({
          duration: 6,
          language: "ja",
          text: "今日は新しい機能を紹介します字幕が自然になりました",
          segments: [
            { start: 0, end: 2.8, speaker: "A", text: "今日は新しい機能を紹介します" },
            { start: 3.1, end: 6, speaker: "A", text: "字幕が自然になりました" },
          ],
        });
      }

      assert.equal(model, "gpt-4o-transcribe");
      assert.equal(init.body.get("language"), "ja");
      assert.equal(init.body.get("response_format"), "json");
      assert.match(init.body.get("prompt"), /日本語のInstagramリール/);
      return Response.json({
        duration: 6,
        language: "ja",
        text: "今日は新しい機能をご紹介します。字幕がもっと自然になりました。",
      });
    }

    return nativeFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("high-accuracy-test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([0, 0, 0, 24])], "voice.wav", {
        type: "audio/wav",
      }),
    );
    formData.set("quality", "high");

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
    assert.deepEqual(requestedModels, [
      "whisper-1",
      "gpt-4o-transcribe",
    ]);
    assert.equal(payload.refined, true);
    assert.equal(payload.refinementReason, "requested");
    assert.equal(
      payload.segments.map((segment) => segment.text).join(""),
      "今日は新しい機能をご紹介します。字幕がもっと自然になりました。",
    );
    assert.equal(payload.segments[0].start, 0);
    assert.equal(payload.segments.at(-1).end, 6);
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("keeps the timed transcript when a high-accuracy pass omits speech", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      const model = init.body.get("model");
      if (model === "whisper-1") {
        return Response.json({
          duration: 12,
          language: "ja",
          text: "あ、これ押さないとダメなんだ。ちょっと待って、試してみよう。",
          segments: [
            {
              start: 0,
              end: 2,
              speaker: "A",
              text: "あ、これ押さないとダメなんだ。",
            },
            {
              start: 10,
              end: 12,
              speaker: "A",
              text: "ちょっと待って、試してみよう。",
            },
          ],
        });
      }

      assert.equal(model, "gpt-4o-transcribe");
      return Response.json({
        duration: 12,
        language: "ja",
        text: "ちょっと待って、試してみよう。",
      });
    }

    return nativeFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set(
      "incomplete-high-accuracy-test",
      `${process.pid}-${Date.now()}`,
    );
    const { default: worker } = await import(workerUrl.href);
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([0, 0, 0, 24])], "voice.wav", {
        type: "audio/wav",
      }),
    );
    formData.set("quality", "high");

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
    assert.equal(payload.refined, false);
    assert.equal(payload.refinementReason, undefined);
    assert.equal(
      payload.segments.map((segment) => segment.text).join(""),
      "あ、これ押さないとダメなんだ。ちょっと待って、試してみよう。",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("marks a silent audio chunk as skippable", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/audio/transcriptions") {
      return Response.json({
        duration: 4,
        text: "",
        segments: [],
      });
    }

    return nativeFetch(input);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("silent-test", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const formData = new FormData();
    formData.set(
      "file",
      new File([new Uint8Array([0, 0, 0, 24])], "silence.wav", {
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
    assert.deepEqual(await response.json(), {
      text: "",
      language: "ja",
      duration: 4,
      segments: [],
      silent: true,
      refined: false,
    });
  } finally {
    globalThis.fetch = nativeFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("explains when the OpenAI API credit is exhausted", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
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
