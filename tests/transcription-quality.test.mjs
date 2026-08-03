import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  alignRefinedTextToSegments,
  getTranscriptionQualityReasons,
  isRefinedTranscriptComplete,
} from "../lib/transcription-quality.ts";

const transcriptionRouteSource = await readFile(
  new URL("../app/api/transcribe/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("normal MP4 transcription does not depend on temporary R2 video storage", () => {
  const start = pageSource.indexOf("async function startEditing");
  const end = pageSource.indexOf("async function startNarrationEditing", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const startEditingSource = pageSource.slice(start, end);

  assert.match(startEditingSource, /transcribeMediaFile\(/);
  assert.doesNotMatch(startEditingSource, /uploadVideoInChunks\(/);
});

test("never accepts an incomplete refinement just because the first pass was poor", () => {
  assert.doesNotMatch(
    transcriptionRouteSource,
    /qualityReasons\.length\s*>\s*0\s*\|\|\s*isRefinedTranscriptComplete/,
  );
  assert.match(
    transcriptionRouteSource,
    /isRefinedTranscriptComplete\(refinedText, rawSegments\)\s*&&/,
  );
});

test("flags only clearly suspicious Japanese transcription output", () => {
  assert.deepEqual(
    getTranscriptionQualityReasons("今日は新しいリールの作り方を紹介します。"),
    [],
  );
  assert.deepEqual(
    getTranscriptionQualityReasons("hello world this is an english transcript"),
    ["unexpected-language"],
  );
  assert.deepEqual(
    getTranscriptionQualityReasons("テストです。テストです。テストです。"),
    ["repetition"],
  );
});

test("aligns refined text to the original speech timing", () => {
  const aligned = alignRefinedTextToSegments(
    "今日は新しい機能を紹介します。字幕がもっと自然になりました。",
    [
      { start: 0, end: 2.8, text: "今日は新しい機能を紹介します" },
      { start: 3.1, end: 6.2, text: "字幕がもっと自然になりました" },
    ],
  );

  assert.equal(aligned.length, 2);
  assert.equal(aligned[0].start, 0);
  assert.equal(aligned[0].end, 2.8);
  assert.equal(aligned[1].start, 3.1);
  assert.equal(aligned[1].end, 6.2);
  assert.equal(
    aligned.map((segment) => segment.text).join(""),
    "今日は新しい機能を紹介します。字幕がもっと自然になりました。",
  );
});

test("rejects a refined transcript that omits a large part of the source", () => {
  const sourceSegments = [
    { start: 0, end: 2, text: "あ、これ押さないとダメなんだ" },
    { start: 10, end: 12, text: "ちょっと待って、試してみよう" },
  ];

  assert.equal(
    isRefinedTranscriptComplete(
      "ちょっと待って、試してみよう。",
      sourceSegments,
    ),
    false,
  );
  assert.equal(
    isRefinedTranscriptComplete(
      "あ、これを押さないとダメなんだ。ちょっと待って、試してみよう。",
      sourceSegments,
    ),
    true,
  );
});
