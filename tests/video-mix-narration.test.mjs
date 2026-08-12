import assert from "node:assert/strict";
import test from "node:test";

import {
  createVideoMixNarrationFrameRequests,
  drawVideoMixNarrationCaption,
  getActiveVideoMixCaption,
} from "../lib/video-mix-narration.ts";

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
    fill() {},
    stroke() {},
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
  assert.equal(drawn.length, 2);
});
