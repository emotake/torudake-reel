import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [clientSource, pageSource, cssSource, exporterSource] = await Promise.all([
  readFile(
    new URL("../app/video-mix/video-mix-client.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../app/video-mix/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../lib/video-mix-export.ts", import.meta.url), "utf8"),
]);

test("offers an ordered maximum-five-source editor with one or two clips", () => {
  assert.match(clientSource, /type="file"[\s\S]*?multiple/);
  assert.match(clientSource, /VIDEO_COMPOSITION_MAX_SOURCES/);
  assert.match(clientSource, /選んだ順が、そのまま完成動画の順番/);
  assert.match(clientSource, /途中で前の動画へ戻る編集や、逆再生は行いません/);
  assert.match(clientSource, /aria-pressed=\{source\.clips\.length === 1\}/);
  assert.match(clientSource, /aria-pressed=\{source\.clips\.length === 2\}/);
  assert.match(clientSource, /clips: source\.clips/);
  assert.match(clientSource, /if \(source\.clips\.length === count\) return source/);
  assert.doesNotMatch(clientSource, /draggable=|onDragStart=|\bmoveSource\b|reorderSource/);
});

test("keeps every default draft within the ninety-second output budget", () => {
  assert.match(
    clientSource,
    /VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS\s*\/\s*VIDEO_COMPOSITION_MAX_SOURCES/,
  );
  assert.match(clientSource, /createInitialClip\(source\.duration\)/);
  assert.match(clientSource, /createVideoCompositionPlan/);
  assert.match(clientSource, /完成動画は90秒以内にしてください/);
  assert.match(clientSource, /時間が前後したり重なったりしないようにしてください/);
});

