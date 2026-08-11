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

test("keeps preview and recorder fallback aligned with local loudness and ducking", () => {
  const start = pageSource.indexOf("function ResultWorkspace(");
  const end = pageSource.indexOf("\n  return (", start);
  const workspaceFlow = pageSource.slice(start, end);
  const exportStart = workspaceFlow.indexOf("async function exportCaptionedVideo(");
  const exportFlow = workspaceFlow.slice(exportStart);

  assert.match(workspaceFlow, /measurePortableOriginalAudioNormalization\(/);
  assert.match(workspaceFlow, /detectPortableNarrationActivity\(/);
  assert.match(workspaceFlow, /remapPortableNarrationActivity\(/);
  assert.match(workspaceFlow, /buildPortableDuckingEnvelope\(/);
  assert.match(workspaceFlow, /schedulePreviewOriginalDucking\(/);
  assert.match(
    exportFlow,
    /getNarrationMixLevels\(narrationOriginalAudio\)\.original[\s\S]*originalAudioNormalizationGain/,
  );
  assert.match(exportFlow, /activeExportNarrationSliceGain/);
  assert.match(exportFlow, /PORTABLE_AUDIO_CUT_FADE_SECONDS/);
  assert.match(exportFlow, /PORTABLE_VIDEO_CROSSFADE_SECONDS/);
  assert.match(exportFlow, /fallbackCrossfadeFrame/);
  assert.match(exportFlow, /scheduleGainEnvelope\(/);
});

test("normalizes spoken preview audio and softens manual cut boundaries", () => {
  const start = pageSource.indexOf("async function playPreviewFromEditedTime(");
  const end = pageSource.indexOf("\n  function seekTo(", start);
  const previewFlow = pageSource.slice(start, end);
  const transitionStart = pageSource.indexOf(
    "async function crossfadePreviewToSourceTime(",
  );
  const transitionEnd = pageSource.indexOf(
    "\n  async function moveToNextKeptRange(",
    transitionStart,
  );
  const transitionFlow = pageSource.slice(transitionStart, transitionEnd);

  assert.match(
    pageSource,
    /return narrationPlan[\s\S]*originalAudioNormalizationGain/,
  );
  assert.match(
    previewFlow,
    /narrationPlan[\s\S]*ensurePreviewNarrationEngine\(true\)[\s\S]*ensureVideoAudioEngine\(true\)/,
  );
  assert.match(previewFlow, /resetPreviewOriginalGain\(engine\)/);
  assert.match(transitionFlow, /PORTABLE_VIDEO_CROSSFADE_SECONDS/);
  assert.match(transitionFlow, /gain\.linearRampToValueAtTime\(0/);
  assert.match(transitionFlow, /seekVideoBeforePlayback\(video, targetTime\)/);
  assert.match(transitionFlow, /getPreviewOriginalBaseGain\(\)/);
});

test("preflights long iPhone exports before starting either encoder", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const setupEnd = pageSource.indexOf("isExportingRef.current = true", start);
  const preflightFlow = pageSource.slice(start, setupEnd);

  assert.match(preflightFlow, /getPortableExportMemoryPreflight\(/);
  assert.match(preflightFlow, /if \(!memoryPreflight\.ok\)/);
  assert.match(preflightFlow, /PC版Chrome/);
});

test("makes the narration disclosure dialog keyboard-safe", () => {
  assert.match(pageSource, /aria-describedby="disclosure-description"/);
  assert.match(pageSource, /ref=\{disclosureDialogRef\}/);
  assert.match(pageSource, /tabIndex=\{-1\}/);
  assert.match(pageSource, /event\.key === "Escape"/);
  assert.match(pageSource, /event\.key !== "Tab"/);
  assert.match(pageSource, /disclosurePreviousFocusRef/);
  assert.match(pageSource, /previous\?\.focus\(\)/);
});

test("keeps free users in editing and preview while paid buckets can export", () => {
  const exportStart = pageSource.indexOf("async function exportCaptionedVideo(");
  const exportEnd = pageSource.indexOf("\n  function requestVideoExport()", exportStart);
  const exportFlow = pageSource.slice(exportStart, exportEnd);
  const saveStart = pageSource.indexOf("async function saveExportedVideo()");
  const saveEnd = pageSource.indexOf("\n  function requestVideoExport()", saveStart);
  const saveFlow = pageSource.slice(saveStart, saveEnd);
  const requestStart = pageSource.indexOf("function requestVideoExport()");
  const requestEnd = pageSource.indexOf("\n  async function confirmNarrationExport()", requestStart);
  const requestFlow = pageSource.slice(requestStart, requestEnd);
  const confirmationStart = pageSource.indexOf("async function confirmNarrationExport()");
  const confirmationEnd = pageSource.indexOf("\n  return (", confirmationStart);
  const confirmationFlow = pageSource.slice(confirmationStart, confirmationEnd);

  assert.match(pageSource, /isBillingBucket\(payload\.bucket\)/);
  assert.match(pageSource, /reservationId:[\s\S]*?bucket,[\s\S]*?aiOperationLimit/);
  assert.match(pageSource, /rememberUsageReservation\(newlyReservedUsage, reservation\.bucket\)/);
  assert.match(pageSource, /canSaveCompletedVideo\(usageBucket\)/);
  assert.match(exportFlow, /if \(!completedVideoSaveAllowed\)/);
  assert.match(saveFlow, /if \(!completedVideoSaveAllowed\)/);
  assert.match(requestFlow, /if \(!completedVideoSaveAllowed\)/);
  assert.match(confirmationFlow, /if \(!completedVideoSaveAllowed\)/);
  assert.match(pageSource, /完成動画を保存するにはプランを選択/);
  assert.match(pageSource, /月\$\{STANDARD_MONTHLY_VIDEO_LIMIT\}本・¥/);
  assert.match(pageSource, /月\$\{STARTER_MONTHLY_VIDEO_LIMIT\}本・¥/);
  assert.doesNotMatch(pageSource, /月3本・月8本・1動画作成/);
  assert.match(pageSource, /1動画作成・¥/);
  assert.match(pageSource, /編集・プレビューまで/);
  assert.match(pageSource, /完成動画の保存は有料/);
  assert.match(pageSource, /target="_blank"/);
  assert.match(pageSource, /購入済みの方：保存を有効にする/);
  assert.match(pageSource, /usageReservationPendingExport/);
  assert.match(pageSource, /completePendingExportReservation\(\)/);
});

test("charges a paid video only after a validated export and releases abandoned unlocks", () => {
  assert.doesNotMatch(
    pageSource,
    /updateVideoUsage\(\s*"complete",\s*newlyReservedUsage/,
  );
  assert.match(
    pageSource,
    /newlyReservedUsage &&[\s\S]*usageReservationPendingExportRef\.current = true/,
  );
  assert.match(pageSource, /if \(!usageReservationPendingExport\) return/);
  assert.match(pageSource, /await updateVideoUsage\("complete", usageReservationId\)/);
  assert.match(pageSource, /window\.addEventListener\("pagehide"/);
  assert.match(pageSource, /if \(event\.persisted\) return/);
  assert.match(pageSource, /navigator\.sendBeacon\(/);
});

test("consumes a free preview after processing while keeping paid usage reversible until export", () => {
  const start = pageSource.indexOf(
    "async function settleVideoUsageAfterProcessing(",
  );
  const end = pageSource.indexOf(
    "\n  function releasePendingExportReservation(",
    start,
  );
  const settleFlow = pageSource.slice(start, end);

  assert.match(settleFlow, /bucket === "free"/);
  assert.match(settleFlow, /updateVideoUsage\("complete", reservationId\)/);
  assert.match(
    settleFlow,
    /usageReservationPendingExportRef\.current = false/,
  );
  assert.match(settleFlow, /usageReservationPendingExportRef\.current = true/);
  assert.match(
    pageSource,
    /await settleVideoUsageAfterProcessing\(\s*newlyReservedUsage,\s*newlyReservedBucket/,
  );
});

test("discards a paid export reservation if the edited video changes", () => {
  const start = pageSource.indexOf("async function checkPaidExportAccess()");
  const end = pageSource.indexOf("\n  async function startCheckout", start);
  const accessFlow = pageSource.slice(start, end);

  assert.match(accessFlow, /const accessGeneration = editGenerationRef\.current/);
  assert.match(accessFlow, /const accessFile = file/);
  assert.match(accessFlow, /reserveVideoUsage\(accessFile\)/);
  assert.match(
    accessFlow,
    /editGenerationRef\.current !== accessGeneration[\s\S]*releaseVideoUsageBestEffort\(reservation\.reservationId\)/,
  );
});

test("keeps both export paths at the same high-quality bitrate", () => {
  const start = pageSource.indexOf("const preferredMimeTypes = [");
  const end = pageSource.indexOf("const activeRecorder = recorder;", start);
  const recorderSetup = pageSource.slice(start, end);

  assert.ok(start >= 0);
  assert.match(recorderSetup, /const recorderOptions: MediaRecorderOptions/);
  assert.match(
    recorderSetup,
    /videoBitsPerSecond:\s*HIGH_QUALITY_VIDEO_BITRATE/,
  );
  assert.match(
    recorderSetup,
    /new MediaRecorder\(liveOutputStream, recorderOptions\)/,
  );
  assert.doesNotMatch(recorderSetup, /:\s*undefined/);
  assert.match(pageSource, /imageSmoothingQuality\s*=\s*"high"/);
  assert.match(pageSource, /computePortableVideoDimensions/);
  assert.match(pageSource, /computePortableVideoDrawRect/);
  assert.match(pageSource, /getContext\("2d", \{ alpha: false \}\)/);
  assert.match(pageSource, /avc1\.640028/);
});

test("inspects the completed file from both export paths before offering it", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const end = pageSource.indexOf("\n  function requestVideoExport()", start);
  const exportFlow = pageSource.slice(start, end);
  const qualityChecks =
    exportFlow.match(/inspectCompletedVideoQuality\(/g) ?? [];

  assert.equal(qualityChecks.length, 2);
  assert.match(exportFlow, /sourceExportDimensions/);
  assert.match(exportFlow, /expectedExportDimensions/);
  assert.match(
    exportFlow,
    /inspectCompletedVideoQuality\(\s*output,\s*sourceExportDimensions,\s*expectedExportDimensions/,
  );
  assert.match(exportFlow, /if \(!portableQuality\.accepted\)/);
  assert.match(exportFlow, /if \(!fallbackQuality\.accepted\)/);
  assert.match(exportFlow, /expectedDurationSeconds: editedDurationSeconds/);
  assert.match(exportFlow, /expectedNarrationRanges/);
  assert.match(exportFlow, /captionRanges/);
  assert.match(exportFlow, /setExportedVideoQualityMessage/);
  assert.match(pageSource, /exportedVideoQualityMessage \?\?/);
});

test("shows source, planned, and measured output resolutions without misattributing quality", () => {
  const metadataStart = pageSource.indexOf("onLoadedMetadata={(event) => {");
  const metadataEnd = pageSource.indexOf("onTimeUpdate=", metadataStart);
  const metadataFlow = pageSource.slice(metadataStart, metadataEnd);

  assert.ok(metadataStart >= 0);
  assert.match(pageSource, /sourceVideoDimensions/);
  assert.match(metadataFlow, /event\.currentTarget\.videoWidth/);
  assert.match(metadataFlow, /event\.currentTarget\.videoHeight/);
  assert.match(metadataFlow, /setSourceVideoDimensions/);
  assert.match(pageSource, /元動画：/);
  assert.match(pageSource, /書き出し予定：/);
  assert.match(pageSource, /完成動画（実測）：/);
  assert.match(pageSource, /映像の細かさは元動画の解像度に準じます/);
  assert.match(globalCssSource, /\.exportResolutionStatus/);
});

test("prefers an iPhone-compatible MP4 and keeps a user-triggered save action", () => {
  const start = pageSource.indexOf("const preferredMimeTypes = [");
  const end = pageSource.indexOf("];", start);
  const mimeCandidates = pageSource.slice(start, end);
  const explicitMp4Candidates =
    mimeCandidates.match(/"video\/mp4;codecs=[^"]+"/g) ?? [];

  assert.match(
    pageSource,
    /video\/mp4;codecs=avc1\.42E028,mp4a\.40\.2/,
  );
  assert.match(pageSource, /video\/mp4;codecs=avc1\.4D4028/);
  assert.match(pageSource, /"video\/mp4"/);
  assert.match(pageSource, /video\/webm;codecs=vp9,opus/);
  assert.match(pageSource, /video\/webm;codecs=vp8,opus/);
  assert.doesNotMatch(pageSource, /avc1\.42E01E/);
  assert.ok(explicitMp4Candidates.length >= 3);
  assert.ok(
    explicitMp4Candidates.every((candidate) => candidate.includes("mp4a.40.2")),
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
  assert.match(pageSource, /テロップに表示されている言葉/);
  assert.match(pageSource, /AI音声での読み（ひらがな）/);
  assert.match(pageSource, /テロップの漢字は変わりません/);
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
  assert.match(pageSource, /読み方はそのままでOK/);
  assert.match(pageSource, /選択した言葉を追加/);
  assert.match(pageSource, /別の言葉も修正する/);
  assert.match(pageSource, /テロップ「\$\{row\.surface\.trim\(\)\}」／音声/);
  assert.match(pageSource, /ここへ入力するだけではAI処理の残り回数は減りません/);
  assert.match(pageSource, /変更内容をAI音声に反映（AI処理1回）/);
  assert.match(editorFlow, /addSelectedNarrationPronunciationTerm/);
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

test("keeps a partial intonation correction on the original voice profile", () => {
  const correctionStart = pageSource.indexOf(
    "async function regenerateNarrationSegment(",
  );
  const correctionEnd = pageSource.indexOf(
    "\n  async function updateNarrationCutMode",
    correctionStart,
  );
  const correctionFlow = pageSource.slice(correctionStart, correctionEnd);

  assert.ok(correctionStart >= 0);
  assert.match(
    correctionFlow,
    /narrationAudioModel !== PARTIAL_NARRATION_MODEL/,
  );
  assert.match(correctionFlow, /!narrationAudioVoice/);
  assert.match(correctionFlow, /!narrationAudioProfile/);
  assert.match(
    correctionFlow,
    /speechResult\.voice !== narrationAudioVoice/,
  );
  assert.match(
    correctionFlow,
    /speechResult\.profile !== narrationAudioProfile/,
  );
  assert.match(correctionFlow, /model: speechResult\.model/);
  assert.match(correctionFlow, /voice: speechResult\.voice/);
  assert.match(correctionFlow, /profile: speechResult\.profile/);
  assert.match(correctionFlow, /setNarrationAudioProfile\(correction\.profile\)/);
});

test("stops both correction comparison audios before switching playback or clearing a candidate", () => {
  const stopStart = pageSource.indexOf(
    "function stopNarrationCorrectionComparisonAudio(",
  );
  const stopEnd = pageSource.indexOf(
    "\n  function clearNarrationCorrectionCandidate()",
    stopStart,
  );
  const stopFlow = pageSource.slice(stopStart, stopEnd);
  const clearEnd = pageSource.indexOf(
    "\n  const [isGeneratingNarrationCorrection",
    stopEnd,
  );
  const clearFlow = pageSource.slice(stopEnd, clearEnd);

  assert.ok(stopStart >= 0);
  assert.match(stopFlow, /narrationCorrectionAudioRefs\.current\.forEach/);
  assert.match(stopFlow, /audio === except/);
  assert.match(stopFlow, /audio\.pause\(\)/);
  assert.match(stopFlow, /audio\.currentTime = 0/);
  assert.match(
    clearFlow,
    /stopNarrationCorrectionComparisonAudio\(\)[\s\S]*?setNarrationCorrectionCandidate\(null\)/,
  );
  assert.equal(
    pageSource.match(/setNarrationCorrectionCandidate\(null\)/g)?.length,
    1,
  );

  const toggleStart = pageSource.indexOf("async function togglePlayback()");
  const toggleEnd = pageSource.indexOf(
    "\n  function downloadText",
    toggleStart,
  );
  const toggleFlow = pageSource.slice(toggleStart, toggleEnd);
  assert.ok(
    toggleFlow.indexOf("stopNarrationCorrectionComparisonAudio()") <
      toggleFlow.indexOf("playPreviewFromEditedTime("),
  );

  const sampleStart = pageSource.indexOf("ref={narrationSampleAudioRef}");
  const sampleEnd = pageSource.indexOf(
    '<p className="naturalNarrationNote">',
    sampleStart,
  );
  const sampleFlow = pageSource.slice(sampleStart, sampleEnd);
  assert.match(
    sampleFlow,
    /onPlay=\{\(event\) => \{[\s\S]*?stopNarrationCorrectionComparisonAudio\(\)/,
  );

  const generationStart = pageSource.indexOf(
    "async function handleNarrationCorrectionGeneration()",
  );
  const generationEnd = pageSource.indexOf(
    "\n  function handleNarrationCorrectionApply()",
    generationStart,
  );
  const generationFlow = pageSource.slice(generationStart, generationEnd);
  assert.ok(
    generationFlow.indexOf("clearNarrationCorrectionCandidate()") <
      generationFlow.indexOf("regenerateNarrationSegment("),
  );

  const applyEnd = pageSource.indexOf(
    "\n  async function handleNarrationCutModeChange",
    generationEnd,
  );
  const applyFlow = pageSource.slice(generationEnd, applyEnd);
  assert.ok(
    applyFlow.indexOf("stopNarrationCorrectionComparisonAudio()") <
      applyFlow.indexOf("applyNarrationSegmentCorrection("),
  );
  assert.match(
    pageSource,
    /narrationCorrectionAudioRefs\.current\[0\] = audio[\s\S]*?narrationCorrectionAudioRefs\.current\[1\] = audio/,
  );
  assert.equal(
    pageSource.match(
      /stopNarrationCorrectionComparisonAudio\(\s*event\.currentTarget,?\s*\)/g,
    )?.length,
    2,
  );
  assert.match(
    pageSource,
    /onClick=\{clearNarrationCorrectionCandidate\}[\s\S]*?採用せず閉じる/,
  );
});

test("uses one initial narration action while charging each manual voice regeneration once", () => {
  const initialStart = pageSource.indexOf(
    "async function startNarrationEditing()",
  );
  const initialEnd = pageSource.indexOf(
    "\n  async function regenerateNarration(",
    initialStart,
  );
  const initialFlow = pageSource.slice(initialStart, initialEnd);
  const regenerationEnd = pageSource.indexOf(
    "\n  async function updateNarrationCutMode",
    initialEnd,
  );
  const regenerationFlow = pageSource.slice(initialEnd, regenerationEnd);

  assert.ok(initialStart >= 0);
  assert.match(
    initialFlow,
    /const initialNarrationOperationId = crypto\.randomUUID\(\)/,
  );
  assert.doesNotMatch(initialFlow, /scriptOperationId|speechOperationId/);
  assert.match(
    initialFlow,
    /requestNarrationPlan\(\{[\s\S]*?aiOperationId: initialNarrationOperationId,[\s\S]*?initialNarration: true/,
  );
  assert.match(
    initialFlow,
    /requestNarrationSpeech\([\s\S]*?initialNarrationOperationId,[\s\S]*?true,[\s\S]*?nextPlan\.narrationBundleToken/,
  );
  assert.match(
    initialFlow,
    /previousScript: nextPlan\.script,[\s\S]*?aiOperationId: initialNarrationOperationId,[\s\S]*?narrationBundleToken: nextPlan\.narrationBundleToken/,
  );

  assert.match(
    regenerationFlow,
    /requestNarrationSpeech\([\s\S]*?crypto\.randomUUID\(\)/,
  );
  assert.doesNotMatch(
    regenerationFlow,
    /initialNarration:\s*true|narrationBundleToken/,
  );
  assert.match(regenerationFlow, /recordAiOperationResult\(speechResult\)/);
  assert.match(
    pageSource,
    /初回のAI台本とAI音声は、まとめてAI処理を1回使用します/,
  );
  assert.match(
    pageSource,
    /初回のAI台本とAI音声はまとめて1回です。作成後のAI音声の作り直し/,
  );
  assert.match(pageSource, /変更内容をAI音声に反映（AI処理1回）/);
});

test("shows and enforces the shared server-backed AI processing allowance", () => {
  const regenerationStart = pageSource.indexOf(
    "async function regenerateNarration(",
  );
  const regenerationEnd = pageSource.indexOf(
    "\n  async function updateNarrationCutMode",
    regenerationStart,
  );
  const regenerationFlow = pageSource.slice(regenerationStart, regenerationEnd);

  assert.match(pageSource, /X-AI-Operation-Limit/);
  assert.match(pageSource, /X-AI-Operations-Remaining/);
  assert.match(pageSource, /aiOperationLimitRef/);
  assert.match(pageSource, /narrationGenerationLimit=\{aiOperationLimit\}/);
  assert.match(
    pageSource,
    /function describeAiOperationQuota/,
  );
  assert.match(pageSource, /case "free"/);
  assert.match(pageSource, /case "subscription"/);
  assert.match(pageSource, /case "one_time"/);
  assert.match(pageSource, /case "operator"/);
  assert.match(pageSource, /サンプルではAI処理の利用回数を消費しません/);
  assert.match(
    pageSource,
    /describeAiOperationQuota\(\s*usageBucket,\s*narrationGenerationLimit/,
  );
  assert.match(pageSource, /AI処理の利用回数/);
  assert.match(pageSource, /失敗・内部の分割処理・自動尺調整では追加消費しません/);
  assert.match(pageSource, /高精度で再生成（AI処理1回）/);
  assert.match(pageSource, /変更は反映済み/);
  assert.match(regenerationFlow, /narrationRegenerationAbortRef\.current/);
  assert.match(regenerationFlow, /controller\.signal/);
  assert.match(regenerationFlow, /recordAiOperationResult\(speechResult\)/);
});

test("uses video length language and gives spoken videos independent output choices", () => {
  assert.doesNotMatch(pageSource, /AIナレーションの長さ/);
  assert.match(pageSource, />\s*動画の長さ\s*</);
  assert.match(pageSource, /元動画の長さ/);
  assert.match(pageSource, /おまかせ編集/);
  assert.match(pageSource, /自分で選んでカット/);
  assert.match(pageSource, /カットしない/);
  assert.match(pageSource, /spokenCaptionsEnabled/);
  assert.match(pageSource, /useState<SpokenCutMode>\("auto"\)/);
  assert.match(pageSource, /setSpokenCutMode\("auto"\)/);
  assert.match(pageSource, /setSpokenCutMode\("manual"\)/);
  assert.match(pageSource, /setSpokenCutMode\("none"\)/);
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
  assert.match(editRangesFlow, /spokenCutMode/);
  assert.match(pageSource, /spokenCutMode === "auto"[\s\S]*createNaturalEdit/);
  assert.match(pageSource, /const captionsVisible = narrationPlan[\s\S]*spokenCaptionsEnabled/);
  assert.match(overlayFlow, /if \(!captionsVisible\) return/);
  assert.match(pageSource, /spokenCaptionsEnabled,[\s\S]*spokenCutMode/);
  assert.match(pageSource, /!narrationPlan && spokenCutMode !== "none"/);
  assert.match(pageSource, /spokenCutMode === "manual"[\s\S]*目安 \{length\}秒/);
  assert.match(
    pageSource,
    /audioMode === "spoken" && spokenCutMode === "manual"[\s\S]*`目安\$\{length\}秒`/,
  );
  assert.doesNotMatch(pageSource, /spokenAutoCutEnabled/);
});

test("renders the Vlog simple caption consistently in preview and video export", () => {
  const overlayStart = pageSource.indexOf("function drawCaptionOverlay(");
  const overlayEnd = pageSource.indexOf(
    "async function exportCaptionedVideo(",
    overlayStart,
  );
  const overlayFlow = pageSource.slice(overlayStart, overlayEnd);

  assert.match(overlayFlow, /tone === "vlog"/);
  assert.match(overlayFlow, /canvas\.height \* 0\.43/);
  assert.match(globalCssSource, /\.resultCaption\.vlog\s*\{/);
  assert.match(globalCssSource, /\.captionStyleSample\.vlog\s*\{/);
});
