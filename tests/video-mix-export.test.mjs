import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildVideoMixFrameDecodeBatches,
  buildVideoMixNarrationDuckingMetadata,
  computeVideoMixFrameLayout,
  createVideoMixSourceAudioAnalysisWindows,
  createVideoMixAudioExportMetadata,
  exportVideoMixMp4,
  getVideoMixTransitionCanvasWorkingBytes,
  getVideoMixDuckingGainAtTime,
  getVideoMixClipAudioOverlapEnvelope,
  getVideoMixTransitionAudioGains,
  measureVideoMixSourceAudioNormalization,
} from "../lib/video-mix-export.ts";
import {
  buildVideoCompositionFrameSchedule,
  createVideoCompositionPlan,
} from "../lib/video-composition.ts";

test("uses equal-power audio gains throughout a true-overlap transition", () => {
  const plan = createVideoCompositionPlan({
    sources: [
      { id: "one", fileSize: 10, duration: 4, clips: [{ start: 0, end: 4 }] },
      { id: "two", fileSize: 10, duration: 4, clips: [{ start: 0, end: 4 }] },
    ],
    transition: { type: "crossfade", duration: 0.4 },
  });
  const boundary = plan.boundaries[0];
  const start = getVideoMixTransitionAudioGains(plan, boundary.editedTime);
  const middle = getVideoMixTransitionAudioGains(
    plan,
    boundary.editedTime + boundary.transition.duration / 2,
  );
  assert.ok(start);
  assert.ok(middle);
  assert.equal(start.incoming, 0);
  assert.equal(start.outgoing, 1);
  assert.ok(Math.abs(middle.incoming - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(middle.outgoing - Math.SQRT1_2) < 1e-12);
  assert.equal(
    getVideoMixTransitionAudioGains(
      plan,
      boundary.editedTime + boundary.transition.duration + 0.01,
    ),
    null,
  );
});

test("keeps the audible side faded when the neighboring overlap clip is silent", () => {
  const plan = createVideoCompositionPlan({
    sources: [
      { id: "audible", fileSize: 10, duration: 4, clips: [{ start: 0, end: 4 }] },
      { id: "silent", fileSize: 10, duration: 4, clips: [{ start: 0, end: 4 }] },
    ],
    transition: { type: "crossfade", duration: 0.4 },
  });
  const outgoingOnly = getVideoMixClipAudioOverlapEnvelope(plan, 0);
  const incomingOnly = getVideoMixClipAudioOverlapEnvelope(plan, 1);
  assert.equal(outgoingOnly.fadeIn, null);
  assert.deepEqual(outgoingOnly.fadeOut, {
    start: plan.boundaries[0].editedTime,
    end: plan.boundaries[0].editedTime + 0.4,
  });
  assert.deepEqual(incomingOnly.fadeIn, outgoingOnly.fadeOut);
  assert.equal(incomingOnly.fadeOut, null);
});

test("bounds selected-clip loudness analysis for preview/export parity", () => {
  assert.equal(typeof measureVideoMixSourceAudioNormalization, "function");
  const windows = createVideoMixSourceAudioAnalysisWindows([
    { start: 10, end: 30 },
    { start: 50, end: 70 },
  ]);
  assert.equal(windows.length, 2);
  assert.ok(Math.abs(windows.reduce((sum, item) => sum + item.end - item.start, 0) - 15) < 1e-9);
  assert.deepEqual(windows, [
    { start: 16.25, end: 23.75 },
    { start: 56.25, end: 63.75 },
  ]);
});

test("scales preview backing blur to the same displayed radius as export", () => {
  const exported = computeVideoMixFrameLayout(1920, 1080, 1080, 1920, {
    mode: "blur",
    focusX: 0.3,
    focusY: 0.7,
  });
  const preview = computeVideoMixFrameLayout(1920, 1080, 540, 960, {
    mode: "blur",
    focusX: 0.3,
    focusY: 0.7,
  });
  assert.equal(exported.background.kind, "blurred-video");
  assert.equal(preview.background.kind, "blurred-video");
  assert.ok(
    Math.abs(
      exported.background.blurPixels * (360 / 1080) -
        preview.background.blurPixels * (360 / 540),
    ) < 0.01,
  );
  assert.equal(preview.background.rect.x, exported.background.rect.x / 2);
  assert.equal(preview.background.rect.y, exported.background.rect.y / 2);
  assert.equal(preview.background.rect.width, exported.background.rect.width / 2);
  assert.equal(preview.background.rect.height, exported.background.rect.height / 2);
});

test("exposes the browser-only multi-video MP4 exporter", () => {
  assert.equal(typeof exportVideoMixMp4, "function");
});

test("reports mixed source audio for post-export quality inspection", () => {
  const metadata = createVideoMixAudioExportMetadata({
    sources: [
      { sourceId: "first", hasAudioTrack: true },
      { sourceId: "second", hasAudioTrack: false },
    ],
    audioGain: 1,
    contributingSourceIndexes: new Set([0]),
    outputHasAudioTrack: true,
  });

  assert.equal(metadata.state, "mixed");
  assert.equal(metadata.hasSourceAudioTrack, true);
  assert.equal(metadata.hasSelectedAudioSamples, true);
  assert.equal(metadata.outputHasAudioTrack, true);
  assert.equal(metadata.requireAudio, true);
  assert.equal(metadata.inspectAudioActivity, true);
  assert.deepEqual(metadata.narration, {
    requested: false,
    hasDecodedSamples: false,
    hasActivity: false,
    contributedToMix: false,
    duckedSourceAudio: false,
  });
  assert.deepEqual(metadata.sources, [
    {
      sourceId: "first",
      sourceIndex: 0,
      hasAudioTrack: true,
      hasSelectedAudioSamples: true,
      contributedToMix: true,
    },
    {
      sourceId: "second",
      sourceIndex: 1,
      hasAudioTrack: false,
      hasSelectedAudioSamples: false,
      contributedToMix: false,
    },
  ]);
});

test("distinguishes intentional mute from missing or unavailable audio", () => {
  const intentionallyMuted = createVideoMixAudioExportMetadata({
    sources: [{ sourceId: "voice", hasAudioTrack: true }],
    audioGain: 0,
    contributingSourceIndexes: null,
    outputHasAudioTrack: false,
  });
  assert.equal(intentionallyMuted.state, "intentionally-muted");
  assert.equal(intentionallyMuted.hasSelectedAudioSamples, null);
  assert.equal(intentionallyMuted.sources[0].hasSelectedAudioSamples, null);
  assert.equal(intentionallyMuted.requireAudio, false);

  const noSourceAudio = createVideoMixAudioExportMetadata({
    sources: [{ sourceId: "silent", hasAudioTrack: false }],
    audioGain: 1,
    contributingSourceIndexes: new Set(),
    outputHasAudioTrack: false,
  });
  assert.equal(noSourceAudio.state, "no-source-audio");
  assert.equal(noSourceAudio.requireAudio, false);

  const unavailableInSelection = createVideoMixAudioExportMetadata({
    sources: [{ sourceId: "short-audio", hasAudioTrack: true }],
    audioGain: 1,
    contributingSourceIndexes: new Set(),
    outputHasAudioTrack: false,
  });
  assert.equal(
    unavailableInSelection.state,
    "source-audio-unavailable-in-selection",
  );
  assert.equal(unavailableInSelection.hasSelectedAudioSamples, false);
  // An input track was expected, so a missing output track must remain a
  // blocking quality-check condition instead of silently becoming optional.
  assert.equal(unavailableInSelection.requireAudio, true);
  assert.equal(unavailableInSelection.inspectAudioActivity, false);
});

test("requires and reports narration even when all source videos are silent", () => {
  const narrationOnly = createVideoMixAudioExportMetadata({
    sources: [{ sourceId: "silent-video", hasAudioTrack: false }],
    audioGain: 1,
    contributingSourceIndexes: new Set(),
    outputHasAudioTrack: true,
    narration: {
      requested: true,
      hasDecodedSamples: true,
      hasActivity: true,
      contributedToMix: true,
      duckedSourceAudio: false,
    },
  });

  assert.equal(narrationOnly.state, "narration-only");
  assert.equal(narrationOnly.requireAudio, true);
  assert.equal(narrationOnly.inspectAudioActivity, true);
  assert.equal(narrationOnly.narration.contributedToMix, true);

  const missingNarrationOutput = createVideoMixAudioExportMetadata({
    sources: [{ sourceId: "silent-video", hasAudioTrack: false }],
    audioGain: 0,
    contributingSourceIndexes: null,
    outputHasAudioTrack: false,
    narration: {
      requested: true,
      hasDecodedSamples: false,
      hasActivity: false,
      contributedToMix: false,
      duckedSourceAudio: false,
    },
  });
  assert.equal(missingNarrationOutput.requireAudio, true);
  assert.equal(missingNarrationOutput.outputHasAudioTrack, false);
});

test("keeps the multi exporter on the portable Mediabunny path", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /new media\.Input/);
  assert.match(source, /new media\.VideoSampleSink/);
  assert.match(source, /new media\.CanvasSource/);
  assert.match(source, /new media\.Mp4OutputFormat/);
  assert.match(source, /HIGH_QUALITY_VIDEO_BITRATE/);
  assert.match(source, /VIDEO_COMPOSITION_OUTPUT_WIDTH/);
  assert.match(source, /VIDEO_COMPOSITION_OUTPUT_HEIGHT/);
  assert.match(source, /OUTPUT_AUDIO_BITRATE = 192_000/);
  assert.doesNotMatch(source, /MediaRecorder/);
  assert.doesNotMatch(source, /captureStream/);
});

