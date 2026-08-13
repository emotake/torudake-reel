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

const narrationCloudflareEnv = {
  OPENAI_API_KEY: "test-key",
  USAGE_ENFORCEMENT_TEST_MODE: "codex-test-only",
};

async function loadWorker(testName) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(testName, `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

class MockRealtimeSocket {
  constructor(mode = "success") {
    this.mode = mode;
    this.readyState = 1;
    this.closed = false;
    this.sent = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  accept() {
    queueMicrotask(() => {
      if (this.mode === "error") {
        this.emit("error");
        return;
      }
      this.emit("message", {
        data: JSON.stringify({ type: "session.created" }),
      });
    });
  }

  send(value) {
    const event = JSON.parse(value);
    this.sent.push(event);
    if (event.type === "session.update") {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ type: "session.updated" }),
        });
      });
      return;
    }
    if (event.type !== "response.create") return;

    queueMicrotask(() => {
      if (this.mode === "hang") return;
      if (this.mode === "pre-audio-error") {
        this.emit("message", {
          data: JSON.stringify({
            type: "error",
            error: {
              code: "server_error",
              type: "api_error",
              message: "generation interrupted before audio",
            },
          }),
        });
        return;
      }
      this.emit("message", {
        data: JSON.stringify({
          type: "response.output_audio.delta",
          delta: Buffer.from([0, 0, 1, 0, 255, 255]).toString("base64"),
        }),
      });
      if (this.mode === "partial-error") {
        this.emit("message", {
          data: JSON.stringify({
            type: "error",
            error: {
              code: "server_error",
              type: "api_error",
              message: "connection interrupted",
            },
          }),
        });
        return;
      }
      this.emit("message", {
        data: JSON.stringify({
          type: "response.done",
          response: { status: "completed" },
        }),
      });
    });
  }

  close() {
    this.readyState = 3;
    this.closed = true;
  }
}

function realtimeUpgrade(socket) {
  return {
    status: 101,
    ok: false,
    headers: new Headers(),
    webSocket: socket,
  };
}

test("generates four delivery templates with the recommended realtime voices", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sockets = [];
  globalThis.fetch = async (url, init) => {
    const socket = new MockRealtimeSocket();
    requests.push({ url, init });
    sockets.push(socket);
    return realtimeUpgrade(socket);
  };

  try {
    const worker = await loadWorker("narration-realtime-voices");
    const styles = ["calm", "bright", "comedy", "party"];
    const voices = ["cedar", "marin", "cedar", "marin"];
    const speeds = [0.99, 1, 1.03, 1.03];

    for (const [index, style] of styles.entries()) {
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
      assert.equal(response.headers.get("content-type"), "audio/wav");
      assert.equal(
        response.headers.get("x-narration-model"),
        "gpt-realtime-2.1-mini",
      );
      assert.equal(response.headers.get("x-narration-voice"), voices[index]);
      assert.equal(
        response.headers.get("x-narration-profile"),
        `2026-08-13-quality-v3:${style}:gpt-realtime-2.1-mini:${voices[index]}:${speeds[index]}`,
      );
      const wav = new Uint8Array(await response.arrayBuffer());
      assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
      assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), "WAVE");
      assert.equal(new DataView(wav.buffer).getUint32(24, true), 24_000);
      assert.equal(new DataView(wav.buffer).getUint32(40, true), 6);
    }

    assert.ok(
      requests.every(
        (request) =>
          request.url ===
            "https://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini" &&
          request.init.headers.Authorization === "Bearer test-key" &&
          request.init.headers.Upgrade === "websocket",
      ),
    );
    const sessions = sockets.map((socket) => socket.sent[0].session);
    const responses = sockets.map((socket) => socket.sent[1].response);
    assert.deepEqual(
      sessions.map((session) => session.audio.output.voice),
      voices,
    );
    assert.equal(
      new Set(sessions.map((session) => session.audio.output.voice)).size,
      2,
    );
    assert.deepEqual(
      sessions.map((session) => session.audio.output.speed),
      speeds,
    );
    assert.ok(
      sessions.every(
        (session) =>
          session.type === "realtime" &&
          session.output_modalities[0] === "audio" &&
          session.audio.output.format.type === "audio/pcm" &&
          session.audio.output.format.rate === 24_000,
      ),
    );
    assert.ok(
      responses.every(
        (response) =>
          response.conversation === "none" &&
          response.output_modalities[0] === "audio" &&
          response.input[0].type === "message" &&
          response.input[0].role === "user" &&
          response.input[0].content[0].type === "input_text" &&
          response.input[0].content[0].text ===
            "同じ台本で声の違いを確認します。" &&
          response.instructions.includes(
            "台本にない語句、相づち、笑い声、効果音を追加せず",
          ) &&
          response.instructions.includes("# Language") &&
          response.instructions.includes("日本語だけにする") &&
          response.instructions.includes("# Accent and Pronunciation") &&
          response.instructions.includes("日本語を母語とする成人") &&
          response.instructions.includes("自然な共通語") &&
          response.instructions.includes("日本語のモーラ") &&
          response.instructions.includes("自然な高低アクセント") &&
          response.instructions.includes("外国語話者が日本語を読むような抑揚"),
      ),
    );
    assert.equal(
      new Set(responses.map((response) => response.instructions)).size,
      4,
    );
    assert.match(responses[0].instructions, /聞き取りやすい中低音/);
    assert.match(responses[1].instructions, /温かくクリア/);
    assert.match(
      responses[2].instructions,
      /休日のお出かけや楽しかった体験.*成人男性/,
    );
    assert.match(responses[2].instructions, /自然な笑顔が伝わるクリアな声/);
    assert.match(
      responses[3].instructions,
      /友人とのお出かけやおすすめの場所.*成人女性/,
    );
    assert.match(responses[3].instructions, /自然な笑顔と前向きさ/);
    assert.ok(
      responses.every((response) =>
        response.instructions.includes("台本の最後の音節と語尾まで明瞭に言い切る"),
      ),
    );
    assert.doesNotMatch(
      responses.slice(2).map((response) => response.instructions).join("\n"),
      /コメディ|オチ|笑いを作る/,
    );
    assert.doesNotMatch(
      responses.map((response) => response.instructions).join("\n"),
      /instagram\.com|萌えアニメ|関西ツッコミ|明石家|さんま/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses the matching HD fallback when realtime cannot connect", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) {
      return realtimeUpgrade(new MockRealtimeSocket("error"));
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  try {
    const worker = await loadWorker("narration-realtime-fallback");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "大切な出来事を自然な声で読みます。",
          style: "refined",
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(response.headers.get("x-narration-model"), "tts-1-hd");
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /gpt-realtime-2\.1-mini/);
    const fallbackBody = JSON.parse(requests[1].init.body);
    assert.equal(
      requests[1].url,
      "https://api.openai.com/v1/audio/speech",
    );
    assert.equal(fallbackBody.model, "tts-1-hd");
    assert.equal(fallbackBody.voice, "echo");
    assert.equal(fallbackBody.speed, 0.99);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("maps the retired pop voice to the bright female HD fallback", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) {
      return realtimeUpgrade(new MockRealtimeSocket("error"));
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  };

  try {
    const worker = await loadWorker("narration-party-fallback");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "華やかな声でテンポよく読みます。",
          style: "tempo",
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-narration-model"), "tts-1-hd");
    assert.equal(requests.length, 2);
    const fallbackBody = JSON.parse(requests[1].init.body);
    assert.equal(fallbackBody.model, "tts-1-hd");
    assert.equal(fallbackBody.voice, "shimmer");
    assert.equal(fallbackBody.speed, 1.03);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not create a second billable request after realtime generation is requested", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return realtimeUpgrade(new MockRealtimeSocket("pre-audio-error"));
  };

  try {
    const worker = await loadWorker("narration-realtime-no-double-charge");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "途中失敗時の課金を確認します。",
          style: "bright",
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 502);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /gpt-realtime-2\.1-mini/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applies an allowlisted intonation correction to one sentence", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const socket = new MockRealtimeSocket();
  globalThis.fetch = async () => realtimeUpgrade(socket);

  try {
    const worker = await loadWorker("narration-partial-intonation");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "今日のおすすめを紹介します。",
          style: "bright",
          partialCorrection: true,
          deliveryPreset: "emphasis",
          emphasisText: "おすすめ",
          expectedDurationSeconds: 3.2,
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-narration-partial-correction"), "1");
    assert.equal(response.headers.get("x-narration-model"), "gpt-realtime-2.1-mini");
    assert.equal(response.headers.get("x-narration-voice"), "marin");
    assert.equal(
      response.headers.get("x-narration-profile"),
      "2026-08-13-quality-v3:bright:gpt-realtime-2.1-mini:marin:1",
    );
    const session = socket.sent[0].session;
    assert.equal(session.audio.output.voice, "marin");
    assert.equal(session.audio.output.speed, 1);
    assert.equal(session.audio.output.format.rate, 24_000);
    const generated = socket.sent[1].response;
    assert.equal(
      generated.input[0].content[0].text,
      "今日のおすすめを紹介します。",
    );
    assert.match(generated.instructions, /Requested Correction/);
    assert.match(generated.instructions, /Voice Continuity/);
    assert.match(generated.instructions, /同一話者/);
    assert.match(generated.instructions, /全体の音量を上げ下げしない/);
    assert.match(generated.instructions, /約3\.2秒/);
    assert.match(
      generated.instructions,
      /「おすすめ」だけを、日本語として自然な高低アクセント（ピッチアクセント）/,
    );
    assert.match(generated.instructions, /直前・直後のごく短い間だけ/);
    assert.match(generated.instructions, /一文全体のピーク音量、平均音量/);
    assert.match(generated.instructions, /声質、息遣い、収録距離感/);
    assert.match(
      generated.instructions,
      /音量を上げる、叫ぶ、息を強く当てる、破裂音や摩擦音を強くする/,
    );
    assert.match(generated.instructions, /音を歪ませる表現は禁止/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an emphasis word that is not in the selected sentence", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return realtimeUpgrade(new MockRealtimeSocket());
  };

  try {
    const worker = await loadWorker("narration-invalid-emphasis");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "今日のおすすめを紹介します。",
          style: "bright",
          partialCorrection: true,
          deliveryPreset: "emphasis",
          emphasisText: "明日の予定",
          expectedDurationSeconds: 3.2,
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 400);
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not switch voice models when a partial correction cannot connect", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return realtimeUpgrade(new MockRealtimeSocket("error"));
  };

  try {
    const worker = await loadWorker("narration-partial-no-fallback");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "語尾を自然に言い切ります。",
          style: "calm",
          partialCorrection: true,
          deliveryPreset: "firm_ending",
          expectedDurationSeconds: 3,
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 502);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /gpt-realtime-2\.1-mini/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("closes realtime generation when the browser request is aborted", async () => {
  delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const socket = new MockRealtimeSocket("hang");
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return realtimeUpgrade(socket);
  };

  try {
    const worker = await loadWorker("narration-realtime-abort");
    const controller = new AbortController();
    const responsePromise = worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "中断時は音声生成を止めます。",
          style: "calm",
        }),
        signal: controller.signal,
      }),
      workerEnv,
      workerContext,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const response = await responsePromise;

    assert.equal(response.status, 499);
    assert.equal(requests.length, 1);
    assert.equal(socket.closed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("supports an emergency rollback to the legacy TTS model", async () => {
  narrationCloudflareEnv.NARRATION_SPEECH_MODE = "legacy";
  globalThis.__cloudflareEnv = narrationCloudflareEnv;
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
    const worker = await loadWorker("narration-legacy-rollback");
    const response = await worker.fetch(
      new Request("http://localhost/api/narration/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: "落ち着いた声で読みます。",
          style: "calm",
        }),
      }),
      workerEnv,
      workerContext,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-narration-model"), "gpt-4o-mini-tts");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.openai.com/v1/audio/speech");
    assert.equal(requests[0].body.model, "gpt-4o-mini-tts");
    assert.equal(requests[0].body.voice, "cedar");
    assert.match(requests[0].body.instructions, /日本語だけにする/);
    assert.match(requests[0].body.instructions, /日本語を母語とする成人/);
    assert.match(requests[0].body.instructions, /自然な高低アクセント/);
    assert.match(requests[0].body.instructions, /穏やかで信頼感/);
    assert.match(requests[0].body.instructions, /聞き取りやすい中低音/);
  } finally {
    globalThis.fetch = originalFetch;
    delete narrationCloudflareEnv.NARRATION_SPEECH_MODE;
  }
});
