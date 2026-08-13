import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const styles = ["calm", "bright", "comedy", "party"];

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

test("keeps a clean 300 ms post-roll after every fixed voice preview", async () => {
  for (const style of styles) {
    const bytes = await readFile(
      new URL(`../public/demo/voices/${style}-v4.wav`, import.meta.url),
    );
    const { pcm, sampleRate } = wavPcm16(bytes);
    const postRoll = pcm.subarray(pcm.length - Math.round(sampleRate * 0.3));
    assert.ok(postRoll.length > 0);
    assert.equal(
      postRoll.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
      0,
      `${style} must end with 300 ms of digital silence`,
    );
    const precedingVoiceWindow = pcm.subarray(
      Math.max(0, pcm.length - Math.round(sampleRate * 0.9)),
      pcm.length - Math.round(sampleRate * 0.35),
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
