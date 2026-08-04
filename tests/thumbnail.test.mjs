import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCoverCrop,
  getThumbnailFrameTime,
  selectThumbnailCandidates,
} from "../lib/thumbnail.ts";

test("selects accented thumbnail candidates first and keeps stable order", () => {
  const captions = [
    { id: 1, start: 0, end: 1, text: "通常の場面", removed: false },
    { id: 2, start: 1, end: 2, text: "最初の見せ場", accent: true },
    { id: 3, start: 2, end: 3, text: "次の場面" },
    { id: 4, start: 3, end: 4, text: "二つ目の見せ場", accent: true },
  ];

  assert.deepEqual(
    selectThumbnailCandidates(captions).map((caption) => caption.id),
    [2, 4, 1],
  );
});

test("excludes removed and blank captions, deduplicates text, and returns at most three", () => {
  const captions = [
    { id: 1, start: 0, end: 1, text: "同じ  見せ場", accent: true },
    { id: 2, start: 1, end: 2, text: "同じ 見せ場" },
    { id: 3, start: 2, end: 3, text: "削除済み", removed: true, accent: true },
    { id: 4, start: 3, end: 4, text: "   ", accent: true },
    { id: 5, start: 4, end: 5, text: "候補2" },
    { id: 6, start: 5, end: 6, text: "候補3" },
    { id: 7, start: 6, end: 7, text: "候補4" },
  ];

  assert.deepEqual(
    selectThumbnailCandidates(captions).map((caption) => caption.id),
    [1, 5, 6],
  );
  assert.deepEqual(selectThumbnailCandidates([]), []);
});

test("chooses a frame inside a caption and caps long-caption offsets", () => {
  assert.equal(getThumbnailFrameTime({ start: 2, end: 3 }, 10), 2.5);
  assert.equal(getThumbnailFrameTime({ start: 2, end: 8 }, 10), 2.8);
});

test("clamps thumbnail frames before the end of the video", () => {
  assert.equal(getThumbnailFrameTime({ start: 9.9, end: 10 }, 10), 9.925);
  assert.equal(getThumbnailFrameTime({ start: 10, end: 12 }, 10), 9.95);
  assert.equal(getThumbnailFrameTime({ start: -2, end: 0.4 }, 10), 0.2);
  assert.equal(getThumbnailFrameTime({ start: 1, end: 2 }, 0), 0);
});

test("calculates a centered 9:16 cover crop for landscape video", () => {
  assert.deepEqual(calculateCoverCrop(1920, 1080), {
    x: 656.25,
    y: 0,
    width: 607.5,
    height: 1080,
  });
});

test("keeps matching portrait video uncropped", () => {
  assert.deepEqual(calculateCoverCrop(1080, 1920), {
    x: 0,
    y: 0,
    width: 1080,
    height: 1920,
  });
});

test("calculates centered cover crops for square and custom ratios", () => {
  assert.deepEqual(calculateCoverCrop(1000, 1000), {
    x: 218.75,
    y: 0,
    width: 562.5,
    height: 1000,
  });
  assert.deepEqual(calculateCoverCrop(1080, 1920, 1, 1), {
    x: 0,
    y: 420,
    width: 1080,
    height: 1080,
  });
});

test("rejects invalid cover crop dimensions", () => {
  assert.throws(() => calculateCoverCrop(0, 1080), RangeError);
  assert.throws(() => calculateCoverCrop(1920, Number.NaN), RangeError);
  assert.throws(() => calculateCoverCrop(1920, 1080, 9, 0), RangeError);
});