test("offers eight no-cost transition styles shared with the exporter", () => {
  for (const id of [
    "crossfade",
    "cut",
    "fade-black",
    "fade-white",
    "flash",
    "wipe-left",
    "slide-left",
    "zoom-dissolve",
  ]) {
    assert.match(clientSource, new RegExp(`id: "${id}"`));
  }
  assert.match(clientSource, /つなぎ方の変更自体は無料です/);
  assert.match(clientSource, /音声の作り直しにはAI処理を1回使います/);
  assert.match(clientSource, /exportVideoMixMp4\(\{/);
  assert.match(clientSource, /transition,/);
  assert.match(clientSource, /boundaryTransitions: resolvedBoundaryTransitions/);
  assert.match(clientSource, /切り目ごとに変更/);
  assert.match(clientSource, /aria-label="切り目ごとのつなぎ方"/);
  assert.match(clientSource, /setBoundaryTransitionPreferences/);
  assert.match(
    clientSource,
    /setBoundaryTransitionPreferences\(\(currentPreferences\) =>\s*pruneVideoMixBoundaryTransitionPreferences\(next, currentPreferences\)/,
  );
  assert.match(clientSource, /動画とカットの順番は固定したまま/);
  assert.doesNotMatch(exporterSource, /openai|api\/transcribe|api\/narration/i);
});

test("adds an optional metered AI narration with locally aligned captions", () => {
  assert.match(clientSource, /AIナレーションを入れる/);
  assert.match(clientSource, /元音声のまま/);
  assert.match(clientSource, /narrationCaptionsEnabled/);
  assert.match(clientSource, /extractVideoMixNarrationFrames/);
  assert.match(clientSource, /prepareVideoMixNarration/);
  assert.match(clientSource, /\/api\/narration\/script/);
  assert.match(clientSource, /\/api\/narration\/speech/);
  assert.match(clientSource, /initialNarration:\s*true/);
  assert.match(clientSource, /narrationBundleToken/);
  assert.match(clientSource, /narrationAudio: narrationEnabled/);
  assert.match(clientSource, /normalizationGain: prepared\.normalizationGain/);
  assert.match(clientSource, /narrationNormalizationGain:/);
  assert.match(clientSource, /setPreviewNarrationGain\(narrationPlayer, narration\.normalizationGain\)/);
  assert.match(clientSource, /drawVideoMixNarrationCaption/);
  assert.match(clientSource, /AI処理 残り/);
  assert.match(clientSource, /NARRATION_DISCLOSURE_TEXT/);
  assert.match(clientSource, /\/api\/narration\/disclosure/);
});

test("reserves once for all sources and consumes one entitlement only after a verified export", () => {
  assert.match(
    clientSource,
    /reserveMixUsage\([\s\S]*?requestedDuration,[\s\S]*?idempotencyKey,[\s\S]*?signal/,
  );
  assert.match(clientSource, /ensureMixUsageReservation\(controller\.signal, true\)/);
  assert.match(clientSource, /canSaveCompletedVideo\(reservation\.bucket\)/);
  assert.match(
    clientSource,
    /exportVideoMixMp4\([\s\S]*?onPlan:[\s\S]*?exportedPlan = actualPlan[\s\S]*?inspectMixOutput\([\s\S]*?blob,[\s\S]*?exportedPlan,[\s\S]*?audioMetadata,[\s\S]*?completeReservationUsage\(reservationId, reservation\.bucket\)/,
  );
  assert.match(clientSource, /updateUsage\("release", reservationId\)/);
  assert.match(clientSource, /caught instanceof VideoMixRequestError && caught\.status === 402/);
  assert.match(clientSource, /完成動画1本分の利用枠を使用/);
});

test("makes cancellation, reservation release, checkout return, and repeated actions deterministic", () => {
  assert.match(clientSource, /const USAGE_RELEASE_RETRY_DELAYS_MS/);
  assert.match(clientSource, /releaseUsageWithRetry\(reservationId\)/);
  assert.match(
    clientSource,
    /const releaseActiveReservationForeground[\s\S]*?reservationReleasePromiseRef/,
  );
  assert.match(
    clientSource,
    /const releaseActiveReservationOnPageHide[\s\S]*?sendMixUsageReleaseBeacon/,
  );
  assert.match(
    clientSource,
    /pageHidingRef\.current = true;[\s\S]*?releaseActiveReservationOnPageHide\(\)/,
  );
  assert.match(
    clientSource,
    /if \(!pageHidingRef\.current\) \{[\s\S]*?releaseActiveReservationForeground\(\)/,
  );
  assert.match(clientSource, /window\.addEventListener\("pageshow"/);
  assert.match(clientSource, /window\.addEventListener\("focus"/);
  assert.match(clientSource, /document\.addEventListener\("visibilitychange"/);
  assert.match(clientSource, /synchronizeBillingAndQuota/);
  assert.match(clientSource, /narrationGeneratingRef\.current/);
  assert.match(clientSource, /exportRunningRef\.current/);
  assert.match(clientSource, /finalizeActionRef\.current/);
  assert.match(clientSource, /prepareVideoMixNarration\([\s\S]*?controller\.signal/);
  assert.match(clientSource, /recordMixNarrationDisclosure\(reservationId, controller\.signal\)/);
  assert.match(clientSource, /disabled=\{finalizingUsage\}/);
  assert.match(clientSource, /保存枠を確定中/);
  assert.match(clientSource, /invalidateGeneratedNarration/);
  assert.match(clientSource, /if \(added\.length > 0\) \{[\s\S]*?invalidateGeneratedNarration\(\)/);
  assert.match(clientSource, /setNarrationStale\(true\)/);
});

test("serializes usage leases and discards stale reservation responses", () => {
  assert.match(clientSource, /const reservationMutexRef = useRef<Promise<void>>/);
  assert.match(clientSource, /const withReservationLock = useCallback/);
  assert.match(clientSource, /const releaseActiveReservationLocked = useCallback/);
  assert.match(
    clientSource,
    /const ensureMixUsageReservation[\s\S]*?withReservationLock\(async \(\) =>/,
  );
  assert.match(
    clientSource,
    /sourceGenerationRef\.current !== requestGeneration[\s\S]*?releaseReturnedReservationLocked/,
  );
  assert.match(clientSource, /reservationDurationRef\.current \?\? currentDuration\(\)/);
  assert.ok(
    (clientSource.match(/sourceGenerationRef\.current \+= 1/g) ?? []).length >= 4,
  );
  assert.match(
    clientSource,
    /monthlyHasRoom[\s\S]*?videosUsed[\s\S]*?< Number\(billing\.monthly\.videoLimit\)/,
  );
  assert.match(clientSource, /const DEFAULT_AI_OPERATION_LIMIT = 3/);
});

test("detaches completion from pagehide and validates the actual export duration", () => {
  assert.match(
    clientSource,
    /const completeReservationUsage[\s\S]*?activeReservationRef\.current = null;[\s\S]*?withReservationLock\(async \(\) =>[\s\S]*?updateUsage\("complete", reservationId\)[\s\S]*?catch[\s\S]*?activeReservationRef\.current = reservationId/,
  );
  assert.match(clientSource, /let exportedPlan: VideoCompositionPlan \| null = null/);
  assert.match(clientSource, /onPlan: \(actualPlan\) => \{[\s\S]*?exportedPlan = actualPlan/);
  assert.match(clientSource, /if \(!exportedPlan\)/);
  assert.match(
    clientSource,
    /Math\.min\(plan\.duration, range\.start\)[\s\S]*?Math\.min\(plan\.duration, range\.end\)/,
  );
});

test("fails closed when source audio disappears from the encoded MP4", () => {
  assert.match(clientSource, /onAudioMetadata: \(metadata\) =>/);
  assert.match(clientSource, /audioMetadata\.requireAudio && !audioMetadata\.outputHasAudioTrack/);
  assert.match(clientSource, /source\.hasAudioTrack && source\.hasSelectedAudioSamples === false/);
  assert.match(clientSource, /inspectAudioActivity: audioMetadata\.inspectAudioActivity/);
  assert.match(clientSource, /requireAudio: audioMetadata\.requireAudio/);
  assert.match(clientSource, /requireCompatibleAudio: audioMetadata\.requireAudio/);
});

test("does not revoke source object URLs when the source state merely changes", () => {
  assert.match(clientSource, /const sourcesRef = useRef<MixSource\[\]>\(\[\]\)/);
  assert.match(clientSource, /sourcesRef\.current = sources/);
  assert.match(clientSource, /sourcesRef\.current\.forEach/);
  assert.doesNotMatch(
    clientSource,
    /useEffect\(\(\) => \(\) => \{[\s\S]*?sources\.forEach[\s\S]*?\}, \[sources/,
  );
});

test("keeps preview layers and paid reservations safe across transitions and navigation", () => {
  assert.match(clientSource, /stylePreviewLayer\(incoming, 2, 0\)/);
  assert.match(clientSource, /stylePreviewLayer\(outgoing, 0, 1\)/);
  assert.match(clientSource, /setPreviewMediaGain\(outgoing, 0\)/);
  assert.match(clientSource, /setPreviewMediaGain\([\s\S]*?active,/);
  assert.match(clientSource, /getVideoMixTransitionAudioGains\(plan, time\)/);
  assert.match(clientSource, /setPreviewMediaGain\([\s\S]*?active,[\s\S]*?incomingBaseGain \* \(transitionAudio\?\.incoming \?\? 1\)/);
  assert.match(clientSource, /setPreviewMediaGain\([\s\S]*?other,[\s\S]*?outgoingBaseGain \* \(transitionAudio\?\.outgoing \?\? 0\)/);
  assert.match(clientSource, /transitionFrame\.from\.sourceTime/);
  assert.match(clientSource, /other\.dataset\.sourceId !== outgoingSource\.id/);
  const previewConfigurationStart = clientSource.indexOf("const configurePreviewAt");
  const previewConfiguration = clientSource.slice(
    previewConfigurationStart,
    clientSource.indexOf("const startPreview =", previewConfigurationStart),
  );
  assert.doesNotMatch(previewConfiguration, /outgoing\.pause\(\)|other\.pause\(\)/);
  assert.doesNotMatch(previewConfiguration, /playPreviewMedia\(incoming\)|playPreviewMedia\(other\)/);
  assert.match(clientSource, /const attempts = \[primary\.play\(\), secondary\.play\(\)\]/);
  assert.match(clientSource, /setPreviewMediaGain\(primary, 0\)[\s\S]*?setPreviewMediaGain\(secondary, 0\)[\s\S]*?startPreviewMediaPair\(primary, secondary\)/);
  assert.match(clientSource, /activeClipRef\.current = startClip\.globalClipIndex/);
  assert.match(clientSource, /startFrame\?\.transition[\s\S]*?sources\[startFrame\.transition\.from\.sourceIndex\]/);
  assert.match(clientSource, /Loading a new URL may implicitly pause a pre-started layer/);
  assert.match(previewConfiguration, /setPreviewMediaGain\(incoming, 0\)[\s\S]*?incoming\.currentTime = targetTime/);
  assert.match(previewConfiguration, /resumePreviewMediaMuted\(incoming, sourcePreviewGain\)/);
  assert.match(previewConfiguration, /resumePreviewMediaMuted\(current, sourcePreviewGain\)/);
  assert.doesNotMatch(previewConfiguration, /incoming\.play\(\)|current\.play\(\)|other\.play\(\)/);
  const mediaGainGuard = clientSource.slice(
    clientSource.indexOf("const setPreviewMediaGain"),
    clientSource.indexOf("const setPreviewNarrationGain"),
  );
  assert.match(
    mediaGainGuard,
    /previewPendingPlayRef\.current\.has\(video\)[\s\S]*?previewDeferredGainRef\.current\.set\(video, safeGain\)[\s\S]*?node\.gain\.value = 0/,
  );
  assert.match(mediaGainGuard, /video\.muted = false/);
  assert.doesNotMatch(
    mediaGainGuard,
    /video\.muted = true|video\.muted = safeGain <= 0/,
  );
  const mutedResume = clientSource.slice(
    clientSource.indexOf("const resumePreviewMediaMuted"),
    clientSource.indexOf("const previewSourceGainAt"),
  );
  assert.match(
    mutedResume,
    /previewPendingPlayRef\.current\.add\(video\)[\s\S]*?setPreviewMediaGain\(video, desiredGain\)[\s\S]*?video\.play\(\)/,
  );
  const singleClipPreview = clientSource.slice(
    clientSource.indexOf("const previewSingleClip"),
    clientSource.indexOf("const setClipEdgeFromPreview"),
  );
  assert.match(
    singleClipPreview,
    /stopPreview\(\);[\s\S]*?startPreview\(\{ start: clip\.editedStart, end: clip\.editedEnd \}\)/,
  );
  assert.doesNotMatch(singleClipPreview, /requestAnimationFrame\s*\(/);
  assert.match(clientSource, /window\.addEventListener\("pagehide"/);
  assert.match(clientSource, /sendMixUsageReleaseBeacon/);
  assert.match(clientSource, /activeReservationRef\.current = reservationId/);
  assert.match(clientSource, /preparing \|\| exporting \|\| narrationGenerating \|\| discardingPending \|\| Boolean\(pendingFinalize\)/);
  assert.match(clientSource, /ensureMixExportActive\(controller\.signal, mountedRef\.current\)/);
  assert.match(clientSource, /pendingFinalizeRef\.current = stagedPending/);
  assert.match(clientSource, /activeReservationRef\.current = null;[\s\S]*?updateUsage\("complete", reservationId\)/);
  assert.match(clientSource, /プレビューと書き出しへ同じ調整を反映します/);
  assert.match(clientSource, /previewPrimaryBlurRef/);
  assert.match(clientSource, /previewSecondaryBlurRef/);
  assert.match(clientSource, /previewPrimaryLayerRef/);
  assert.match(clientSource, /previewSecondaryLayerRef/);
  assert.match(clientSource, /computeVideoMixFrameLayout/);
  const layerStyling = clientSource.slice(
    clientSource.indexOf("const stylePreviewLayer"),
    clientSource.indexOf("const updatePreviewLayerBackground"),
  );
  assert.match(layerStyling, /wrapper\.style\.opacity = String\(opacity\)/);
  assert.doesNotMatch(layerStyling, /video\.style\.opacity|background\.style\.opacity/);
  assert.match(clientSource, /frameLayout\.framing\.mode === "cover"[\s\S]*?: "center"/);
  assert.match(cssSource, /\.videoMixPhone video\s*\{[^}]*object-fit:\s*contain/);
  assert.doesNotMatch(cssSource, /\.videoMixPhone video\s*\{[^}]*object-fit:\s*cover/);
});

test("ships accessible mobile controls and route metadata", () => {
  assert.match(pageSource, /path: "\/video-mix"/);
  assert.match(pageSource, /各動画から1〜2カット/);
  assert.match(clientSource, /role="radiogroup"/);
  assert.match(clientSource, /role="radio"/);
  assert.match(clientSource, /aria-label="すべての切り目のつなぎ方"/);
  assert.match(clientSource, /tabIndex=\{transition === option\.id \? 0 : -1\}/);
  assert.match(clientSource, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/);
  assert.match(clientSource, /event\.key === "Home"/);
  assert.match(clientSource, /event\.key === "End"/);
  assert.match(clientSource, /aria-live="polite"/);
  assert.match(clientSource, /role="alert"/);
  assert.match(
    cssSource,
    /\.videoMixShell[\s\S]*?:is\(button, a, input, select, textarea, summary\):focus-visible[\s\S]*?outline:/,
  );
  assert.match(
    cssSource,
    /\.videoMixShell button,[\s\S]*?min-height:\s*44px/,
  );
  assert.match(
    cssSource,
    /\.videoMixFooter a\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*font-size:\s*13px/,
  );
  assert.match(cssSource, /@media \(max-width: 620px\)[\s\S]*?\.videoMixTransitionGrid/);
  assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.videoMixShell/);
});

test("keeps local editing recoverable and reports errors next to upload", () => {
  assert.match(clientSource, /readVideoMixClientDraft/);
  assert.match(clientSource, /findVideoMixDraftSource/);
  assert.match(clientSource, /saveVideoMixClientDraft/);
  assert.match(clientSource, /window\.addEventListener\("beforeunload"/);
  assert.match(clientSource, /videoMixSourceFeedback/);
  assert.match(clientSource, /sourceFeedbackRef\.current\?\.focus/);
  assert.match(clientSource, /undoRemoveSource/);
});

test("retains stale narration, durable output, framing, and mobile steps", () => {
  assert.match(clientSource, /setNarrationStale\(true\)/);
  assert.match(clientSource, /ひとつ前の音声へ戻す/);
  assert.match(clientSource, /saveDurableVideoMixOutput/);
  assert.match(clientSource, /markDurableVideoMixOutputCompleted/);
  assert.match(clientSource, /listDurableVideoMixOutputRecoveryCandidates/);
  assert.match(clientSource, /loadDurableVideoMixOutput\(metadata\.id\)/);
  assert.match(clientSource, /framing: source\.framing/);
  assert.match(clientSource, /縦画面への収め方/);
  assert.match(clientSource, /data-mobile-step/);
  assert.match(clientSource, /ほかの5種類も見る/);
  assert.match(clientSource, /主役の縦位置/);
  assert.match(clientSource, /videoMixBlurCanvas/);
  assert.match(clientSource, /width=\{540\} height=\{960\}/);
  assert.match(clientSource, /measureVideoMixSourceAudioNormalization\([\s\S]*?source\.file,[\s\S]*?source\.clips,[\s\S]*?controller\.signal/);
  assert.match(clientSource, /audioNormalizationCacheRef\.current\.get\(source\.key\)/);
  assert.match(clientSource, /window\.setTimeout\([\s\S]*?180/);
  assert.match(clientSource, /audioNormalizationGain: previewSourceNormalizationGain\(source\)/);
  assert.match(clientSource, /createMediaElementSource\(primary\)/);
  assert.match(clientSource, /source\.audioNormalizationGain/);
});

test("exposes fine cut controls and accessible playback progress", () => {
  assert.match(clientSource, /videoMixFilmstrip/);
  assert.match(clientSource, /extractVideoFilmstrip/);
  assert.match(clientSource, /window\.setTimeout[\s\S]*?5_000/);
  assert.match(clientSource, /window\.clearTimeout\(timeoutId\)/);
  assert.match(clientSource, /video\.removeAttribute\("src"\)/);
  assert.match(clientSource, /source\.thumbnails\.map/);
  assert.match(clientSource, /このカットを繰り返し再生/);
  assert.match(clientSource, /停止位置を開始に/);
  assert.match(clientSource, /type="number"/);
  assert.match(clientSource, /aria-valuetext/);
  assert.match(clientSource, /role="progressbar"/);
  assert.match(clientSource, /tabIndex=\{-1\}[\s\S]*?aria-hidden="true"/);
});

test("reserves only after an explicit AI or export action and renews before export", () => {
  const synchronization = clientSource.slice(
    clientSource.indexOf("const synchronizeBillingAndQuota"),
    clientSource.indexOf("const completeReservationUsage"),
  );
  assert.doesNotMatch(synchronization, /reserveMixUsage\(|renewMixUsage\(/);
  assert.match(synchronization, /readMixBillingStatus\(\)/);
  assert.match(clientSource, /ensureMixUsageReservation\(controller\.signal, true\)/);
  assert.match(
    clientSource,
    /activeReservationBucketRef\.current === "free"[\s\S]*?SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT[\s\S]*?ONE_TIME_AI_OPERATION_SUCCESS_LIMIT[\s\S]*?rememberAiQuota\(paidLimit, paidLimit\)/,
  );
  assert.match(clientSource, /fetch\("\/api\/usage\/renew"/);
  assert.match(clientSource, /status === "completed"/);
  assert.match(clientSource, /sendMixUsageReleaseBeacon\(reservationId, reservationKeyRef\.current\)/);
});

test("keeps a durable download until sharing succeeds or the seven-day TTL expires", () => {
  const saveResult = clientSource.slice(
    clientSource.indexOf("const saveResult"),
    clientSource.indexOf("return (", clientSource.indexOf("const saveResult")),
  );
  const anchorDownload = saveResult.slice(saveResult.indexOf("document.createElement"));
  assert.doesNotMatch(
    anchorDownload.slice(0, anchorDownload.indexOf("const deleteResultDurableCopy")),
    /deleteDurableVideoMixOutput/,
  );
  assert.match(saveResult, /await navigator\.share/);
  assert.match(clientSource, /7日以内に自動削除/);
  assert.match(clientSource, /const deleteResultDurableCopy/);
  assert.match(clientSource, /端末内の一時コピーを削除/);
  assert.match(clientSource, /durableId: undefined/);
});

test("binds recovered durable output to the current account before creating a Blob URL", () => {
  assert.match(clientSource, /async function verifyDurableVideoMixOutputOwnership/);
  assert.match(clientSource, /fetch\("\/api\/usage\/status"/);
  assert.match(
    clientSource,
    /listDurableVideoMixOutputRecoveryCandidates\(\)[\s\S]*?for \(const metadata of candidates\)[\s\S]*?verifyDurableVideoMixOutputOwnership\([\s\S]*?metadata\.reservationId[\s\S]*?if \(!owned\) continue[\s\S]*?loadDurableVideoMixOutput\(metadata\.id\)[\s\S]*?URL\.createObjectURL\(saved\.blob\)/,
  );
});

test("renews a recovered completion without falling back to a free save", () => {
  const retry = clientSource.slice(
    clientSource.indexOf("const retryFinalize"),
    clientSource.indexOf("const discardPending"),
  );
  assert.match(retry, /renewMixUsage\(/);
  assert.match(retry, /refreshed\.status !== "completed"/);
  assert.match(retry, /!canSaveCompletedVideo\(refreshed\.bucket\)/);
  assert.match(retry, /setShowPurchase\(true\)/);
  assert.match(retry, /pendingResult = \{ \.\.\.pendingResult, bucket: refreshed\.bucket \}/);
  assert.match(retry, /completeReservationUsage\([\s\S]*?refreshed\.bucket/);
});

test("releases a committed reservation by key when its reserve response was lost", () => {
  assert.match(clientSource, /function sendMixUsageReleaseBeacon\([\s\S]*?reservationId: string \| null/);
  assert.match(
    clientSource,
    /const releaseActiveReservationOnPageHide[\s\S]*?sendMixUsageReleaseBeacon\(reservationId, reservationKeyRef\.current\)/,
  );
});

test("marks generated narration stale when a transition changes the edited duration", () => {
  assert.match(
    clientSource,
    /const selectGlobalTransition[\s\S]*?clearResult\(\);[\s\S]*?invalidateGeneratedNarration\(\);[\s\S]*?setTransition/,
  );
  assert.match(
    clientSource,
    /onChange=\{\(event\) => \{[\s\S]*?clearResult\(\);[\s\S]*?invalidateGeneratedNarration\(\);[\s\S]*?setBoundaryTransitionPreferences/,
  );
});
