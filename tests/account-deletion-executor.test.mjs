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
const { purgeExpiredAccountChallenges, runDueAccountDeletions } = await import(
  "../lib/account-deletion-executor.ts"
);

test("challenge retention deletes only strictly expired authentication rows", async () => {
  createChallengeRetentionFixture("retention-expired", 99);
  createChallengeRetentionFixture("retention-cutoff", 100);
  createChallengeRetentionFixture("retention-future", 101);

  const result = await purgeExpiredAccountChallenges({ nowSeconds: 100 });

  assert.deepEqual(result, {
    accountAuthChallenges: 1,
    accountEmailChallenges: 1,
    accountOauthChallenges: 1,
    accountRecoveryChallenges: 1,
    total: 4,
    batches: 1,
    hasMore: false,
  });
  assert.equal(challengeRetentionFixtureCount("retention-expired"), 0);
  assert.equal(challengeRetentionFixtureCount("retention-cutoff"), 4);
  assert.equal(challengeRetentionFixtureCount("retention-future"), 4);
  await assert.rejects(
    purgeExpiredAccountChallenges({ nowSeconds: -1 }),
    /invalid_challenge_retention_cutoff/,
  );

  deleteChallengeRetentionFixtures("retention-cutoff");
  deleteChallengeRetentionFixtures("retention-future");
});

