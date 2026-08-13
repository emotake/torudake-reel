const EXECUTION_CONFIRMATION = "execute-due-account-deletions";
const DEFAULT_ORIGIN = "https://torudake-reel.pages.dev";
const DEFAULT_BATCH_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 25_000;

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
    const body = await response.json().catch(() => null);
    if (!response.ok || !validExecutionResult(body)) {
      throw new Error(
        `Account deletion scheduler failed (status=${response.status}, requestId=${safeIdentifier(body?.requestId)}).`,
      );
    }
    if (body.failed > 0) {
      throw new Error(
        `Account deletion scheduler reported failures (requestId=${safeIdentifier(body.requestId)}, failed=${body.failed}).`,
      );
    }
    console.log(
      JSON.stringify({
        event: "account_deletion_schedule_completed",
        requestId: safeIdentifier(body.requestId),
        scanned: body.scanned,
        completed: body.completed,
        blocked: body.blocked,
        skipped: body.skipped,
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

function validExecutionResult(value) {
  if (!value || typeof value !== "object" || value.dryRun !== false) return false;
  return ["scanned", "completed", "blocked", "failed", "skipped"].every(
    (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
  );
}

function safeIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value)
    ? value
    : "missing";
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
