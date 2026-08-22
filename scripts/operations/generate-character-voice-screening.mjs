import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPENAI_REALTIME_MINI_PRICING,
  buildEvaluationPlan,
  evaluationData,
} from "./character-voice-evaluation.mjs";

export const EXECUTION_CONFIRMATION =
  "generate-24-character-voice-samples";
export const RESUME_CONFIRMATION =
  "resume-character-voice-screening-after-validation-failure";
export const MAX_BUDGET_JPY = 20;
export const MAX_TRANSCRIPT_MISMATCH_EXCLUSIONS = 4;
export const DEFAULT_USD_TO_JPY = 150;
export const REALTIME_SAMPLE_RATE = 24_000;
export const DEFAULT_CLIP_TIMEOUT_MS = 45_000;
export const SCREENING_SAMPLE_COUNT = 24;
export const APPROVED_EVALUATION_DATA_SHA256 =
  "E3B91D0BFBF026EA58ADED824AA25C915B246A4A4F358051897E5E7BEBB80728";
export const APPROVED_AGGREGATE_AUDIO_OUTPUT_TOKENS = 4_800;

const MANIFEST_RELATIVE_PATH = path.join(
  "operator",
  "generation-results.json",
);
const AUDIO_DIRECTORY_NAME = "audio";
const MAX_INPUT_TOKEN_RESERVE_PER_SAMPLE = 1_400;
const INPUT_TOKEN_ESTIMATE_OVERHEAD = 256;
const MINIMUM_DURATION_RATIO = 0.5;
const MINIMUM_NORMALIZED_RMS = 0.002;
const MAXIMUM_CLIPPED_SAMPLE_RATIO = 0.005;
const EVALUATION_DATA_URL = new URL(
  "./data/character-voice-evaluation-v1.json",
  import.meta.url,
);
const APPROVED_OUTPUT_TOKEN_CAPS = Object.freeze({
  impact_hook: 180,
  japanese_phonemes: 220,
  conversational_pacing: 200,
});

function finitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
  return value;
}

function integerInRange(value, label, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredNumberArgument(argv, name) {
  const raw = argument(argv, name);
  if (raw === undefined) throw new Error(`${name} is required.`);
  return finitePositive(Number(raw), name);
}

function optionalNumberArgument(argv, name, fallback) {
  const raw = argument(argv, name);
  return raw === undefined ? fallback : finitePositive(Number(raw), name);
}

function fileExists(filePath) {
  return stat(filePath)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
}

function maximumAudioSeconds(row) {
  return row.expectedSeconds + 3;
}

function priceTokens({
  textInput = 0,
  cachedTextInput = 0,
  textOutput = 0,
  audioOutput = 0,
}) {
  const prices = OPENAI_REALTIME_MINI_PRICING.perMillionTokensUsd;
  const lineItemsUsd = {
    textInput: (textInput / 1_000_000) * prices.textInput,
    cachedTextInput:
      (cachedTextInput / 1_000_000) * prices.cachedTextInput,
    textOutput: (textOutput / 1_000_000) * prices.textOutput,
    audioOutput: (audioOutput / 1_000_000) * prices.audioOutput,
  };
  return {
    lineItemsUsd,
    totalUsd: Object.values(lineItemsUsd).reduce(
      (total, amount) => total + amount,
      0,
    ),
  };
}

export function normalizeRealtimeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    throw new Error("response.done did not include usage.");
  }
  const inputDetails =
    usage.input_token_details ?? usage.input_tokens_details ?? {};
  const outputDetails =
    usage.output_token_details ?? usage.output_tokens_details ?? {};
  const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
  const inputAudio = Math.max(0, Number(inputDetails.audio_tokens) || 0);
  const outputAudioDetail = Number(outputDetails.audio_tokens);
  const outputTextDetail = Number(outputDetails.text_tokens);
  if (
    !Number.isFinite(Number(usage.input_tokens)) ||
    !Number.isFinite(Number(usage.output_tokens)) ||
    !Number.isFinite(outputAudioDetail)
  ) {
    throw new Error("response.done usage breakdown is incomplete.");
  }
  const outputAudio = Math.max(0, outputAudioDetail);
  const outputText = Number.isFinite(outputTextDetail)
    ? Math.max(0, outputTextDetail)
    : Math.max(0, outputTokens - outputAudio);
  const rawInputText = Number(inputDetails.text_tokens);
  const inputTextTotal = Number.isFinite(rawInputText)
    ? Math.max(0, rawInputText)
    : Math.max(0, inputTokens - inputAudio);
  const cachedInput = Math.min(
    inputTextTotal,
    Math.max(0, Number(inputDetails.cached_tokens) || 0),
  );

  return Object.freeze({
    inputTokens,
    outputTokens,
    textInputTokens: Math.max(0, inputTextTotal - cachedInput),
    cachedTextInputTokens: cachedInput,
    audioInputTokens: inputAudio,
    textOutputTokens: outputText,
    audioOutputTokens: outputAudio,
  });
}

export function realtimeUsageCost(usage, usdToJpy = DEFAULT_USD_TO_JPY) {
  finitePositive(usdToJpy, "usdToJpy");
  const normalized = normalizeRealtimeUsage(usage);
  const priced = priceTokens({
    textInput: normalized.textInputTokens,
    cachedTextInput: normalized.cachedTextInputTokens,
    textOutput: normalized.textOutputTokens,
    audioOutput: normalized.audioOutputTokens,
  });
  return Object.freeze({
    usage: normalized,
    lineItemsUsd: Object.freeze(priced.lineItemsUsd),
    totalUsd: priced.totalUsd,
    totalJpy: priced.totalUsd * usdToJpy,
  });
}

