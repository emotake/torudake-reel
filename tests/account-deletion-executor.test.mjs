import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

class D1Statement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.query, values);
  }

  async first() {
    return this.database.sqlite.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.sqlite.prepare(this.query).all(...this.values) };
  }

  async run() {
    const result = this.database.sqlite.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }

  prepare(query) {
    return new D1Statement(this, query);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const database = new D1Database();
const migrationDirectory = new URL("../drizzle/", import.meta.url);
for (const fileName of (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()) {
  const source = await readFile(new URL(fileName, migrationDirectory), "utf8");
  database.sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
}

const deletedObjects = [];
const failingMultipartKeys = new Set();
globalThis.__cloudflareEnv = {
  DB: database,
  OPS_HEALTH_SECRET: "health-monitor-secret-that-is-at-least-32-characters",
  ACCOUNT_DELETION_OPERATIONS_SECRET:
    "deletion-operator-secret-that-is-at-least-32-characters",
  MEDIA: {
    delete: async (key) => deletedObjects.push(key),
    resumeMultipartUpload: (key) => ({
      abort: async () => {
        if (failingMultipartKeys.has(key)) throw new Error("R2 unavailable");
      },
    }),
  },
};
const { runDueAccountDeletions } = await import(
  "../lib/account-deletion-executor.ts"
);

test("dry-run audits a due account without mutating account data", async () => {
  const fixture = createFixture("dry", { executeAfter: 10 });
  const result = await runDueAccountDeletions({
    dryRun: true,
    limit: 5,
    requestId: "dry-run-request-0001",
    nowSeconds: 100,
  });
  assert.equal(result.ready, 1);
  assert.equal(result.completed, 0);
  assert.equal(row("SELECT COUNT(*) AS value FROM account_passkeys WHERE user_id = ?", fixture.userId).value, 1);
  assert.equal(row("SELECT status FROM account_deletion_requests WHERE user_id = ?", fixture.userId).status, "scheduled");
  assert.equal(row("SELECT dry_run, outcome FROM account_deletion_execution_audit ORDER BY started_at DESC LIMIT 1").dry_run, 1);
  database.sqlite
    .prepare("UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = ?")
    .run(fixture.userId);
});

test("execute anonymizes identity and deletes credentials while preserving billing ledger", async () => {
  const fixture = createFixture("execute", { executeAfter: 20, withPurchase: true });
  const result = await runDueAccountDeletions({
    dryRun: false,
    limit: 5,
    requestId: "execute-request-0001",
    nowSeconds: 200,
  });
  assert.equal(result.completed, 1);
  assert.equal(row("SELECT COUNT(*) AS value FROM account_passkeys WHERE user_id = ?", fixture.userId).value, 0);
  assert.equal(row("SELECT COUNT(*) AS value FROM account_sessions WHERE user_id = ?", fixture.userId).value, 0);
  assert.equal(row("SELECT COUNT(*) AS value FROM billing_purchases WHERE user_id = ?", fixture.userId).value, 1);
  const user = row("SELECT email, billing_email, full_name, account_deleted_at FROM users WHERE id = ?", fixture.userId);
  assert.match(user.email, /^deleted\+[0-9a-f]+@anonymous\.torudake\.invalid$/);
  assert.equal(user.billing_email, null);
  assert.equal(user.full_name, null);
  assert.equal(user.account_deleted_at, 200);
  assert.equal(row("SELECT status FROM account_deletion_requests WHERE user_id = ?", fixture.userId).status, "completed");

  const repeated = await runDueAccountDeletions({
    dryRun: false,
    limit: 5,
    requestId: "execute-request-0002",
    nowSeconds: 201,
  });
  assert.equal(repeated.scanned, 0);
  assert.equal(repeated.completed, 0);
});

test("deletion never treats another account's primary email as owned media via billing email", async () => {
  const fixture = createFixture("ownership", { executeAfter: 25 });
  const otherUserId = "deletion-other-owner";
  const otherEmail = "other-owner@example.invalid";
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, ?, NULL, 'Other Owner', NULL, NULL, 1, 1)
    `)
    .run(otherUserId, otherEmail);
  database.sqlite
    .prepare("UPDATE users SET billing_email = ? WHERE id = ?")
    .run(otherEmail, fixture.userId);
  database.sqlite
    .prepare(`
      INSERT INTO video_transfers (
        id, code_hash, file_name, content_type, size, object_key, upload_id,
        status, owner_email, created_at, expires_at, completed_at, deleted_at
      ) VALUES (
        'transfer-other-owner', 'hash-other-owner', 'other.mov',
        'video/quicktime', 123, 'private/other-owner.mov', 'upload-other-owner',
        'complete', ?, 1, 9999999999999, 1, NULL
      )
    `)
    .run(otherEmail);

  const result = await runDueAccountDeletions({
    dryRun: false,
    limit: 5,
    requestId: "ownership-request-0001",
    nowSeconds: 250,
  });

  assert.equal(result.completed, 1);
  assert.equal(
    row("SELECT COUNT(*) AS value FROM video_transfers WHERE id = 'transfer-other-owner'").value,
    1,
  );
  assert.equal(deletedObjects.includes("private/other-owner.mov"), false);
});

test("open local dispute blocks deletion and releases the execution lease", async () => {
  const fixture = createFixture("dispute", {
    executeAfter: 30,
    withPurchase: true,
    disputeState: "needs_response",
  });
  const result = await runDueAccountDeletions({
    dryRun: false,
    limit: 5,
    requestId: "blocked-request-0001",
    nowSeconds: 300,
  });
  assert.equal(result.blocked, 1);
  assert.equal(result.results[0].reasonCode, "open_dispute");
  const request = row("SELECT status, execution_token, last_block_reason FROM account_deletion_requests WHERE user_id = ?", fixture.userId);
  assert.equal(request.status, "scheduled");
  assert.equal(request.execution_token, null);
  assert.equal(request.last_block_reason, "open_dispute");
  assert.equal(row("SELECT COUNT(*) AS value FROM account_passkeys WHERE user_id = ?", fixture.userId).value, 1);
  database.sqlite
    .prepare("UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = ?")
    .run(fixture.userId);
});

test("multipart abort failure keeps account and transfer metadata for retry", async () => {
  const fixture = createFixture("mediafailure", { executeAfter: 40 });
  const objectKey = "private/mediafailure.mov";
  database.sqlite
    .prepare(`
      INSERT INTO video_transfers (
        id, code_hash, file_name, content_type, size, object_key, upload_id,
        status, owner_email, created_at, expires_at, completed_at, deleted_at
      ) VALUES (
        'transfer-mediafailure', 'hash-mediafailure', 'private.mov',
        'video/quicktime', 123, ?, 'upload-mediafailure', 'uploading',
        'mediafailure@example.invalid', 1, 9999999999999, NULL, NULL
      )
    `)
    .run(objectKey);
  failingMultipartKeys.add(objectKey);
  const result = await runDueAccountDeletions({
    dryRun: false,
    limit: 5,
    requestId: "media-failure-request-0001",
    nowSeconds: 400,
  });
  failingMultipartKeys.delete(objectKey);

  assert.equal(result.failed, 1);
  assert.equal(result.results[0].reasonCode, "media_cleanup_failed");
  assert.equal(row("SELECT COUNT(*) AS value FROM users WHERE id = ?", fixture.userId).value, 1);
  assert.equal(row("SELECT COUNT(*) AS value FROM account_passkeys WHERE user_id = ?", fixture.userId).value, 1);
  assert.equal(row("SELECT COUNT(*) AS value FROM video_transfers WHERE id = 'transfer-mediafailure'").value, 1);
  const request = row("SELECT status, execution_token, last_error_code FROM account_deletion_requests WHERE user_id = ?", fixture.userId);
  assert.equal(request.status, "scheduled");
  assert.equal(request.execution_token, null);
  assert.equal(request.last_error_code, "media_cleanup_failed");
});

test("executor route rejects the health secret and requires two execution confirmations", async () => {
  const source = await readFile(
    new URL("../app/api/internal/account-deletions/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /authorizeAccountDeletionOperations\(request\)/);
  assert.match(source, /const dryRun = payload\.dryRun !== false/);
  assert.match(source, /x-operations-confirm/);
  assert.match(source, /execute-due-account-deletions/);
  assert.match(source, /limit > 25/);
  assert.match(source, /private, no-store/);

  const { POST } = await import(
    "../app/api/internal/account-deletions/route.ts"
  );
  const withHealthSecret = await POST(
    operationRequest(
      "health-monitor-secret-that-is-at-least-32-characters",
      { dryRun: true, limit: 1 },
    ),
  );
  assert.equal(withHealthSecret.status, 401);

  const withoutSecondConfirmation = await POST(
    operationRequest(
      "deletion-operator-secret-that-is-at-least-32-characters",
      {
        dryRun: false,
        limit: 1,
        confirmation: "execute-due-account-deletions",
      },
    ),
  );
  assert.equal(withoutSecondConfirmation.status, 409);

  const authorizedDryRun = await POST(
    operationRequest(
      "deletion-operator-secret-that-is-at-least-32-characters",
      { limit: 1 },
    ),
  );
  assert.equal(authorizedDryRun.status, 200);
  assert.equal((await authorizedDryRun.json()).dryRun, true);
});

function createFixture(
  suffix,
  { executeAfter, withPurchase = false, disputeState = null },
) {
  const userId = `deletion-${suffix}`;
  const email = `${suffix}@example.invalid`;
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Test User', NULL, NULL, 1, 1)
    `)
    .run(userId, email, email);
  database.sqlite
    .prepare(`
      INSERT INTO account_passkeys (
        credential_id, user_id, public_key, counter, transports, device_type,
        backed_up, display_name, created_at, updated_at, last_used_at
      ) VALUES (?, ?, 'AQID', 0, NULL, 'singleDevice', 0, 'Device', 1, 1, 1)
    `)
    .run(`credential_${suffix}_abcdefghijkl`, userId);
  database.sqlite
    .prepare(`
      INSERT INTO account_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at,
        reauthenticated_at
      ) VALUES (?, ?, 1, 1, 9999999999, 1)
    `)
    .run(`session-${suffix}`, userId);
  database.sqlite
    .prepare(`
      INSERT INTO account_deletion_requests (
        user_id, status, requested_at, execute_after, cancelled_at,
        completed_at, execution_token, execution_started_at, attempt_count,
        last_block_reason, last_error_code, updated_at
      ) VALUES (?, 'scheduled', 1, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, 1)
    `)
    .run(userId, executeAfter);
  if (withPurchase) {
    database.sqlite
      .prepare(`
        INSERT INTO billing_purchases (
          id, user_id, stripe_customer_id, stripe_payment_intent_id,
          stripe_price_id, credits, refund_blocking_amount, dispute_state,
          revoked_at, stripe_state_synced_at, stripe_state_sync_started_at,
          purchased_at
        ) VALUES (?, ?, 'cus_ledger', ?, 'price_one', 1, 0, ?, NULL, 1, NULL, 1)
      `)
      .run(`purchase-${suffix}`, userId, `pi-${suffix}`, disputeState);
  }
  return { userId };
}

function row(query, ...values) {
  return database.sqlite.prepare(query).get(...values);
}

function operationRequest(secret, body, confirmation = null) {
  const headers = {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
    "x-request-id": "route-test-request-0001",
  };
  if (confirmation) headers["x-operations-confirm"] = confirmation;
  return new Request(
    "https://torudake-reel.pages.dev/api/internal/account-deletions",
    { method: "POST", headers, body: JSON.stringify(body) },
  );
}

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
