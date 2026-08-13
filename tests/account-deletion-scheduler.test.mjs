import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeDueAccountDeletions } from "../workers/account-deletion-scheduler.mjs";

const SECRET = "scheduler-secret-that-is-at-least-thirty-two-characters";

test("scheduled executor uses the dedicated secret and both confirmations", async () => {
  let captured;
  const result = await executeDueAccountDeletions(
    { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
    async (url, init) => {
      captured = { url, init };
      return Response.json({
        dryRun: false,
        requestId: "scheduler-request-0001",
        scanned: 1,
        completed: 1,
        blocked: 0,
        failed: 0,
        skipped: 0,
      });
    },
  );

  assert.equal(result.completed, 1);
  assert.equal(
    captured.url,
    "https://torudake-reel.pages.dev/api/internal/account-deletions",
  );
  assert.equal(captured.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(
    captured.init.headers["X-Operations-Confirm"],
    "execute-due-account-deletions",
  );
  assert.deepEqual(JSON.parse(captured.init.body), {
    dryRun: false,
    limit: 5,
    confirmation: "execute-due-account-deletions",
  });
});

test("scheduled executor fails closed on missing secret and reported failures", async () => {
  await assert.rejects(
    executeDueAccountDeletions({}, async () => {
      throw new Error("fetch must not run");
    }),
    /secret is unavailable/,
  );
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () =>
        Response.json({
          dryRun: false,
          requestId: "scheduler-request-0002",
          scanned: 1,
          completed: 0,
          blocked: 0,
          failed: 1,
          skipped: 0,
        }),
    ),
    /reported failures/,
  );
});

test("scheduler config is private, daily, bounded, and observable", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../wrangler.account-deletion-scheduler.jsonc", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.triggers.crons, ["15 18 * * *"]);
  assert.equal(config.vars.ACCOUNT_DELETION_BATCH_LIMIT, "5");
  assert.equal(config.observability.logs.persist, true);
  assert.equal(
    Object.hasOwn(config.vars, "ACCOUNT_DELETION_OPERATIONS_SECRET"),
    false,
  );
});
