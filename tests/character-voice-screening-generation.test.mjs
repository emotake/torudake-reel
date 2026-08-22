import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPROVED_AGGREGATE_AUDIO_OUTPUT_TOKENS,
  APPROVED_EVALUATION_DATA_SHA256,
  EXECUTION_CONFIRMATION,
  MAX_BUDGET_JPY,
  MAX_TRANSCRIPT_MISMATCH_EXCLUSIONS,
  RESUME_CONFIRMATION,
  SCREENING_SAMPLE_COUNT,
  buildPaidScreeningPlan,
  generateScreeningSamples,
  normalizeRealtimeUsage,
  resumeScreeningSamples,
  validatePcm16Audio,
} from "../scripts/operations/generate-character-voice-screening.mjs";

const TEST_API_KEY = "test-key-that-is-never-sent";

class MockRealtimeSocket {
  constructor({ row, behavior, sentEvents }) {
    this.row = row;
    this.behavior = behavior;
    this.sentEvents = sentEvents;
    this.listeners = new Map();
    this.closed = false;
    setImmediate(() => {
      this.emitMessage({
        type: "session.created",
        session: { id: `session-${row.sampleId}` },
      });
    });
  }

  on(eventName, listener) {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  emit(eventName, value) {
    for (const listener of this.listeners.get(eventName) ?? []) listener(value);
  }

  emitMessage(event) {
    this.emit("message", Buffer.from(JSON.stringify(event), "utf8"));
  }

  send(value) {
    const event = JSON.parse(value);
    this.sentEvents.push(event);
    if (event.type === "session.update") {
      setImmediate(() => {
        this.emitMessage({
          type: "session.updated",
          session: this.behavior.omitSessionConfiguration
            ? {}
            : {
                audio: {
                  output: {
                    voice: this.behavior.sessionVoice ?? this.row.voice,
                    format: { type: "audio/pcm", rate: 24_000 },
                  },
                },
              },
        });
      });
      return;
    }
    if (event.type !== "response.create") return;
    setImmediate(() => {
      if (this.behavior.providerError) {
        this.emitMessage({
          type: "error",
          error: { code: "mock_provider_failure" },
        });
        return;
      }
      const pcm = makePcm(this.row.expectedSeconds * 0.6);
      this.emitMessage({
        type: "response.output_audio.delta",
        delta: pcm.toString("base64"),
      });
      if (!this.behavior.noTranscript) {
        this.emitMessage({
          type: "response.output_audio_transcript.done",
          transcript:
            this.behavior.transcript ??
            `${this.row.text}${this.behavior.appendTranscriptPunctuation ? "！！" : ""}`,
        });
      }
      this.emitMessage({
        type: "response.done",
        request_id: `request-${this.row.sampleId}`,
        response: {
          id: `response-${this.row.sampleId}`,
          status: "completed",
          usage: this.behavior.missingUsage
            ? undefined
            : {
                input_tokens: 100,
                output_tokens: 20,
                input_token_details: {
                  text_tokens: 100,
                  cached_tokens: 0,
                },
                output_token_details: {
                  text_tokens: 0,
                  audio_tokens: 20,
                },
              },
        },
      });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1000 });
  }
}

function makePcm(seconds, amplitude = 2_000) {
  const samples = Math.ceil(seconds * 24_000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
  }
  return pcm;
}

function mockFactory({ behaviors = [] } = {}) {
  const plan = buildPaidScreeningPlan();
  const rowById = new Map(plan.rows.map((row) => [row.sampleId, row]));
  const sockets = [];
  const sentEvents = [];
  const factory = async ({ sampleId, apiKey }) => {
    assert.equal(apiKey, TEST_API_KEY);
    const row = rowById.get(sampleId);
    assert.ok(row);
    const socket = new MockRealtimeSocket({
      row,
      behavior: behaviors[sockets.length] ?? {},
      sentEvents,
    });
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets, sentEvents, plan };
}

function generationOptions(outputDirectory, webSocketFactory) {
  return {
    execute: true,
    confirmation: EXECUTION_CONFIRMATION,
    outputDirectory,
    budgetJpy: MAX_BUDGET_JPY,
    usdToJpy: 150,
    apiKey: TEST_API_KEY,
    webSocketFactory,
    timeoutMs: 5_000,
  };
}

function resumeOptions(outputDirectory, webSocketFactory) {
  return {
    execute: true,
    resume: true,
    confirmation: RESUME_CONFIRMATION,
    outputDirectory,
    budgetJpy: MAX_BUDGET_JPY,
    apiKey: TEST_API_KEY,
    webSocketFactory,
    timeoutMs: 5_000,
  };
}

async function createTranscriptMismatchPack(root, failureIndex = 9) {
  const behaviors = Array.from({ length: failureIndex + 1 }, () => ({}));
  behaviors[failureIndex] = { transcript: "意図しない別の読み上げ" };
  const initial = mockFactory({ behaviors });
  const result = await generateScreeningSamples(
    generationOptions(root, initial.factory),
  );
  assert.equal(result.manifest.status, "stopped_failure");
  assert.equal(result.manifest.completedSampleCount, failureIndex);
  assert.equal(result.manifest.failure.code, "audio_transcript_mismatch");
  return result;
}

test("pins the approved 24-sample screening plan and maximum cost", () => {
  const plan = buildPaidScreeningPlan({ usdToJpy: 150 });
  assert.equal(plan.rows.length, SCREENING_SAMPLE_COUNT);
  assert.equal(plan.aggregateOutputTokens, 4_800);
  assert.equal(
    plan.aggregateOutputTokens,
    APPROVED_AGGREGATE_AUDIO_OUTPUT_TOKENS,
  );
  assert.ok(
    plan.rows.every((row) => row.guard.inputTokenEstimate <= 1_400),
  );
  assert.ok(Math.abs(plan.guardedTotalUsd - 0.11616) < 1e-12);
  assert.ok(Math.abs(plan.guardedTotalJpy - 17.424) < 1e-12);
  assert.equal(
    APPROVED_EVALUATION_DATA_SHA256,
    "E3B91D0BFBF026EA58ADED824AA25C915B246A4A4F358051897E5E7BEBB80728",
  );
  const caps = Object.fromEntries(
    plan.rows.map((row) => [row.scriptId, row.guard.maxOutputTokens]),
  );
  assert.deepEqual(caps, {
    impact_hook: 180,
    japanese_phonemes: 220,
    conversational_pacing: 200,
  });
});

test("requires every paid execution guard before creating a socket", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-guards-"));
  const mock = mockFactory();
  await assert.rejects(
    generateScreeningSamples({
      ...generationOptions(root, mock.factory),
      execute: false,
    }),
    /--execute/u,
  );
  await assert.rejects(
    generateScreeningSamples({
      ...generationOptions(root, mock.factory),
      confirmation: "wrong",
    }),
    /--confirm/u,
  );
  await assert.rejects(
    generateScreeningSamples({
      ...generationOptions(root, mock.factory),
      budgetJpy: 20.01,
    }),
    /must not exceed 20/u,
  );
  await assert.rejects(
    generateScreeningSamples({
      ...generationOptions(root, mock.factory),
      apiKey: undefined,
    }),
    /OPENAI_API_KEY/u,
  );
  assert.equal(mock.sockets.length, 0);
});

