import assert from "node:assert/strict";
import test from "node:test";

import {
  computePhotoReelImageLayout,
  computePhotoReelSubjectAwareCoverRect,
} from "../lib/photo-reel.ts";
import {
  estimatePhotoReelSubject,
  normalizePhotoReelFocusPoint,
} from "../lib/photo-reel-subject.ts";

function makeImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = paint(x, y);
      const index = (y * width + x) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

test("prefers detected faces and keeps a little space below them", () => {
  const focus = estimatePhotoReelSubject(
    makeImage(8, 8, () => [0, 0, 0]),
    [{ x: 0.68, y: 0.12, width: 0.2, height: 0.24, confidence: 0.95 }],
  );

  assert.equal(focus.source, "face");
  assert.ok(focus.x > 0.76 && focus.x < 0.79);
  assert.ok(focus.y > 0.27 && focus.y < 0.3);
  assert.ok(focus.confidence > 0.65);
});

test("finds a salient off-center subject without uploading pixels", () => {
  const focus = estimatePhotoReelSubject(
    makeImage(32, 24, (x, y) =>
      x >= 23 && x <= 28 && y >= 7 && y <= 17
        ? [250, 95, 40]
        : [28, 32, 38],
    ),
  );

  assert.equal(focus.source, "saliency");
  assert.ok(focus.x > 0.57);
  assert.ok(focus.confidence > 0);
});

test("uses a safe center when a photo contains no reliable subject", () => {
  assert.deepEqual(
    estimatePhotoReelSubject(makeImage(16, 16, () => [90, 90, 90])),
    { x: 0.5, y: 0.45, confidence: 0, source: "center" },
  );
  assert.deepEqual(normalizePhotoReelFocusPoint({ x: 2, y: -1 }), {
    x: 0.95,
    y: 0.05,
    confidence: 1,
    source: "manual",
  });
});

test("moves only the hidden cover area toward the selected subject", () => {
  const right = computePhotoReelSubjectAwareCoverRect(
    1300,
    1920,
    1080,
    1920,
    { x: 0.85, y: 0.5, confidence: 1 },
  );
  const left = computePhotoReelSubjectAwareCoverRect(
    1300,
    1920,
    1080,
    1920,
    { x: 0.15, y: 0.5, confidence: 1 },
  );
  assert.equal(right.x, -220);
  assert.equal(left.x, 0);
  assert.equal(right.width, 1300);
  assert.equal(right.height, 1920);
});

test("keeps old centered output when evidence is missing", () => {
  assert.deepEqual(
    computePhotoReelImageLayout(1080, 1920),
    computePhotoReelImageLayout(1080, 1920, 1080, 1920, {
      x: 0.9,
      y: 0.2,
      confidence: 0,
    }),
  );
  const focused = computePhotoReelImageLayout(1200, 2000, 1080, 1920, {
    x: 0.9,
    y: 0.45,
    confidence: 0.8,
  });
  assert.equal(focused.mode, "cover");
  assert.ok(focused.foreground.x < 0);
});
