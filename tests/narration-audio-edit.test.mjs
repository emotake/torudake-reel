import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNarrationAudioSpans,
  findQuietNarrationBoundary,
  resolveNarrationAudioBoundaries,
  spliceNarrationAudioSegment,
} from "../lib/narration-audio-edit.ts";

function audioSource(values, sampleRate = 1_000) {
  const channelData = [Float32Array.from(values)];
  return {
    duration: values.length / sampleRate,
    getChannelData: (channel) => channelData[channel],
    length: values.length,
    numberOfChannels: 1,
    sampleRate,
  };
}

function decodePcm16Wav(buffer) {
  const view = new DataView(buffer);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const dataBytes = view.getUint32(40, true);
  const frameCount = dataBytes / (channels * 2);
  return {
    channels,
    frameCount,
    sampleRate,
    sample(frame, channel = 0) {
      return (
        view.getInt16(44 + (frame * channels + channel) * 2, true) / 0x8000
      );
    },
  };
}

test("builds stable narration spans from the spoken text weights", () => {
  const spans = buildNarrationAudioSpans(
    [
      { text: "短い文。" },
      { text: "表示", speechText: "読み方を反映した少し長い文。" },
    ],
    10,
  );

  assert.equal(spans.length, 2);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[1].end, 10);
  assert.ok(spans[0].end < spans[1].end - spans[0].end);
});

test("finds the quiet point near an estimated sentence boundary", () => {
  const samples = Array.from({ length: 3_000 }, () => 0.25);
  for (let index = 1_180; index < 1_225; index += 1) samples[index] = 0;
  const boundary = findQuietNarrationBoundary(
    audioSource(samples),
    1.1,
    0.25,
  );

  assert.ok(boundary >= 1.17 && boundary <= 1.24);
});

test("replaces one narration range without changing the full duration", () => {
  const originalSamples = Array.from({ length: 4_000 }, (_, index) =>
    index < 1_000 ? 0.1 : index < 2_000 ? 0.2 : 0.3,
  );
  for (let index = 960; index < 1_040; index += 1) {
    originalSamples[index] = 0;
  }
  for (let index = 1_960; index < 2_040; index += 1) {
    originalSamples[index] = 0;
  }
  const replacementSamples = Array.from({ length: 650 }, () => 0.45);

  const boundaries = resolveNarrationAudioBoundaries(
    audioSource(originalSamples),
    1,
    2,
  );
  const result = spliceNarrationAudioSegment(
    audioSource(originalSamples),
    audioSource(replacementSamples),
    1,
    2,
    boundaries,
  );

  assert.ok(result.originalStart >= 0.93 && result.originalStart <= 1.07);
  assert.ok(result.originalEnd >= 1.93 && result.originalEnd <= 2.07);
  assert.equal(result.duration, 4);
  for (const wav of [
    result.audio,
    result.originalPreview,
    result.correctedPreview,
  ]) {
    const bytes = new Uint8Array(wav);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "RIFF");
    assert.equal(new TextDecoder().decode(bytes.subarray(8, 12)), "WAVE");
    assert.equal(new DataView(wav).getUint32(24, true), 1_000);
    assert.ok(bytes.length > 44);
  }
  assert.equal(decodePcm16Wav(result.audio).frameCount, originalSamples.length);
});

test("rejects partial replacement before generation when boundaries are not quiet", () => {
  const original = audioSource(Array.from({ length: 3_000 }, () => 0.2));

  assert.throws(
    () => resolveNarrationAudioBoundaries(original, 0.8, 2.1),
    /十分な無音がないため/,
  );
  assert.throws(
    () =>
      spliceNarrationAudioSegment(
        original,
        audioSource(Array.from({ length: 500 }, () => 0.2)),
        0.8,
        2.1,
      ),
    /十分な無音がないため/,
  );
});

test("trims replacement silence and RMS-matches speech in a valid WAV", () => {
  const originalSamples = Array.from({ length: 4_000 }, () => 0.25);
  for (let index = 950; index < 1_050; index += 1) {
    originalSamples[index] = 0;
  }
  for (let index = 1_950; index < 2_050; index += 1) {
    originalSamples[index] = 0;
  }
  const replacementSamples = [
    ...Array.from({ length: 150 }, () => 0),
    ...Array.from({ length: 400 }, () => 0.4),
    ...Array.from({ length: 250 }, () => 0),
  ];
  const original = audioSource(originalSamples);
  const boundaries = resolveNarrationAudioBoundaries(original, 1, 2);
  const result = spliceNarrationAudioSegment(
    original,
    audioSource(replacementSamples),
    1,
    2,
    boundaries,
  );
  const wav = decodePcm16Wav(result.audio);
  const retainedReplacementSeconds = result.correctedEnd - result.correctedStart;

  assert.ok(retainedReplacementSeconds >= 0.42);
  assert.ok(retainedReplacementSeconds <= 0.44);
  assert.equal(result.duration, original.duration);
  assert.equal(wav.frameCount, original.length);
  assert.equal(wav.sampleRate, original.sampleRate);
  const replacementMiddleFrame = Math.floor(
    ((result.correctedStart + result.correctedEnd) / 2) * wav.sampleRate,
  );
  assert.ok(Math.abs(wav.sample(replacementMiddleFrame) - 0.25) < 0.015);
});

test("rejects a trimmed replacement that exceeds the safe overhang", () => {
  const originalSamples = Array.from({ length: 4_000 }, () => 0.2);
  for (let index = 950; index < 1_050; index += 1) {
    originalSamples[index] = 0;
  }
  for (let index = 1_950; index < 2_050; index += 1) {
    originalSamples[index] = 0;
  }

  assert.throws(
    () =>
      spliceNarrationAudioSegment(
        audioSource(originalSamples),
        audioSource(Array.from({ length: 1_100 }, () => 0.2)),
        1,
        2,
      ),
    /元の修正区間より長すぎるため/,
  );
});
