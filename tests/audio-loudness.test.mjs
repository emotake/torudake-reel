import assert from "node:assert/strict";
import test from "node:test";

import {
  combineAudioLoudnessMeasurements,
  computeLoudnessNormalizationGain,
  estimateTruePeak4x,
  measureAudioLoudness,
} from "../lib/audio-loudness.ts";

function sineWave({
  amplitude,
  durationSeconds,
  frequency = 1_000,
  sampleRate = 48_000,
}) {
  const samples = new Float32Array(Math.round(durationSeconds * sampleRate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] =
      amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return samples;
}

test("returns a silent measurement without an unsafe amplification gain", () => {
  const measurement = measureAudioLoudness(
    [new Float32Array(48_000)],
    48_000,
  );
  assert.equal(measurement.integratedLufs, null);
  assert.equal(measurement.samplePeak, 0);
  assert.equal(measurement.truePeak, 0);
  assert.equal(computeLoudnessNormalizationGain(measurement), 1);
});

test("measures K-weighted mono programme loudness and raises quiet speech safely", () => {
  const measurement = measureAudioLoudness(
    [sineWave({ amplitude: 0.05, durationSeconds: 1.2 })],
    48_000,
  );
  assert.ok(Number.isFinite(measurement.integratedLufs));
  assert.ok(measurement.integratedLufs < -20);
  assert.ok(measurement.gatedBlockCount > 0);
  assert.equal(measurement.totalBlockCount, 9);
  assert.equal(computeLoudnessNormalizationGain(measurement), 1.8);
});

test("accounts for stereo energy and combines separately scheduled clips", () => {
  const tone = sineWave({ amplitude: 0.1, durationSeconds: 1 });
  const mono = measureAudioLoudness([tone], 48_000);
  const stereo = measureAudioLoudness([tone, tone], 48_000);
  assert.ok(mono.integratedLufs !== null);
  assert.ok(stereo.integratedLufs !== null);
  assert.ok(Math.abs(stereo.integratedLufs - mono.integratedLufs - 3.01) < 0.15);

  const combined = combineAudioLoudnessMeasurements([mono, stereo]);
  assert.ok(combined.integratedLufs > mono.integratedLufs);
  assert.ok(combined.integratedLufs < stereo.integratedLufs);
  assert.equal(combined.durationSeconds, 2);
});

test("measures sub-400ms clips instead of treating them as silence", () => {
  const shortClip = measureAudioLoudness(
    [sineWave({ amplitude: 0.12, durationSeconds: 0.08 })],
    48_000,
  );
  assert.ok(Number.isFinite(shortClip.integratedLufs));
  assert.equal(shortClip.totalBlockCount, 1);
  assert.equal(shortClip.gatedBlockCount, 1);
  assert.ok(Math.abs(shortClip.durationSeconds - 0.08) < 1e-9);
});

test("estimates four-times inter-sample peaks and keeps -1 dBTP headroom", () => {
  const samples = Float32Array.from([0, 0.8, 0.8, 0, 0, 0.8, 0.8, 0]);
  const peaks = estimateTruePeak4x([samples]);
  assert.ok(peaks.truePeak > peaks.samplePeak);

  const gain = computeLoudnessNormalizationGain({
    integratedLufs: -30,
    truePeak: peaks.truePeak,
  });
  const maximumTruePeak = 10 ** (-1 / 20);
  assert.ok(peaks.truePeak * gain <= maximumTruePeak + 1e-12);
  assert.ok(gain < 1.8);
});

test("rejects invalid rates and normalization bounds", () => {
  assert.throws(
    () => measureAudioLoudness([new Float32Array(1)], 0),
    /sampleRate/,
  );
  assert.throws(
    () =>
      computeLoudnessNormalizationGain(
        { integratedLufs: -20, truePeak: 0.5 },
        { minimumGain: 2, maximumGain: 1 },
      ),
    /Invalid loudness normalization options/,
  );
});
