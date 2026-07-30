import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisclosedPostCaption,
  buildNarrationTimeline,
  getNarrationOriginalAudioGain,
  getNarrationPlaybackRate,
  NARRATION_DISCLOSURE_TEXT,
  NARRATION_STYLES,
  normalizeNarrationPlan,
  splitNarrationScript,
} from "../lib/narration.ts";
import {
  buildEditRanges,
  getEditedDuration,
} from "../lib/edit-plan.ts";

test("normalizes a structured narration plan", () => {
  const plan = normalizeNarrationPlan({
    title: "  朝のバッグ紹介  ",
    script: "軽くて、毎日持ちたくなるバッグです。",
    socialCaption: "今日の新作をご紹介。",
    segments: [
      { text: "軽くて、", emphasis: true },
      { text: "毎日持ちたくなるバッグです。", emphasis: false },
    ],
  });
  assert.equal(plan.title, "朝のバッグ紹介");
  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[0].emphasis, true);
});

test("falls back to sentence boundaries when segments are missing", () => {
  const plan = normalizeNarrationPlan({
    script: "最初の場面です。次の場面へ進みます！最後に完成です。",
  });
  assert.ok(plan.segments.length >= 2);
  assert.deepEqual(
    plan.segments.map((segment) => segment.text),
    splitNarrationScript(plan.script),
  );
});

test("samples the whole source while matching the natural audio duration", () => {
  const timeline = buildNarrationTimeline(
    [
      { text: "最初の場面です", emphasis: true },
      { text: "使い方を見せます" },
      { text: "最後に完成です" },
    ],
    72,
    30,
    21.6,
  );
  assert.equal(timeline.length, 3);
  const editedDuration = timeline.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  );
  assert.ok(Math.abs(editedDuration - 21.6) < 0.01);
  assert.ok(timeline[1].start > timeline[0].end);
  assert.equal(timeline.at(-1).end, 72);
});

test("uses four clearly named voice characters with stable ids", () => {
  assert.deepEqual(
    NARRATION_STYLES.map((style) => style.id),
    ["bright", "calm", "tempo", "refined"],
  );
  assert.equal(new Set(NARRATION_STYLES.map((style) => style.label)).size, 4);
  assert.ok(NARRATION_STYLES.every((style) => style.note.includes("声")));
});

test("never stretches narration to fill the video duration", () => {
  assert.equal(getNarrationPlaybackRate(), 1);
});

test("preserves short narration cut gaps instead of rejoining the source", () => {
  const timeline = buildNarrationTimeline(
    Array.from({ length: 20 }, (_, index) => ({
      text: `場面${index + 1}の説明です`,
      emphasis: index === 0,
    })),
    60,
    60,
    52.8,
  );
  const ranges = buildEditRanges(timeline, {
    maxJoinGapSeconds: 0.001,
  });
  assert.ok(ranges.length > 1);
  assert.ok(Math.abs(getEditedDuration(ranges) - 52.8) < 0.02);
});

test("always appends one visible AI narration disclosure", () => {
  const caption = buildDisclosedPostCaption(
    `今日の新作です。\n\n${NARRATION_DISCLOSURE_TEXT}`,
  );
  assert.equal(
    caption.split(NARRATION_DISCLOSURE_TEXT).length - 1,
    1,
  );
  assert.ok(caption.endsWith(NARRATION_DISCLOSURE_TEXT));
});

test("uses a quiet original track only when narration mix keeps it", () => {
  assert.equal(getNarrationOriginalAudioGain("duck"), 0.12);
  assert.equal(getNarrationOriginalAudioGain("mute"), 0);
});
