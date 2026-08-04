import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const globalCssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
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
  assert.match(pageSource, /読み間違いを直す/);
  assert.match(pageSource, /台本の言葉/);
  assert.match(pageSource, /正しい読み方/);
  assert.match(pageSource, /漢字の表示はそのまま/);
  const matchValidationIndex = regenerationFlow.indexOf(
    "unmatchedPronunciationEntries",
  );
  const speechRequestIndex = regenerationFlow.indexOf(
    "requestNarrationSpeech(",
  );
  assert.ok(matchValidationIndex >= 0);
  assert.ok(matchValidationIndex < speechRequestIndex);
});

test("offers a mobile-friendly pronunciation editor without using the API while typing", () => {
  const editorStart = pageSource.indexOf(
    "function updateNarrationPronunciationRow(",
  );
  const editorEnd = pageSource.indexOf(
    "\n  async function handleNarrationRegeneration()",
    editorStart,
  );
  const editorFlow = pageSource.slice(editorStart, editorEnd);

  assert.ok(editorStart >= 0);
  assert.match(pageSource, /別の読み方を追加/);
  assert.match(pageSource, /台本内\$\{matchCount\}か所の読みを変更します/);
  assert.match(pageSource, /入力中はAPIを使いません/);
  assert.match(pageSource, /読み方を反映してAI音声を作り直す（1回使用）/);
  assert.doesNotMatch(editorFlow, /requestNarrationSpeech|regenerateNarration/);
  assert.match(
    globalCssSource,
    /\.pronunciationRow input\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*16px;/,
  );
  assert.match(
    globalCssSource,
    /\.pronunciationActions button,[\s\S]*?\.regenerateVoice\s*\{[\s\S]*?min-height:\s*48px;/,
  );
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

test("uses video length language and gives spoken videos independent output choices", () => {
  assert.doesNotMatch(pageSource, /AIナレーションの長さ/);
  assert.match(pageSource, />\s*動画の長さ\s*</);
  assert.match(pageSource, /元動画の長さ/);
  assert.match(pageSource, /音声に合わせてつなぎ直す/);
  assert.match(pageSource, /元動画の流れを保つ/);
  assert.match(pageSource, /spokenCaptionsEnabled/);
  assert.match(pageSource, /spokenAutoCutEnabled/);
  assert.match(
    pageSource,
    /const narrationPlanLength = narrationAutoCutEnabled \? length : 90/,
  );
});

test("keeps spoken caption and cut choices aligned across preview and export", () => {
  const editRangesStart = pageSource.indexOf("const editRanges = useMemo(");
  const editRangesEnd = pageSource.indexOf(
    "const previewRanges = useMemo(",
    editRangesStart,
  );
  const editRangesFlow = pageSource.slice(editRangesStart, editRangesEnd);
  const overlayStart = pageSource.indexOf("function drawCaptionOverlay(");
  const overlayEnd = pageSource.indexOf(
    "async function exportCaptionedVideo(",
    overlayStart,
  );
  const overlayFlow = pageSource.slice(overlayStart, overlayEnd);

  assert.match(editRangesFlow, /buildSpokenEditRanges\(/);
  assert.match(editRangesFlow, /spokenAutoCutEnabled/);
  assert.match(pageSource, /spokenAutoCutEnabled\s*\?\s*createNaturalEdit/);
  assert.match(pageSource, /const captionsVisible = narrationPlan[\s\S]*spokenCaptionsEnabled/);
  assert.match(overlayFlow, /if \(!captionsVisible\) return/);
  assert.match(pageSource, /spokenCaptionsEnabled,[\s\S]*spokenAutoCutEnabled/);
  assert.match(pageSource, /!narrationPlan && spokenAutoCutEnabled/);
});
