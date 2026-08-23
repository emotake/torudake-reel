import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

// Keep this list aligned with the active, ready entries in
// lib/voice-sample-catalog.ts.
const activeSamples = [
  ["calm", "calm-v5.wav"],
  ["bright", "bright-v5.wav"],
  ["comedy", "comedy-v6.wav"],
];

function wavPcm16(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 24_000);
  assert.equal(bytes.readUInt16LE(34), 16);
  const dataIndex = bytes.indexOf(Buffer.from("data"));
  assert.ok(dataIndex >= 36);
  const length = bytes.readUInt32LE(dataIndex + 4);
  const pcm = new Int16Array(
    bytes.buffer,
    bytes.byteOffset + dataIndex + 8,
    Math.floor(length / 2),
  );
  return { pcm, sampleRate: 24_000 };
}

function dbfs(value) {
  return value > 0 ? 20 * Math.log10(value / 32_768) : -120;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

test("keeps a clean, quiet post-speech tail after every fixed voice preview", async () => {
  for (const [style, file] of activeSamples) {
    const bytes = await readFile(
      new URL(`../public/demo/voices/${file}`, import.meta.url),
    );
    const { pcm, sampleRate } = wavPcm16(bytes);
    const finalTwentyMs = pcm.subarray(
      pcm.length - Math.round(sampleRate * 0.02),
    );
    assert.equal(
      finalTwentyMs.reduce(
        (peak, sample) => Math.max(peak, Math.abs(sample)),
        0,
      ),
      0,
      `${style} must end in digital silence`,
    );
    const precedingVoiceWindow = pcm.subarray(
      Math.max(0, pcm.length - Math.round(sampleRate * 0.75)),
      pcm.length - Math.round(sampleRate * 0.3),
    );
    assert.ok(
      precedingVoiceWindow.some((sample) => Math.abs(sample) >= 64),
      `${style} must contain real speech before its post-roll`,
    );
    assert.equal(
      pcm.reduce(
        (count, sample) => count + (Math.abs(sample) >= 32_767 ? 1 : 0),
        0,
      ),
      0,
      `${style} must not contain clipped samples`,
    );
    const frameSamples = Math.round(sampleRate * 0.02);
    const quietFrames = [];
    let lastActiveFrameEnd = 0;
    for (let start = 0; start < pcm.length; start += frameSamples) {
      const end = Math.min(pcm.length, start + frameSamples);
      let energy = 0;
      for (let index = start; index < end; index += 1) {
        energy += pcm[index] ** 2;
      }
      const frameDbfs = dbfs(Math.sqrt(energy / Math.max(1, end - start)));
      if (frameDbfs > -35) lastActiveFrameEnd = end;
      if (frameDbfs < -45 && frameDbfs > -100) quietFrames.push(frameDbfs);
    }
    assert.ok(
      (pcm.length - lastActiveFrameEnd) / sampleRate >= 0.3,
      `${style} must preserve at least 300 ms after active speech`,
    );
    assert.ok(
      quietFrames.length > 0 && percentile(quietFrames, 0.5) <= -60,
      `${style} quiet-frame median must stay at or below -60 dBFS`,
    );
  }
});

test("does not ship the temporary fixed-sample generation endpoint", async () => {
  const temporaryRoute = new URL(
    "../app/api/internal/voice-samples/route.ts",
    import.meta.url,
  );
  await assert.rejects(access(temporaryRoute), { code: "ENOENT" });

  const productionSpeechRoute = await readFile(
    new URL("../app/api/narration/speech/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    productionSpeechRoute,
    /generateFixedVoiceSampleForOperations/,
  );
});
