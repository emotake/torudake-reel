import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ALL_FORMATS, BlobSource, Input } from "mediabunny";

import { extractTranscriptionAudioChunks } from "../lib/transcription-media.ts";
import { validateVideoInputDuration } from "../lib/video-input-policy.ts";

const FIXTURE_ROOT = new URL("./fixtures/media/", import.meta.url);

async function inspectFixture(name, type) {
  const bytes = await readFile(new URL(name, FIXTURE_ROOT));
  const input = new Input({
    source: new BlobSource(new Blob([bytes], { type })),
    formats: ALL_FORMATS,
  });

  try {
    assert.equal(await input.canRead(), true, `${name} should be readable`);
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    assert.ok(videoTrack, `${name} should contain a video track`);

    const [width, height, rotation, duration, videoCodec, audioCodec] =
      await Promise.all([
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getRotation(),
        videoTrack.computeDuration(),
        videoTrack.getCodec(),
        audioTrack?.getCodec() ?? null,
      ]);

    return {
      bytes,
      width: Math.round(width),
      height: Math.round(height),
      rotation,
      duration,
      hasAudio: Boolean(audioTrack),
      videoCodec,
      audioCodec,
    };
  } finally {
    input.dispose();
  }
}

async function collectTranscriptionChunks(name, type) {
  const bytes = await readFile(new URL(name, FIXTURE_ROOT));
  const source = new File([bytes], name, { type });
  const chunks = [];

  for await (const chunk of extractTranscriptionAudioChunks(source)) {
    chunks.push(chunk);
  }

  return chunks;
}

test("reads the synthetic portrait MOV without presenting it as an iPhone capture", async () => {
  const media = await inspectFixture(
    "synthetic-portrait-h264-aac.mov",
    "video/quicktime",
  );

  assert.deepEqual(
    {
      width: media.width,
      height: media.height,
      hasAudio: media.hasAudio,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
    },
    {
      width: 360,
      height: 640,
      hasAudio: true,
      videoCodec: "avc",
      audioCodec: "aac",
    },
  );
  assert.ok(media.duration >= 1.9 && media.duration <= 2.1);
});

test("reads a CC0 iPhone XR HEVC MOV and preserves its exact upstream bytes", async () => {
  const media = await inspectFixture(
    "iphone-xr-hevc-pcm.mov",
    "video/quicktime",
  );

  assert.deepEqual(
    {
      width: media.width,
      height: media.height,
      rotation: media.rotation,
      hasAudio: media.hasAudio,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
    },
    {
      width: 1440,
      height: 1080,
      rotation: 0,
      hasAudio: true,
      videoCodec: "hevc",
      audioCodec: "pcm-s16",
    },
  );
  assert.ok(media.duration >= 2.9 && media.duration <= 3.0);
  assert.equal(
    createHash("sha256").update(media.bytes).digest("hex"),
    "5ff33a1b7527eec60f302da2bf860688dc2a21e9ebf6ee150118d5983d927582",
  );
});

test("extracts the real iPhone PCM track to an API-compatible WAV without an API call", async () => {
  const chunks = await collectTranscriptionChunks(
    "iphone-xr-hevc-pcm.mov",
    "video/quicktime",
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startSeconds, 0);
  assert.equal(chunks[0].file.type, "audio/wav");
  assert.match(chunks[0].file.name, /-audio-01\.wav$/);
  assert.ok(chunks[0].file.size > 250_000);
  assert.ok(chunks[0].file.size < 300_000);

  const extractedInput = new Input({
    source: new BlobSource(chunks[0].file),
    formats: ALL_FORMATS,
  });
  try {
    assert.equal(await extractedInput.canRead(), true);
    const extractedAudio = await extractedInput.getPrimaryAudioTrack();
    assert.ok(extractedAudio);
    assert.equal(await extractedAudio.getCodec(), "pcm-s16");
    assert.ok((await extractedAudio.computeDuration()) >= 2.9);
  } finally {
    extractedInput.dispose();
  }
});

test("recognizes a truly silent portrait video without inventing audio", async () => {
  const media = await inspectFixture("silent-portrait.mp4", "video/mp4");

  assert.deepEqual(
    { width: media.width, height: media.height, hasAudio: media.hasAudio },
    { width: 360, height: 640, hasAudio: false },
  );

  await assert.rejects(async () => {
    await collectTranscriptionChunks("silent-portrait.mp4", "video/mp4");
  });
});

test("distinguishes a silent AAC track from a video with no audio track", async () => {
  const media = await inspectFixture("silent-audio-track.mp4", "video/mp4");

  assert.equal(media.hasAudio, true);
  assert.equal(media.audioCodec, "aac");
  const chunks = await collectTranscriptionChunks(
    "silent-audio-track.mp4",
    "video/mp4",
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].file.type, "audio/mp4");
  assert.match(chunks[0].file.name, /-audio-01\.m4a$/);
  assert.ok(chunks[0].file.size > 0);
});

test("preserves landscape orientation during input inspection", async () => {
  const media = await inspectFixture("landscape.mp4", "video/mp4");

  assert.deepEqual(
    { width: media.width, height: media.height, hasAudio: media.hasAudio },
    { width: 640, height: 360, hasAudio: true },
  );
});

test("detects a source longer than the supported five-minute workflow", async () => {
  const media = await inspectFixture("long-305s.mp4", "video/mp4");

  assert.ok(media.duration >= 304.9, `unexpected duration: ${media.duration}`);
  assert.equal(media.hasAudio, false);
  const policyResult = validateVideoInputDuration(media.duration);
  assert.equal(policyResult.ok, false);
  assert.equal(policyResult.code, "video_duration_too_long");
  assert.equal(policyResult.maximumSeconds, 300);
});
