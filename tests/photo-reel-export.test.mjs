import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizePhotoReelAudioGain,
  resolvePhotoReelAudioPlacement,
} from "../lib/photo-reel-export.ts";

test("loops short user music to the exact video duration", () => {
  assert.deepEqual(resolvePhotoReelAudioPlacement(4.5, 15, "loop"), {
    playDuration: 15,
    loop: true,
  });
  assert.deepEqual(resolvePhotoReelAudioPlacement(35, 30, "loop"), {
    playDuration: 30,
    loop: false,
  });
});

test("can keep a short track unlooped and leave the rest silent", () => {
  assert.deepEqual(resolvePhotoReelAudioPlacement(4.5, 15, "trim"), {
    playDuration: 4.5,
    loop: false,
  });
});

test("validates safe audio gain bounds", () => {
  assert.equal(normalizePhotoReelAudioGain(), 0.82);
  assert.equal(normalizePhotoReelAudioGain(0), 0);
  assert.equal(normalizePhotoReelAudioGain(2), 2);
  assert.throws(() => normalizePhotoReelAudioGain(-0.1), /between 0 and 2/);
  assert.throws(() => normalizePhotoReelAudioGain(2.1), /between 0 and 2/);
});

test("uses the same deterministic canvas renderer for preview and MP4 export", async () => {
  const source = await readFile(
    new URL("../lib/photo-reel-export.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /drawPhotoReelPlanFrame\(/);
  assert.match(source, /new media\.Mp4OutputFormat\(\{ fastStart: "reserve" \}\)/);
  assert.match(source, /maximumPacketCount: schedule\.length \+ 2/);
  assert.match(source, /maximumPacketCount: Math\.ceil\(plan\.duration \* 150\) \+ 2/);
  assert.match(source, /new media\.CanvasSource\(canvas/);
  assert.match(source, /codec: "avc"/);
  assert.match(source, /HIGH_QUALITY_VIDEO_BITRATE/);
  assert.match(source, /new media\.AudioBufferSource\(/);
  assert.match(source, /codec: "aac"/);
});

test("falls back to an MP4 canvas recorder when WebCodecs AVC is unavailable", async () => {
  const source = await readFile(
    new URL("../lib/photo-reel-export.ts", import.meta.url),
    "utf8",
  );
  const capabilityIndex = source.indexOf("canEncodeWithWebCodecs");
  const fallbackIndex = source.indexOf("exportPhotoReelWithMediaRecorder(");
  const recorderIndex = source.indexOf("new MediaRecorder(");

  assert.ok(capabilityIndex >= 0);
  assert.ok(fallbackIndex >= 0);
  assert.ok(recorderIndex > fallbackIndex);
  assert.match(source, /HTMLCanvasElement\.prototype\.captureStream/);
  assert.match(source, /videoBitsPerSecond: HIGH_QUALITY_VIDEO_BITRATE/);
  assert.match(source, /video\/mp4;codecs=avc1\.640028,mp4a\.40\.2/);
  assert.match(
    source,
    /needsRecorderFallback\s*=\s*!canEncodeWithWebCodecs \|\| !canEncodeAudioWithWebCodecs/,
  );
  assert.match(source, /let recorderStarted = false/);
  assert.match(source, /if \(recorderStarted\)/);
  assert.match(source, /preparePhotoReelAudioContext/);
  assert.match(source, /callbacks\.preparedAudioContext \?\?/);
  assert.match(source, /frameIndex !== lastFrameIndex/);
  assert.doesNotMatch(source, /video\/webm/);
});

test("validates the completed MP4 before charging and aborts a backgrounded iPhone export", async () => {
  const [exportSource, clientSource] = await Promise.all([
    readFile(new URL("../lib/photo-reel-export.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/photo-reel/photo-reel-client.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(exportSource, /async function validatePhotoReelOutput\(/);
  assert.match(exportSource, /input\.getPrimaryVideoTrack\(\)/);
  assert.match(exportSource, /input\.getPrimaryAudioTrack\(\)/);
  assert.match(exportSource, /Math\.round\(width\) !== plan\.width/);
  assert.match(exportSource, /isAvcCodec\(codec, parameter\)/);
  assert.match(exportSource, /isAacCodec\(audioCodec, audioParameter\)/);
  assert.equal(
    exportSource.match(/await validatePhotoReelOutput\(/g)?.length,
    2,
  );
  assert.match(exportSource, /document\.addEventListener\("visibilitychange"/);
  assert.match(exportSource, /window\.addEventListener\("pagehide"/);
  assert.match(exportSource, /throwIfAborted\(callbacks\.signal\);\s*callbacks\.onProgress\?\.\(1\)/);

  assert.ok(
    clientSource.indexOf("preparedResult = prepareResultVideo(blob)") >
      clientSource.indexOf("const blob = await exportPhotoReel"),
  );
  assert.ok(
    clientSource.indexOf('await updatePhotoUsage("complete", reservationId)') >
      clientSource.indexOf("preparedResult = prepareResultVideo(blob)"),
  );
});

test("protects iPhone memory, pending usage, and synchronized BGM preview", async () => {
  const client = await readFile(
    new URL("../app/photo-reel/photo-reel-client.tsx", import.meta.url),
    "utf8",
  );
  const clearResultStart = client.indexOf("const clearResult = useCallback");
  const clearResultEnd = client.indexOf("const setPreviewAudioPosition", clearResultStart);
  const clearResult = client.slice(clearResultStart, clearResultEnd);

  assert.match(client, /MAX_AUDIO_BYTES = 12 \* 1024 \* 1024/);
  assert.match(client, /MAX_AUDIO_DURATION_SECONDS = 90/);
  assert.match(client, /readAudioDuration\(nextPreviewUrl\)/);
  assert.match(
    client,
    /isEditingLocked\s*=\s*preparing\s*\|\|\s*exporting\s*\|\|\s*audioPreparing\s*\|\|\s*finalizingUsage\s*\|\|\s*Boolean\(pendingFinalize\)/,
  );
  assert.ok(
    client.indexOf("assertPhotoReelExportSupported(Boolean(audioFile))") <
      client.indexOf("reservationId = await reservePhotoUsage(duration, reservationAttempt)"),
  );
  assert.ok(
    client.indexOf("preparedResult = prepareResultVideo(blob)") <
      client.indexOf('await updatePhotoUsage("complete", reservationId)'),
  );
  assert.doesNotMatch(clearResult, /setPendingFinalize\(null\)/);
  assert.match(client, /mountedRef\.current = true/);
  assert.match(client, /audioValidationRef\.current \+= 1/);
  assert.match(client, /pendingFinalizeRef\.current = pending/);
  assert.match(client, /ref=\{audioPreviewRef\}/);
  assert.match(client, /onClick=\{togglePreviewPlayback\}/);
  assert.match(client, /setPreviewAudioPosition\(nextTime\)/);
});

test("fits the complete optional title instead of silently removing its end", async () => {
  const source = await readFile(
    new URL("../lib/photo-reel.ts", import.meta.url),
    "utf8",
  );
  const titleStart = source.indexOf("function wrapTitle(");
  const titleEnd = source.indexOf("export function drawPhotoReelPlanFrame", titleStart);
  const titleFlow = source.slice(titleStart, titleEnd);

  assert.doesNotMatch(titleFlow, /slice\(0, 3\)/);
  assert.match(titleFlow, /while \(fontSize >= 48\)/);
  assert.match(titleFlow, /if \(lines\.length <= 3 \|\| fontSize === 48\) break/);
});

test("keeps all photo and music processing in the browser", async () => {
  const files = await Promise.all(
    ["../lib/photo-reel.ts", "../lib/photo-reel-assets.ts", "../lib/photo-reel-export.ts"].map(
      (path) => readFile(new URL(path, import.meta.url), "utf8"),
    ),
  );
  const source = files.join("\n");
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /\/api\//);
});

test("accepts iPhone HEIC and HEIF files even when the browser omits MIME type", async () => {
  const source = await readFile(
    new URL("../lib/photo-reel-assets.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /jpe\?g\|png\|webp\|heic\|heif/);
  assert.match(source, /HEIC・HEIF/);
});
