import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluationData } from "../scripts/operations/character-voice-evaluation.mjs";
import {
  BLIND_TARGET_LUFS,
  BLIND_TRUE_PEAK_LIMIT_DBTP,
  DEFAULT_BLIND_SEED,
  POP_VOICES,
  preparePopVoiceBlindPack,
  runCli,
} from "../scripts/operations/prepare-pop-voice-blind-pack.mjs";

const toolSource = await readFile(
  new URL(
    "../scripts/operations/prepare-pop-voice-blind-pack.mjs",
    import.meta.url,
  ),
  "utf8",
);
const evaluationDataSource = await readFile(
  new URL(
    "../scripts/operations/data/character-voice-evaluation-v1.json",
    import.meta.url,
  ),
);
const currentEvaluationDataSha256 = createHash("sha256")
  .update(evaluationDataSource)
  .digest("hex")
  .toUpperCase();

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function makeWav(marker) {
  const sampleRate = 24_000;
  const pcm = Buffer.alloc(sampleRate * 2);
  const amplitude = 400 + marker * 600;
  for (let index = 0; index < pcm.length / 2; index += 1) {
    const sample = Math.round(
      amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate),
    );
    pcm.writeInt16LE(sample, index * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function createExistingPack() {
  const root = await mkdtemp(path.join(tmpdir(), "pop-existing-source-"));
  await Promise.all([
    mkdir(path.join(root, "audio"), { recursive: true }),
    mkdir(path.join(root, "operator"), { recursive: true }),
  ]);
  const samples = [];
  let marker = 1;
  for (const scriptId of evaluationData.screeningScriptIds) {
    for (const voice of POP_VOICES) {
      if (voice === "marin" && scriptId === "japanese_phonemes") continue;
      const sampleId = `SOURCE-${String(marker).padStart(2, "0")}`;
      const wav = makeWav(marker);
      const file = `audio/${sampleId}.wav`;
      await writeFile(path.join(root, ...file.split("/")), wav);
      samples.push({
        sampleId,
        profileId: "pop",
        voice,
        scriptId,
        take: 1,
        file,
        bytes: wav.length,
        durationSeconds: 1,
        sha256: sha256(wav),
        transcript: { normalizedMatchesInput: true },
      });
      marker += 1;
    }
  }
  const manifest = {
    schemaVersion: 1,
    status: "completed_with_exclusion",
    phase: "screening",
    model: "local-test-model",
    evaluationDataSha256: currentEvaluationDataSha256,
    samples,
    excludedSamples: [
      {
        sampleId: "SOURCE-EXCLUDED",
        profileId: "pop",
        voice: "marin",
        scriptId: "japanese_phonemes",
        reason: "audio_transcript_mismatch",
      },
    ],
  };
  await writeFile(
    path.join(root, "operator", "generation-results.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { root, manifest };
}

test("normalizes the 11 existing pop WAVs into a deterministic blind pack", async () => {
  const source = await createExistingPack();
  const outputOne = path.join(
    await mkdtemp(path.join(tmpdir(), "pop-blind-parent-")),
    "pack-one",
  );
  const outputTwo = path.join(
    await mkdtemp(path.join(tmpdir(), "pop-blind-parent-")),
    "pack-two",
  );

  const first = await preparePopVoiceBlindPack({
    sourceDirectory: source.root,
    outputDirectory: outputOne,
    seed: DEFAULT_BLIND_SEED,
  });
  await preparePopVoiceBlindPack({
    sourceDirectory: source.root,
    outputDirectory: outputTwo,
    seed: DEFAULT_BLIND_SEED,
  });

  assert.equal(first.sampleCount, 11);
  assert.equal(first.completeScriptCount, 2);
  assert.equal(first.missingSampleCount, 1);
  assert.equal(first.apiCalled, false);
  assert.equal(first.networkUsed, false);
  assert.equal(first.additionalCostJpy, 0);
  assert.equal(first.targetIntegratedLufs, BLIND_TARGET_LUFS);
  assert.equal(first.truePeakLimitDbtp, BLIND_TRUE_PEAK_LIMIT_DBTP);
  assert.ok(first.manifest.mastering.sourceIntegratedLufs.spreadDb > 10);
  assert.ok(first.manifest.mastering.outputIntegratedLufs.spreadDb < 0.05);
  assert.ok(
    first.manifest.mastering.maximumOutputTruePeakDbtp <=
      BLIND_TRUE_PEAK_LIMIT_DBTP + 1e-6,
  );
  assert.equal(first.manifest.mastering.allOutputsWithinTruePeakLimit, true);
  assert.equal(first.manifest.mastering.sourceFilesOverwritten, false);
  assert.equal(
    first.manifest.source.currentEvaluationDataSha256,
    currentEvaluationDataSha256,
  );
  assert.deepEqual(
    first.manifest.selection.completeScriptIds.sort(),
    ["conversational_pacing", "impact_hook"],
  );
  assert.deepEqual(first.manifest.selection.supplementalScriptIds, [
    "japanese_phonemes",
  ]);
  assert.deepEqual(first.manifest.missingCells, [
    {
      voice: "marin",
      scriptId: "japanese_phonemes",
      reason: "audio_transcript_mismatch",
      sourceSampleId: "SOURCE-EXCLUDED",
    },
  ]);

  const copiedAudio = await readdir(path.join(outputOne, "evaluator", "audio"));
  assert.equal(copiedAudio.length, 11);
  assert.ok(copiedAudio.every((file) => /^PB-[A-F0-9]{8}\.wav$/u.test(file)));

  for (const file of [
    path.join("evaluator", "index.html"),
    path.join("evaluator", "blind-evaluation.csv"),
    path.join("operator", "sample-key.csv"),
    path.join("operator", "pack-manifest.json"),
  ]) {
    assert.equal(
      await readFile(path.join(outputOne, file), "utf8"),
      await readFile(path.join(outputTwo, file), "utf8"),
      `${file} must be reproducible for the same source and seed`,
    );
  }

  for (const sample of first.manifest.samples) {
    const normalized = await readFile(path.join(outputOne, sample.evaluatorFile));
    const original = await readFile(
      path.join(source.root, ...sample.sourceFile.split("/")),
    );
    assert.equal(sha256(normalized), sample.sha256);
    assert.equal(sha256(original), sample.sourceSha256);
    assert.notEqual(sample.sha256, sample.sourceSha256);
    assert.ok(
      Math.abs(
        sample.mastering.outputIntegratedLufs - BLIND_TARGET_LUFS,
      ) < 0.05,
    );
    assert.ok(
      sample.mastering.outputTruePeakDbtp <=
        BLIND_TRUE_PEAK_LIMIT_DBTP + 1e-6,
    );
  }
});

test("keeps provider names and source IDs out of every evaluator-facing file", async () => {
  const source = await createExistingPack();
  const output = path.join(
    await mkdtemp(path.join(tmpdir(), "pop-blind-public-")),
    "pack",
  );
  await preparePopVoiceBlindPack({
    sourceDirectory: source.root,
    outputDirectory: output,
  });

  const evaluatorText = (
    await Promise.all(
      ["index.html", "blind-evaluation.csv", "guide.md"].map((file) =>
        readFile(path.join(output, "evaluator", file), "utf8"),
      ),
    )
  ).join("\n");
  const operatorText = await readFile(
    path.join(output, "operator", "sample-key.csv"),
    "utf8",
  );
  for (const voice of POP_VOICES) {
    assert.doesNotMatch(evaluatorText, new RegExp(voice, "u"));
    assert.match(operatorText, new RegExp(voice, "u"));
  }
  for (const sample of source.manifest.samples) {
    assert.doesNotMatch(evaluatorText, new RegExp(sample.sampleId, "u"));
    assert.match(operatorText, new RegExp(sample.sampleId, "u"));
  }
  for (const label of [
    "イントネーションの自然さ",
    "アクセントの自然さ",
    "語尾の自然さ",
    "間の自然さ",
  ]) {
    assert.match(evaluatorText, new RegExp(label, "u"));
  }
  assert.match(evaluatorText, /音声はこのフォルダー内だけから再生/u);
  assert.match(evaluatorText, /採点結果を保存/u);
  assert.match(evaluatorText, /-22\.5 LUFS/u);
  assert.match(evaluatorText, /-3 dBTP/u);
});

test("escapes an arbitrary seed before embedding it in evaluator JavaScript", async () => {
  const source = await createExistingPack();
  const output = path.join(
    await mkdtemp(path.join(tmpdir(), "pop-blind-hostile-seed-")),
    "pack",
  );
  const maliciousSeed =
    "</script><script>globalThis.injected=true</script>\u2028\u2029&<>";
  await preparePopVoiceBlindPack({
    sourceDirectory: source.root,
    outputDirectory: output,
    seed: maliciousSeed,
  });
  const html = await readFile(
    path.join(output, "evaluator", "index.html"),
    "utf8",
  );
  assert.doesNotMatch(html, /<script>globalThis\.injected/u);
  assert.doesNotMatch(html, /\u2028|\u2029/u);
  assert.match(html, /\\u003C\/script\\u003E\\u003Cscript\\u003E/u);
  assert.match(html, /\\u0026\\u003C\\u003E/u);
});

test("rejects source tampering and refuses to overwrite an output directory", async () => {
  const source = await createExistingPack();
  const tampered = source.manifest.samples[0];
  const target = path.join(source.root, ...tampered.file.split("/"));
  const buffer = await readFile(target);
  buffer[44] ^= 1;
  await writeFile(target, buffer);
  const output = path.join(
    await mkdtemp(path.join(tmpdir(), "pop-blind-tamper-")),
    "pack",
  );
  await assert.rejects(
    preparePopVoiceBlindPack({
      sourceDirectory: source.root,
      outputDirectory: output,
    }),
    /SHA-256 mismatch/u,
  );

  const cleanSource = await createExistingPack();
  const existingOutput = await mkdtemp(path.join(tmpdir(), "pop-blind-existing-"));
  await assert.rejects(
    preparePopVoiceBlindPack({
      sourceDirectory: cleanSource.root,
      outputDirectory: existingOutput,
    }),
    /Refusing to overwrite/u,
  );
});

test("rejects stale evaluation definitions and unverified transcripts", async () => {
  const stale = await createExistingPack();
  stale.manifest.evaluationDataSha256 = "0".repeat(64);
  await writeFile(
    path.join(stale.root, "operator", "generation-results.json"),
    `${JSON.stringify(stale.manifest, null, 2)}\n`,
  );
  await assert.rejects(
    preparePopVoiceBlindPack({
      sourceDirectory: stale.root,
      outputDirectory: path.join(stale.root, "stale-output"),
    }),
    /does not match the current evaluation definition/u,
  );

  const unverified = await createExistingPack();
  unverified.manifest.samples[0].transcript.normalizedMatchesInput = false;
  await writeFile(
    path.join(unverified.root, "operator", "generation-results.json"),
    `${JSON.stringify(unverified.manifest, null, 2)}\n`,
  );
  await assert.rejects(
    preparePopVoiceBlindPack({
      sourceDirectory: unverified.root,
      outputDirectory: path.join(unverified.root, "unverified-output"),
    }),
    /Transcript was not verified/u,
  );
});

test("the local packer has no API, secret, or network execution path", async () => {
  assert.doesNotMatch(toolSource, /api\.openai\.com/u);
  assert.doesNotMatch(toolSource, /OPENAI_API_KEY/u);
  assert.doesNotMatch(toolSource, /\bfetch\s*\(/u);
  assert.doesNotMatch(toolSource, /https?:\/\//u);
  assert.doesNotMatch(toolSource, /WebSocket/u);
  const help = await runCli(["--help"]);
  assert.match(help.help, /Local-only/u);
  assert.match(help.help, /No API/u);
});
