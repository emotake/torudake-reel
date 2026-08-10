import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeVideoFrame,
  calculateSceneDifference,
  createRepresentativeFrameSampleTimes,
  selectRepresentativeVideoFrames,
} from "../lib/video-frame-analysis.ts";

function createFrame(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixelAt(x, y);
      const index = (y * width + x) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

function solid(value, width = 24, height = 24) {
  return createFrame(width, height, () => [value, value, value]);
}

function detailed(base = 128, phase = 0) {
  return createFrame(32, 32, (x, y) => {
    const detail = (x + y + phase) % 2 === 0 ? -62 : 62;
    return [base + detail, base + detail * 0.72, base - detail * 0.38];
  });
}

test("scores balanced, detailed frames above clipped or blurred frames", () => {
  const balanced = analyzeVideoFrame(detailed());
  const dark = analyzeVideoFrame(solid(0));
  const overexposed = analyzeVideoFrame(solid(255));
  const flat = analyzeVideoFrame(solid(132));

  assert.ok(balanced.exposureScore > dark.exposureScore);
  assert.ok(balanced.exposureScore > overexposed.exposureScore);
  assert.ok(balanced.sharpnessScore > flat.sharpnessScore + 0.5);
  assert.ok(balanced.qualityScore > dark.qualityScore + 0.35);
  assert.equal(dark.shadowClipRatio, 1);
  assert.equal(overexposed.highlightClipRatio, 1);
});

test("uses optional face and subject metadata to reward safe composition", () => {
  const image = detailed();
  const wellComposed = analyzeVideoFrame(image, {
    faces: [{ x: 0.24, y: 0.2, width: 0.18, height: 0.22, confidence: 0.98 }],
  });
  const croppedAtEdge = analyzeVideoFrame(image, {
    faces: [{ x: -0.08, y: 0.02, width: 0.42, height: 0.54, confidence: 0.98 }],
  });
  const subjectAtThird = analyzeVideoFrame(image, {
    subject: { x: 1 / 3, y: 1 / 3 },
  });
  const subjectAtEdge = analyzeVideoFrame(image, {
    subject: { x: 0.01, y: 0.98 },
  });

  assert.ok(wellComposed.faceScore > croppedAtEdge.faceScore + 0.25);
  assert.ok(subjectAtThird.compositionScore > subjectAtEdge.compositionScore + 0.45);
});

test("detects scene changes deterministically across different frame sizes", () => {
  const sceneA = createFrame(24, 16, (x) =>
    x < 12 ? [30, 80, 190] : [220, 180, 40],
  );
  const sameSceneLarger = createFrame(48, 32, (x) =>
    x < 24 ? [30, 80, 190] : [220, 180, 40],
  );
  const sceneB = createFrame(24, 16, (x, y) =>
    y < 8 ? [210, 50, 60] : [20, 190, 90],
  );

  assert.equal(calculateSceneDifference(sceneA, sceneA), 0);
  assert.ok(calculateSceneDifference(sceneA, sameSceneLarger) < 0.01);
  assert.ok(calculateSceneDifference(sceneA, sceneB) > 0.45);
});

test("builds a non-uniform sampling plan covering the full video", () => {
  const times = createRepresentativeFrameSampleTimes(90, { count: 15 });
  const intervals = times.slice(1).map((time, index) => time - times[index]);

  assert.equal(times.length, 15);
  assert.ok(times[0] < 2);
  assert.ok(times.at(-1) > 88);
  assert.ok(times.some((time) => Math.abs(time - 45) < 0.01));
  assert.ok(new Set(intervals.map((value) => value.toFixed(2))).size > 5);
  assert.deepEqual(createRepresentativeFrameSampleTimes(0), []);
});

test("selects strong representative frames from early, middle, and late scenes", () => {
  const dark = solid(0);
  const sceneA = detailed(118, 0);
  const sceneB = createFrame(32, 32, (x, y) =>
    (x + y) % 3 === 0 ? [40, 170, 90] : [200, 110, 50],
  );
  const sceneC = createFrame(32, 32, (x, y) =>
    x % 3 === 0 ? [65, 100, 220] : y % 2 ? [230, 190, 70] : [90, 45, 150],
  );
  const candidates = [
    { time: 1, image: dark, value: "bad-early" },
    { time: 8, image: sceneA, value: "early" },
    { time: 29, image: dark, value: "bad-middle" },
    { time: 42, image: sceneB, value: "middle" },
    { time: 67, image: dark, value: "bad-late" },
    { time: 82, image: sceneC, value: "late" },
  ];
  const selected = selectRepresentativeVideoFrames(candidates, {
    count: 3,
    duration: 90,
  });

  assert.deepEqual(
    selected.map((entry) => entry.candidate.value),
    ["early", "middle", "late"],
  );
  assert.ok(selected.every((entry) => entry.analysis.qualityScore > 0.45));
});

test("rejects malformed pixel buffers instead of silently mis-scoring them", () => {
  assert.throws(
    () => analyzeVideoFrame({ width: 2, height: 2, data: new Uint8Array(4) }),
    RangeError,
  );
  assert.throws(
    () => analyzeVideoFrame({ width: 0, height: 2, data: new Uint8Array(16) }),
    RangeError,
  );
});
