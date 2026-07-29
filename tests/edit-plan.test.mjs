import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditRanges,
  createNaturalEdit,
  editedTimeToSourceTime,
  getEditedDuration,
  remapCaptionsToEditedTimeline,
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
