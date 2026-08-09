import assert from "node:assert/strict";
import test from "node:test";

test("shortens only an overlong narration while preserving its intent", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
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
    assert.match(prompt, /台本の文字数: 75〜90字/);
    assert.match(prompt, /再調整する元台本/);
    assert.match(prompt, /元台本の意味・事実・冒頭の引き・結びを保ち/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("maps the retired emotional style to the natural male template", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
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
          title: "いつもの帰り道",
          script: "立ち止まった先に、いつもと違う景色がありました。今日の記憶を、静かに残します。",
          socialCaption: "何気ない一日にも、残したい瞬間がある。",
          segments: [
            { text: "立ち止まった先に、", emphasis: false },
            { text: "いつもと違う景色がありました。", emphasis: true },
            { text: "今日の記憶を、静かに残します。", emphasis: false },
          ],
        }),
      });
    }

    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set(
      "narration-emotional-story-style",
      `${process.pid}-${Date.now()}`,
    );
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: ["data:image/jpeg;base64,AA=="],
          brief: "夕方の散歩で見つけた景色",
          goal: "follow",
          length: 30,
          style: "refined",
          sourceDuration: 45,
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
    const prompt = openAiRequest.input[0].content[0].text;
    assert.match(prompt, /自然な男性の話し言葉/);
    assert.doesNotMatch(prompt, /エモーショナルストーリー/);
    assert.match(prompt, /台本の文字数: 107〜129字/);
    assert.doesNotMatch(
      prompt,
      /instagram\.com|低音シネマ|明石家|さんま/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("builds the bright male style without forcing comedy", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
  };
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
          title: "真顔で挑む朝",
          script: "準備は完璧。と思った三秒後、全部やり直しです。",
          socialCaption: "予想外まで含めて今日の記録。",
          segments: [
            { text: "準備は完璧。", emphasis: true },
            { text: "と思った三秒後、全部やり直しです。", emphasis: true },
          ],
        }),
      });
    }

    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set(
      "narration-comedy-style",
      `${process.pid}-${Date.now()}`,
    );
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: ["data:image/jpeg;base64,AA=="],
          brief: "朝の支度で起きた小さな失敗",
          goal: "reach",
          length: 30,
          style: "comedy",
          sourceDuration: 45,
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
    const prompt = openAiRequest.input[0].content[0].text;
    assert.match(prompt, /明るくテンポのよい自然な男性/);
    assert.match(prompt, /短い文と自然な緩急/);
    assert.match(prompt, /親しみやすく自然な明るさ/);
    assert.match(
      prompt,
      /実在人物、投稿者、声優、既存キャラクター、地域芸能人の声質、口癖、話速、固有のイントネーション、間合いは模倣しない/,
    );
    assert.match(prompt, /映像にない出来事や感情を作らない/);
    assert.doesNotMatch(
      prompt,
      /リズムコメディ|短い状況説明→一拍|笑いやオチ|ツッコミ/,
    );
    assert.match(prompt, /台本の文字数: 112〜134字/);
    assert.doesNotMatch(
      prompt,
      /instagram\.com|萌えアニメ|関西ツッコミ|激しい関西芸人風|明石家|さんま/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});
