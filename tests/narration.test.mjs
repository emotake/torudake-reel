import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNarrationPronunciationGuide,
  buildDisclosedPostCaption,
  buildNarrationEditRanges,
  buildNarrationTimeline,
  getNarrationBufferSlice,
  getNarrationMixLevels,
  getNarrationOriginalAudioGain,
  getNarrationPlaybackRate,
  NARRATION_DISCLOSURE_TEXT,
  NARRATION_SPEECH_SUCCESS_LIMIT,
  NARRATION_STYLES,
  normalizeNarrationPlan,
  parseNarrationPronunciationGuide,
  splitNarrationScript,
  validateNarrationPronunciationGuide,
} from "../lib/narration.ts";
import {
  buildEditRanges,
  getEditedDuration,
} from "../lib/edit-plan.ts";

test("caps successful AI voice outputs for one video", () => {
  assert.equal(NARRATION_SPEECH_SUCCESS_LIMIT, 5);
});

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

test("changes only the narration reading while preserving the display script", () => {
  const displayScript = "御厨さんが撮るだけリールを紹介します。";
  const guide = [
    "御厨 → みくりや",
    "撮るだけリール = とるだけりーる",
  ].join("\n");

  assert.deepEqual(parseNarrationPronunciationGuide(guide), [
    { surface: "撮るだけリール", reading: "とるだけりーる" },
    { surface: "御厨", reading: "みくりや" },
  ]);
  assert.equal(
    applyNarrationPronunciationGuide(displayScript, guide),
    "みくりやさんがとるだけりーるを紹介します。",
  );
  assert.equal(displayScript, "御厨さんが撮るだけリールを紹介します。");
});

test("uses the longest pronunciation match without cascading replacements", () => {
  const guide = ["東京 → とうきょう", "東京駅 → とうきょうえき"].join("\n");
  assert.equal(
    applyNarrationPronunciationGuide("東京駅から東京へ向かいます。", guide),
    "とうきょうえきからとうきょうへ向かいます。",
  );
});

test("reports invalid pronunciation guide lines without silently applying the rest", () => {
  const validation = validateNarrationPronunciationGuide(
    "商品名：しょうひんめい\n形式が違う行",
  );
  assert.deepEqual(validation.entries, []);
  assert.match(validation.error, /2行目/);
  assert.deepEqual(
    parseNarrationPronunciationGuide("商品名：しょうひんめい\n形式が違う行"),
    [],
  );
});

test("reports duplicate and excessive pronunciation entries", () => {
  assert.match(
    validateNarrationPronunciationGuide("御厨 → みくりや\n御厨 → みくりやさん").error,
    /重複/,
  );
  const tooMany = Array.from(
    { length: 21 },
    (_, index) => `商品${index + 1} → しょうひん${index + 1}`,
  ).join("\n");
  assert.match(validateNarrationPronunciationGuide(tooMany).error, /20件/);
});

test("supports product names containing regular-expression symbols", () => {
  assert.equal(
    applyNarrationPronunciationGuide("C++入門です。", "C++ → シープラスプラス"),
    "シープラスプラス入門です。",
  );
});

test("uses corrected speech length for caption timing without changing caption text", () => {
  const timeline = buildNarrationTimeline(
    [
      { text: "甲。", speechText: "とてもながいよみかたです。" },
      { text: "乙。", speechText: "おつ。" },
    ],
    30,
    30,
    12,
    { autoCut: false },
  );
  assert.equal(timeline[0].text, "甲。");
  assert.equal(timeline[1].text, "乙。");
  assert.ok(timeline[0].end - timeline[0].start > timeline[1].end - timeline[1].start);
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

test("keeps the four voice ids stable and adds a distinct comedy voice", () => {
  assert.deepEqual(
    NARRATION_STYLES.map((style) => style.id),
    ["bright", "calm", "tempo", "refined", "comedy"],
  );
  assert.equal(new Set(NARRATION_STYLES.map((style) => style.label)).size, 5);
  assert.ok(NARRATION_STYLES.every((style) => style.note.includes("声")));
  assert.deepEqual(
    NARRATION_STYLES.map((style) => style.label),
    [
      "自然な女性",
      "自然な男性",
      "ポップボイス",
      "低音シネマ",
      "テンポコメディ",
    ],
  );
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

test("keeps the complete source when narration auto cut is disabled", () => {
  const timeline = buildNarrationTimeline(
    [
      { text: "最初の説明です", emphasis: true },
      { text: "続きの説明です" },
    ],
    72,
    30,
    18,
    { autoCut: false },
  );
  assert.equal(timeline[0].start, 0);
  assert.ok(timeline.at(-1).end <= 18.01);
  assert.deepEqual(buildNarrationEditRanges(timeline, 72, false), [
    { start: 0, end: 72 },
  ]);
  assert.ok(buildNarrationEditRanges(timeline, 72, true).length >= 1);
  assert.ok(
    getEditedDuration(buildNarrationEditRanges(timeline, 72, true)) < 72,
  );
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

test("converts the selected original-audio percentage into a safe gain", () => {
  assert.equal(getNarrationOriginalAudioGain(0), 0);
  assert.equal(getNarrationOriginalAudioGain(8), 0.08);
  assert.equal(getNarrationOriginalAudioGain(12), 0.12);
  assert.equal(getNarrationOriginalAudioGain(-5), 0);
  assert.equal(getNarrationOriginalAudioGain(80), 0.2);
  assert.equal(getNarrationOriginalAudioGain(Number.NaN), 0);
});

test("keeps narration at full volume for every original-audio setting", () => {
  for (const [percent, expectedOriginal] of [
    [0, 0],
    [8, 0.08],
    [12, 0.12],
    [17, 0.17],
  ]) {
    assert.deepEqual(getNarrationMixLevels(percent), {
      original: expectedOriginal,
      narration: 1,
    });
  }
});

test("slices decoded narration continuously across edited ranges", () => {
  assert.deepEqual(getNarrationBufferSlice(0, 4, 9.5), {
    offset: 0,
    duration: 4,
  });
  assert.deepEqual(getNarrationBufferSlice(4, 4, 9.5), {
    offset: 4,
    duration: 4,
  });
  assert.deepEqual(getNarrationBufferSlice(8, 4, 9.5), {
    offset: 8,
    duration: 1.5,
  });
  assert.equal(getNarrationBufferSlice(9.5, 4, 9.5), null);
});
