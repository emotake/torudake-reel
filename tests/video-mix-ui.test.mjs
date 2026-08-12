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

test("offers four no-AI transition styles shared with the exporter", () => {
  for (const id of ["crossfade", "cut", "fade-black", "fade-white"]) {
    assert.match(clientSource, new RegExp(`id: "${id}"`));
  }
  assert.match(clientSource, /何度変えても追加料金やAI処理回数は発生しません/);
  assert.match(clientSource, /exportVideoMixMp4\(\{/);
  assert.match(clientSource, /transition,/);
  assert.doesNotMatch(clientSource, /\/api\/(?:transcribe|narration)/);
  assert.doesNotMatch(exporterSource, /openai|api\/transcribe|api\/narration/i);
});

test("reserves once for all sources and consumes one entitlement only after a verified export", () => {
  assert.match(clientSource, /reserveMixUsage\(aggregateDuration, idempotencyKey\)/);
  assert.match(clientSource, /canSaveCompletedVideo\(reservation\.bucket\)/);
  assert.match(
    clientSource,
    /exportVideoMixMp4\([\s\S]*?inspectMixOutput\(blob, plan, audioMetadata\)[\s\S]*?updateUsage\("complete", reservationId\)/,
  );
  assert.match(clientSource, /updateUsage\("release", reservationId\)/);
  assert.match(clientSource, /caught instanceof VideoMixRequestError && caught\.status === 402/);
  assert.match(clientSource, /完成動画1本分の利用枠を使用/);
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
  assert.match(clientSource, /const editingLocked = preparing \|\| exporting \|\| Boolean\(pendingFinalize\)/);
  assert.match(clientSource, /ensureMixExportActive\(controller\.signal, mountedRef\.current\)/);
  assert.match(clientSource, /pendingFinalizeRef\.current = stagedPending/);
  assert.match(clientSource, /activeReservationRef\.current = null;[\s\S]*?updateUsage\("complete", reservationId\)/);
  assert.match(clientSource, /素材ごとの音量調整は書き出し時に反映します/);
  assert.match(cssSource, /\.videoMixPhone video\s*\{[^}]*object-fit:\s*contain/);
  assert.doesNotMatch(cssSource, /\.videoMixPhone video\s*\{[^}]*object-fit:\s*cover/);
});

test("ships accessible mobile controls and route metadata", () => {
  assert.match(pageSource, /path: "\/video-mix"/);
  assert.match(pageSource, /各動画から1〜2カット/);
  assert.match(clientSource, /role="radiogroup"/);
  assert.match(clientSource, /role="radio"/);
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
