import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDisclosedPostCaption,
  buildNarrationTimeline,
  NARRATION_DISCLOSURE_TEXT,
  normalizeNarrationPlan,
  splitNarrationScript,
} from "../lib/narration.ts";

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

test("samples the whole source while keeping the requested edit duration", () => {
  const timeline = buildNarrationTimeline(
    [
      { text: "最初の場面です", emphasis: true },
      { text: "使い方を見せます" },
      { text: "最後に完成です" },
    ],
    72,
    30,
  );
  assert.equal(timeline.length, 3);
  const editedDuration = timeline.reduce(
    (total, segment) => total + segment.end - segment.start,
    0,
  );
  assert.ok(Math.abs(editedDuration - 30) < 0.01);
  assert.ok(timeline[1].start > timeline[0].end);
  assert.ok(timeline.at(-1).end <= 72);
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
