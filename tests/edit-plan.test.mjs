import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditRanges,
  buildSpokenEditRanges,
  createNaturalEdit,
  editedTimeToSourceTime,
  explainCaptionCut,
  getEditedDuration,
  remapCaptionsToEditedTimeline,
  setCaptionCut,
  snapEditRangesToTimedSilence,
  sourceTimeToEditedTime,
  summarizeAutomaticSilenceCuts,
} from "../lib/edit-plan.ts";

function caption(id, start, end, text) {
  return { id, start, end, text, removed: false };
}

test("explains automatic and manual caption cuts without another model", () => {
  const source = [
    { ...caption(1, 0, 1, "えーと"), removed: true },
    caption(2, 1.2, 3, "最初に結論をお伝えします。"),
    { ...caption(3, 3.2, 5, "最初に結論をお伝えします。"), removed: true },
    { ...caption(4, 5.2, 8, "補足の説明です。"), removed: true },
  ];

  assert.equal(explainCaptionCut(source, 1, "auto", 30)?.code, "filler");
  assert.equal(explainCaptionCut(source, 3, "auto", 30)?.code, "duplicate");
  assert.deepEqual(explainCaptionCut(source, 4, "auto", 30), {
    code: "duration",
    label: "30秒に整えるため",
    detail: "全体の要点と流れを残しながら、選んだ長さへ収めています。",
  });
  assert.equal(explainCaptionCut(source, 4, "manual", 30)?.code, "manual");
  assert.equal(explainCaptionCut(source, 2, "auto", 30), null);
});

test("summarizes only measured long transcript gaps in automatic mode", () => {
  const source = [
    caption(1, 0, 1, "前半です。"),
    caption(2, 2, 3, "間を空けて続けます。"),
    caption(3, 3.3, 4, "すぐ続きます。"),
    caption(4, 5.5, 6, "最後です。"),
  ];

  assert.deepEqual(summarizeAutomaticSilenceCuts(source, "auto"), {
    count: 2,
    totalSeconds: 2.5,
  });
  assert.deepEqual(summarizeAutomaticSilenceCuts(source, "manual"), {
    count: 0,
    totalSeconds: 0,
  });
});

test("builds a natural edit near the requested duration from the full source", () => {
  const source = [
    caption(1, 0, 2.5, "えー、今日はですね、"),
    caption(2, 2.5, 7, "最初に結論をお伝えします。"),
    caption(3, 7.8, 12.5, "続けるためのポイントは三つあります。"),
    caption(4, 13, 17.5, "一つ目は小さく始めることです。"),
    caption(5, 18, 22.5, "二つ目は時間を決めることです。"),
    caption(6, 23, 27.5, "三つ目は記録を残すことです。"),
    caption(7, 28.2, 32.7, "でも毎日できなくても大丈夫です。"),
    caption(8, 33.3, 37.8, "できた日だけ印をつけてください。"),
    caption(9, 38.4, 42.9, "あの、できた日だけ印をつけてください。"),
    caption(10, 43.5, 48, "一週間後には変化が見えてきます。"),
    caption(11, 48.7, 53.2, "まずは今日一分だけ試しましょう。"),
    caption(12, 54, 58.5, "続けるコツは完璧を目指さないことです。"),
    caption(13, 59.2, 63.7, "ぜひ保存して後から見返してください。"),
    caption(14, 64.4, 68.9, "それでは一緒に始めてみましょう。"),
  ];

  const edited = createNaturalEdit(source, 30, "follow");
  const kept = edited.filter((item) => !item.removed);
  const duration = getEditedDuration(buildEditRanges(edited));

  assert.ok(kept.length >= 5);
  assert.ok(duration <= 30.35);
  assert.ok(duration >= 24);
  assert.equal(edited[0].removed, true);
  assert.equal(edited[8].removed, true);
  assert.match(kept.at(-1).text, /。$/);
});

test("a 30 second edit keeps representative moments from early, middle, and late", () => {
  const source = Array.from({ length: 18 }, (_, index) => ({
    ...caption(
      index + 1,
      index * 4,
      index * 4 + 3.4,
      `要点${index + 1}を分かりやすく説明します。`,
    ),
    wordTimings: [
      { startOffset: 0, endOffset: 0.8, word: `要点${index + 1}` },
      { startOffset: 0.8, endOffset: 1.8, word: "を分かりやすく" },
      { startOffset: 1.8, endOffset: 2.7, word: "説明" },
      { startOffset: 2.7, endOffset: 3.4, word: "します。" },
    ],
  }));

  const edited = createNaturalEdit(source, 30, "sales");
  const kept = edited.filter((item) => !item.removed);
  const duration = getEditedDuration(buildEditRanges(edited));

  assert.ok(duration >= 28.5);
  assert.ok(duration <= 30.35);
  assert.ok(kept.some((item) => item.start < 24));
  assert.ok(kept.some((item) => item.start >= 24 && item.start < 48));
  assert.ok(kept.some((item) => item.start >= 48));
});

