import assert from "node:assert/strict";
import test from "node:test";

const narrationScriptCloudflareEnv = {
  OPENAI_API_KEY: "test-key",
  USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
};

function setNarrationScriptTestEnvironment(profile) {
  if (profile) {
    narrationScriptCloudflareEnv.NARRATION_VOICE_PROFILE = profile;
  } else {
    delete narrationScriptCloudflareEnv.NARRATION_VOICE_PROFILE;
  }
  globalThis.__cloudflareEnv = narrationScriptCloudflareEnv;
}

test("shortens only an overlong narration while preserving its intent", async () => {
  setNarrationScriptTestEnvironment();
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
    assert.match(prompt, /元動画の話し声をそのまま使うのではなく/);
    assert.match(prompt, /内容をAIナレーションで伝え直す独立した台本/);
    assert.match(prompt, /環境音やBGM/);
    assert.doesNotMatch(prompt, /話し声が見つからなかった動画だけに使用/);
    assert.doesNotMatch(prompt, /会話や環境音が含まれている場合でも、その上に重ね/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("maps the retired emotional style to the natural male template", async () => {
  setNarrationScriptTestEnvironment();
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
  setNarrationScriptTestEnvironment();
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
    assert.match(prompt, /20代らしい活気と華やかさのある男性/);
    assert.match(prompt, /クラブや音楽イベントの高揚感/);
    assert.match(prompt, /社交的で自信のある語り口/);
    assert.match(prompt, /短い文と自然な緩急/);
    assert.match(
      prompt,
      /実在人物、投稿者、声優、既存キャラクター、地域芸能人の声質、口癖、話速、固有のイントネーション、間合いは模倣しない/,
    );
    assert.match(prompt, /映像にない出来事や感情を作らない/);
    assert.doesNotMatch(
      prompt,
      /リズムコメディ|短い状況説明→一拍|笑いやオチ|ツッコミ/,
    );
    assert.match(prompt, /台本の文字数: 116〜139字/);
    assert.doesNotMatch(
      prompt,
      /instagram\.com|萌えアニメ|関西ツッコミ|激しい関西芸人風|明石家|さんま/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("builds a lively young-adult female style without sacrificing clarity", async () => {
  setNarrationScriptTestEnvironment();
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
          title: "今夜のベストシーン",
          script: "この瞬間、空気まで一気に変わる。今日いちばんの景色を、みんなで楽しもう。",
          socialCaption: "今日いちばんの瞬間を残そう。",
          segments: [
            { text: "この瞬間、空気まで一気に変わる。", emphasis: true },
            { text: "今日いちばんの景色を、みんなで楽しもう。", emphasis: false },
          ],
        }),
      });
    }

    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set(
      "narration-party-style",
      `${process.pid}-${Date.now()}`,
    );
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          frames: ["data:image/jpeg;base64,AA=="],
          brief: "友人と音楽イベントへ出かけた夜",
          goal: "reach",
          length: 30,
          style: "party",
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
    assert.match(prompt, /20代らしい活気と華やかさのある女性/);
    assert.match(prompt, /クラブや音楽イベントの高揚感/);
    assert.match(prompt, /ギャル系ファッションやクラブカルチャー/);
    assert.match(prompt, /華やかで自信と親しみやすさのある語り口/);
    assert.match(prompt, /無理な若者言葉、ギャル語、内輪ノリ、煽り文句を連発せず/);
    assert.match(prompt, /台本の文字数: 116〜139字/);
    assert.doesNotMatch(prompt, /実在人物の声を模倣|幼いアニメ声/);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
  }
});

test("uses the shared character-v1 personas only when explicitly enabled", async () => {
  setNarrationScriptTestEnvironment("character-v1");
  const originalFetch = globalThis.fetch;
  const openAiRequests = [];
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? new URL(input)
        : new URL(input.url);

    if (url.href === "https://api.openai.com/v1/responses") {
      openAiRequests.push(JSON.parse(init.body));
      return Response.json({
        output_text: JSON.stringify({
          title: "日常の一場面",
          script: "いつもの景色に、小さな発見がありました。今日の記録を残します。",
          socialCaption: "日常の小さな発見。",
          segments: [
            { text: "いつもの景色に、", emphasis: false },
            { text: "小さな発見がありました。", emphasis: true },
            { text: "今日の記録を残します。", emphasis: false },
          ],
        }),
      });
    }

    return originalFetch(input, init);
  };

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set(
      "narration-character-v1-script",
      `${process.pid}-${Date.now()}`,
    );
    const { default: worker } = await import(workerUrl.href);
    const prompts = [];

    for (const style of ["party", "comedy"]) {
      const response = await worker.fetch(
        new Request("http://localhost/api/narration/script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frames: ["data:image/jpeg;base64,AA=="],
            brief: "出かけた日に見つけた景色",
            goal: "reach",
            length: 30,
            style,
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
      assert.equal(
        response.headers.get("x-narration-voice-profile"),
        "character-v1",
      );
      assert.equal(
        response.headers.get("x-narration-voice-profile-version"),
        "2026-08-23-character-v1-pop-ja-v2",
      );
      prompts.push(openAiRequests.at(-1).input[0].content[0].text);
    }

    assert.equal(openAiRequests.length, 2);
    assert.match(prompts[0], /声の雰囲気: ポップキャラクター/);
    assert.match(prompts[0], /大人の日常動画にも使いやすい/);
    assert.match(prompts[0], /明瞭な言葉と軽快なテンポ/);
    assert.match(prompts[0], /意味のまとまりを一息/);
    assert.match(prompts[0], /平叙文は自然に言い切/);
    assert.match(prompts[0], /疑問の意図がある文だけを疑問文/);
    assert.doesNotMatch(prompts[0], /重要語だけを自然に弾ませ/);
    assert.match(prompts[0], /台本の文字数: 100〜120字/);
    assert.match(prompts[1], /声の雰囲気: ハイテンショントーク/);
    assert.match(prompts[1], /短い導入からすぐ本題/);
    assert.match(prompts[1], /要点の直前には意味のある短い一拍/);
    assert.match(prompts[1], /結論だけを明瞭に強調/);
    assert.match(prompts[1], /台本の文字数: 104〜125字/);
    for (const prompt of prompts) {
      assert.match(prompt, /実在人物、投稿者、声優、既存キャラクター/);
      assert.match(prompt, /映像にない出来事や感情を作らない/);
      assert.doesNotMatch(prompt, /20代|クラブ|ギャル/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete narrationScriptCloudflareEnv.NARRATION_VOICE_PROFILE;
    delete globalThis.__cloudflareEnv;
  }
});
