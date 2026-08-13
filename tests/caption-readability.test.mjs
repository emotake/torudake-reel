import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCaptionReadability,
  CAPTION_MAX_JAPANESE_CHARS_PER_SECOND,
  CAPTION_MIN_DISPLAY_SECONDS,
  countCaptionReadableCharacters,
  fitCaptionDisplayTimeline,
  fitCaptionDisplayTimelineWithinEditRanges,
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

test("fits readable display windows without changing cuts or finished duration", () => {
  const captions = [
    { id: 1, start: 0.2, end: 0.5, text: "短い字幕", removed: false },
    {
      id: 2,
      start: 0.5,
      end: 0.9,
      text: "123456789012345678",
      removed: false,
    },
  ];
  const fitted = fitCaptionDisplayTimeline(captions, {
    timelineStartSeconds: 0,
    timelineEndSeconds: 3,
  });

  assert.deepEqual(
    fitted.map(({ start, end }) => ({ start, end })),
    captions.map(({ start, end }) => ({ start, end })),
    "visibility fitting must never change the edit ranges",
  );
  assert.ok(fitted[0].displayStart >= 0);
  assert.ok(fitted[0].displayEnd <= fitted[1].displayStart);
  assert.ok(fitted[1].displayEnd <= 3);
  fitted.forEach((caption) => {
    assert.equal(
      assessCaptionReadability({
        ...caption,
        start: caption.displayStart,
        end: caption.displayEnd,
      }).readable,
      true,
    );
  });
});

test("shares an impossible short timeline without overlap or duration growth", () => {
  const fitted = fitCaptionDisplayTimeline(
    [
      { id: 1, start: 0, end: 0.2, text: "123456", removed: false },
      { id: 2, start: 0.2, end: 0.4, text: "abcdef", removed: false },
    ],
    { timelineStartSeconds: 0, timelineEndSeconds: 1 },
  );

  assert.equal(fitted[0].displayStart, 0);
  assert.equal(fitted[0].displayEnd, fitted[1].displayStart);
  assert.equal(fitted[1].displayEnd, 1);
  assert.ok(fitted.every((caption) => caption.end <= 0.4));
});

test("never maps a fitted caption window across a removed source gap", () => {
  const fitted = fitCaptionDisplayTimelineWithinEditRanges(
    [
      { id: 1, start: 0, end: 0.5, text: "123456", removed: false },
      { id: 2, start: 10, end: 10.4, text: "abcdef", removed: false },
    ],
    [
      { start: 0, end: 0.5 },
      { start: 10, end: 10.4 },
    ],
  );

  assert.ok(fitted[0].displayStart >= 0);
  assert.ok(fitted[0].displayEnd <= 0.5);
  assert.ok(fitted[1].displayStart >= 10);
  assert.ok(fitted[1].displayEnd <= 10.4);
  assert.ok(
    fitted.every(
      (caption) =>
        caption.displayEnd <= 0.5 || caption.displayStart >= 10,
    ),
    "a source-clock visibility range must not include the removed 0.5–10s gap",
  );
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