function conservativeRowCost(row, usdToJpy, inputTokenEstimate) {
  const outputSeconds = maximumAudioSeconds(row);
  const maxOutputTokens = APPROVED_OUTPUT_TOKEN_CAPS[row.scriptId];
  if (!Number.isSafeInteger(maxOutputTokens)) {
    throw new Error(`No approved output cap for ${row.scriptId}.`);
  }
  if (inputTokenEstimate > MAX_INPUT_TOKEN_RESERVE_PER_SAMPLE) {
    throw new Error(
      `Input estimate for ${row.sampleId} exceeds ${MAX_INPUT_TOKEN_RESERVE_PER_SAMPLE} tokens.`,
    );
  }
  const priced = priceTokens({
    textInput: MAX_INPUT_TOKEN_RESERVE_PER_SAMPLE,
    audioOutput: maxOutputTokens,
  });
  const baseJpy = priced.totalUsd * usdToJpy;
  return Object.freeze({
    outputSeconds,
    maxOutputTokens,
    inputTokenEstimate,
    reservedInputTokens: MAX_INPUT_TOKEN_RESERVE_PER_SAMPLE,
    guardedUsd: priced.totalUsd,
    baseJpy,
    guardedJpy: baseJpy,
  });
}

function assertApprovedScreeningPlan(plan) {
  if (
    plan.phase !== "screening" ||
    plan.takes !== 1 ||
    plan.rows.length !== SCREENING_SAMPLE_COUNT
  ) {
    throw new Error(
      `Only the fixed ${SCREENING_SAMPLE_COUNT}-sample screening plan is allowed.`,
    );
  }
  const allowedScripts = new Set(evaluationData.screeningScriptIds);
  const allowedVoices = new Map(
    evaluationData.profiles.map((profile) => [
      profile.id,
      new Set(profile.candidates.map(({ voice }) => voice)),
    ]),
  );
  const sampleIds = new Set();
  for (const row of plan.rows) {
    if (
      row.phase !== "screening" ||
      row.take !== 1 ||
      !allowedScripts.has(row.scriptId) ||
      !allowedVoices.get(row.profileId)?.has(row.voice)
    ) {
      throw new Error(`Screening row is not approved: ${row.sampleId}.`);
    }
    if (sampleIds.has(row.sampleId)) {
      throw new Error(`Duplicate screening sample ID: ${row.sampleId}.`);
    }
    sampleIds.add(row.sampleId);
  }
  return plan;
}

export function buildPaidScreeningPlan({
  usdToJpy = DEFAULT_USD_TO_JPY,
} = {}) {
  finitePositive(usdToJpy, "usdToJpy");
  const plan = assertApprovedScreeningPlan(buildEvaluationPlan());
  const rows = plan.rows.map((row) => {
    const instructions = profileInstructions(row);
    const inputTokenEstimate =
      Buffer.byteLength(`${instructions}\n${row.text}`, "utf8") +
      INPUT_TOKEN_ESTIMATE_OVERHEAD;
    return {
      ...row,
      instructions,
      guard: conservativeRowCost(row, usdToJpy, inputTokenEstimate),
    };
  });
  const aggregateOutputTokens = rows.reduce(
    (total, row) => total + row.guard.maxOutputTokens,
    0,
  );
  if (aggregateOutputTokens !== APPROVED_AGGREGATE_AUDIO_OUTPUT_TOKENS) {
    throw new Error(
      `Approved output-token total changed (${aggregateOutputTokens}).`,
    );
  }
  return Object.freeze({
    ...plan,
    rows: Object.freeze(rows),
    guardedTotalJpy: rows.reduce(
      (total, row) => total + row.guard.guardedJpy,
      0,
    ),
    guardedTotalUsd: rows.reduce(
      (total, row) => total + row.guard.guardedUsd,
      0,
    ),
    aggregateOutputTokens,
  });
}

function profileInstructions(row) {
  const profile = evaluationData.profiles.find(
    ({ id }) => id === row.profileId,
  );
  if (!profile) throw new Error(`Unknown profile: ${row.profileId}.`);
  return [
    "# 読み上げ",
    "入力台本だけを、自然な日本語のナレーションとして正確に読む。説明、言い換え、台詞の追加は禁止。",
    "日本語母語話者の自然な共通語で、意味のまとまりと句読点に合わせて間を置く。外国語風アクセント、物真似、叫び声、単調な機械音声を避ける。",
    "# 演出",
    profile.goal,
    profile.impactDirection,
    "声だけを明瞭に出力し、音楽や効果音は加えず、最後まで読み切る。",
  ].join("\n");
}

function socketOn(socket, eventName, listener) {
  if (typeof socket.on === "function") {
    socket.on(eventName, (...args) => {
      if (eventName === "message") listener({ data: args[0] });
      else listener(args[0] ?? {});
    });
    return;
  }
  socket.addEventListener(eventName, listener);
}

function decodeSocketText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  return Buffer.from(data).toString("utf8");
}

async function defaultWebSocketFactory({ apiKey, model }) {
  const wsModule = await import("ws");
  const WebSocketConstructor = wsModule.WebSocket ?? wsModule.default;
  return new WebSocketConstructor(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );
}

function terminateSocket(socket, reason, force = false) {
  try {
    if (force && typeof socket.terminate === "function") {
      socket.terminate();
      return;
    }
    if (typeof socket.close === "function") socket.close(1000, reason);
  } catch {
    try {
      socket.terminate?.();
    } catch {
      // The operation is already settling; there is nothing left to recover.
    }
  }
}

function safeFailure(error, fallbackCode) {
  return Object.freeze({
    category:
      error?.category === "provider"
        ? "provider"
        : error?.category === "timeout"
          ? "timeout"
          : "transport",
    code:
      typeof error?.code === "string" && error.code.length <= 80
        ? error.code
        : fallbackCode,
    status:
      Number.isSafeInteger(error?.status) && error.status >= 400
        ? error.status
        : undefined,
    usageUnverified: error?.usageUnverified === true,
  });
}

function safeIdentifier(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_.:-]+$/u.test(value)
    ? value
    : null;
}

function normalizeTranscript(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\p{P}\p{Z}\s]+/gu, "")
    .trim();
}

function validateSessionUpdate(event, row) {
  const output = event.session?.audio?.output;
  if (!output || output.voice !== row.voice) {
    throw Object.assign(new Error("session_voice_mismatch"), {
      category: "provider",
      code: "session_voice_mismatch",
    });
  }
  const format = output?.format;
  if (!format || format.type !== "audio/pcm") {
    throw Object.assign(new Error("session_audio_format_mismatch"), {
      category: "provider",
      code: "session_audio_format_mismatch",
    });
  }
  if (Number(format.rate) !== REALTIME_SAMPLE_RATE) {
    throw Object.assign(new Error("session_sample_rate_mismatch"), {
      category: "provider",
      code: "session_sample_rate_mismatch",
    });
  }
}

