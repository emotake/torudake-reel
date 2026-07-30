import assert from "node:assert/strict";
import test from "node:test";

test("shortens only an overlong narration while preserving its intent", async () => {
  globalThis.__cloudflareEnv = { OPENAI_API_KEY: "test-key" };
  const originalFetch = globalThis.fetch;
  let openAiRequest;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/responses") {
      openAiRequest = JSON.parse(init.body);
      return Response.json({
        output_text: JSON.stringify({
          title: "短く整えたリール",
          script: "映像の魅力を短く自然に伝えます。最後まで余韻を残します。",
          socialCaption: "映像の魅力をお届けします。",
          segments: [
            { text: "映像の魅力を短く自然に伝えます。", emphasis: true },
            { text: "最後まで余韻を残します。", emphasis: false },
          ],
        }),
      });
    }

    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set(
      "narration-timing-correction",
      `${process.pid}-${Date.now()}`,
    );
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: ["data:image/jpeg;base64,AA=="],
          brief: "店内の雰囲気を伝えたい",
          goal: "follow",
          length: 30,
          style: "calm",
          sourceDuration: 72,
          timingScale: 0.7,
          previousScript:
            "元の台本の意味を保ちながら、自然な読み上げ時間へ短く整えます。",
        }),
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
    assert.ok(openAiRequest);
    const prompt = openAiRequest.input[0].content[0].text;
    assert.match(prompt, /自然な読み上げ時間: 約18秒/);
    assert.match(prompt, /台本の文字数: 70〜84字/);
    assert.match(prompt, /再調整する元台本/);
    assert.match(prompt, /元台本の意味・事実・冒頭の引き・結びを保ち/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});
