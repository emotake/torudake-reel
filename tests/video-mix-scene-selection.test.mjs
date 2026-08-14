import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_MIX_RECOMMENDED_MAX_SOURCE_SECONDS,
  VIDEO_MIX_RECOMMENDED_MIN_CLIP_SECONDS,
  selectRecommendedVideoMixClips,
} from "../lib/video-mix-scene-selection.ts";

function sample(time, qualityScore, sceneChangeScore = 0) {
  return { time, qualityScore, sceneChangeScore };
}

function assertSafeRecommendation(recommendation, duration) {
  assert.ok(recommendation.clips.length >= 1);
  assert.ok(recommendation.clips.length <= 2);
  assert.ok(
    recommendation.clips.every(
      (clip) =>
        clip.start >= 0 &&
        clip.end <= duration &&
        clip.end - clip.start >=
          VIDEO_MIX_RECOMMENDED_MIN_CLIP_SECONDS - 1e-6,
    ),
  );
  assert.ok(
    recommendation.clips.every(
      (clip, index) => index === 0 || clip.start >= recommendation.clips[index - 1].end,
    ),
  );
  assert.ok(
    recommendation.clips.reduce(
      (total, clip) => total + clip.end - clip.start,
      0,
    ) <= VIDEO_MIX_RECOMMENDED_MAX_SOURCE_SECONDS + 1e-6,
  );
}

test("keeps a short source whole without inventing a cut", () => {
  const recommendation = selectRecommendedVideoMixClips(11.275, [
    sample(1, 0.2),
    sample(6, 0.9, 0.8),
  ]);

  assert.deepEqual(recommendation.clips, [{ start: 0, end: 11.275 }]);
  assert.equal(recommendation.reason, "whole-source");
  assert.equal(recommendation.confidence, "high");
});

test("uses the established centered eighteen-second fallback without samples", () => {
  const recommendation = selectRecommendedVideoMixClips(30, []);

  assert.deepEqual(recommendation.clips, [{ start: 6, end: 24 }]);
  assert.equal(recommendation.reason, "centered-fallback");
  assert.equal(recommendation.confidence, "low");
});

test("never rounds a fractional source end beyond the eighteen-second budget", () => {
  const duration = 18.0006;
  const recommendation = selectRecommendedVideoMixClips(duration, [
    sample(4, 0.7),
    sample(9, 0.8),
    sample(14, 0.72),
  ]);

  assertSafeRecommendation(recommendation, duration);
  assert.ok(
    recommendation.clips.reduce(
      (total, clip) => total + clip.end - clip.start,
      0,
    ) <= 18,
  );
});

test("selects one visually strong continuous window for a stable scene", () => {
  const recommendation = selectRecommendedVideoMixClips(42, [
    sample(2, 0.2),
    sample(6, 0.25),
    sample(10, 0.3),
    sample(18, 0.75),
    sample(22, 0.92),
    sample(26, 0.85),
    sample(30, 0.8),
    sample(38, 0.22),
  ]);

  assert.equal(recommendation.reason, "best-continuous");
  assert.equal(recommendation.clips.length, 1);
  assert.ok(recommendation.clips[0].start >= 10);
  assert.ok(recommendation.clips[0].end <= 39);
  assertSafeRecommendation(recommendation, 42);
});

test("uses two chronological ranges when two strong scenes are distinct", () => {
  const recommendation = selectRecommendedVideoMixClips(44, [
    sample(2, 0.7),
    sample(6, 0.82),
    sample(10, 0.78),
    sample(14, 0.73),
    sample(24, 0.79, 0.82),
    sample(28, 0.88),
    sample(32, 0.84),
    sample(38, 0.76),
  ]);

  assert.equal(recommendation.reason, "scene-pair");
  assert.equal(recommendation.clips.length, 2);
  assert.ok(recommendation.clips[0].end + 0.35 <= recommendation.clips[1].start + 1e-6);
  assertSafeRecommendation(recommendation, 44);
});

test("does not trade a strong continuous scene for a very poor second scene", () => {
  const recommendation = selectRecommendedVideoMixClips(44, [
    sample(2, 0.88),
    sample(6, 0.9),
    sample(10, 0.86),
    sample(14, 0.9),
    sample(24, 0.04, 0.9),
    sample(28, 0.03),
    sample(32, 0.06),
    sample(38, 0.02),
  ]);

  assert.equal(recommendation.reason, "best-continuous");
  assert.equal(recommendation.clips.length, 1);
  assertSafeRecommendation(recommendation, 44);
});

test("filters malformed samples and remains deterministic", () => {
  const samples = [
    sample(Number.NaN, 1, 1),
    sample(-3, 1, 1),
    sample(8, Number.POSITIVE_INFINITY, Number.NaN),
    sample(8, 0.8, 0.4),
    sample(21, 0.7, 0.7),
    sample(100, 1, 1),
  ];
  const first = selectRecommendedVideoMixClips(35, samples);
  const second = selectRecommendedVideoMixClips(35, samples);

  assert.deepEqual(first, second);
  assert.equal(first.analyzedFrameCount, 2);
  assertSafeRecommendation(first, 35);
});

test("returns no invalid clip for a non-positive duration", () => {
  assert.deepEqual(selectRecommendedVideoMixClips(0, [sample(0, 1)]).clips, []);
  assert.deepEqual(selectRecommendedVideoMixClips(Number.NaN, []).clips, []);
});