export function validatePcm16Audio(pcm, row) {
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  if (bytes.byteLength < 2 || bytes.byteLength % 2 !== 0) {
    throw Object.assign(new Error("invalid_pcm16_length"), {
      category: "provider",
      code: "invalid_pcm16_length",
    });
  }
  const sampleCount = bytes.byteLength / 2;
  let squaredTotal = 0;
  let clippedSamples = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    const sample = bytes.readInt16LE(offset);
    const normalized = sample / 32_768;
    squaredTotal += normalized * normalized;
    if (Math.abs(sample) >= 32_760) clippedSamples += 1;
  }
  const durationSeconds = sampleCount / REALTIME_SAMPLE_RATE;
  const normalizedRms = Math.sqrt(squaredTotal / sampleCount);
  const clippedSampleRatio = clippedSamples / sampleCount;
  if (durationSeconds < row.expectedSeconds * MINIMUM_DURATION_RATIO) {
    throw Object.assign(new Error("audio_too_short"), {
      category: "provider",
      code: "audio_too_short",
    });
  }
  if (durationSeconds > maximumAudioSeconds(row)) {
    throw Object.assign(new Error("audio_too_long"), {
      category: "provider",
      code: "audio_too_long",
    });
  }
  if (normalizedRms < MINIMUM_NORMALIZED_RMS) {
    throw Object.assign(new Error("audio_is_silent"), {
      category: "provider",
      code: "audio_is_silent",
    });
  }
  if (clippedSampleRatio > MAXIMUM_CLIPPED_SAMPLE_RATIO) {
    throw Object.assign(new Error("audio_is_clipped"), {
      category: "provider",
      code: "audio_is_clipped",
    });
  }
  return Object.freeze({
    durationSeconds,
    normalizedRms,
    clippedSampleRatio,
  });
}

export async function generateRealtimeClip({
  apiKey,
  row,
  webSocketFactory = defaultWebSocketFactory,
  timeoutMs = DEFAULT_CLIP_TIMEOUT_MS,
} = {}) {
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
    throw Object.assign(new Error("OPENAI_API_KEY is unavailable."), {
      code: "missing_api_key",
    });
  }
  integerInRange(timeoutMs, "timeoutMs", 1_000, 120_000);
  const maximumBytes =
    row.guard.outputSeconds * REALTIME_SAMPLE_RATE * 2;
  const socket = await webSocketFactory({
    apiKey,
    model: OPENAI_REALTIME_MINI_PRICING.model,
    sampleId: row.sampleId,
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let sessionConfigured = false;
    let responseRequested = false;
    let settled = false;
    let transcript = "";
    let transcriptProvided = false;
    let responseId = null;
    let requestId = null;

    const settle = (callback, value, reason, force = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminateSocket(socket, reason, force);
      callback(value);
    };
    const fail = (error, fallbackCode = "realtime_transport_failure") => {
      const safe = safeFailure(
        {
          ...error,
          usageUnverified:
            error?.usageUnverified === true || responseRequested,
        },
        fallbackCode,
      );
      settle(
        reject,
        Object.assign(new Error(safe.code), safe),
        "screening failed",
        true,
      );
    };
    const timeout = setTimeout(() => {
      fail(
        { category: "timeout", code: "realtime_timeout" },
        "realtime_timeout",
      );
    }, timeoutMs);

    socketOn(socket, "message", ({ data }) => {
      if (settled) return;
      let event;
      try {
        event = JSON.parse(decodeSocketText(data));
      } catch {
        return;
      }
      requestId =
        safeIdentifier(event.request_id ?? event._request_id) ?? requestId;
      responseId = safeIdentifier(event.response?.id) ?? responseId;
      if (event.type === "session.created") {
        if (sessionConfigured) return;
        sessionConfigured = true;
        try {
          socket.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                output_modalities: ["audio"],
                audio: {
                  output: {
                    format: {
                      type: "audio/pcm",
                      rate: REALTIME_SAMPLE_RATE,
                    },
                    voice: row.voice,
                    speed: 1,
                  },
                },
              },
            }),
          );
        } catch {
          fail({ code: "session_update_send_failed" });
        }
        return;
      }
      if (event.type === "session.updated") {
        if (responseRequested) return;
        try {
          validateSessionUpdate(event, row);
        } catch (error) {
          fail(error, "session_configuration_mismatch");
          return;
        }
        responseRequested = true;
        try {
          socket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                conversation: "none",
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: row.text }],
                  },
                ],
                output_modalities: ["audio"],
                instructions: row.instructions,
                max_output_tokens: row.guard.maxOutputTokens,
              },
            }),
          );
        } catch {
          fail({ code: "response_create_send_failed" });
        }
        return;
      }
      if (
        event.type === "response.output_audio_transcript.delta" &&
        typeof event.delta === "string" &&
        event.delta.trim().length > 0
      ) {
        transcriptProvided = true;
        transcript += event.delta;
        return;
      }
      if (event.type === "response.output_audio_transcript.done") {
        if (
          typeof event.transcript === "string" &&
          event.transcript.trim().length > 0
        ) {
          transcriptProvided = true;
          transcript = event.transcript;
        }
        return;
      }
      if (event.type === "response.output_audio.delta" && event.delta) {
        let chunk;
        try {
          chunk = Buffer.from(event.delta, "base64");
        } catch {
          fail({ code: "invalid_audio_delta" });
          return;
        }
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maximumBytes) {
          try {
            socket.send(JSON.stringify({ type: "response.cancel" }));
          } catch {
            // Closing the socket below is sufficient if cancellation cannot send.
          }
          fail(
            { category: "provider", code: "audio_duration_limit_exceeded" },
            "audio_duration_limit_exceeded",
          );
          return;
        }
        chunks.push(chunk);
        return;
      }
      if (event.type === "error") {
        fail(
          {
            category: "provider",
            code: event.error?.code ?? event.error?.type ?? "realtime_error",
            status: event.error?.status,
          },
          "realtime_error",
        );
        return;
      }
      if (event.type !== "response.done") return;
      if (event.response?.status !== "completed") {
        fail(
          {
            category: "provider",
            code:
              event.response?.status_details?.error?.code ??
              "realtime_incomplete",
          },
          "realtime_incomplete",
        );
        return;
      }
      if (chunks.length === 0 || receivedBytes < 2) {
        fail(
          { category: "provider", code: "empty_realtime_audio" },
          "empty_realtime_audio",
        );
        return;
      }
      try {
        normalizeRealtimeUsage(event.response?.usage);
      } catch {
        fail(
          { category: "provider", code: "missing_response_usage" },
          "missing_response_usage",
        );
        return;
      }
      settle(
        resolve,
        {
          pcm: Buffer.concat(chunks),
          usage: event.response.usage,
          transcript: transcriptProvided ? transcript : null,
          responseId,
          requestId,
        },
        "screening complete",
      );
    });

    socketOn(socket, "error", () => {
      fail({ code: "realtime_socket_error" });
    });
    socketOn(socket, "close", () => {
      if (!settled) fail({ code: "realtime_socket_closed" });
    });
  });
}

