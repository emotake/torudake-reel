import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildVideoMixFrameDecodeBatches,
  createVideoMixAudioExportMetadata,
  exportVideoMixMp4,
  getVideoMixTransitionCanvasWorkingBytes,
} from "../lib/video-mix-export.ts";
import {
  buildVideoCompositionFrameSchedule,
  createVideoCompositionPlan,
} from "../lib/video-composition.ts";

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

  assert.equal(schedule.length, 2_700);
  assert.equal(batches.length, 10);
  assert.equal(
    batches.reduce((total, batch) => total + batch.frames.length, 0),
    schedule.length,
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.frames.map((frame) => frame.frameIndex)),
    schedule.map((frame) => frame.frameIndex),
  );
  assert.equal(
    batches.filter((batch) => batch.captureBoundaryIndex !== null).length,
    9,
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
});

test("preserves consecutive premium boundaries around a 0.35s middle clip", async () => {
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

  assert.equal(middleBatch.captureBoundaryIndex, 1);
  assert.equal(middleBatch.frames[0].transition?.boundaryIndex, 0);
  assert.equal(middleBatch.frames.at(-1).transition?.boundaryIndex, 0);
  assert.equal(middleBatch.frames.at(-1).transition?.type, "wipe-left");
  assert.equal(batches[2].frames[0].transition?.boundaryIndex, 1);
  assert.equal(batches[2].frames[0].transition?.type, "slide-left");

  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );
  const renderLoop = source.slice(
    source.indexOf("for await (const sample"),
    source.indexOf("if (emittedFrames !== schedule.length)"),
  );
  const captureRawIndex = renderLoop.indexOf(
    "copyCanvasFrame(canvas, spareTransitionFrame)",
  );
  const renderCurrentBoundaryIndex = renderLoop.indexOf(
    "drawFrameTransition(",
    captureRawIndex,
  );
  const promoteSpareIndex = renderLoop.indexOf(
    "outgoingTransitionFrame = promotedOutgoingFrame",
  );

  assert.ok(captureRawIndex >= 0);
  assert.ok(renderCurrentBoundaryIndex > captureRawIndex);
  assert.ok(promoteSpareIndex > renderCurrentBoundaryIndex);
  assert.match(renderLoop, /incomingFrameAlreadyCaptured|promotedOutgoingFrame !== null/);
});

test("closes yielded samples on abort and releases transition backing stores", async () => {
  const source = await readFile(
    new URL("../lib/video-mix-export.ts", import.meta.url),
    "utf8",
  );
  const renderLoop = source.slice(
    source.indexOf("for await (const sample"),
    source.indexOf("if (emittedFrames !== schedule.length)"),
  );
  const guardedWorkIndex = renderLoop.indexOf("try {");
  const abortSafetyCommentIndex = renderLoop.indexOf(
    "// A sample may arrive just as cancellation is requested.",
  );
  const abortIndex = renderLoop.indexOf("throwIfAborted(options.signal)");
  const sampleCloseIndex = renderLoop.indexOf("sample.close()");

  assert.ok(guardedWorkIndex >= 0);
  assert.ok(abortSafetyCommentIndex > guardedWorkIndex);
  assert.ok(abortIndex > abortSafetyCommentIndex);
  assert.ok(sampleCloseIndex > abortIndex);
  assert.match(renderLoop, /finally \{\s*sample\.close\(\);\s*\}/);
  assert.match(source, /releaseVideoMixTransitionCanvas\(outgoingTransitionFrame\)/);
  assert.match(source, /releaseVideoMixTransitionCanvas\(incomingTransitionFrame\)/);
  assert.match(
    source,
    /function releaseVideoMixTransitionCanvas[\s\S]*canvas\.width = 0;[\s\S]*canvas\.height = 0;/,
  );
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

test("renders premium transition metadata on Canvas without retiming audio", async () => {
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
  // Transition visuals remain a video-only concern. Existing source-audio
  // placement and equal-power cut handling stay on the original path.
  assert.match(source, /applyMixAudioCrossfades\(groups\)/);
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