test("decodes a maximum composition in monotonic clip batches instead of per frame", () => {
  const plan = createVideoCompositionPlan({
    sources: Array.from({ length: 5 }, (_, sourceIndex) => ({
      id: `source-${sourceIndex}`,
      fileSize: 1,
      duration: 20,
      clips: [
        { start: 0, end: 9 },
        { start: 10, end: 19 },
      ],
    })),
    transition: "zoom-dissolve",
  });
  const schedule = buildVideoCompositionFrameSchedule(plan);
  const batches = buildVideoMixFrameDecodeBatches(plan, schedule);

  assert.equal(schedule.length, Math.ceil(plan.duration * plan.frameRate));
  assert.equal(batches.length, 10);
  assert.equal(
    batches.reduce((total, batch) => total + batch.frames.length, 0),
    schedule.length,
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.frames.map((frame) => frame.frameIndex)),
    schedule.map((frame) => frame.frameIndex),
  );
  assert.ok(
    batches.every((batch) =>
      batch.frames.every(
        (frame, index) =>
          index === 0 ||
          frame.sourceTime >= batch.frames[index - 1].sourceTime,
      ),
    ),
  );
  assert.ok(
    batches.every((batch) =>
      batch.requests.every(
        (request, index) =>
          index === 0 || request.sourceTime >= batch.requests[index - 1].sourceTime,
      ),
    ),
  );
  assert.ok(
    batches.some((batch) =>
      batch.requests.some((request) => request.role === "transition-outgoing"),
    ),
  );
});