export function pcm16ToWav(pcm, sampleRate = REALTIME_SAMPLE_RATE) {
  const source = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const alignedLength = source.byteLength - (source.byteLength % 2);
  const wav = Buffer.alloc(44 + alignedLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + alignedLength, 4);
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
  wav.writeUInt32LE(alignedLength, 40);
  source.copy(wav, 44, 0, alignedLength);
  return wav;
}

async function writeManifest(manifestPath, manifest, { first = false } = {}) {
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    first ? { encoding: "utf8", flag: "wx" } : "utf8",
  );
}

function numbersMatch(left, right, tolerance = 1e-9) {
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= tolerance
  );
}

function assertManifestPlanPins(manifest, plan, evaluationDataSha256) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.phase !== "screening" ||
    manifest.model !== OPENAI_REALTIME_MINI_PRICING.model ||
    manifest.evaluationDataSha256 !== evaluationDataSha256 ||
    manifest.requestedSampleCount !== SCREENING_SAMPLE_COUNT ||
    manifest.aggregateAudioOutputTokenCap !==
      APPROVED_AGGREGATE_AUDIO_OUTPUT_TOKENS ||
    !numbersMatch(
      manifest.budget?.guardedPlanUsd,
      plan.guardedTotalUsd,
    ) ||
    !numbersMatch(
      manifest.budget?.guardedPlanJpy,
      plan.guardedTotalJpy,
    )
  ) {
    throw new Error(
      "Resume refused because the manifest does not pin the approved 24-sample plan.",
    );
  }
}

function assertVerifiedResumeBudget(
  manifest,
  plan,
  budgetJpy,
  failedRowIndex,
) {
  const budget = manifest.budget;
  if (
    !numbersMatch(budget?.maximumJpy, MAX_BUDGET_JPY) ||
    !numbersMatch(budgetJpy, budget.maximumJpy) ||
    !numbersMatch(budget.actualJpy, budget.verifiedUsageJpy) ||
    !numbersMatch(budget.actualUsd, budget.verifiedUsageUsd) ||
    !numbersMatch(budget.actualJpy, budget.actualUsd * budget.usdToJpy) ||
    !numbersMatch(budget.unverifiedReservedJpy, 0) ||
    !numbersMatch(budget.unverifiedReservedUsd, 0)
  ) {
    throw new Error(
      "Resume refused because incurred cost is not fully response.done-verified under the original 20 JPY budget.",
    );
  }
  let successfulCostJpy = 0;
  for (const sample of manifest.samples) {
    if (
      !numbersMatch(
        Number(sample.costJpy),
        Number(sample.costUsd) * budget.usdToJpy,
      )
    ) {
      throw new Error(
        `Resume refused because sample cost verification failed: ${sample.sampleId}.`,
      );
    }
    successfulCostJpy += Number(sample.costJpy);
  }
  if (
    !Number.isFinite(successfulCostJpy) ||
    budget.actualJpy <= successfulCostJpy
  ) {
    throw new Error(
      "Resume refused because the failed response cost is not represented in verified usage.",
    );
  }
  const remainingGuardJpy = plan.rows
    .slice(failedRowIndex + 1)
    .reduce((total, row) => total + row.guard.guardedJpy, 0);
  if (budget.actualJpy + remainingGuardJpy > budget.maximumJpy + 1e-9) {
    throw new Error(
      "Resume refused because verified usage plus all remaining guards exceeds the original 20 JPY budget.",
    );
  }
  return remainingGuardJpy;
}

