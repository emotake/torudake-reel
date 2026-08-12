import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIBLE_AUDIO_PEAK_THRESHOLD,
  AUDIBLE_AUDIO_RMS_THRESHOLD,
  encodeMonoWavChunk,
  measureAudioSignal,
  TRANSCRIPTION_AUDIO_CHUNK_SECONDS,
  TRANSCRIPTION_AUDIO_SAMPLE_RATE,
} from "../lib/audio.ts";

test("encodes a decoded audio chunk as mono PCM WAV", () => {
  const samples = new Float32Array([-1, -0.5, 0.5, 1]);
  const wav = encodeMonoWavChunk(
    {
      duration: 2,
      getChannelData: () => samples,
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: 2,
    },
    0,
    2,
    2,
  );
  const view = new DataView(wav);
  const ascii = (offset, length) =>
    Array.from(
      { length },
      (_, index) => String.fromCharCode(view.getUint8(offset + index)),
    ).join("");

  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(36, 4), "data");
  assert.equal(view.getUint32(24, true), 2);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(wav.byteLength, 52);
});

test("keeps each browser-generated audio request below the API limit", () => {
  const wavBytes =
    44 +
    TRANSCRIPTION_AUDIO_CHUNK_SECONDS *
      TRANSCRIPTION_AUDIO_SAMPLE_RATE *
      2;

  assert.equal(TRANSCRIPTION_AUDIO_CHUNK_SECONDS, 150);
  assert.ok(wavBytes < 8 * 1024 * 1024);
  assert.ok(wavBytes < 25 * 1024 * 1024);
});

test("distinguishes audible audio from a silent encoded track", () => {
  const silent = measureAudioSignal(new Float32Array(4_800));
  assert.equal(silent.rms, 0);
  assert.equal(silent.peak, 0);
  assert.equal(silent.audibleSampleRatio, 0);

  const audible = measureAudioSignal(
    Float32Array.from({ length: 4_800 }, (_, index) =>
      Math.sin((index / 48_000) * Math.PI * 2 * 440) * 0.08,
    ),
  );
  assert.ok(audible.rms > AUDIBLE_AUDIO_RMS_THRESHOLD);
  assert.ok(audible.peak > AUDIBLE_AUDIO_PEAK_THRESHOLD);
  assert.ok(audible.audibleSampleRatio > 0.5);
});

test("normalizes a quiet voice without clipping its waveform", () => {
  const samples = new Float32Array([-0.02, -0.01, 0.01, 0.02]);
  const wav = encodeMonoWavChunk(
    {
      duration: 2,
      getChannelData: () => samples,
      length: samples.length,
      numberOfChannels: 1,
      sampleRate: 2,
    },
    0,
    2,
    2,
  );
  const view = new DataView(wav);
  const encodedSamples = Array.from(
    { length: samples.length },
    (_, index) => view.getInt16(44 + index * 2, true),
  );

  assert.ok(Math.max(...encodedSamples.map(Math.abs)) > 2_000);
  assert.ok(Math.max(...encodedSamples.map(Math.abs)) < 32_767);
});
