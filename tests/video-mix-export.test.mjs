import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createVideoMixAudioExportMetadata,
  exportVideoMixMp4,
} from "../lib/video-mix-export.ts";

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