async function assertCompletedPrefixAndFreshRemainder({
  outputDirectory,
  manifest,
  plan,
  exclusions,
  failedRowIndex,
}) {
  const audioDirectory = path.join(outputDirectory, AUDIO_DIRECTORY_NAME);
  const completedCount = manifest.completedSampleCount;
  if (
    !Number.isSafeInteger(completedCount) ||
    completedCount < 0 ||
    completedCount >= plan.rows.length ||
    !Array.isArray(manifest.samples) ||
    manifest.samples.length !== completedCount
  ) {
    throw new Error(
      "Resume refused because completed samples are not a valid plan prefix.",
    );
  }

  const expectedFiles = new Set();
  let sampleIndex = 0;
  let exclusionIndex = 0;
  for (let planIndex = 0; planIndex < failedRowIndex; planIndex += 1) {
    const row = plan.rows[planIndex];
    const exclusion = exclusions[exclusionIndex];
    if (exclusion?.sampleId === row.sampleId) {
      if (
        exclusion.profileId !== row.profileId ||
        exclusion.voice !== row.voice ||
        exclusion.scriptId !== row.scriptId ||
        exclusion.take !== row.take ||
        exclusion.reason !== "audio_transcript_mismatch" ||
        exclusion.incurredCostAccounting !== "response.done-verified" ||
        exclusion.regenerated !== false
      ) {
        throw new Error(
          `Resume refused because exclusion ${exclusionIndex + 1} is not the exact approved row.`,
        );
      }
      exclusionIndex += 1;
      continue;
    }
    const sample = manifest.samples[sampleIndex];
    const expectedFile = `${AUDIO_DIRECTORY_NAME}/${row.sampleId}.wav`;
    if (
      sample?.sampleId !== row.sampleId ||
      sample.profileId !== row.profileId ||
      sample.voice !== row.voice ||
      sample.scriptId !== row.scriptId ||
      sample.take !== row.take ||
      sample.file !== expectedFile ||
      typeof sample.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(sample.sha256)
    ) {
      throw new Error(
        `Resume refused because sample ${sampleIndex + 1} is not the exact approved prefix.`,
      );
    }
    const audioPath = path.join(outputDirectory, ...sample.file.split("/"));
    const wav = await readFile(audioPath);
    const hash = createHash("sha256").update(wav).digest("hex");
    if (wav.byteLength !== sample.bytes || hash !== sample.sha256) {
      throw new Error(
        `Resume refused because completed WAV verification failed: ${row.sampleId}.`,
      );
    }
    expectedFiles.add(`${row.sampleId}.wav`);
    sampleIndex += 1;
  }
  if (
    sampleIndex !== manifest.samples.length ||
    exclusionIndex !== exclusions.length
  ) {
    throw new Error(
      "Resume refused because samples and exclusions do not form the exact processed plan prefix.",
    );
  }

  const existingFiles = await readdir(audioDirectory);
  if (
    existingFiles.length !== expectedFiles.size ||
    existingFiles.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error(
      "Resume refused because the audio directory is not the exact completed prefix.",
    );
  }
  for (const row of plan.rows.slice(failedRowIndex + 1)) {
    const pendingPath = path.join(
      audioDirectory,
      `${row.sampleId}.wav`,
    );
    if (await fileExists(pendingPath)) {
      throw new Error(`Resume refused to overwrite: ${pendingPath}`);
    }
  }
  return audioDirectory;
}