test("preserves both advancing premium boundaries around a 0.35s middle clip", async () => {
  const plan = createVideoCompositionPlan({
    sources: Array.from({ length: 3 }, (_, sourceIndex) => ({
      id: `short-${sourceIndex}`,
      fileSize: 1,
      duration: 0.35,
      clips: [{ start: 0, end: 0.35 }],
    })),
    transition: "cut",
    boundaryTransitions: ["wipe-left", "slide-left"],
  });
  const schedule = buildVideoCompositionFrameSchedule(plan);
  const batches = buildVideoMixFrameDecodeBatches(plan, schedule);
  const middleBatch = batches[1];

  const boundaryIndexes = new Set(
    schedule.filter((frame) => frame.transition).map((frame) => frame.transition.boundaryIndex),
  );
  assert.deepEqual(boundaryIndexes, new Set([0, 1]));
  assert.ok(
    middleBatch.requests.some((request) => request.role === "transition-outgoing"),
  );
  assert.ok(
    middleBatch.requests.every(
      (request, index) =>
        index === 0 || request.sourceTime >= middleBatch.requests[index - 1].sourceTime,
    ),
  );

  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /role: "transition-outgoing"/);
  assert.match(source, /takeSample\([\s\S]*"transition-outgoing"/);
  assert.match(source, /drawVideoMixSourceFrame\([\s\S]*outgoingSample/);
});

test("closes yielded samples on abort and releases transition backing stores", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /finally \{\s*primarySample\.close\(\);\s*outgoingSample\?\.close\(\);\s*\}/);
  assert.match(source, /state\.iterator\.return\?\.\(\)/);
  assert.match(source, /releaseVideoMixTransitionCanvas\(outgoingTransitionFrame\)/);
  assert.match(source, /releaseVideoMixTransitionCanvas\(incomingTransitionFrame\)/);
  assert.match(
    source,
    /function releaseVideoMixTransitionCanvas[\s\S]*canvas\.width = 0;[\s\S]*canvas\.height = 0;/,
  );
});

