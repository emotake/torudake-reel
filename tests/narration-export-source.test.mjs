import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("prepares the narration audio context before recording disclosure", () => {
  const start = pageSource.indexOf("async function confirmNarrationExport()");
  const end = pageSource.indexOf("\n  return (", start);
  const confirmationFlow = pageSource.slice(start, end);
  const prepareIndex = confirmationFlow.indexOf(
    "createRunningNarrationAudioContext()",
  );
  const recordIndex = confirmationFlow.indexOf(
    "recordDisclosureConfirmation()",
  );
  const exportIndex = confirmationFlow.indexOf("exportCaptionedVideo(");

  assert.ok(prepareIndex >= 0);
  assert.ok(prepareIndex < recordIndex);
  assert.ok(recordIndex < exportIndex);
});

test("exports decoded narration through an AudioBuffer source", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const end = pageSource.indexOf(
    "\n  function requestVideoExport()",
    start,
  );
  const exportFlow = pageSource.slice(start, end);

  assert.match(exportFlow, /decodeAudioData\(narrationBytes\)/);
  assert.match(exportFlow, /createBufferSource\(\)/);
  assert.match(exportFlow, /getNarrationBufferSlice\(/);
  assert.doesNotMatch(
    exportFlow,
    /createMediaElementSource\(exportNarration\)/,
  );
});

test("does not require HTMLVideoElement.captureStream on iPhone", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const setupEnd = pageSource.indexOf("isExportingRef.current = true", start);
  const capabilityCheck = pageSource.slice(start, setupEnd);

  assert.doesNotMatch(capabilityCheck, /!captureVideoStream/);
  assert.match(capabilityCheck, /HTMLCanvasElement\.prototype\.captureStream/);
  assert.match(capabilityCheck, /usePortableMp4Exporter/);
  assert.match(pageSource, /exportPortableVideoMp4/);
});

test("prefers an iPhone-compatible MP4 and keeps a user-triggered save action", () => {
  assert.match(
    pageSource,
    /video\/mp4;codecs=avc1\.42E01E,mp4a\.40\.2/,
  );
  assert.match(pageSource, /navigator\.share\(shareData\)/);
  assert.match(pageSource, /動画を保存・共有/);
  assert.match(pageSource, /「ビデオを保存」を選べます/);
});