async function loadAndValidateResumeState({
  outputDirectory,
  budgetJpy,
}) {
  const evaluationDataSha256 = await verifyApprovedEvaluationData();
  const manifestPath = path.join(outputDirectory, MANIFEST_RELATIVE_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const usdToJpy = finitePositive(
    Number(manifest.budget?.usdToJpy),
    "manifest budget.usdToJpy",
  );
  const plan = buildPaidScreeningPlan({ usdToJpy });
  assertManifestPlanPins(manifest, plan, evaluationDataSha256);
  const exclusions = Array.isArray(manifest.excludedSamples)
    ? manifest.excludedSamples
    : [];
  const resumeCount = manifest.resumeCount ?? 0;
  if (
    manifest.status !== "stopped_failure" ||
    manifest.stoppedOnFirstFailure !== true ||
    manifest.retryCount !== 0 ||
    manifest.failure?.code !== "audio_transcript_mismatch" ||
    manifest.failure?.incurredCostAccounting !== "response.done-verified" ||
    manifest.failure?.usageUnverified !== false ||
    !Number.isSafeInteger(resumeCount) ||
    resumeCount !== exclusions.length ||
    (manifest.excludedSampleCount ?? 0) !== exclusions.length ||
    exclusions.length >= MAX_TRANSCRIPT_MISMATCH_EXCLUSIONS
  ) {
    throw new Error(
      `Resume is allowed only for a response.done-verified audio_transcript_mismatch stop with fewer than ${MAX_TRANSCRIPT_MISMATCH_EXCLUSIONS} prior exclusions.`,
    );
  }
  const failedRowIndex = manifest.completedSampleCount + exclusions.length;
  const failedRow = plan.rows[failedRowIndex];
  if (!failedRow || manifest.failure.sampleId !== failedRow.sampleId) {
    throw new Error(
      "Resume refused because the failed sample is not exactly the next plan row.",
    );
  }
  const remainingGuardJpy = assertVerifiedResumeBudget(
    manifest,
    plan,
    budgetJpy,
    failedRowIndex,
  );
  const audioDirectory = await assertCompletedPrefixAndFreshRemainder({
    outputDirectory,
    manifest,
    plan,
    exclusions,
    failedRowIndex,
  });
  return {
    audioDirectory,
    exclusions,
    failedRow,
    failedRowIndex,
    manifest,
    manifestPath,
    plan,
    remainingGuardJpy,
    usdToJpy,
  };
}

async function assertTargetsAreFresh(outputDirectory, plan) {
  const manifestPath = path.join(outputDirectory, MANIFEST_RELATIVE_PATH);
  const audioDirectory = path.join(outputDirectory, AUDIO_DIRECTORY_NAME);
  const targets = [
    manifestPath,
    ...plan.rows.map((row) =>
      path.join(audioDirectory, `${row.sampleId}.wav`),
    ),
  ];
  for (const target of targets) {
    if (await fileExists(target)) {
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    }
  }
  return { manifestPath, audioDirectory };
}

async function verifyApprovedEvaluationData() {
  const bytes = await readFile(EVALUATION_DATA_URL);
  const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (hash !== APPROVED_EVALUATION_DATA_SHA256) {
    throw new Error(
      `Evaluation data hash changed (${hash}); no request was made.`,
    );
  }
  return hash;
}

function publicPricing() {
  const prices = OPENAI_REALTIME_MINI_PRICING.perMillionTokensUsd;
  return Object.freeze({
    checkedOn: OPENAI_REALTIME_MINI_PRICING.checkedOn,
    usdPerMillionTokens: Object.freeze({
      textInput: prices.textInput,
      cachedTextInput: prices.cachedTextInput,
      textOutput: prices.textOutput,
      audioOutput: prices.audioOutput,
    }),
    sources: OPENAI_REALTIME_MINI_PRICING.sources,
  });
}

export async function generateScreeningSamples({
  execute,
  confirmation,
  outputDirectory,
  budgetJpy,
  usdToJpy = DEFAULT_USD_TO_JPY,
  apiKey,
  webSocketFactory = defaultWebSocketFactory,
  timeoutMs = DEFAULT_CLIP_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  if (execute !== true) {
    throw new Error("Paid generation requires the explicit --execute flag.");
  }
  if (confirmation !== EXECUTION_CONFIRMATION) {
    throw new Error(
      `Paid generation requires --confirm ${EXECUTION_CONFIRMATION}.`,
    );
  }
  finitePositive(budgetJpy, "budgetJpy");
  if (budgetJpy > MAX_BUDGET_JPY) {
    throw new Error(`budgetJpy must not exceed ${MAX_BUDGET_JPY}.`);
  }
  finitePositive(usdToJpy, "usdToJpy");
  integerInRange(timeoutMs, "timeoutMs", 1_000, 120_000);
  if (!outputDirectory) throw new Error("outputDirectory is required.");
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
    throw new Error("OPENAI_API_KEY is required; no request was made.");
  }

  const evaluationDataSha256 = await verifyApprovedEvaluationData();
  const plan = buildPaidScreeningPlan({ usdToJpy });
  if (plan.guardedTotalJpy > budgetJpy) {
    throw new Error(
      `The guarded plan (${plan.guardedTotalJpy.toFixed(3)} JPY) exceeds the budget (${budgetJpy.toFixed(3)} JPY); no request was made.`,
    );
  }
  const resolvedOutput = path.resolve(outputDirectory);
  const { manifestPath, audioDirectory } = await assertTargetsAreFresh(
    resolvedOutput,
    plan,
  );
  await Promise.all([
    mkdir(audioDirectory, { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
  ]);

  const manifest = {
    schemaVersion: 1,
    status: "running",
    phase: "screening",
    model: OPENAI_REALTIME_MINI_PRICING.model,
    evaluationDataSha256,
    aggregateAudioOutputTokenCap: plan.aggregateOutputTokens,
    startedAt: now().toISOString(),
    finishedAt: null,
    requestedSampleCount: plan.rows.length,
    completedSampleCount: 0,
    stoppedOnFirstFailure: false,
    retryCount: 0,
    budget: {
      maximumJpy: budgetJpy,
      usdToJpy,
      guardedPlanJpy: plan.guardedTotalJpy,
      guardedPlanUsd: plan.guardedTotalUsd,
      actualUsd: 0,
      actualJpy: 0,
      verifiedUsageUsd: 0,
      verifiedUsageJpy: 0,
      unverifiedReservedUsd: 0,
      unverifiedReservedJpy: 0,
    },
    pricing: publicPricing(),
    samples: [],
    failure: null,
  };
  await writeManifest(manifestPath, manifest, { first: true });

  let actualUsd = 0;
  let actualJpy = 0;
  let verifiedUsageUsd = 0;
  let verifiedUsageJpy = 0;
  let unverifiedReservedUsd = 0;
  let unverifiedReservedJpy = 0;
  const updateManifestBudget = () => {
    manifest.budget.actualUsd = actualUsd;
    manifest.budget.actualJpy = actualJpy;
    manifest.budget.verifiedUsageUsd = verifiedUsageUsd;
    manifest.budget.verifiedUsageJpy = verifiedUsageJpy;
    manifest.budget.unverifiedReservedUsd = unverifiedReservedUsd;
    manifest.budget.unverifiedReservedJpy = unverifiedReservedJpy;
  };
  for (let rowIndex = 0; rowIndex < plan.rows.length; rowIndex += 1) {
    const row = plan.rows[rowIndex];
    const remainingGuardJpy = plan.rows
      .slice(rowIndex)
      .reduce((total, pending) => total + pending.guard.guardedJpy, 0);
    if (actualJpy + remainingGuardJpy > budgetJpy) {
      manifest.status = "stopped_budget_guard";
      manifest.stoppedOnFirstFailure = true;
      manifest.failure = {
        sampleId: row.sampleId,
        category: "budget",
        code: "remaining_plan_guard_exceeds_budget",
        remainingGuardJpy,
      };
      break;
    }
    let incurredAccounted = false;
    try {
      // A new WebSocket is deliberately created for every clip. Realtime
      // sessions cannot change voice after they have emitted audio.
      const generated = await generateRealtimeClip({
        apiKey,
        row,
        webSocketFactory,
        timeoutMs,
      });
      const cost = realtimeUsageCost(generated.usage, usdToJpy);
      actualUsd += cost.totalUsd;
      actualJpy += cost.totalJpy;
      verifiedUsageUsd += cost.totalUsd;
      verifiedUsageJpy += cost.totalJpy;
      incurredAccounted = true;
      updateManifestBudget();
      if (actualJpy > budgetJpy) {
        throw Object.assign(new Error("budget_exceeded_after_response"), {
          category: "provider",
          code: "budget_exceeded_after_response",
        });
      }
      const normalizedInput = normalizeTranscript(row.text);
      const normalizedOutput =
        generated.transcript === null
          ? null
          : normalizeTranscript(generated.transcript);
      if (
        normalizedOutput !== null &&
        normalizedOutput !== normalizedInput
      ) {
        throw Object.assign(new Error("audio_transcript_mismatch"), {
          category: "provider",
          code: "audio_transcript_mismatch",
        });
      }
      const audio = validatePcm16Audio(generated.pcm, row);
      const wav = pcm16ToWav(generated.pcm);
      const audioPath = path.join(
        audioDirectory,
        `${row.sampleId}.wav`,
      );
      await writeFile(audioPath, wav, { flag: "wx" });
      manifest.samples.push({
        sampleId: row.sampleId,
        profileId: row.profileId,
        voice: row.voice,
        scriptId: row.scriptId,
        take: row.take,
        file: `${AUDIO_DIRECTORY_NAME}/${row.sampleId}.wav`,
        bytes: wav.byteLength,
        durationSeconds: audio.durationSeconds,
        normalizedRms: audio.normalizedRms,
        clippedSampleRatio: audio.clippedSampleRatio,
        sha256: createHash("sha256").update(wav).digest("hex"),
        provider: {
          responseId: generated.responseId,
          requestId: generated.requestId,
        },
        transcript:
          normalizedOutput === null
            ? {
                availability: "unavailable",
                normalizedMatchesInput: null,
                sha256: null,
              }
            : {
                availability: "provided",
                normalizedMatchesInput:
                  normalizedOutput === normalizedInput,
                sha256: createHash("sha256")
                  .update(generated.transcript, "utf8")
                  .digest("hex"),
              },
        usage: cost.usage,
        costUsd: cost.totalUsd,
        costJpy: cost.totalJpy,
      });
      manifest.completedSampleCount = manifest.samples.length;
      updateManifestBudget();
      await writeManifest(manifestPath, manifest);
    } catch (error) {
      if (!incurredAccounted && error?.usageUnverified === true) {
        actualUsd += row.guard.guardedUsd;
        actualJpy += row.guard.guardedJpy;
        unverifiedReservedUsd += row.guard.guardedUsd;
        unverifiedReservedJpy += row.guard.guardedJpy;
        updateManifestBudget();
      }
      manifest.status = "stopped_failure";
      manifest.stoppedOnFirstFailure = true;
      manifest.failure = {
        sampleId: row.sampleId,
        ...safeFailure(error, "sample_generation_failed"),
        incurredCostAccounting:
          incurredAccounted
            ? "response.done-verified"
            : error?.usageUnverified === true
              ? "full-sample-guard-reserved"
              : "none-before-response",
      };
      break;
    }
  }

  if (manifest.status === "running") {
    manifest.status = "completed";
  }
  manifest.finishedAt = now().toISOString();
  manifest.completedSampleCount = manifest.samples.length;
  updateManifestBudget();
  await writeManifest(manifestPath, manifest);
  return Object.freeze({
    outputDirectory: resolvedOutput,
    manifestPath,
    manifest,
  });
}

export async function resumeScreeningSamples({
  execute,
  resume,
  confirmation,
  outputDirectory,
  budgetJpy,
  apiKey,
  webSocketFactory = defaultWebSocketFactory,
  timeoutMs = DEFAULT_CLIP_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  if (execute !== true || resume !== true) {
    throw new Error(
      "Paid continuation requires the explicit --execute and --resume flags.",
    );
  }
  if (confirmation !== RESUME_CONFIRMATION) {
    throw new Error(
      `Paid continuation requires --confirm ${RESUME_CONFIRMATION}.`,
    );
  }
  finitePositive(budgetJpy, "budgetJpy");
  if (budgetJpy > MAX_BUDGET_JPY) {
    throw new Error(`budgetJpy must not exceed ${MAX_BUDGET_JPY}.`);
  }
  integerInRange(timeoutMs, "timeoutMs", 1_000, 120_000);
  if (!outputDirectory) throw new Error("outputDirectory is required.");
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
    throw new Error("OPENAI_API_KEY is required; no request was made.");
  }

  const resolvedOutput = path.resolve(outputDirectory);
  const state = await loadAndValidateResumeState({
    outputDirectory: resolvedOutput,
    budgetJpy,
  });
  const {
    audioDirectory,
    exclusions,
    failedRow,
    failedRowIndex,
    manifest,
    manifestPath,
    plan,
    usdToJpy,
  } = state;
  const resumeStartedAt = now().toISOString();
  manifest.status = "resuming_after_validation_exclusion";
  manifest.finishedAt = null;
  manifest.stoppedOnFirstFailure = false;
  manifest.resumeCount = exclusions.length + 1;
  manifest.excludedSamples = [
    ...exclusions,
    {
      sampleId: failedRow.sampleId,
      profileId: failedRow.profileId,
      voice: failedRow.voice,
      scriptId: failedRow.scriptId,
      take: failedRow.take,
      reason: "audio_transcript_mismatch",
      incurredCostAccounting: "response.done-verified",
      regenerated: false,
      excludedAt: resumeStartedAt,
    },
  ];
  manifest.excludedSampleCount = manifest.excludedSamples.length;
  const priorResumeHistory = Array.isArray(manifest.resumeHistory)
    ? manifest.resumeHistory
    : [];
  manifest.resumeHistory = manifest.resume
    ? [...priorResumeHistory, manifest.resume]
    : priorResumeHistory;
  manifest.resume = {
    startedAt: resumeStartedAt,
    finishedAt: null,
    confirmation: RESUME_CONFIRMATION,
    firstContinuedSampleId:
      plan.rows[failedRowIndex + 1]?.sampleId ?? null,
  };
  manifest.failure = null;
  await writeManifest(manifestPath, manifest);

  let actualUsd = manifest.budget.actualUsd;
  let actualJpy = manifest.budget.actualJpy;
  let verifiedUsageUsd = manifest.budget.verifiedUsageUsd;
  let verifiedUsageJpy = manifest.budget.verifiedUsageJpy;
  let unverifiedReservedUsd = manifest.budget.unverifiedReservedUsd;
  let unverifiedReservedJpy = manifest.budget.unverifiedReservedJpy;
  const updateManifestBudget = () => {
    manifest.budget.actualUsd = actualUsd;
    manifest.budget.actualJpy = actualJpy;
    manifest.budget.verifiedUsageUsd = verifiedUsageUsd;
    manifest.budget.verifiedUsageJpy = verifiedUsageJpy;
    manifest.budget.unverifiedReservedUsd = unverifiedReservedUsd;
    manifest.budget.unverifiedReservedJpy = unverifiedReservedJpy;
  };
  const firstResumeRowIndex = failedRowIndex + 1;
  for (
    let rowIndex = firstResumeRowIndex;
    rowIndex < plan.rows.length;
    rowIndex += 1
  ) {
    const row = plan.rows[rowIndex];
    const remainingGuardJpy = plan.rows
      .slice(rowIndex)
      .reduce((total, pending) => total + pending.guard.guardedJpy, 0);
    if (actualJpy + remainingGuardJpy > budgetJpy + 1e-9) {
      manifest.status = "stopped_budget_guard";
      manifest.stoppedOnFirstFailure = true;
      manifest.failure = {
        sampleId: row.sampleId,
        category: "budget",
        code: "remaining_plan_guard_exceeds_budget",
        remainingGuardJpy,
      };
      break;
    }
    let incurredAccounted = false;
    try {
      const generated = await generateRealtimeClip({
        apiKey,
        row,
        webSocketFactory,
        timeoutMs,
      });
      const cost = realtimeUsageCost(generated.usage, usdToJpy);
      actualUsd += cost.totalUsd;
      actualJpy += cost.totalJpy;
      verifiedUsageUsd += cost.totalUsd;
      verifiedUsageJpy += cost.totalJpy;
      incurredAccounted = true;
      updateManifestBudget();
      if (actualJpy > budgetJpy + 1e-9) {
        throw Object.assign(new Error("budget_exceeded_after_response"), {
          category: "provider",
          code: "budget_exceeded_after_response",
        });
      }
      const normalizedInput = normalizeTranscript(row.text);
      const normalizedOutput =
        generated.transcript === null
          ? null
          : normalizeTranscript(generated.transcript);
      if (
        normalizedOutput !== null &&
        normalizedOutput !== normalizedInput
      ) {
        throw Object.assign(new Error("audio_transcript_mismatch"), {
          category: "provider",
          code: "audio_transcript_mismatch",
        });
      }
      const audio = validatePcm16Audio(generated.pcm, row);
      const wav = pcm16ToWav(generated.pcm);
      const audioPath = path.join(
        audioDirectory,
        `${row.sampleId}.wav`,
      );
      await writeFile(audioPath, wav, { flag: "wx" });
      manifest.samples.push({
        sampleId: row.sampleId,
        profileId: row.profileId,
        voice: row.voice,
        scriptId: row.scriptId,
        take: row.take,
        file: `${AUDIO_DIRECTORY_NAME}/${row.sampleId}.wav`,
        bytes: wav.byteLength,
        durationSeconds: audio.durationSeconds,
        normalizedRms: audio.normalizedRms,
        clippedSampleRatio: audio.clippedSampleRatio,
        sha256: createHash("sha256").update(wav).digest("hex"),
        provider: {
          responseId: generated.responseId,
          requestId: generated.requestId,
        },
        transcript:
          normalizedOutput === null
            ? {
                availability: "unavailable",
                normalizedMatchesInput: null,
                sha256: null,
              }
            : {
                availability: "provided",
                normalizedMatchesInput:
                  normalizedOutput === normalizedInput,
                sha256: createHash("sha256")
                  .update(generated.transcript, "utf8")
                  .digest("hex"),
              },
        usage: cost.usage,
        costUsd: cost.totalUsd,
        costJpy: cost.totalJpy,
      });
      manifest.completedSampleCount = manifest.samples.length;
      updateManifestBudget();
      await writeManifest(manifestPath, manifest);
    } catch (error) {
      if (!incurredAccounted && error?.usageUnverified === true) {
        actualUsd += row.guard.guardedUsd;
        actualJpy += row.guard.guardedJpy;
        unverifiedReservedUsd += row.guard.guardedUsd;
        unverifiedReservedJpy += row.guard.guardedJpy;
        updateManifestBudget();
      }
      manifest.status = "stopped_failure";
      manifest.stoppedOnFirstFailure = true;
      manifest.failure = {
        sampleId: row.sampleId,
        ...safeFailure(error, "sample_generation_failed"),
        incurredCostAccounting:
          incurredAccounted
            ? "response.done-verified"
            : error?.usageUnverified === true
              ? "full-sample-guard-reserved"
              : "none-before-response",
      };
      break;
    }
  }

  if (manifest.status === "resuming_after_validation_exclusion") {
    manifest.status = "completed_with_exclusion";
  }
  const finishedAt = now().toISOString();
  manifest.finishedAt = finishedAt;
  manifest.resume.finishedAt = finishedAt;
  manifest.completedSampleCount = manifest.samples.length;
  manifest.excludedSampleCount = manifest.excludedSamples.length;
  updateManifestBudget();
  await writeManifest(manifestPath, manifest);
  return Object.freeze({
    outputDirectory: resolvedOutput,
    manifestPath,
    manifest,
  });
}

export async function runCli(argv = process.argv.slice(2), overrides = {}) {
  if (argv.includes("--help")) {
    return {
      help: [
        "Paid, guarded screening generation. This command has no dry-run mode.",
        `Required: --execute --confirm ${EXECUTION_CONFIRMATION} --budget-jpy <positive, max ${MAX_BUDGET_JPY}> --output <directory>`,
        `Validated continuation (maximum ${MAX_TRANSCRIPT_MISMATCH_EXCLUSIONS} transcript-mismatch exclusions): --execute --resume --confirm ${RESUME_CONFIRMATION} --budget-jpy ${MAX_BUDGET_JPY} --output <existing directory>`,
        `Optional: --usd-jpy ${DEFAULT_USD_TO_JPY} --timeout-ms ${DEFAULT_CLIP_TIMEOUT_MS}`,
        "The command reads OPENAI_API_KEY and never prints or stores it.",
        "There are no automatic retries. The first provider or transport failure stops the run.",
      ].join("\n"),
    };
  }
  const sharedOptions = {
    execute: argv.includes("--execute"),
    resume: argv.includes("--resume"),
    confirmation: argument(argv, "--confirm"),
    outputDirectory: argument(argv, "--output"),
    budgetJpy: requiredNumberArgument(argv, "--budget-jpy"),
    timeoutMs: optionalNumberArgument(
      argv,
      "--timeout-ms",
      DEFAULT_CLIP_TIMEOUT_MS,
    ),
    apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY,
    webSocketFactory: overrides.webSocketFactory,
    now: overrides.now,
  };
  if (sharedOptions.resume) {
    if (argument(argv, "--usd-jpy") !== undefined) {
      throw new Error(
        "--usd-jpy cannot be changed during resume; it is pinned by the manifest.",
      );
    }
    return resumeScreeningSamples(sharedOptions);
  }
  return generateScreeningSamples({
    ...sharedOptions,
    usdToJpy: optionalNumberArgument(
      argv,
      "--usd-jpy",
      DEFAULT_USD_TO_JPY,
    ),
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
        return;
      }
      console.log(
        JSON.stringify(
          {
            status: result.manifest.status,
            model: result.manifest.model,
            completedSampleCount: result.manifest.completedSampleCount,
            actualJpy: result.manifest.budget.actualJpy,
            manifestPath: result.manifestPath,
          },
          null,
          2,
        ),
      );
      if (
        result.manifest.status !== "completed" &&
        result.manifest.status !== "completed_with_exclusion"
      ) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
