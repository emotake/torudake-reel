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
  assert.match(source, /new media\.Mp4OutputFormat\(\{ fastStart: "in-memory" \}\)/);
  assert.match(source, /new media\.CanvasSource\(canvas/);
  assert.match(source, /codec: "avc"/);
  assert.match(source, /HIGH_QUALITY_VIDEO_BITRATE/);
  assert.match(source, /new media\.AudioBufferSource\(/);
  assert.match(source, /codec: "aac"/);
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
