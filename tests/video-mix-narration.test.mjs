import assert from "node:assert/strict";
import test from "node:test";

import {
  createVideoMixNarrationFrameRequests,
  createVideoMixNarrationContactSheetRequests,
  computeVideoMixNarrationNormalizationGain,
  DEFAULT_VIDEO_MIX_CAPTION_STYLE,
  drawVideoMixNarrationCaption,
  extractVideoMixNarrationFrames,
  getActiveVideoMixCaption,
  getSequentialVideoMixCaptionText,
  prepareVideoMixNarration,
  VIDEO_MIX_CAPTION_STYLE_OPTIONS,
} from "../lib/video-mix-narration.ts";

test("reveals caption words when their spoken timing begins", () => {
  const caption = {
    id: 1,
    start: 2,
    end: 5,
    text: "今日は海へ行きます",
    removed: false,
    wordTimings: [
      { word: "今日は", startOffset: 0.1, endOffset: 0.7 },
      { word: "海へ", startOffset: 0.9, endOffset: 1.4 },
      { word: "行きます", startOffset: 1.6, endOffset: 2.5 },
    ],
  };

  assert.equal(getSequentialVideoMixCaptionText(caption, 2.05), "");
  assert.equal(getSequentialVideoMixCaptionText(caption, 2.12), "今日は");
  assert.equal(getSequentialVideoMixCaptionText(caption, 3), "今日は海へ");
  assert.equal(getSequentialVideoMixCaptionText(caption, 3.7), "今日は海へ行きます");
});

test("uses a stable local sequential fallback without word timing", () => {
  const caption = {
    id: 1,
    start: 0,
    end: 2,
    text: "旅の始まりです",
    removed: false,
  };

  assert.equal(getSequentialVideoMixCaptionText(caption, 0), "");
  assert.equal(getSequentialVideoMixCaptionText(caption, 0.5), "旅の");
  assert.equal(getSequentialVideoMixCaptionText(caption, 2), "旅の始まりです");
});

test("shares a bounded narration normalization gain with preview and export", () => {
  const quiet = new Float32Array(48_000).fill(0.01);
  const loud = new Float32Array(48_000).fill(0.9);
  assert.equal(computeVideoMixNarrationNormalizationGain([quiet], 48_000, 1), 1.35);
  const loudGain = computeVideoMixNarrationNormalizationGain([loud], 48_000, 1);
  assert.ok(loudGain >= 0.65 && loudGain <= 1.35);
  assert.ok(loudGain < 1);
});

async function withFrameExtractionEnvironment(run, onDataUrl = () => undefined) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const stats = {
    activeUrls: 0,
    maximumActiveUrls: 0,
    created: [],
    revoked: [],
    paused: 0,
    removedSources: 0,
    cleanupLoads: 0,
  };

  class MockVideo {
    src = "";
    preload = "";
    muted = false;
    playsInline = false;
    videoWidth = 1080;
    videoHeight = 1920;
    onloadedmetadata = null;
    onseeked = null;
    onerror = null;
    #currentTime = 0;

    set currentTime(value) {
      this.#currentTime = value;
      queueMicrotask(() => this.onseeked?.());
    }

    get currentTime() {
      return this.#currentTime;
    }

    load() {
      if (this.src) queueMicrotask(() => this.onloadedmetadata?.());
      else stats.cleanupLoads += 1;
    }

    pause() {
      stats.paused += 1;
    }

    removeAttribute(name) {
      if (name === "src") {
        this.src = "";
        stats.removedSources += 1;
      }
    }
  }

  let drawnFrame = "";
  const documentMock = {
    createElement(type) {
      if (type === "video") return new MockVideo();
      if (type === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage(video) {
              drawnFrame = `${video.src}@${video.currentTime.toFixed(3)}`;
            },
          }),
          toDataURL() {
            onDataUrl();
            return `data:image/jpeg,${drawnFrame}`;
          },
        };
      }
      throw new Error(`Unexpected element: ${type}`);
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value(file) {
      const value = `blob:${file.name}`;
      stats.created.push(value);
      stats.activeUrls += 1;
      stats.maximumActiveUrls = Math.max(stats.maximumActiveUrls, stats.activeUrls);
      return value;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value(value) {
      stats.revoked.push(value);
      stats.activeUrls -= 1;
    },
  });

  try {
    return await run(stats);
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
    if (createObjectUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectUrlDescriptor);
    else delete URL.createObjectURL;
    if (revokeObjectUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
    else delete URL.revokeObjectURL;
  }
}