test("clips an oversized single transcript segment to the requested duration", () => {
  const edited = createNaturalEdit(
    [
      {
        ...caption(
          1,
          0,
          72,
          "長い説明の中から必要な部分だけを自然な長さに収めて紹介します。",
        ),
        wordTimings: [
          { startOffset: 0, endOffset: 8, word: "長い説明の" },
          { startOffset: 8, endOffset: 18, word: "中から" },
          { startOffset: 18, endOffset: 29.6, word: "必要な部分だけを" },
          { startOffset: 29.6, endOffset: 43, word: "自然な長さに" },
          { startOffset: 43, endOffset: 72, word: "収めて紹介します。" },
        ],
      },
    ],
    30,
    "reach",
  );

  assert.equal(edited.length, 1);
  assert.equal(edited[0].removed, false);
  assert.equal(getEditedDuration(buildEditRanges(edited)), 29.6);
  assert.ok(edited[0].text.length > 0);
  assert.equal(edited[0].end, 29.6);
  assert.equal(edited[0].text, "長い説明の中から必要な部分だけを");
  assert.ok(
    edited[0].wordTimings.every((word) => word.endOffset <= 29.6),
  );
});

test("keeps a whole caption when exact word timestamps are unavailable", () => {
  const original = caption(
    1,
    0,
    72,
    "正確な単語時刻がない場合は発話途中を推定位置で切りません。",
  );
  const edited = createNaturalEdit([original], 30, "reach");

  assert.equal(edited.length, 1);
  assert.equal(edited[0].removed, false);
  assert.equal(edited[0].start, original.start);
  assert.equal(edited[0].end, original.end);
  assert.equal(edited[0].text, original.text);
});

test("places automatic cut joins in timestamped quiet gaps", () => {
  const transcript = [
    {
      ...caption(1, 0, 1, "前の言葉"),
      removed: true,
      wordTimings: [{ startOffset: 0, endOffset: 1, word: "前の言葉" }],
    },
    {
      ...caption(2, 1.4, 2, "残す言葉"),
      wordTimings: [{ startOffset: 0, endOffset: 0.6, word: "残す言葉" }],
    },
    {
      ...caption(3, 2.4, 3, "後の言葉"),
      removed: true,
      wordTimings: [{ startOffset: 0, endOffset: 0.6, word: "後の言葉" }],
    },
  ];

  assert.deepEqual(
    snapEditRangesToTimedSilence(transcript, [{ start: 1.4, end: 2 }]),
    [{ start: 1.38, end: 2.02 }],
  );
  assert.deepEqual(buildEditRanges(transcript), [
    { start: 1.38, end: 2.02 },
  ]);
});

test("does not invent silence joins without exact word timestamps", () => {
  const transcript = [
    { ...caption(1, 0, 1, "cut"), removed: true },
    caption(2, 1.4, 2, "keep"),
  ];

  assert.deepEqual(
    snapEditRangesToTimedSilence(transcript, [{ start: 1.4, end: 2 }]),
    [{ start: 1.4, end: 2 }],
  );
});

test("preserves waveform-measured cut handles instead of expanding them again", () => {
  const transcript = [
    {
      ...caption(1, 0, 1, "before"),
      removed: true,
      wordTimings: [{ startOffset: 0, endOffset: 1, word: "before" }],
    },
    {
      ...caption(2, 1.39, 2.01, "keep"),
      localSilenceStart: true,
      localSilenceEnd: true,
      wordTimings: [{ startOffset: 0.01, endOffset: 0.61, word: "keep" }],
    },
    {
      ...caption(3, 2.4, 3, "after"),
      removed: true,
      wordTimings: [{ startOffset: 0, endOffset: 0.6, word: "after" }],
    },
  ];

  assert.deepEqual(buildEditRanges(transcript), [
    { start: 1.39, end: 2.01 },
  ]);
});

test("maps source timestamps onto the cut timeline", () => {
  const edited = [
    caption(1, 0, 5, "最初の文です。"),
    { ...caption(2, 5, 10, "削除する文です。"), removed: true },
    caption(3, 10, 15, "最後の文です。"),
  ];
  const ranges = buildEditRanges(edited);

  assert.deepEqual(ranges, [
    { start: 0, end: 5 },
    { start: 10, end: 15 },
  ]);
  assert.equal(getEditedDuration(ranges), 10);
  assert.equal(sourceTimeToEditedTime(ranges, 12), 7);
  assert.equal(editedTimeToSourceTime(ranges, 7), 12);
  assert.deepEqual(
    remapCaptionsToEditedTimeline(edited, ranges).map(
      ({ start, end, text }) => ({ start, end, text }),
    ),
    [
      { start: 0, end: 5, text: "最初の文です。" },
      { start: 5, end: 10, text: "最後の文です。" },
    ],
  );
});

