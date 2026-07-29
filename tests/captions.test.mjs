import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCaptionSegments,
  buildCaptionSegmentsFromWords,
  clampCaptionsToDuration,
  selectCaptionHighlight,
} from "../lib/captions.ts";

test("splits Japanese captions at natural punctuation boundaries", () => {
  const captions = buildCaptionSegments([
    {
      start: 0,
      end: 5,
      text: "今日は新しい字幕機能について、わかりやすく説明します。",
    },
  ]);

  assert.deepEqual(
    captions.map((caption) => caption.text),
    ["今日は新しい字幕機能について、", "わかりやすく説明します。"],
  );
  assert.equal(captions[0].start, 0);
  assert.equal(captions.at(-1).end, 5);
});

test("uses phrase endings instead of cutting a long caption mechanically", () => {
  const captions = buildCaptionSegments([
    {
      start: 2,
      end: 7,
      text: "この機能を使うと動画の編集がとても簡単になります",
    },
  ]);

  assert.ok(captions.length >= 2);
  assert.ok(captions.every((caption) => Array.from(caption.text).length <= 18));
  assert.equal(captions.map((caption) => caption.text).join(""), "この機能を使うと動画の編集がとても簡単になります");
  assert.equal(captions[0].start, 2);
  assert.equal(captions.at(-1).end, 7);
});

test("merges a very short fragment into the following phrase", () => {
  const captions = buildCaptionSegments([
    { start: 0, end: 0.5, text: "まずは" },
    { start: 0.5, end: 2.5, text: "小さく始めてみましょう" },
  ]);

  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, "まずは小さく始めてみましょう");
  assert.equal(captions[0].start, 0);
  assert.equal(captions[0].end, 2.5);
});

test("keeps captions after a sentence ending separate", () => {
  const captions = buildCaptionSegments([
    { start: 0, end: 1, text: "大丈夫です。" },
    { start: 1, end: 1.5, text: "次に" },
  ]);

  assert.deepEqual(
    captions.map((caption) => caption.text),
    ["大丈夫です。", "次に"],
  );
});

test("uses word timestamps for natural caption timing", () => {
  const captions = buildCaptionSegmentsFromWords([
    { start: 0.2, end: 0.8, word: "まずは" },
    { start: 0.8, end: 1.4, word: "3つの" },
    { start: 1.4, end: 2.6, word: "ポイントを" },
    { start: 2.6, end: 3.4, word: "紹介します。" },
  ]);

  assert.equal(captions[0].start, 0.2);
  assert.equal(captions.at(-1).end, 3.4);
  assert.ok(captions.every((caption) => caption.start < caption.end));
  assert.equal(
    captions.map((caption) => caption.text).join(""),
    "まずは3つのポイントを紹介します。",
  );
});

test("highlights only visually useful keywords", () => {
  assert.equal(selectCaptionHighlight("大切なポイントです"), "ポイント");
  assert.equal(selectCaptionHighlight("成功率は80%です"), "80%");
  assert.equal(selectCaptionHighlight("自然な話し方です"), undefined);
});

test("clamps generated captions to the selected output duration", () => {
  const captions = clampCaptionsToDuration(
    [
      { id: 4, start: 28, end: 31, text: "last visible", removed: false },
      { id: 5, start: 31, end: 34, text: "outside", removed: false },
    ],
    30,
  );

  assert.deepEqual(captions, [
    { id: 1, start: 28, end: 30, text: "last visible", removed: false },
  ]);
});