test("samples selected clips in finished-video order", () => {
  const frames = createVideoMixNarrationFrameRequests(
    [
      { clips: [{ start: 0, end: 2 }] },
      { clips: [{ start: 10, end: 16 }] },
    ],
    4,
  );

  assert.equal(frames.length, 4);
  assert.deepEqual(frames.map((frame) => frame.sourceIndex), [0, 1, 1, 1]);
  assert.ok(frames.some((frame) => frame.sourceIndex === 0 && frame.sourceTime === 1));
  assert.ok(
    frames.every(
      (frame, index) =>
        index === 0 ||
        frame.sourceIndex > frames[index - 1].sourceIndex ||
        frame.sourceTime > frames[index - 1].sourceTime,
    ),
  );
});

test("includes every selected source before distributing extra frames", () => {
  const frames = createVideoMixNarrationFrameRequests(
    [0, 1, 2, 3, 4].map((index) => ({
      clips: [{ start: index * 10, end: index * 10 + 1 }],
    })),
    6,
  );

  assert.equal(frames.length, 6);
  assert.deepEqual(
    [...new Set(frames.map((frame) => frame.sourceIndex))],
    [0, 1, 2, 3, 4],
  );
});

test("caps narration frame extraction at the API maximum", () => {
  const frames = createVideoMixNarrationFrameRequests(
    [{ clips: [{ start: 0, end: 20 }] }],
    99,
  );
  assert.equal(frames.length, 8);
  assert.ok(frames.every((frame, index) => index === 0 || frame.sourceTime > frames[index - 1].sourceTime));
});

test("rejects more than five narration frame sources", () => {
  assert.throws(
    () =>
      createVideoMixNarrationFrameRequests(
        Array.from({ length: 6 }, () => ({ clips: [{ start: 0, end: 1 }] })),
      ),
    /最大5本/,
  );
});

