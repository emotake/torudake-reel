import { readBoundedJsonResponse } from "../lib/bounded-json-response.mjs";

const EXECUTION_CONFIRMATION = "execute-due-account-deletions";
const DEFAULT_ORIGIN = "https://torudake-reel.pages.dev";
const DEFAULT_BATCH_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ACCOUNT_REFERENCE_PATTERN = /^[0-9a-f]{24}$/;
const REASON_CODE_PATTERN = /^[a-z0-9_]{1,128}$/;

export async function executeDueAccountDeletions(
  environment,
  fetchImpl = fetch,
) {
  const secret = environment.ACCOUNT_DELETION_OPERATIONS_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error("Account deletion scheduler secret is unavailable.");
  }
  const origin = normalizeOrigin(environment.TORUDAKE_SITE_ORIGIN);
  const limit = normalizeLimit(environment.ACCOUNT_DELETION_BATCH_LIMIT);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${origin}/api/internal/account-deletions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "X-Operations-Confirm": EXECUTION_CONFIRMATION,
      },
      body: JSON.stringify({
        dryRun: false,
        limit,
        confirmation: EXECUTION_CONFIRMATION,
      }),
      signal: controller.signal,
    });
    const body = await readBoundedJsonResponse(response, {
      maxBytes: MAX_RESPONSE_BYTES,
    }).catch(() => null);
    if (
      !response.ok ||
      !isValidAccountDeletionExecutionResult(body, {
        expectedDryRun: false,
        expectedLimit: limit,
      })
    ) {
      throw new Error(
        `Account deletion scheduler failed (status=${response.status}, requestId=${safeIdentifier(body?.requestId)}).`,
      );
    }
    if (body.failed > 0) {
      throw new Error(
        `Account deletion scheduler reported failures (requestId=${safeIdentifier(body.requestId)}, failed=${body.failed}).`,
      );
    }
    if (body.challengeRetention.status === "failed") {
      throw new Error(
        `Account challenge retention failed (requestId=${safeIdentifier(body.requestId)}).`,
      );
    }
    if (body.challengeRetention.hasMore) {
      throw new Error(
        `Account challenge retention remains backlogged (requestId=${safeIdentifier(body.requestId)}).`,
      );
    }
    console.log(
      JSON.stringify({
        event: "account_deletion_schedule_completed",
        requestId: safeIdentifier(body.requestId),
        scanned: body.scanned,
        ready: body.ready,
        completed: body.completed,
        blocked: body.blocked,
        skipped: body.skipped,
        expiredAccountAuthChallenges:
          body.challengeRetention.accountAuthChallenges,
        expiredAccountEmailChallenges:
          body.challengeRetention.accountEmailChallenges,
        expiredAccountOauthChallenges:
          body.challengeRetention.accountOauthChallenges,
        expiredAccountRecoveryChallenges:
          body.challengeRetention.accountRecoveryChallenges,
        expiredAccountChallengesTotal: body.challengeRetention.total,
        challengeRetentionBatches: body.challengeRetention.batches,
        challengeRetentionHasMore: body.challengeRetention.hasMore,
      }),
    );
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOrigin(value) {
  const url = new URL(value?.trim() || DEFAULT_ORIGIN);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("TORUDAKE_SITE_ORIGIN must be an HTTPS origin.");
  }
  return url.origin;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_BATCH_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25) {
    throw new Error("ACCOUNT_DELETION_BATCH_LIMIT must be from 1 to 25.");
  }
  return parsed;
}

export function isValidAccountDeletionExecutionResult(
  value,
  { expectedDryRun = false, expectedLimit } = {},
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.dryRun !== expectedDryRun ||
    !isSafeIdentifier(value.requestId) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 25 ||
    (expectedLimit !== undefined && value.limit !== expectedLimit) ||
    !Array.isArray(value.results)
  ) {
    return false;
  }
  const validCounts = [
    "scanned",
    "ready",
    "completed",
    "blocked",
    "failed",
    "skipped",
  ].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
  if (
    !validCounts ||
    value.scanned > value.limit ||
    value.results.length !== value.scanned ||
    !validDeletionResults(value.results, value) ||
    value.ready +
        value.completed +
        value.blocked +
        value.failed +
        value.skipped !==
      value.scanned ||
    (expectedDryRun
      ? value.completed !== 0 || value.skipped !== 0
      : value.ready !== 0)
  ) {
    return false;
  }
  const topLevelKeys = [
    "dryRun",
    "limit",
    "requestId",
    "scanned",
    "ready",
    "completed",
    "blocked",
    "failed",
    "skipped",
    "results",
    "challengeRetention",
  ];
  if (
    Object.keys(value).length !== topLevelKeys.length ||
    !topLevelKeys.every((key) => Object.hasOwn(value, key))
  ) {
    return false;
  }
  if (expectedDryRun) {
    return (
      value.challengeRetention?.status === "skipped" &&
      value.challengeRetention.reason === "dry_run" &&
      Object.keys(value.challengeRetention).length === 2
    );
  }
  if (value.challengeRetention?.status === "failed") {
    return (
      value.challengeRetention.reason === "challenge_retention_failed" &&
      Object.keys(value.challengeRetention).length === 2
    );
  }
  return validChallengeRetentionResult(value.challengeRetention);
}

function validChallengeRetentionResult(value) {
  if (!value || typeof value !== "object" || value.status !== "purged") {
    return false;
  }
  const keys = [
    "status",
    "accountAuthChallenges",
    "accountEmailChallenges",
    "accountOauthChallenges",
    "accountRecoveryChallenges",
    "total",
    "batches",
    "hasMore",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(
      (key) => key === "status" || key === "hasMore" ||
        (Number.isSafeInteger(value[key]) && value[key] >= 0),
    ) ||
    typeof value.hasMore !== "boolean" ||
    !Number.isSafeInteger(value.batches) ||
    value.batches < 1 ||
    value.batches > 4
  ) {
    return false;
  }
  return (
    value.total ===
    value.accountAuthChallenges +
      value.accountEmailChallenges +
      value.accountOauthChallenges +
      value.accountRecoveryChallenges
  );
}

function validDeletionResults(results, counts) {
  const outcomes = {
    ready: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
  };
  for (const result of results) {
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 3 ||
      !Object.hasOwn(result, "accountReference") ||
      !Object.hasOwn(result, "outcome") ||
      !Object.hasOwn(result, "reasonCode") ||
      typeof result.accountReference !== "string" ||
      !ACCOUNT_REFERENCE_PATTERN.test(result.accountReference) ||
      !Object.hasOwn(outcomes, result.outcome)
    ) {
      return false;
    }
    if (
      result.outcome === "ready" ||
      result.outcome === "completed"
        ? result.reasonCode !== null
        : typeof result.reasonCode !== "string" ||
          !REASON_CODE_PATTERN.test(result.reasonCode)
    ) {
      return false;
    }
    outcomes[result.outcome] += 1;
  }
  return Object.entries(outcomes).every(
    ([outcome, count]) => counts[outcome] === count,
  );
}

function isSafeIdentifier(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function safeIdentifier(value) {
  return isSafeIdentifier(value) ? value : "missing";
}

const accountDeletionScheduler = {
  async scheduled(_controller, environment, context) {
    context.waitUntil(executeDueAccountDeletions(environment));
  },
  async fetch() {
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },
};

export default accountDeletionScheduler;
