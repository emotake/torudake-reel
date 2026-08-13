#!/usr/bin/env node

const EXECUTION_CONFIRMATION = "execute-due-account-deletions";
const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const confirmation = valueAfter("--confirm");
const limit = parseLimit(valueAfter("--limit") ?? "5");
const origin = safeOrigin(
  process.env.TORUDAKE_SITE_ORIGIN ?? "https://torudake-reel.pages.dev",
);
const secret = process.env.ACCOUNT_DELETION_OPERATIONS_SECRET?.trim() ?? "";

if (secret.length < 32) {
  throw new Error(
    "ACCOUNT_DELETION_OPERATIONS_SECRET (32+ characters) is required.",
  );
}
if (execute && confirmation !== EXECUTION_CONFIRMATION) {
  throw new Error(
    `Execution requires --confirm ${EXECUTION_CONFIRMATION}. Run without --execute first.`,
  );
}

const headers = {
  Authorization: `Bearer ${secret}`,
  "Content-Type": "application/json",
};
if (execute) headers["X-Operations-Confirm"] = EXECUTION_CONFIRMATION;

const response = await fetch(`${origin}/api/internal/account-deletions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    dryRun: !execute,
    limit,
    ...(execute ? { confirmation: EXECUTION_CONFIRMATION } : {}),
  }),
});
const body = await response.json().catch(() => null);
if (!response.ok || !body) {
  throw new Error(
    `Account deletion operation failed (${response.status}, request ${response.headers.get("x-request-id") ?? "unknown"}).`,
  );
}

console.log(
  JSON.stringify(
    {
      mode: execute ? "execute" : "dry-run",
      requestId: body.requestId,
      scanned: body.scanned,
      ready: body.ready,
      completed: body.completed,
      blocked: body.blocked,
      failed: body.failed,
      skipped: body.skipped,
      results: body.results,
    },
    null,
    2,
  ),
);
if (body.failed > 0) process.exitCode = 2;

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25) {
    throw new Error("--limit must be an integer from 1 to 25.");
  }
  return parsed;
}

function safeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("TORUDAKE_SITE_ORIGIN must use HTTPS.");
  }
  return url.origin;
}
