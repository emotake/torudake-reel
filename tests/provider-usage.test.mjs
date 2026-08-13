import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  listProviderUsageDaily,
  normalizeProviderUsageIncrement,
  recordProviderUsageBestEffort,
} from "../lib/provider-usage.ts";

const migrationSource = readFileSync(
  new URL("../drizzle/0022_outstanding_captain_cross.sql", import.meta.url),
  "utf8",
);
const schemaSource = readFileSync(
  new URL("../db/schema.ts", import.meta.url),
  "utf8",
);
const scriptRouteSource = readFileSync(
  new URL("../app/api/narration/script/route.ts", import.meta.url),
  "utf8",
);
const speechRouteSource = readFileSync(
  new URL("../app/api/narration/speech/route.ts", import.meta.url),
  "utf8",
);
const transcribeRouteSource = readFileSync(
  new URL("../app/api/transcribe/route.ts", import.meta.url),
  "utf8",
);

function fakeDatabase(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(query) {
      const call = { query, values: [] };
      return {
        bind(...values) {
          call.values = values;
          return this;
        },
        async run() {
          calls.push(call);
          return {};
        },
        async all() {
          calls.push(call);
          return { results: rows };
        },
      };
    },
  };
}

test("provider usage dimensions contain no personal or request identifier", () => {
  assert.match(migrationSource, /CREATE TABLE `provider_usage_daily`/u);
  assert.match(
    migrationSource,
    /PRIMARY KEY\(`day`, `provider`, `model`, `operation`\)/u,
  );
  assert.doesNotMatch(
    migrationSource,
    /user_id|actor_hash|request_id|email|filename|transcript|script/u,
  );
  assert.match(schemaSource, /Privacy-minimal provider cost telemetry/u);
});

test("provider usage increments are bounded UTC aggregates", () => {
  const record = normalizeProviderUsageIncrement({
    provider: "openai",
    model: "gpt-realtime-2.1-mini",
    operation: "narration_speech",
    outcome: "success",
    inputTokens: 12.9,
    outputTokens: -4,
    audioSeconds: 1.23456,
    occurredAt: new Date("2026-08-13T23:59:59.000Z"),
  });
  assert.deepEqual(
    {
      day: record.day,
      requestCount: record.requestCount,
      successCount: record.successCount,
      failureCount: record.failureCount,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      audioSeconds: record.audioSeconds,
    },
    {
      day: "2026-08-13",
      requestCount: 1,
      successCount: 1,
      failureCount: 0,
      inputTokens: 12,
      outputTokens: 0,
      audioSeconds: 1.235,
    },
  );
});

test("provider usage uses one atomic additive upsert and never throws", async () => {
  const database = fakeDatabase();
  assert.equal(
    await recordProviderUsageBestEffort(
      {
        provider: "openai",
        model: "gpt-5.6-luna",
        operation: "narration_script",
        outcome: "failure",
      },
      database,
    ),
    true,
  );
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0].query, /ON CONFLICT\(day, provider, model, operation\)/u);
  assert.match(database.calls[0].query, /request_count = provider_usage_daily\.request_count \+ excluded\.request_count/u);
  assert.equal(database.calls[0].values[4], 1);
  assert.equal(database.calls[0].values[5], 0);
  assert.equal(database.calls[0].values[6], 1);

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const broken = { prepare: () => { throw new Error("unavailable"); } };
    assert.equal(
      await recordProviderUsageBestEffort(
        {
          provider: "openai",
          model: "whisper-1",
          operation: "transcribe",
          outcome: "failure",
        },
        broken,
      ),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("operator read contract returns aggregate rows only", async () => {
  const row = {
    day: "2026-08-13",
    provider: "openai",
    model: "whisper-1",
    operation: "transcribe",
    requestCount: 2,
    successCount: 1,
    failureCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    audioSeconds: 71.2,
    inputCharacters: 0,
    updatedAt: 1,
  };
  const database = fakeDatabase([row]);
  assert.deepEqual(
    await listProviderUsageDaily(
      { sinceDay: "2026-08-01", limit: 30 },
      database,
    ),
    [row],
  );
  assert.deepEqual(database.calls[0].values, ["2026-08-01", 30]);
});

test("all OpenAI routes record provider usage from their strongest source", () => {
  assert.match(scriptRouteSource, /responsePayload\.usage\?\.input_tokens/u);
  assert.match(speechRouteSource, /event\.response\?\.usage/u);
  assert.match(speechRouteSource, /receivedAudioBytes \/ \(REALTIME_SAMPLE_RATE \* 2\)/u);
  assert.match(transcribeRouteSource, /transcriptionDurationSeconds\(transcription/u);
  assert.match(transcribeRouteSource, /recordTranscriptionProviderUsage/u);
});