test("shares deterministic framing for blurred, covered, and contained sources", () => {
  const blurred = computeVideoMixFrameLayout(1920, 1080, 1080, 1920);
  assert.equal(blurred.framing.mode, "blur");
  assert.equal(blurred.background.kind, "blurred-video");
  assert.equal(blurred.foregroundRect.width, 1080);

  const covered = computeVideoMixFrameLayout(1920, 1080, 1080, 1920, {
    mode: "cover",
    focusX: 1,
    focusY: -1,
  });
  assert.equal(covered.framing.focusX, 1);
  assert.equal(covered.framing.focusY, 0);
  assert.equal(covered.foregroundRect.height, 1920);
  assert.ok(covered.foregroundRect.x < 0);

  const portrait = computeVideoMixFrameLayout(1080, 1920, 1080, 1920);
  assert.equal(portrait.framing.mode, "cover");
  assert.equal(portrait.foregroundRect.x, 0);
  assert.equal(portrait.foregroundRect.y, 0);
  assert.equal(portrait.foregroundRect.width, 1080);
  assert.equal(portrait.foregroundRect.height, 1920);
});

test("shares the exact narration activity ducking envelope with preview", () => {
  const metadata = buildVideoMixNarrationDuckingMetadata({
    activity: [{ start: 1, end: 2 }],
    baseGain: 1,
    duration: 3,
  });
  assert.equal(getVideoMixDuckingGainAtTime(metadata, 0), 1);
  assert.ok(Math.abs(getVideoMixDuckingGainAtTime(metadata, 1) - 0.42) < 1e-12);
  assert.ok(Math.abs(getVideoMixDuckingGainAtTime(metadata, 1.5) - 0.42) < 1e-12);
  assert.equal(getVideoMixDuckingGainAtTime(metadata, 3), 1);
});

test("accounts for two reusable transition canvases instead of one per boundary", () => {
  const sources = Array.from({ length: 5 }, (_, sourceIndex) => ({
    id: `source-${sourceIndex}`,
    fileSize: 1,
    duration: 20,
    clips: [
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ],
  }));
  const blended = createVideoCompositionPlan({
    sources,
    transition: "crossfade",
  });
  const cuts = createVideoCompositionPlan({ sources, transition: "cut" });
  const mixed = createVideoCompositionPlan({
    sources,
    transition: "cut",
    boundaryTransitions: ["crossfade"],
  });

  assert.equal(
    getVideoMixTransitionCanvasWorkingBytes(blended),
    2 * 1080 * 1920 * 4,
  );
  assert.equal(getVideoMixTransitionCanvasWorkingBytes(cuts), 0);
  assert.equal(
    getVideoMixTransitionCanvasWorkingBytes(mixed),
    2 * 1080 * 1920 * 4,
  );
});