test("generates 24 blind WAVs and treats empty transcript metadata as unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-success-"));
  const mock = mockFactory({
    behaviors: [
      { transcript: "" },
      { appendTranscriptPunctuation: true },
    ],
  });
  const result = await generateScreeningSamples(
    generationOptions(root, mock.factory),
  );
  assert.equal(result.manifest.status, "completed");
  assert.equal(result.manifest.completedSampleCount, 24);
  assert.equal(mock.sockets.length, 24);
  assert.equal(new Set(mock.sockets).size, 24);
  assert.equal(result.manifest.retryCount, 0);
  assert.equal(result.manifest.samples[0].transcript.availability, "unavailable");
  assert.equal(
    result.manifest.samples[0].transcript.normalizedMatchesInput,
    null,
  );
  assert.equal(result.manifest.samples[1].transcript.availability, "provided");
  assert.equal(
    result.manifest.samples[1].transcript.normalizedMatchesInput,
    true,
  );
  assert.ok(
    result.manifest.samples.every(
      (sample) =>
        sample.normalizedRms > 0.002 &&
        sample.clippedSampleRatio === 0 &&
        /^[a-f0-9]{64}$/u.test(sample.sha256),
    ),
  );

  const audioFiles = await readdir(path.join(root, "audio"));
  assert.equal(audioFiles.length, 24);
  assert.ok(audioFiles.every((file) => /^CV-[A-F0-9]{10}\.wav$/u.test(file)));
  const firstWav = await readFile(path.join(root, "audio", audioFiles[0]));
  assert.equal(firstWav.subarray(0, 4).toString("ascii"), "RIFF");

  const manifestText = await readFile(
    path.join(root, "operator", "generation-results.json"),
    "utf8",
  );
  assert.doesNotMatch(manifestText, new RegExp(TEST_API_KEY, "u"));
  assert.doesNotMatch(manifestText, /Authorization/u);
  const creates = mock.sentEvents.filter(
    ({ type }) => type === "response.create",
  );
  assert.equal(creates.length, 24);
  assert.deepEqual(
    creates.map(({ response }) => response.max_output_tokens).sort((a, b) => a - b),
    [
      ...Array(8).fill(180),
      ...Array(8).fill(200),
      ...Array(8).fill(220),
    ],
  );
});

