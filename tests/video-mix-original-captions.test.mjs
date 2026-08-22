import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getEnabledVideoMixOriginalCaptions,
  normalizeVideoMixOriginalCaptions,
  updateVideoMixOriginalCaption,
} from "../lib/video-mix-original-captions.ts";

const [clientSource, exporterSource] = await Promise.all([
  readFile(new URL("../app/video-mix/video-mix-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/video-mix-export.ts", import.meta.url), "utf8"),
]);

test("normalizes transcription to the edited program and drops unsafe fragments", () => {
  const captions = normalizeVideoMixOriginalCaptions([
    { id: 9, start: -0.2, end: 1.23456, text: " 最初です ", removed: false },
    { id: 10, start: 2.97, end: 3.5, text: "最後です", removed: false },
    { id: 11, start: 1, end: 1.01, text: "短い", removed: false },
    { id: 12, start: 1, end: 2, text: "   ", removed: false },
  ], 3);

  assert.deepEqual(captions.map(({ id, start, end, text }) => ({ id, start, end, text })), [
    { id: 1, start: 0, end: 1.235, text: "最初です" },
    { id: 2, start: 2.97, end: 3, text: "最後です" },
  ]);
});

test("edits and hides captions locally without losing their timeline", () => {
  const source = [
    { id: 1, start: 0, end: 1, text: "変更前", removed: false },
    { id: 2, start: 1, end: 2, text: "残す", removed: false },
  ];
  const edited = updateVideoMixOriginalCaption(source, 1, {
    text: "変更後",
    removed: true,
  });
  assert.deepEqual(edited[0], {
    id: 1,
    start: 0,
    end: 1,
    text: "変更後",
    removed: true,
  });
  assert.equal(edited[1], source[1]);
  assert.deepEqual(getEnabledVideoMixOriginalCaptions(edited), [source[1]]);
});

test("transcribes only after the explicit original-caption action", () => {
  assert.match(clientSource, /元音声のテロップを付ける/);
  assert.match(clientSource, /const generateOriginalCaptions = async/);
  const generation = clientSource.slice(
    clientSource.indexOf("const generateOriginalCaptions"),
    clientSource.indexOf("const generateMixNarration"),
  );
  assert.match(generation, /!originalCaptionsEnabled/);
  assert.match(generation, /createVideoMixTranscriptionAudio/);
  assert.match(generation, /requestVideoMixTranscription/);
  assert.match(generation, /const operationId = crypto\.randomUUID\(\)/);

  const exportFlow = clientSource.slice(
    clientSource.indexOf("const startExport"),
    clientSource.indexOf("const retryFinalize"),
  );
  assert.doesNotMatch(exportFlow, /api\/transcribe|requestVideoMixTranscription/);
});

test("uses one selected-timeline WAV and the same captions for preview and export", () => {
  assert.match(exporterSource, /export async function createVideoMixTranscriptionAudio/);
  const audioBuilder = exporterSource.slice(
    exporterSource.indexOf("export async function createVideoMixTranscriptionAudio"),
    exporterSource.indexOf("function copyCanvasFrame"),
  );
  assert.match(audioBuilder, /renderVideoMixAudio/);
  assert.match(audioBuilder, /encodeMonoWavChunk\(rendered\.buffer, 0, duration\)/);
  assert.doesNotMatch(audioBuilder, /fetch\(|openai|api\/transcribe/i);
  assert.match(clientSource, /const activeCaptions = useMemo/);
  assert.match(clientSource, /updateCaptionOverlay/);
  assert.match(clientSource, /drawOverlay:[\s\S]*?activeCaptionsEnabled[\s\S]*?activeCaptions/);
  assert.match(clientSource, /inspectMixOutput\([\s\S]*?activeCaptions,[\s\S]*?activeCaptionsEnabled/);
});

test("keeps narration audio checks separate from original-caption burn-in checks", () => {
  const inspection = clientSource.slice(
    clientSource.indexOf("async function inspectMixOutput"),
    clientSource.indexOf("function clipAtTime"),
  );
  assert.match(inspection, /const renderedCaptionRanges = captionsEnabled/);
  assert.match(inspection, /const expectedNarrationRanges = audioMetadata\.narration\.requested/);
  assert.match(inspection, /const captionRanges = renderedCaptionRanges/);
});
