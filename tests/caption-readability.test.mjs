import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCaptionReadability,
  CAPTION_MAX_JAPANESE_CHARS_PER_SECOND,
  CAPTION_MIN_DISPLAY_SECONDS,
  countCaptionReadableCharacters,
  getCaptionSafeArea,
  getRecommendedCaptionDisplayDuration,
} from "../lib/caption-readability.ts";

test("uses one shared phone-readable speed and minimum duration", () => {
  assert.equal(CAPTION_MIN_DISPLAY_SECONDS, 0.8);
  assert.equal(CAPTION_MAX_JAPANESE_CHARS_PER_SECOND, 12);
  assert.equal(countCaptionReadableCharacters(" 撮る だけ\nリール "), 7);
  assert.equal(getRecommendedCaptionDisplayDuration("１２３４５６"), 0.8);
  assert.equal(
    getRecommendedCaptionDisplayDuration("今日は動画を選ぶだけで完成します"),
    1.333,
  );
});

test("reports fast captions before they reach preview or export", () => {
  const tooFast = assessCaptionReadability({
    start: 1,
    end: 1.5,
    text: "この字幕は速すぎます",
  });
  assert.equal(tooFast.meetsMinimumDuration, false);
  assert.equal(tooFast.meetsReadingSpeed, false);
  assert.equal(tooFast.readable, false);

  const readable = assessCaptionReadability({
    start: 1,
    end: 2.5,
    text: "読みやすい字幕です",
  });
  assert.equal(readable.readable, true);
});

test("keeps vertical captions clear of common short-video controls", () => {
  assert.deepEqual(getCaptionSafeArea(1080, 1920), {
    x: 75.60000000000001,
    y: 192,
    width: 928.8,
    height: 1344,
    left: 75.60000000000001,
    right: 75.60000000000001,
    top: 192,
    bottom: 384,
  });
  assert.throws(() => getCaptionSafeArea(0, 1920), /positive/);
});
