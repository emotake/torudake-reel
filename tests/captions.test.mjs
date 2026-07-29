import assert from "node:assert/strict";
import test from "node:test";

import { buildCaptionSegments } from "../lib/captions.ts";

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