test("missing response usage reserves the full sample guard and stops without a WAV", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-usage-"));
  const mock = mockFactory({ behaviors: [{ missingUsage: true }] });
  const result = await generateScreeningSamples(
    generationOptions(root, mock.factory),
  );
  assert.equal(result.manifest.status, "stopped_failure");
  assert.equal(result.manifest.completedSampleCount, 0);
  assert.equal(result.manifest.failure.code, "missing_response_usage");
  assert.equal(
    result.manifest.failure.incurredCostAccounting,
    "full-sample-guard-reserved",
  );
  assert.ok(result.manifest.budget.unverifiedReservedJpy > 0);
  assert.equal(
    result.manifest.budget.actualJpy,
    result.manifest.budget.unverifiedReservedJpy,
  );
  assert.equal(mock.sockets.length, 1);
  assert.deepEqual(await readdir(path.join(root, "audio")), []);
});

test("provider failure after response.create is never retried and reserves its guard", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-failure-"));
  const mock = mockFactory({
    behaviors: [{}, { providerError: true }],
  });
  const result = await generateScreeningSamples(
    generationOptions(root, mock.factory),
  );
  assert.equal(result.manifest.status, "stopped_failure");
  assert.equal(result.manifest.completedSampleCount, 1);
  assert.equal(result.manifest.retryCount, 0);
  assert.equal(mock.sockets.length, 2);
  assert.equal(result.manifest.failure.code, "mock_provider_failure");
  assert.equal(
    result.manifest.failure.incurredCostAccounting,
    "full-sample-guard-reserved",
  );
  assert.equal((await readdir(path.join(root, "audio"))).length, 1);
});

test("session mismatch fails before a billable response and audio QA rejects silence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-session-"));
  const mock = mockFactory({ behaviors: [{ sessionVoice: "wrong" }] });
  const result = await generateScreeningSamples(
    generationOptions(root, mock.factory),
  );
  assert.equal(result.manifest.failure.code, "session_voice_mismatch");
  assert.equal(result.manifest.budget.actualJpy, 0);
  assert.equal(
    mock.sentEvents.filter(({ type }) => type === "response.create").length,
    0,
  );
  assert.throws(
    () => validatePcm16Audio(Buffer.alloc(24_000 * 2 * 5), mock.plan.rows[0]),
    /audio_is_silent/u,
  );
});

test("missing session confirmation and mismatched transcripts fail closed without a WAV", async () => {
  const missingSessionRoot = await mkdtemp(
    path.join(tmpdir(), "voice-paid-session-missing-"),
  );
  const missingSession = mockFactory({
    behaviors: [{ omitSessionConfiguration: true }],
  });
  const missingResult = await generateScreeningSamples(
    generationOptions(missingSessionRoot, missingSession.factory),
  );
  assert.equal(missingResult.manifest.failure.code, "session_voice_mismatch");
  assert.equal(missingResult.manifest.budget.actualJpy, 0);
  assert.equal(
    missingSession.sentEvents.filter(({ type }) => type === "response.create")
      .length,
    0,
  );

  const transcriptRoot = await mkdtemp(
    path.join(tmpdir(), "voice-paid-transcript-mismatch-"),
  );
  const transcriptMismatch = mockFactory({
    behaviors: [{ transcript: "台本とは異なる読み上げ" }],
  });
  const transcriptResult = await generateScreeningSamples(
    generationOptions(transcriptRoot, transcriptMismatch.factory),
  );
  assert.equal(
    transcriptResult.manifest.failure.code,
    "audio_transcript_mismatch",
  );
  assert.equal(
    transcriptResult.manifest.failure.incurredCostAccounting,
    "response.done-verified",
  );
  assert.ok(transcriptResult.manifest.budget.verifiedUsageJpy > 0);
  assert.deepEqual(await readdir(path.join(transcriptRoot, "audio")), []);
});