test("covers all ten selected clips with at most five contact sheets", () => {
  const sources = Array.from({ length: 5 }, (_, sourceIndex) => ({
    clips: [
      { start: sourceIndex * 10, end: sourceIndex * 10 + 1 },
      { start: sourceIndex * 10 + 2, end: sourceIndex * 10 + 3 },
    ],
  }));
  const sheets = createVideoMixNarrationContactSheetRequests(sources);
  assert.equal(sheets.length, 5);
  assert.equal(sheets.flatMap((sheet) => sheet.frames).length, 10);
  assert.deepEqual(sheets.map((sheet) => sheet.frames.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(
    sheets.flatMap((sheet) => sheet.frames.map((frame) => frame.sourceIndex)),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4],
  );
});

test("extracts sources sequentially, preserves order, and releases every video", async () => {
  await withFrameExtractionEnvironment(async (stats) => {
    const sources = [
      {
        file: new File([new Uint8Array([1])], "first.mp4", { type: "video/mp4" }),
        clips: [{ start: 0, end: 2 }],
      },
      {
        file: new File([new Uint8Array([2])], "second.mp4", { type: "video/mp4" }),
        clips: [{ start: 10, end: 12 }],
      },
    ];
    const frames = await extractVideoMixNarrationFrames(sources, 2);

    assert.deepEqual(frames, [
      "data:image/jpeg,blob:first.mp4@1.000",
      "data:image/jpeg,blob:second.mp4@11.000",
    ]);
    assert.equal(stats.maximumActiveUrls, 1, "only one source URL may be retained");
    assert.deepEqual(stats.revoked, stats.created);
    assert.equal(stats.activeUrls, 0);
    assert.equal(stats.paused, 2);
    assert.equal(stats.removedSources, 2);
    assert.equal(stats.cleanupLoads, 2);
  });
});

test("encodes two selected clips from one source into one contact-sheet image", async () => {
  const drawnTimes = [];
  await withFrameExtractionEnvironment(
    async () => {
      const frames = await extractVideoMixNarrationFrames([
        {
          file: new File([new Uint8Array([1])], "two-clips.mp4", { type: "video/mp4" }),
          clips: [
            { start: 0, end: 2 },
            { start: 4, end: 6 },
          ],
        },
      ]);
      assert.equal(frames.length, 1);
    },
    () => drawnTimes.push("encoded"),
  );
  assert.deepEqual(drawnTimes, ["encoded"]);
});

test("aborting frame extraction returns no frames and still cleans the active source", async () => {
  const controller = new AbortController();
  await withFrameExtractionEnvironment(
    async (stats) => {
      let result;
      await assert.rejects(
        async () => {
          result = await extractVideoMixNarrationFrames(
            [
              {
                file: new File([new Uint8Array([1])], "first.mp4", { type: "video/mp4" }),
                clips: [{ start: 0, end: 2 }],
              },
              {
                file: new File([new Uint8Array([2])], "second.mp4", { type: "video/mp4" }),
                clips: [{ start: 0, end: 2 }],
              },
            ],
            2,
            controller.signal,
          );
        },
        (error) => error instanceof DOMException && error.name === "AbortError",
      );
      assert.equal(result, undefined);
      assert.deepEqual(stats.created, ["blob:first.mp4"]);
      assert.deepEqual(stats.revoked, ["blob:first.mp4"]);
      assert.equal(stats.activeUrls, 0);
      assert.equal(stats.removedSources, 1);
    },
    () => controller.abort(),
  );
});

test("aborting audio decode rejects without a result and closes AudioContext", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let closeCount = 0;
  let markDecodeStarted;
  const decodeStarted = new Promise((resolve) => {
    markDecodeStarted = resolve;
  });
  class MockAudioContext {
    decodeAudioData() {
      markDecodeStarted();
      return new Promise(() => undefined);
    }

    async close() {
      closeCount += 1;
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: MockAudioContext,
  });
  const controller = new AbortController();
  try {
    let result;
    const work = prepareVideoMixNarration(
      new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      {
        title: "test",
        script: "朝の景色です。",
        socialCaption: "",
        segments: [{ text: "朝の景色です。" }],
      },
      5,
      controller.signal,
    ).then((value) => {
      result = value;
      return value;
    });
    await decodeStarted;
    controller.abort();
    await assert.rejects(
      work,
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(result, undefined);
    assert.equal(closeCount, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "AudioContext", descriptor);
    else delete globalThis.AudioContext;
  }
});

test("caption visibility follows locally aligned display timing", () => {
  const captions = [
    {
      id: 1,
      start: 0,
      end: 3,
      displayStart: 0.8,
      displayEnd: 2.4,
      text: "朝の海辺を歩きました。",
      removed: false,
    },
  ];
  assert.equal(getActiveVideoMixCaption(captions, 0.6), null);
  assert.equal(getActiveVideoMixCaption(captions, 0.8)?.id, 1);
  assert.equal(getActiveVideoMixCaption(captions, 2.4), null);
});

test("offers the same six caption patterns as the single-video editor", () => {
  assert.equal(DEFAULT_VIDEO_MIX_CAPTION_STYLE, "auto");
  assert.deepEqual(
    VIDEO_MIX_CAPTION_STYLE_OPTIONS.map((option) => option.id),
    ["auto", "bold", "soft", "pop", "vlog", "refined"],
  );
  assert.ok(
    VIDEO_MIX_CAPTION_STYLE_OPTIONS.every(
      (option) => option.label.length > 0 && option.note.length > 0,
    ),
  );
});

test("renders all six shared caption patterns with distinct Canvas treatments", () => {
  const captions = [
    {
      id: 1,
      start: 0,
      end: 4,
      text: "今日のおすすめを紹介します",
      highlight: "おすすめ",
      accent: true,
      removed: false,
    },
  ];
  const signatures = new Set();

  for (const option of VIDEO_MIX_CAPTION_STYLE_OPTIONS) {
    const operations = [];
    const context = {
      save() { operations.push("save"); },
      restore() { operations.push("restore"); },
      translate(x, y) { operations.push(`translate:${x}:${y}`); },
      measureText(value) { return { width: Array.from(value).length * 48 }; },
      beginPath() { operations.push("path"); },
      roundRect(...values) { operations.push(`round:${values.join(":")}`); },
      fill() { operations.push("fill"); },
      fillRect(...values) { operations.push(`fillRect:${values.join(":")}`); },
      stroke() { operations.push("stroke"); },
      moveTo(...values) { operations.push(`move:${values.join(":")}`); },
      lineTo(...values) { operations.push(`line:${values.join(":")}`); },
      strokeText(value) { operations.push(`strokeText:${value}`); },
      fillText(value) { operations.push(`fillText:${value}`); },
      set font(value) { operations.push(`font:${value}`); },
      set globalAlpha(value) { operations.push(`alpha:${value}`); },
      set textAlign(value) { operations.push(`align:${value}`); },
      set textBaseline(value) { operations.push(`baseline:${value}`); },
      set fillStyle(value) { operations.push(`fillStyle:${value}`); },
      set lineWidth(value) { operations.push(`lineWidth:${value}`); },
      set strokeStyle(value) { operations.push(`strokeStyle:${value}`); },
      set shadowColor(value) { operations.push(`shadowColor:${value}`); },
      set shadowBlur(value) { operations.push(`shadowBlur:${value}`); },
      set shadowOffsetX(value) { operations.push(`shadowX:${value}`); },
      set shadowOffsetY(value) { operations.push(`shadowY:${value}`); },
      set lineJoin(value) { operations.push(`lineJoin:${value}`); },
    };
    assert.equal(
      drawVideoMixNarrationCaption(
        context,
        1080,
        1920,
        1,
        captions,
        option.id,
        "follow",
      ),
      true,
    );
    signatures.add(operations.join("|"));
  }

  assert.equal(signatures.size, VIDEO_MIX_CAPTION_STYLE_OPTIONS.length);
});

test("shared Canvas renderer draws only during the aligned caption window", () => {
  const drawn = [];
  const context = {
    save() {},
    restore() {},
    measureText(value) {
      return { width: Array.from(value).length * 48 };
    },
    beginPath() {},
    roundRect() {},
    translate() {},
    fillRect() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    strokeText() {},
    fillText(value) {
      drawn.push(value);
    },
    set font(value) {},
    set globalAlpha(value) {},
    set textAlign(value) {},
    set textBaseline(value) {},
    set fillStyle(value) {},
    set lineWidth(value) {},
    set strokeStyle(value) {},
    set shadowColor(value) {},
    set shadowBlur(value) {},
    set shadowOffsetX(value) {},
    set shadowOffsetY(value) {},
    set lineJoin(value) {},
  };
  const captions = [
    {
      id: 1,
      start: 0,
      end: 4,
      displayStart: 1,
      displayEnd: 3,
      text: "映像の順番に合わせたテロップです。",
      removed: false,
    },
  ];

  assert.equal(
    drawVideoMixNarrationCaption(context, 1080, 1920, 0.9, captions),
    false,
  );
  assert.equal(
    drawVideoMixNarrationCaption(context, 1080, 1920, 1.05, captions),
    true,
  );
  assert.equal(drawn.length, 1);
});

test("renders the shared text-only caption patterns without a panel", () => {
  const operations = [];
  const context = {
    save() {},
    restore() {},
    measureText(value) {
      return { width: Array.from(value).length * 48 };
    },
    beginPath() {
      operations.push("panel-path");
    },
    roundRect() {},
    translate() {},
    fillRect() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    strokeText(value) {
      operations.push(`outline:${value}`);
    },
    fillText(value) {
      operations.push(`text:${value}`);
    },
    set font(value) {},
    set globalAlpha(value) {},
    set textAlign(value) {},
    set textBaseline(value) {},
    set fillStyle(value) {},
    set lineWidth(value) {},
    set lineJoin(value) {},
    set strokeStyle(value) {},
    set shadowColor(value) {},
    set shadowBlur(value) {},
    set shadowOffsetX(value) {},
    set shadowOffsetY(value) {},
  };
  const captions = [
    {
      id: 1,
      start: 0,
      end: 4,
      text: "朝の海辺です。",
      removed: false,
    },
  ];

  assert.equal(
    drawVideoMixNarrationCaption(context, 1080, 1920, 1, captions, "soft"),
    true,
  );
  assert.ok(operations.some((operation) => operation.startsWith("outline:")));
  assert.doesNotMatch(operations.join("|"), /panel-path/);

  operations.length = 0;
  assert.equal(
    drawVideoMixNarrationCaption(context, 1080, 1920, 1, captions, "vlog"),
    true,
  );
  assert.ok(operations.some((operation) => operation.startsWith("text:")));
  assert.doesNotMatch(operations.join("|"), /outline:|panel-path/);
});