test("challenge retention caps each table and reports a remaining backlog", async () => {
  for (let index = 0; index < 405; index += 1) {
    createChallengeRetentionFixture(`retention-bounded-${index}`, 1);
  }

  const first = await purgeExpiredAccountChallenges({ nowSeconds: 100 });
  assert.deepEqual(first, {
    accountAuthChallenges: 400,
    accountEmailChallenges: 400,
    accountOauthChallenges: 400,
    accountRecoveryChallenges: 400,
    total: 1600,
    batches: 4,
    hasMore: true,
  });
  const second = await purgeExpiredAccountChallenges({ nowSeconds: 100 });
  assert.deepEqual(second, {
    accountAuthChallenges: 5,
    accountEmailChallenges: 5,
    accountOauthChallenges: 5,
    accountRecoveryChallenges: 5,
    total: 20,
    batches: 1,
    hasMore: false,
  });
});

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
  assert.equal(row("SELECT COUNT(*) AS value FROM account_external_identities WHERE user_id = ?", fixture.userId).value, 0);
  assert.equal(row("SELECT COUNT(*) AS value FROM account_oauth_challenges WHERE initiating_user_id = ?", fixture.userId).value, 0);
  assert.equal(row("SELECT COUNT(*) AS value FROM account_email_challenges WHERE initiating_user_id = ?", fixture.userId).value, 0);
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
  database.sqlite
    .prepare("UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = ?")
    .run(fixture.userId);
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
  const partialFailure = createFixture("route-partial-failure", {
    executeAfter: 1,
  });
  const partialFailureObjectKey = "private/route-partial-failure.mov";
  database.sqlite
    .prepare(`
      INSERT INTO video_transfers (
        id, code_hash, file_name, content_type, size, object_key, upload_id,
        status, owner_email, created_at, expires_at, completed_at, deleted_at
      ) VALUES (
        'transfer-route-partial-failure', 'hash-route-partial-failure',
        'private.mov', 'video/quicktime', 123, ?,
        'upload-route-partial-failure', 'uploading',
        'route-partial-failure@example.invalid', 1, 9999999999999, NULL, NULL
      )
    `)
    .run(partialFailureObjectKey);
  failingMultipartKeys.add(partialFailureObjectKey);
  createChallengeRetentionFixture("route-retention", 1);
  const withHealthSecret = await POST(
    operationRequest(
      "health-monitor-secret-that-is-at-least-32-characters",
      { dryRun: true, limit: 1 },
    ),
  );
  assert.equal(withHealthSecret.status, 401);
  assert.equal(challengeRetentionFixtureCount("route-retention"), 4);

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
  assert.equal(challengeRetentionFixtureCount("route-retention"), 4);

  const authorizedDryRun = await POST(
    operationRequest(
      "deletion-operator-secret-that-is-at-least-32-characters",
      { limit: 1 },
    ),
  );
  assert.equal(authorizedDryRun.status, 200);
  const dryRunBody = await authorizedDryRun.json();
  assert.equal(dryRunBody.dryRun, true);
  assert.deepEqual(dryRunBody.challengeRetention, {
    status: "skipped",
    reason: "dry_run",
  });
  assert.equal(challengeRetentionFixtureCount("route-retention"), 4);

  const authorizedExecution = await POST(
    operationRequest(
      "deletion-operator-secret-that-is-at-least-32-characters",
      {
        dryRun: false,
        limit: 1,
        confirmation: "execute-due-account-deletions",
      },
      "execute-due-account-deletions",
    ),
  );
  assert.equal(authorizedExecution.status, 200);
  const executionBody = await authorizedExecution.json();
  assert.equal(executionBody.failed, 1);
  assert.equal(executionBody.challengeRetention.status, "purged");
  assert.equal(executionBody.challengeRetention.total, 4);
  assert.equal(challengeRetentionFixtureCount("route-retention"), 0);
  failingMultipartKeys.delete(partialFailureObjectKey);
  database.sqlite
    .prepare("UPDATE account_deletion_requests SET status = 'cancelled' WHERE user_id = ?")
    .run(partialFailure.userId);

  createChallengeRetentionFixture("route-retention-success", 1);
  const successfulRetention = await POST(
    operationRequest(
      "deletion-operator-secret-that-is-at-least-32-characters",
      {
        dryRun: false,
        limit: 1,
        confirmation: "execute-due-account-deletions",
      },
      "execute-due-account-deletions",
    ),
  );
  assert.equal(successfulRetention.status, 200);
  const successfulRetentionBody = await successfulRetention.json();
  assert.equal(successfulRetentionBody.failed, 0);
  assert.equal(successfulRetentionBody.challengeRetention.status, "purged");
  assert.equal(successfulRetentionBody.challengeRetention.total, 4);
  assert.equal(challengeRetentionFixtureCount("route-retention-success"), 0);

  const originalDatabase = globalThis.__cloudflareEnv.DB;
  createChallengeRetentionFixture("route-retention-purge-failure", 1);
  let purgeFailureBatchCalls = 0;
  globalThis.__cloudflareEnv.DB = {
    prepare(query) {
      return originalDatabase.prepare(query);
    },
    async batch() {
      purgeFailureBatchCalls += 1;
      throw new Error("D1 retention batch unavailable");
    },
  };
  try {
    const purgeFailure = await POST(
      operationRequest(
        "deletion-operator-secret-that-is-at-least-32-characters",
        {
          dryRun: false,
          limit: 1,
          confirmation: "execute-due-account-deletions",
        },
        "execute-due-account-deletions",
      ),
    );
    assert.equal(purgeFailure.status, 200);
    const purgeFailureBody = await purgeFailure.json();
    assert.equal(purgeFailureBody.failed, 0);
    assert.deepEqual(purgeFailureBody.challengeRetention, {
      status: "failed",
      reason: "challenge_retention_failed",
    });
    assert.equal(purgeFailureBatchCalls, 1);
  } finally {
    globalThis.__cloudflareEnv.DB = originalDatabase;
  }
  assert.equal(
    challengeRetentionFixtureCount("route-retention-purge-failure"),
    4,
  );
  deleteChallengeRetentionFixtures("route-retention-purge-failure");

  createChallengeRetentionFixture("route-executor-failure", 1);
  let batchCalls = 0;
  const failingStatement = {
    bind() {
      return this;
    },
    async all() {
      throw new Error("D1 unavailable");
    },
  };
  globalThis.__cloudflareEnv.DB = {
    prepare() {
      return failingStatement;
    },
    async batch() {
      batchCalls += 1;
      throw new Error("D1 unavailable");
    },
  };
  try {
    const failedExecution = await POST(
      operationRequest(
        "deletion-operator-secret-that-is-at-least-32-characters",
        {
          dryRun: false,
          limit: 1,
          confirmation: "execute-due-account-deletions",
        },
        "execute-due-account-deletions",
      ),
    );
    assert.equal(failedExecution.status, 500);
    assert.equal(batchCalls, 1);
  } finally {
    globalThis.__cloudflareEnv.DB = originalDatabase;
  }
  assert.equal(challengeRetentionFixtureCount("route-executor-failure"), 4);
  deleteChallengeRetentionFixtures("route-executor-failure");
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
      INSERT INTO account_external_identities (
        id, user_id, provider, subject_hash, verified_email,
        created_at, last_used_at, revoked_at
      ) VALUES (?, ?, 'google', ?, ?, 1, 1, NULL)
    `)
    .run(`identity-${suffix}`, userId, `subject-${suffix}-hash`, email);
  database.sqlite
    .prepare(`
      INSERT INTO account_oauth_challenges (
        state_hash, provider, nonce, pkce_verifier, intent,
        initiating_user_id, expected_origin, return_to, network_hash,
        created_at, expires_at, consumed_at
      ) VALUES (?, 'google', 'nonce', 'verifier', 'link', ?,
        'https://torudake-reel.pages.dev', '/account', 'network', 1,
        9999999999, NULL)
    `)
    .run(`oauth-${suffix}`, userId);
  database.sqlite
    .prepare(`
      INSERT INTO account_email_challenges (
        challenge_hash, email_hash, normalized_email, code_hash, intent,
        initiating_user_id, expected_origin, return_to, network_hash,
        attempts, created_at, expires_at, consumed_at
      ) VALUES (?, 'email-hash', ?, 'code-hash', 'link', ?,
        'https://torudake-reel.pages.dev', '/account', 'network', 0, 1,
        9999999999, NULL)
    `)
    .run(`email-${suffix}`, email, userId);
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

function createChallengeRetentionFixture(prefix, expiresAt) {
  database.sqlite
    .prepare(`
      INSERT INTO account_auth_challenges (
        token_hash, challenge, ceremony, user_id, expected_origin, rp_id,
        network_hash, created_at, expires_at, consumed_at
      ) VALUES (?, 'challenge', 'authentication', NULL,
        'https://torudake-reel.pages.dev', 'torudake-reel.pages.dev',
        'network', 1, ?, NULL)
    `)
    .run(`${prefix}-auth`, expiresAt);
  database.sqlite
    .prepare(`
      INSERT INTO account_email_challenges (
        challenge_hash, email_hash, normalized_email, code_hash, intent,
        initiating_user_id, expected_origin, return_to, network_hash,
        attempts, created_at, expires_at, consumed_at
      ) VALUES (?, 'email-hash', 'retention@example.invalid', 'code-hash',
        'login', NULL, 'https://torudake-reel.pages.dev', '/account',
        'network', 0, 1, ?, NULL)
    `)
    .run(`${prefix}-email`, expiresAt);
  database.sqlite
    .prepare(`
      INSERT INTO account_oauth_challenges (
        state_hash, provider, nonce, pkce_verifier, intent,
        initiating_user_id, expected_origin, return_to, network_hash,
        created_at, expires_at, consumed_at
      ) VALUES (?, 'line', 'nonce', 'verifier', 'login', NULL,
        'https://torudake-reel.pages.dev', '/account', 'network', 1, ?, NULL)
    `)
    .run(`${prefix}-oauth`, expiresAt);
  database.sqlite
    .prepare(`
      INSERT INTO account_recovery_challenges (
        id, user_id, contact_hash, network_hash, challenge_hash, status,
        created_at, expires_at, reviewed_at, consumed_at
      ) VALUES (?, NULL, 'contact-hash', 'network', NULL, 'requested',
        1, ?, NULL, NULL)
    `)
    .run(`${prefix}-recovery`, expiresAt);
}

function challengeRetentionFixtureCount(prefix) {
  return [
    ["account_auth_challenges", "token_hash"],
    ["account_email_challenges", "challenge_hash"],
    ["account_oauth_challenges", "state_hash"],
    ["account_recovery_challenges", "id"],
  ].reduce(
    (total, [table, column]) =>
      total +
      database.sqlite
        .prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${column} LIKE ?`)
        .get(`${prefix}-%`).value,
    0,
  );
}

function deleteChallengeRetentionFixtures(prefix) {
  database.sqlite
    .prepare("DELETE FROM account_auth_challenges WHERE token_hash LIKE ?")
    .run(`${prefix}-%`);
  database.sqlite
    .prepare("DELETE FROM account_email_challenges WHERE challenge_hash LIKE ?")
    .run(`${prefix}-%`);
  database.sqlite
    .prepare("DELETE FROM account_oauth_challenges WHERE state_hash LIKE ?")
    .run(`${prefix}-%`);
  database.sqlite
    .prepare("DELETE FROM account_recovery_challenges WHERE id LIKE ?")
    .run(`${prefix}-%`);
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
