import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeMonoWavChunk,
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

test("keeps each browser-generated audio request well below the site limit", () => {
  const wavBytes =
    44 +
    TRANSCRIPTION_AUDIO_CHUNK_SECONDS *
      TRANSCRIPTION_AUDIO_SAMPLE_RATE *
      2;

  assert.ok(wavBytes < 8 * 1024 * 1024);
});
