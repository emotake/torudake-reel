import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_AUDIO_CHUNK_BYTES,
  MIN_AUDIO_CHUNK_BYTES,
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
  assert.equal(DEFAULT_MAX_AUDIO_CHUNK_BYTES, 768 * 1024);
  assert.equal(MIN_AUDIO_CHUNK_BYTES, 192 * 1024);

  const normalChunkSeconds = getSafeAudioChunkSeconds(128_000);
  assert.ok(normalChunkSeconds < 60);
  assert.ok(
    (normalChunkSeconds * 128_000) / 8 <
      DEFAULT_MAX_AUDIO_CHUNK_BYTES,
  );

  const highBitrateChunkSeconds = getSafeAudioChunkSeconds(320_000);
  assert.ok(highBitrateChunkSeconds < normalChunkSeconds);
  assert.ok(
    (highBitrateChunkSeconds * 320_000) / 8 <
      DEFAULT_MAX_AUDIO_CHUNK_BYTES,
  );

  const retryChunkSeconds = getSafeAudioChunkSeconds(
    128_000,
    MIN_AUDIO_CHUNK_BYTES,
  );
  assert.ok(retryChunkSeconds < normalChunkSeconds);
  assert.ok(
    (retryChunkSeconds * 128_000) / 8 < MIN_AUDIO_CHUNK_BYTES,
  );
  assert.equal(getSafeAudioChunkSeconds(null), 150);
});
