import assert from "node:assert/strict";
import test from "node:test";

import {
  getAudioCodecPriority,
  getDirectCopyAudioOutput,
  getSafeAudioChunkSeconds,
} from "../lib/transcription-media.ts";

test("uses an audio-only MP4 container for iPhone AAC audio", () => {
  assert.deepEqual(getDirectCopyAudioOutput("aac"), {
    extension: "m4a",
    kind: "mp4",
    mimeType: "audio/mp4",
  });
});

test("uses an audio-only WebM container for WebM audio codecs", () => {
  assert.equal(getDirectCopyAudioOutput("opus")?.kind, "webm");
  assert.equal(getDirectCopyAudioOutput("vorbis")?.kind, "webm");
});

test("prefers the AAC fallback track in iPhone spatial-audio videos", () => {
  const codecs = [null, "aac"];
  codecs.sort(
    (left, right) =>
      getAudioCodecPriority(left) - getAudioCodecPriority(right),
  );

  assert.equal(codecs[0], "aac");
});

test("keeps Dolby audio tracks available as a secondary fallback", () => {
  assert.equal(getDirectCopyAudioOutput("ac3")?.kind, "mp4");
  assert.equal(getDirectCopyAudioOutput("eac3")?.kind, "mp4");
});

test("keeps direct-copy audio chunks below the upload limit", () => {
  assert.equal(getSafeAudioChunkSeconds(128_000), 150);
  assert.ok(getSafeAudioChunkSeconds(1_500_000) < 150);
  assert.equal(getSafeAudioChunkSeconds(null), 150);
});
