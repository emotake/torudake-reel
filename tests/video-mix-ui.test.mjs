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
  assert.match(clientSource, /何度変えても追加料金やAI処理回数は発生しません/);
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
  assert.match(clientSource, /ensureMixUsageReservation\(controller\.signal\)/);
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
  assert.match(clientSource, /if \(added\.length > 0\) \{[\s\S]*?clearNarrationDraft\(\)/);
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
  assert.match(clientSource, /incoming\.style\.zIndex = "2"/);
  assert.match(clientSource, /outgoing\.style\.zIndex = "1"/);
  assert.match(clientSource, /outgoing\.pause\(\)/);
  assert.match(clientSource, /outgoing\.muted = true/);
  assert.match(clientSource, /active\.muted = false/);
  assert.match(clientSource, /other\.muted = true/);
  assert.match(clientSource, /transitionFrame\.from\.sourceTime/);
  assert.match(clientSource, /other\.dataset\.sourceId !== outgoingSource\.id/);
  assert.match(clientSource, /window\.addEventListener\("pagehide"/);
  assert.match(clientSource, /sendMixUsageReleaseBeacon/);
  assert.match(clientSource, /activeReservationRef\.current = reservationId/);
  assert.match(clientSource, /preparing \|\| exporting \|\| narrationGenerating \|\| Boolean\(pendingFinalize\)/);
  assert.match(clientSource, /ensureMixExportActive\(controller\.signal, mountedRef\.current\)/);
  assert.match(clientSource, /pendingFinalizeRef\.current = stagedPending/);
  assert.match(clientSource, /activeReservationRef\.current = null;[\s\S]*?updateUsage\("complete", reservationId\)/);
  assert.match(clientSource, /素材ごとの最終的な音量調整は書き出し時に反映します/);
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
    /\.videoMixShell[\s\S]*?:is\(button, a, input\):focus-visible[\s\S]*?outline:/,
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
