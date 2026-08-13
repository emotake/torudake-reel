import { env } from "cloudflare:workers";

const DIMENSION_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_COUNTER_INCREMENT = 1_000_000_000;
const MAX_AUDIO_SECONDS_INCREMENT = 24 * 60 * 60;

export type ProviderUsageOutcome = "success" | "failure";

export type ProviderUsageIncrement = Readonly<{
  provider: "openai";
  model: string;
  operation:
    | "narration_initial"
    | "narration_script"
    | "narration_speech"
    | "narration_partial_correction"
    | "transcribe"
    | "transcribe_refine";
  outcome: ProviderUsageOutcome;
  inputTokens?: number;
  outputTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  audioSeconds?: number;
  inputCharacters?: number;
  occurredAt?: Date;
}>;

export type ProviderUsageDailyRow = Readonly<{
  day: string;
  provider: string;
  model: string;
  operation: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  audioSeconds: number;
  inputCharacters: number;
  updatedAt: number;
}>;

type D1Result<T> = { results?: T[] };
type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  run: () => Promise<unknown>;
  all: <T>() => Promise<D1Result<T>>;
};
export type ProviderUsageDatabase = {
  prepare: (query: string) => D1Statement;
};

function nonNegativeInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_COUNTER_INCREMENT, Math.floor(value));
}

function nonNegativeSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_AUDIO_SECONDS_INCREMENT, Math.round(value * 1_000) / 1_000);
}

function safeDimension(value: string, field: string) {
  const normalized = value.trim();
  if (!DIMENSION_PATTERN.test(normalized)) {
    throw new Error(`Invalid provider usage ${field}.`);
  }
  return normalized;
}

export function normalizeProviderUsageIncrement(input: ProviderUsageIncrement) {
  const occurredAt = input.occurredAt ?? new Date();
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new Error("Invalid provider usage timestamp.");
  }
  const day = occurredAt.toISOString().slice(0, 10);
  return {
    day,
    provider: safeDimension(input.provider, "provider"),
    model: safeDimension(input.model, "model"),
    operation: safeDimension(input.operation, "operation"),
    requestCount: 1,
    successCount: input.outcome === "success" ? 1 : 0,
    failureCount: input.outcome === "failure" ? 1 : 0,
    inputTokens: nonNegativeInteger(input.inputTokens),
    outputTokens: nonNegativeInteger(input.outputTokens),
    inputAudioTokens: nonNegativeInteger(input.inputAudioTokens),
    outputAudioTokens: nonNegativeInteger(input.outputAudioTokens),
    audioSeconds: nonNegativeSeconds(input.audioSeconds),
    inputCharacters: nonNegativeInteger(input.inputCharacters),
    updatedAt: Math.floor(occurredAt.getTime() / 1_000),
  };
}

function usageDatabase(override?: ProviderUsageDatabase) {
  if (override?.prepare) return override;
  const database = env.DB as unknown as ProviderUsageDatabase | undefined;
  if (!database?.prepare) throw new Error("Provider usage database unavailable.");
  return database;
}

export async function recordProviderUsageBestEffort(
  increment: ProviderUsageIncrement,
  databaseOverride?: ProviderUsageDatabase,
) {
  let normalized: ReturnType<typeof normalizeProviderUsageIncrement> | null = null;
  try {
    normalized = normalizeProviderUsageIncrement(increment);
    await usageDatabase(databaseOverride)
      .prepare(`
        INSERT INTO provider_usage_daily (
          day, provider, model, operation,
          request_count, success_count, failure_count,
          input_tokens, output_tokens,
          input_audio_tokens, output_audio_tokens,
          audio_seconds, input_characters, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, provider, model, operation) DO UPDATE SET
          request_count = provider_usage_daily.request_count + excluded.request_count,
          success_count = provider_usage_daily.success_count + excluded.success_count,
          failure_count = provider_usage_daily.failure_count + excluded.failure_count,
          input_tokens = provider_usage_daily.input_tokens + excluded.input_tokens,
          output_tokens = provider_usage_daily.output_tokens + excluded.output_tokens,
          input_audio_tokens = provider_usage_daily.input_audio_tokens + excluded.input_audio_tokens,
          output_audio_tokens = provider_usage_daily.output_audio_tokens + excluded.output_audio_tokens,
          audio_seconds = provider_usage_daily.audio_seconds + excluded.audio_seconds,
          input_characters = provider_usage_daily.input_characters + excluded.input_characters,
          updated_at = MAX(provider_usage_daily.updated_at, excluded.updated_at)
      `)
      .bind(
        normalized.day,
        normalized.provider,
        normalized.model,
        normalized.operation,
        normalized.requestCount,
        normalized.successCount,
        normalized.failureCount,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.inputAudioTokens,
        normalized.outputAudioTokens,
        normalized.audioSeconds,
        normalized.inputCharacters,
        normalized.updatedAt,
      )
      .run();
    return true;
  } catch (error) {
    console.warn({
      schemaVersion: 1,
      severity: "warn",
      service: "torudake-reel",
      component: "provider_usage",
      event: "provider_usage_record_failed",
      provider: normalized?.provider ?? "invalid",
      model: normalized?.model ?? "invalid",
      operation: normalized?.operation ?? "invalid",
      errorName: error instanceof Error ? error.name : "NonErrorThrown",
    });
    return false;
  }
}

export async function listProviderUsageDaily(
  options: Readonly<{ sinceDay?: string; limit?: number }> = {},
  databaseOverride?: ProviderUsageDatabase,
) {
  const sinceDay = options.sinceDay?.trim() || "1970-01-01";
  if (!DAY_PATTERN.test(sinceDay)) throw new Error("Invalid provider usage start day.");
  const limit = Math.min(1_000, Math.max(1, Math.floor(options.limit ?? 180)));
  const result = await usageDatabase(databaseOverride)
    .prepare(`
      SELECT
        day,
        provider,
        model,
        operation,
        request_count AS requestCount,
        success_count AS successCount,
        failure_count AS failureCount,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        input_audio_tokens AS inputAudioTokens,
        output_audio_tokens AS outputAudioTokens,
        audio_seconds AS audioSeconds,
        input_characters AS inputCharacters,
        updated_at AS updatedAt
      FROM provider_usage_daily
      WHERE day >= ?
      ORDER BY day DESC, provider ASC, model ASC, operation ASC
      LIMIT ?
    `)
    .bind(sinceDay, limit)
    .all<ProviderUsageDailyRow>();
  return result.results ?? [];
}