test("usage accounting fails closed without output-audio detail", () => {
  assert.throws(
    () =>
      normalizeRealtimeUsage({
        input_tokens: 100,
        output_tokens: 20,
      }),
    /incomplete/u,
  );
});

test("refuses to overwrite a completed pack before opening another session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-fresh-"));
  const first = mockFactory();
  await generateScreeningSamples(generationOptions(root, first.factory));
  const second = mockFactory();
  await assert.rejects(
    generateScreeningSamples(generationOptions(root, second.factory)),
    /Refusing to overwrite/u,
  );
  assert.equal(second.sockets.length, 0);
});

test("resumes after the one validated mismatch, excludes it, and never regenerates it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-resume-"));
  const initial = await createTranscriptMismatchPack(root);
  const failedSampleId = initial.manifest.failure.sampleId;
  const continued = mockFactory();
  const result = await resumeScreeningSamples(
    resumeOptions(root, continued.factory),
  );

  assert.equal(result.manifest.status, "completed_with_exclusion");
  assert.equal(result.manifest.completedSampleCount, 23);
  assert.equal(result.manifest.excludedSampleCount, 1);
  assert.equal(result.manifest.retryCount, 0);
  assert.equal(result.manifest.resumeCount, 1);
  assert.equal(result.manifest.failure, null);
  assert.deepEqual(
    result.manifest.excludedSamples.map(
      ({ sampleId, reason, regenerated }) => ({
        sampleId,
        reason,
        regenerated,
      }),
    ),
    [
      {
        sampleId: failedSampleId,
        reason: "audio_transcript_mismatch",
        regenerated: false,
      },
    ],
  );
  assert.equal(continued.sockets.length, 14);
  assert.equal(continued.sockets[0].row.sampleId, continued.plan.rows[10].sampleId);
  assert.ok(
    continued.sockets.every(({ row }) => row.sampleId !== failedSampleId),
  );
  assert.equal((await readdir(path.join(root, "audio"))).length, 23);
  assert.ok(
    result.manifest.samples.every(
      ({ sampleId }) => sampleId !== failedSampleId,
    ),
  );
  assert.ok(result.manifest.budget.actualJpy <= MAX_BUDGET_JPY);
});

test("a second validated mismatch is appended as an exclusion and continuation stays sequential", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "voice-paid-second-resume-"),
  );
  const initial = await createTranscriptMismatchPack(root);
  const secondFailureBehaviors = Array.from({ length: 9 }, () => ({}));
  secondFailureBehaviors[8] = {
    transcript: "二度目の意図しない読み上げ",
  };
  const firstContinuation = mockFactory({
    behaviors: secondFailureBehaviors,
  });
  const stoppedAgain = await resumeScreeningSamples(
    resumeOptions(root, firstContinuation.factory),
  );
  assert.equal(stoppedAgain.manifest.status, "stopped_failure");
  assert.equal(stoppedAgain.manifest.completedSampleCount, 17);
  assert.equal(stoppedAgain.manifest.excludedSampleCount, 1);
  assert.equal(stoppedAgain.manifest.resumeCount, 1);
  assert.equal(
    stoppedAgain.manifest.failure.sampleId,
    firstContinuation.plan.rows[18].sampleId,
  );

  const secondContinuation = mockFactory();
  const result = await resumeScreeningSamples(
    resumeOptions(root, secondContinuation.factory),
  );
  const excludedIds = result.manifest.excludedSamples.map(
    ({ sampleId }) => sampleId,
  );
  assert.equal(result.manifest.status, "completed_with_exclusion");
  assert.equal(result.manifest.completedSampleCount, 22);
  assert.equal(result.manifest.excludedSampleCount, 2);
  assert.equal(result.manifest.resumeCount, 2);
  assert.deepEqual(excludedIds, [
    initial.manifest.failure.sampleId,
    firstContinuation.plan.rows[18].sampleId,
  ]);
  assert.equal(secondContinuation.sockets.length, 5);
  assert.equal(
    secondContinuation.sockets[0].row.sampleId,
    secondContinuation.plan.rows[19].sampleId,
  );
  assert.ok(
    secondContinuation.sockets.every(
      ({ row }) => !excludedIds.includes(row.sampleId),
    ),
  );
  assert.equal((await readdir(path.join(root, "audio"))).length, 22);
});