test("does not merge ranges across an explicitly cut short caption", () => {
  const edited = [
    caption(1, 0, 2, "残す前半です。"),
    { ...caption(2, 2, 2.2, "短くても切る部分です。"), removed: true },
    caption(3, 2.2, 4, "残す後半です。"),
  ];

  const ranges = buildEditRanges(edited);

  assert.deepEqual(ranges, [
    { start: 0, end: 2 },
    { start: 2.2, end: 4 },
  ]);
  assert.equal(getEditedDuration(ranges), 3.8);
  assert.equal(sourceTimeToEditedTime(ranges, 2.2), 2);
  assert.equal(editedTimeToSourceTime(ranges, 2.1), 2.3);
});

test("still joins a short natural gap when no caption was explicitly cut", () => {
  const edited = [
    caption(1, 0, 2, "前半です。"),
    caption(2, 2.2, 4, "後半です。"),
  ];

  assert.deepEqual(buildEditRanges(edited), [{ start: 0, end: 4 }]);
});

test("applies distinct spoken cut ranges for auto, manual, and none", () => {
  const transcript = [
    caption(1, 2, 4, "冒頭の無音後に話します。"),
    caption(2, 8, 11, "途中にも間があります。"),
  ];

  assert.deepEqual(buildSpokenEditRanges(transcript, 15.4321, "none"), [
    { start: 0, end: 15.432 },
  ]);
  assert.deepEqual(buildSpokenEditRanges(transcript, 15.4321, "manual"), [
    { start: 0, end: 15.432 },
  ]);
  assert.deepEqual(
    buildSpokenEditRanges(transcript, 15.4321, "auto"),
    buildEditRanges(transcript),
  );
});

test("manual spoken cuts remove only the sections explicitly chosen", () => {
  const transcript = [
    caption(1, 2, 4, "残す前半です。"),
    { ...caption(2, 8, 11, "手動で切る部分です。"), removed: true },
    { ...caption(3, 10.5, 12, "重なって切る部分です。"), removed: true },
    caption(4, 13, 14, "残す後半です。"),
  ];

  assert.deepEqual(buildSpokenEditRanges(transcript, 15.4321, "manual"), [
    { start: 0, end: 8 },
    { start: 12, end: 15.432 },
  ]);
  assert.deepEqual(buildSpokenEditRanges(transcript, 15.4321, "none"), [
    { start: 0, end: 15.432 },
  ]);
  assert.deepEqual(buildSpokenEditRanges(transcript, 15.4321, "auto"), [
    { start: 2, end: 4 },
    { start: 13, end: 14 },
  ]);
});

test("manual and no-cut modes keep the opening before source metadata is available", () => {
  const transcript = [caption(1, 2, 4, "冒頭の風景も残します。")];

  assert.deepEqual(buildSpokenEditRanges(transcript, 0, "manual"), [
    { start: 0, end: 4 },
  ]);
  assert.deepEqual(buildSpokenEditRanges(transcript, 0, "none"), [
    { start: 0, end: 4 },
  ]);
  assert.deepEqual(buildSpokenEditRanges(transcript, 0, "auto"), [
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(buildSpokenEditRanges([], 0, "manual"), []);
  assert.deepEqual(buildSpokenEditRanges([], 0, "none"), []);
});

test("sets and restores a caption cut without mutating other captions", () => {
  const source = [
    caption(1, 0, 2, "残す文です。"),
    caption(2, 2, 4, "切り替える文です。"),
  ];

  const cut = setCaptionCut(source, 2, true);
  assert.equal(cut.changed, true);
  assert.equal(cut.blockedReason, undefined);
  assert.equal(cut.captions[0], source[0]);
  assert.equal(cut.captions[1].removed, true);
  assert.equal(source[1].removed, false);

  const restored = setCaptionCut(cut.captions, 2, false);
  assert.equal(restored.changed, true);
  assert.equal(restored.captions[1].removed, false);
});

test("prevents cutting the final playable caption", () => {
  const source = [
    caption(1, 0, 2, "最後に残った文です。"),
    { ...caption(2, 2, 4, "すでにカット中です。"), removed: true },
    caption(3, 4, 6, ""),
  ];

  const result = setCaptionCut(source, 1, true);

  assert.equal(result.changed, false);
  assert.equal(result.blockedReason, "would-remove-all");
  assert.equal(result.captions, source);
});

test("allows restoring from an all-cut state and ignores an unknown id", () => {
  const source = [
    { ...caption(1, 0, 2, "戻す文です。"), removed: true },
  ];

  const restored = setCaptionCut(source, 1, false);
  assert.equal(restored.changed, true);
  assert.equal(restored.captions[0].removed, false);

  const unknown = setCaptionCut(source, 999, true);
  assert.equal(unknown.changed, false);
  assert.equal(unknown.blockedReason, "not-found");
  assert.equal(unknown.captions, source);
});
