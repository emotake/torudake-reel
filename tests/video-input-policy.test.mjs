import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_VIDEO_INPUT_DURATION_SECONDS,
  validateVideoInputDuration,
} from "../lib/video-input-policy.ts";

test("allows source videos up to and including the five-minute boundary", () => {
  assert.equal(MAX_VIDEO_INPUT_DURATION_SECONDS, 300);
  assert.deepEqual(validateVideoInputDuration(299), {
    ok: true,
    durationSeconds: 299,
  });
  assert.deepEqual(validateVideoInputDuration(300), {
    ok: true,
    durationSeconds: 300,
  });
});

test("rejects any duration beyond 300 seconds with an explicit Japanese result", () => {
  const result = validateVideoInputDuration(300.001);

  assert.equal(result.ok, false);
  assert.equal(result.code, "video_duration_too_long");
  assert.equal(result.maximumSeconds, 300);
  assert.match(result.message, /5分（300秒）まで/);
  assert.match(result.message, /300秒を超える動画/);
});

test("distinguishes an unreadable duration from an over-limit video", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const result = validateVideoInputDuration(value);
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid_video_duration");
    assert.match(result.message, /動画の長さを確認できませんでした/);
  }
});

test("the reservation endpoint uses the shared five-minute policy", async () => {
  const source = await readFile(
    new URL("../app/api/usage/reserve/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /validateVideoInputDuration/);
  assert.match(source, /durationResult\.durationSeconds/);
  assert.match(source, /maximumSeconds:\s*durationResult\.maximumSeconds/);
  assert.doesNotMatch(source, /60\s*\*\s*60/);
});

test("the narration endpoint cannot bypass the shared five-minute policy", async () => {
  const source = await readFile(
    new URL("../app/api/narration/script/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /validateVideoInputDuration/);
  assert.match(source, /sourceDurationResult\.durationSeconds/);
  assert.match(source, /maximumSeconds:\s*sourceDurationResult\.maximumSeconds/);
  assert.doesNotMatch(source, /sourceDuration\s*>\s*60\s*\*\s*60/);
});
