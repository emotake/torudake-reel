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

test("reuses the media element audio source across repeated original-audio exports", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const end = pageSource.indexOf("\n  function requestVideoExport()", start);
  const exportFlow = pageSource.slice(start, end);

  assert.match(exportFlow, /ensureVideoAudioEngine\(true\)/);
  assert.doesNotMatch(exportFlow, /createMediaElementSource\(video\)/);
  assert.match(exportFlow, /shouldCloseExportAudioContext = false/);
});

test("does not require HTMLVideoElement.captureStream on iPhone", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const setupEnd = pageSource.indexOf("isExportingRef.current = true", start);
  const capabilityCheck = pageSource.slice(start, setupEnd);

  assert.doesNotMatch(capabilityCheck, /!captureVideoStream/);
  assert.match(capabilityCheck, /HTMLCanvasElement\.prototype\.captureStream/);
  assert.match(capabilityCheck, /canUseLegacyRecorder/);
  assert.match(pageSource, /exportPortableVideoMp4/);
});

test("tries a deterministic MP4 export before the MediaRecorder fallback", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const end = pageSource.indexOf("\n  function requestVideoExport()", start);
  const exportFlow = pageSource.slice(start, end);
  const portableIndex = exportFlow.indexOf("exportPortableVideoMp4({");
  const recorderIndex = exportFlow.indexOf("new MediaRecorder(");

  assert.ok(portableIndex >= 0);
  assert.ok(recorderIndex > portableIndex);
  assert.match(exportFlow, /if \(!canUseLegacyRecorder\) throw portableExportError/);
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

test("rejects unsupported desktop containers before processing", () => {
  assert.match(pageSource, /UNSUPPORTED_VIDEO_EXTENSION/);
  assert.match(pageSource, /AVI・MKVなどには対応していません/);
  assert.match(
    pageSource,
    /accept="video\/mp4,video\/quicktime,video\/x-m4v,video\/webm/,
  );
});

test("lets the result switch to a full-length source without another AI request", () => {
  const start = pageSource.indexOf("async function updateNarrationCutMode(");
  const end = pageSource.indexOf("\n  function reset()", start);
  const cutModeFlow = pageSource.slice(start, end);

  assert.ok(start >= 0);
  assert.match(cutModeFlow, /buildNarrationTimeline\(/);
  assert.match(cutModeFlow, /setNarrationAutoCutEnabled\(autoCut\)/);
  assert.doesNotMatch(cutModeFlow, /requestNarrationPlan|requestNarrationSpeech/);
  assert.match(pageSource, /元動画にAI音声だけ追加/);
  assert.match(pageSource, /映像・順番・長さを変更しない/);
});

test("keeps display text separate from user-specified narration readings", () => {
  const start = pageSource.indexOf("async function regenerateNarration(");
  const end = pageSource.indexOf("\n  async function updateNarrationCutMode", start);
  const regenerationFlow = pageSource.slice(start, end);

  assert.match(regenerationFlow, /applyNarrationPronunciationGuide/);
  assert.match(regenerationFlow, /requestNarrationSpeech\(\s*speechScript/);
  assert.match(regenerationFlow, /splitNarrationScript\(cleanScript\)/);
  assert.match(pageSource, /漢字の読み方を直す/);
  assert.match(pageSource, /テロップの漢字は変わりません/);
});

test("shows and enforces the server-backed narration generation allowance", () => {
  const regenerationStart = pageSource.indexOf(
    "async function regenerateNarration(",
  );
  const regenerationEnd = pageSource.indexOf(
    "\n  async function updateNarrationCutMode",
    regenerationStart,
  );
  const regenerationFlow = pageSource.slice(regenerationStart, regenerationEnd);

  assert.match(pageSource, /X-Narration-Generations-Remaining/);
  assert.match(pageSource, /AI音声の生成/);
  assert.match(pageSource, /初回生成と自動的な尺調整も含みます/);
  assert.match(pageSource, /1動画作成の利用枠やお支払いは増えません/);
  assert.match(pageSource, /変更は反映済み/);
  assert.match(regenerationFlow, /narrationRegenerationAbortRef\.current/);
  assert.match(regenerationFlow, /controller\.signal/);
  assert.match(regenerationFlow, /recordNarrationSpeechResult\(speechResult\)/);
});
