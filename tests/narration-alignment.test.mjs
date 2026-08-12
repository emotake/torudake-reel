import assert from "node:assert/strict";
import test from "node:test";

import {
  alignNarrationCaptionsToSpeechActivity,
  attachNarrationCaptionDisplayTiming,
  narrationCaptionNeedsReadabilitySplit,
  normalizeSpeechActivityRanges,
} from "../lib/narration-alignment.ts";
import {
  buildEditRanges,
  getEditedDuration,
  remapCaptionsToEditedTimeline,
} from "../lib/edit-plan.ts";

function caption(id, start, end, text, extra = {}) {
  return { id, start, end, text, removed: false, ...extra };
}

test("aligns generated captions to the actual local narration phrases", () => {
  const source = [
    caption(1, 0, 4, "最初の言葉です。"),
    caption(2, 4, 8, "次の言葉です。"),
  ];
  const aligned = alignNarrationCaptionsToSpeechActivity(
    source,
    [
      { start: 0.2, end: 1.2 },
      { start: 2, end: 3 },
    ],
    { edgePaddingSeconds: 0.04 },
  );

  assert.deepEqual(
    aligned.map(({ start, end }) => ({ start, end })),
    [
      { start: 0.2, end: 1.2 },
      { start: 2, end: 3 },
    ],
  );
  assert.equal(aligned[0].localSilenceStart, true);
  assert.equal(aligned[1].localSilenceEnd, true);
  assert.notEqual(aligned, source);
});

test("normalizes overlapping VAD windows and respects narration duration", () => {
  assert.deepEqual(
    normalizeSpeechActivityRanges(
      [
        { start: 0.2, end: 0.8 },
        { start: 0.82, end: 1.1 },
        { start: 1.5, end: 2.4 },
        { start: Number.NaN, end: 3 },
      ],
      2,
    ),
    [
      { start: 0.2, end: 1.1 },
      { start: 1.5, end: 2 },
    ],
  );
});

test("does not overwrite exact word timing or invent speech from silence", () => {
  const exact = caption(1, 0, 1, "正確な時刻", {
    wordTimings: [{ startOffset: 0, endOffset: 1, word: "正確な時刻" }],
  });
  const approximate = caption(2, 1, 2, "推定する時刻");
  const source = [exact, approximate];
  const aligned = alignNarrationCaptionsToSpeechActivity(source, [
    { start: 4, end: 5 },
  ]);

  assert.equal(aligned[0], exact);
  assert.equal(aligned[1].start, 4);
  assert.equal(aligned[1].end, 5);
  assert.equal(
    alignNarrationCaptionsToSpeechActivity(source, []),
    source,
  );
});

test("flags mapped narration captions that still need a text split", () => {
  assert.equal(
    narrationCaptionNeedsReadabilitySplit(
      caption(1, 0, 0.5, "短時間では読み切れない字幕です"),
    ),
    true,
  );
  assert.equal(
    narrationCaptionNeedsReadabilitySplit(caption(1, 0, 2, "読みやすい字幕")),
    false,
  );
});

test("aligns caption visibility without shortening narration edit ranges", () => {
  const source = [
    caption(1, 0, 3, "最初の言葉です。"),
    caption(2, 8, 11, "次の言葉です。"),
    caption(3, 16, 20, "最後の言葉です。"),
  ];
  const aligned = attachNarrationCaptionDisplayTiming(
    source,
    [
      { start: 0.2, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 9 },
    ],
    { maximumDurationSeconds: 10, edgePaddingSeconds: 0 },
  );

  assert.deepEqual(
    aligned.map(({ start, end }) => ({ start, end })),
    source.map(({ start, end }) => ({ start, end })),
  );
  const ranges = buildEditRanges(aligned, { maxJoinGapSeconds: 0.001 });
  assert.equal(getEditedDuration(ranges), 10);
  assert.deepEqual(
    remapCaptionsToEditedTimeline(aligned, ranges).map(({ start, end }) => ({
      start,
      end,
    })),
    [
      { start: 0.2, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 9 },
    ],
  );
});