test("mixes all source audio and normalizes each source before the limiter", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getPreferredPortableInputAudioTrack/);
  assert.match(source, /measureAudioLoudness/);
  assert.match(source, /combineAudioLoudnessMeasurements/);
  assert.match(source, /sourceGains/);
  assert.match(source, /createDynamicsCompressor/);
  assert.match(source, /buildPortableAudioCrossfadePlan/);
  assert.match(source, /ensurePortableAacEncoding/);
  assert.match(source, /onAudioMetadata\?\./);
});

test("decodes, normalizes, clips and ducks for optional narration audio", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /narrationAudio\?: Blob/);
  assert.match(source, /narrationGain\?: number/);
  assert.match(source, /duckSourceAudioDuringNarration\?: boolean/);
  assert.match(source, /decodeAudioData\(encodedNarration\)/);
  assert.match(source, /detectPortableNarrationActivity/);
  assert.match(source, /buildPortableDuckingEnvelope/);
  assert.match(source, /targetLufs: -18/);
  assert.match(source, /maximumGain: 1\.35/);
  assert.match(source, /Math\.min\(plan\.duration, narrationBuffer\.duration\)/);
  assert.match(source, /narrationGainNode\.connect\(limiter\)/);
});

test("uses source-specific dimensions, HDR plans, progress and abort", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /getDisplayWidth/);
  assert.match(source, /getDisplayHeight/);
  assert.match(source, /getColorSpace/);
  assert.match(source, /hasHighDynamicRange/);
  assert.match(source, /createPortableVideoColorConversionPlan/);
  assert.match(source, /onColorConversionPlans/);
  assert.match(source, /onProgress\?\./);
  assert.match(source, /throwIfAborted\(options\.signal\)/);
  assert.match(source, /samplesAtTimestamps/);
  assert.match(source, /abortAwareVideoMixTimestamps/);
  assert.doesNotMatch(source, /\.getSample\(/);
  assert.doesNotMatch(source, /outgoingTransitionFrames/);
});

test("renders premium transition metadata on Canvas with matching overlap audio", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /transitionUsesOutgoingFrame/);
  assert.match(source, /type === "wipe-left"/);
  assert.match(source, /type === "slide-left"/);
  assert.match(source, /type === "zoom-dissolve"/);
  assert.match(source, /visual\.incomingReveal/);
  assert.match(source, /visual\.incomingOffsetX/);
  assert.match(source, /visual\.incomingScale/);
  assert.match(source, /visual\.overlayOpacity/);
  assert.match(source, /context\.clip\(\)/);
  assert.match(source, /context\.scale\(scale, scale\)/);
  assert.match(source, /applyMixAudioCrossfades\(groups, plan\)/);
  assert.match(source, /videoCompositionTransitionUsesOverlap/);
  assert.match(source, /item\.overlapFadeOut = envelope\.fadeOut/);
  assert.match(source, /item\.overlapFadeIn = envelope\.fadeIn/);
  assert.match(source, /prepared\[sourceIndex\]\.source\.audioNormalizationGain/);
  assert.match(
    source,
    /!item\.overlapFadeIn \|\|[\s\S]*?item\.overlapFadeIn\.start > itemStart \+ TIME_EPSILON[\s\S]*?gain\.gain\.setValueAtTime\(1, itemStart\)/,
  );
  assert.match(source, /else if \(!item\.overlapFadeIn\)/);
});

test("does not change the established single-video exporter contract", async () => {
  const source = await readFile(
    new URL("../lib/portable-video-export.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /export type PortableVideoExportOptions/);
  assert.match(source, /file: File/);
  assert.match(source, /ranges: readonly PortableVideoRange\[\]/);
  assert.match(source, /export async function exportPortableVideoMp4/);
});
