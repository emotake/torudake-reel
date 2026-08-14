import assert from "node:assert/strict";
import test from "node:test";

const sceneTimeline = [
  {
    id: "scene-1",
    startSeconds: 0,
    endSeconds: 1.8,
    sourceIndex: 0,
    clipIndex: 0,
    imageIndex: 0,
    cellIndex: 0,
    cellCount: 2,
  },
  {
    id: "scene-2",
    startSeconds: 1.8,
    endSeconds: 3.4,
    sourceIndex: 0,
    clipIndex: 1,
    imageIndex: 0,
    cellIndex: 1,
    cellCount: 2,
  },
  {
    id: "scene-3",
    startSeconds: 3.4,
    endSeconds: 7.2,
    sourceIndex: 1,
    clipIndex: 0,
    imageIndex: 1,
    cellIndex: 0,
    cellCount: 1,
  },
];

function narrationRequest(overrides = {}) {
  return new Request("http://localhost/api/narration/script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frames: [
        "data:image/jpeg;base64,AA==",
        "data:image/jpeg;base64,BB==",
      ],
      brief: "海辺から食事、夜景へ進む一日",
      goal: "follow",
      length: 30,
      style: "calm",
      sourceDuration: 7.2,
      sceneTimeline,
      ...overrides,
    }),
  });
}

const workerContext = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

test("grounds multi-video narration segments without another provider call", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
  const originalFetch = globalThis.fetch;
  let openAiRequest;
  let providerCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);
    if (url.href === "https://api.openai.com/v1/responses") {
      providerCalls += 1;
      openAiRequest = JSON.parse(init.body);
      return Response.json({
        output_text: JSON.stringify({
          title: "一日の流れ",
          script: "海辺を歩きます。食事を楽しみます。最後は夜景です。",
          socialCaption: "一日の景色をまとめました。",
          // The mock deliberately violates the schema. Server-side fallback
          // must never pass forged or backward scene ids to the client.
          segments: [
            { text: "海辺を歩きます。", emphasis: true, sceneId: "scene-3" },
            { text: "食事を楽しみます。", emphasis: false, sceneId: "forged" },
            { text: "最後は夜景です。", emphasis: false, sceneId: "scene-1" },
          ],
        }),
      });
    }
    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("video-mix-scene-grounding", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      narrationRequest(),
      workerContext,
      executionContext,
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(providerCalls, 1);
    const content = openAiRequest.input[0].content;
    assert.deepEqual(
      content.map((item) => item.type),
      ["input_text", "input_text", "input_image", "input_text", "input_image"],
    );
    assert.match(content[0].text, /segmentsの各要素にはsceneIdを必ず付け/);
    assert.match(content[1].text, /scene-1: 左セル/);
    assert.match(content[1].text, /scene-2: 右セル/);
    assert.match(content[3].text, /scene-3: 全体/);
    const segmentSchema =
      openAiRequest.text.format.schema.properties.segments.items;
    assert.deepEqual(segmentSchema.required, ["text", "emphasis", "sceneId"]);
    assert.deepEqual(segmentSchema.properties.sceneId.enum, [
      "scene-1",
      "scene-2",
      "scene-3",
    ]);
    const repairedIndexes = payload.segments.map((segment) =>
      sceneTimeline.findIndex((scene) => scene.id === segment.sceneId),
    );
    assert.ok(repairedIndexes.every((index) => index >= 0));
    assert.ok(
      repairedIndexes.every(
        (index, position) =>
          position === 0 || index >= repairedIndexes[position - 1],
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("rejects an invalid scene manifest before calling the provider", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);
    if (url.href === "https://api.openai.com/v1/responses") {
      providerCalls += 1;
    }
    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("video-mix-scene-rejection", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      narrationRequest({
        sceneTimeline: sceneTimeline.map((scene, index) =>
          index === 1 ? { ...scene, cellIndex: 0 } : scene,
        ),
      }),
      workerContext,
      executionContext,
    );

    assert.equal(response.status, 400);
    assert.equal(providerCalls, 0);
    assert.match((await response.json()).error, /画像内の場面セル対応/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});
