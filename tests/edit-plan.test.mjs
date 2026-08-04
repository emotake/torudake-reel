import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditRanges,
  buildSpokenEditRanges,
  createNaturalEdit,
  editedTimeToSourceTime,
  getEditedDuration,
  remapCaptionsToEditedTimeline,
  setCaptionCut,
  sourceTimeToEditedTime,
} from "../lib/edit-plan.ts";

function caption(id, start, end, text) {
  return { id, start, end, text, removed: false };
}

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
  const source = Array.from({ length: 18 }, (_, index) =>
    caption(
      index + 1,
      index * 4,
      index * 4 + 3.4,
      `要点${index + 1}を分かりやすく説明します。`,
    ),
  );

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
      caption(
        1,
        0,
        72,
        "長い説明の中から必要な部分だけを自然な長さに収めて紹介します。",
      ),
    ],
    30,
    "reach",
  );

  assert.equal(edited.length, 1);
  assert.equal(edited[0].removed, false);
  assert.equal(getEditedDuration(buildEditRanges(edited)), 30);
  assert.ok(edited[0].text.length > 0);
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

test("keeps the complete source range when spoken-video reconnection is off", () => {
  const transcript = [
    caption(1, 2, 4, "冒頭の無音後に話します。"),
    caption(2, 8, 11, "途中にも間があります。"),
  ];

  assert.deepEqual(buildSpokenEditRanges(transcript, 15.4321, false), [
    { start: 0, end: 15.432 },
  ]);
  assert.deepEqual(
    buildSpokenEditRanges(transcript, 15.4321, true),
    buildEditRanges(transcript),
  );
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