test("resume refuses a fifth transcript-mismatch exclusion before opening a socket", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "voice-paid-exclusion-limit-"),
  );
  await createTranscriptMismatchPack(root);

  for (
    let exclusionNumber = 1;
    exclusionNumber <= MAX_TRANSCRIPT_MISMATCH_EXCLUSIONS;
    exclusionNumber += 1
  ) {
    const stopImmediately = mockFactory({
      behaviors: [{ transcript: `除外候補${exclusionNumber + 1}` }],
    });
    const result = await resumeScreeningSamples(
      resumeOptions(root, stopImmediately.factory),
    );
    assert.equal(result.manifest.status, "stopped_failure");
    assert.equal(
      result.manifest.excludedSampleCount,
      exclusionNumber,
    );
    assert.equal(stopImmediately.sockets.length, 1);
  }

  const refused = mockFactory();
  await assert.rejects(
    resumeScreeningSamples(resumeOptions(root, refused.factory)),
    /fewer than 4 prior exclusions/u,
  );
  assert.equal(refused.sockets.length, 0);
});

test("resume fails closed before a socket on wrong confirmation, WAV tampering, or plan drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "voice-paid-resume-guard-"));
  const initial = await createTranscriptMismatchPack(root);
  const noCalls = mockFactory();

  await assert.rejects(
    resumeScreeningSamples({
      ...resumeOptions(root, noCalls.factory),
      confirmation: "wrong",
    }),
    /--confirm/u,
  );
  assert.equal(noCalls.sockets.length, 0);

  const firstSample = initial.manifest.samples[0];
  const firstWavPath = path.join(
    root,
    ...firstSample.file.split("/"),
  );
  const originalWav = await readFile(firstWavPath);
  const changedWav = Buffer.from(originalWav);
  changedWav[44] ^= 1;
  await writeFile(firstWavPath, changedWav);
  await assert.rejects(
    resumeScreeningSamples(resumeOptions(root, noCalls.factory)),
    /WAV verification failed/u,
  );
  assert.equal(noCalls.sockets.length, 0);
  await writeFile(firstWavPath, originalWav);

  const manifestPath = path.join(
    root,
    "operator",
    "generation-results.json",
  );
  const originalManifestText = await readFile(manifestPath, "utf8");
  const changedManifest = JSON.parse(originalManifestText);
  changedManifest.failure.sampleId = changedManifest.samples[0].sampleId;
  await writeFile(
    manifestPath,
    `${JSON.stringify(changedManifest, null, 2)}\n`,
  );
  await assert.rejects(
    resumeScreeningSamples(resumeOptions(root, noCalls.factory)),
    /failed sample is not exactly the next plan row/u,
  );
  assert.equal(noCalls.sockets.length, 0);
  await writeFile(manifestPath, originalManifestText);

  const overBudgetManifest = JSON.parse(originalManifestText);
  overBudgetManifest.budget.actualJpy = 10;
  overBudgetManifest.budget.verifiedUsageJpy = 10;
  overBudgetManifest.budget.actualUsd = 10 / 150;
  overBudgetManifest.budget.verifiedUsageUsd = 10 / 150;
  await writeFile(
    manifestPath,
    `${JSON.stringify(overBudgetManifest, null, 2)}\n`,
  );
  await assert.rejects(
    resumeScreeningSamples(resumeOptions(root, noCalls.factory)),
    /remaining guards exceeds/u,
  );
  assert.equal(noCalls.sockets.length, 0);
});
