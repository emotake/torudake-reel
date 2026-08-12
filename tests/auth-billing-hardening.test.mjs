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

  async run() {
    const result = this.database.sqlite.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async all() {
    return {
      results: this.database.sqlite.prepare(this.query).all(...this.values),
    };
  }

  async raw() {
    return this.database.sqlite
      .prepare(this.query)
      .all(...this.values)
      .map((row) => Object.values(row));
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

const runtimeEnv = {
  DB: database,
  TRIAL_ISSUANCE_SECRET: "test-secret-with-at-least-thirty-two-characters",
  STRIPE_SECRET_KEY: "sk_test_hardening",
  STRIPE_PRICE_STARTER_MONTHLY: "price_starter",
  STRIPE_PRICE_STANDARD_MONTHLY: "price_standard",
  STRIPE_PRICE_LIGHT_MONTHLY: "price_legacy",
  STRIPE_PRICE_ONE_TIME: "price_one_time",
};
globalThis.__cloudflareEnv = runtimeEnv;

const {
  acquireMonthlyCheckoutLock,
  authorizeMeteredAiOperation,
  completeMeteredAiOperation,
  completeUsage,
  finishPurchaseStateSync,
  getAiEntitlementBudgetForReservation,
  releaseMonthlyCheckoutLock,
  releaseMeteredAiOperation,
  releaseUsage,
  setSubscriptionPeriodRevocationState,
} = await import("../lib/billing-store.ts");
const {
  bindTrialSessionToAccount,
  trialSessionPrincipalEmail,
} = await import("../lib/trial-session-store.ts");
const { getUsagePrincipal } = await import("../lib/operator-access.ts");
const {
  accountSessionCookie,
  hashAccountToken,
  randomAccountToken,
} = await import("../lib/account-session.ts");
const { registrationOptions } = await import("../lib/account-auth.ts");
const { POST: logout } = await import("../app/api/account/logout/route.ts");
const {
  handleSubscriptionChanged,
  selectSubscriptionInvoicePeriodStart,
} = await import("../app/api/billing/webhook/route.ts");
const { settleExpiredUsageReservations } = await import(
  "../lib/operator-usage.ts"
);

test("a promoted trial cannot recover account entitlement after logout", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const trialId = "11111111-1111-4111-8111-111111111111";
  const trialHash = await sha256(trialId);
  const userId = "user-auth-hardening";
  const email = await trialSessionPrincipalEmail(trialId);
  const accountToken = randomAccountToken();
  const accountHash = await hashAccountToken(accountToken);

  database.sqlite
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash, account_user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, NULL, ?, ?, ?)
    `)
    .run(trialHash, now, now, now + 3_600);
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, email, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_passkeys (
        credential_id, user_id, public_key, counter, transports,
        device_type, backed_up, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, 0, NULL, 'singleDevice', 0, ?, ?, ?)
    `)
    .run("existing_credential_12345", userId, "AQID", now, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(accountHash, userId, now, now, now + 3_600);

  const authenticatedRequest = accountRequest(accountToken, trialId);
  const backup = await registrationOptions(authenticatedRequest);
  assert.equal(backup.options.excludeCredentials?.[0]?.id, "existing_credential_12345");
  assert.equal(await bindTrialSessionToAccount(trialId, userId), true);

  const trialOnly = new Request("https://torudake-reel.pages.dev/", {
    headers: { cookie: `torudake_trial_id=${trialId}` },
  });
  assert.equal(
    (await getUsagePrincipal(trialOnly, { allowTrial: true })).currentUser,
    null,
    "a bound trial cookie is no longer an anonymous billing principal",
  );
  assert.equal(
    (await getUsagePrincipal(authenticatedRequest, { allowTrial: true }))
      .currentUser?.id,
    userId,
  );

  const response = await logout(
    new Request("https://torudake-reel.pages.dev/api/account/logout", {
      method: "POST",
      headers: {
        origin: "https://torudake-reel.pages.dev",
        cookie: cookieHeader(accountToken, trialId),
      },
    }),
  );
  assert.equal(response.status, 200);
  const setCookies = response.headers.getSetCookie();
  assert.ok(setCookies.some((cookie) => cookie.startsWith("__Host-torudake_account=")));
  assert.ok(setCookies.some((cookie) => cookie.startsWith("torudake_trial_id=")));
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?")
      .get(userId).count,
    0,
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM trial_sessions WHERE session_hash = ?")
      .get(trialHash).count,
    0,
  );
});

test("the migration binds existing passkey accounts to their legacy trial", async () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    const files = (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const fileName of files.filter((name) => name < "0015_")) {
      const source = await readFile(new URL(fileName, migrationDirectory), "utf8");
      legacy.exec(source.replaceAll("--> statement-breakpoint", ""));
    }
    const sessionHash = "ab".repeat(32);
    const userId = "legacy-passkey-user";
    const email = `trial-${sessionHash.slice(0, 48)}@anonymous.torudake.invalid`;
    legacy
      .prepare(`
        INSERT INTO trial_sessions (session_hash, created_at, last_seen_at, expires_at)
        VALUES (?, 1, 1, 9999999999)
      `)
      .run(sessionHash);
    legacy
      .prepare(`
        INSERT INTO users (
          id, email, billing_email, full_name, stripe_customer_id,
          created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, 1, 1)
      `)
      .run(userId, email);
    legacy
      .prepare(`
        INSERT INTO account_passkeys (
          credential_id, user_id, public_key, counter, transports,
          device_type, backed_up, created_at, updated_at, last_used_at
        ) VALUES ('legacy-credential', ?, 'AQID', 0, NULL, 'singleDevice', 0, 1, 1, 1)
      `)
      .run(userId);
    const migration = await readFile(
      new URL("0015_shocking_agent_zero.sql", migrationDirectory),
      "utf8",
    );
    legacy.exec(migration.replaceAll("--> statement-breakpoint", ""));
    assert.equal(
      legacy
        .prepare("SELECT account_user_id FROM trial_sessions WHERE session_hash = ?")
        .get(sessionHash).account_user_id,
      userId,
    );
  } finally {
    legacy.close();
  }
});

test("the subscription sync lease migration is safe to apply explicitly twice", async () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    const files = (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const fileName of files.filter((name) => name < "0016_")) {
      const source = await readFile(new URL(fileName, migrationDirectory), "utf8");
      legacy.exec(source.replaceAll("--> statement-breakpoint", ""));
    }
    const migration = await readFile(
      new URL("0016_elite_sphinx.sql", migrationDirectory),
      "utf8",
    );
    legacy.exec(migration.replaceAll("--> statement-breakpoint", ""));
    legacy.exec(migration.replaceAll("--> statement-breakpoint", ""));
    assert.equal(
      legacy
        .prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_schema
          WHERE type = 'table' AND name = 'billing_subscription_sync_leases'
        `)
        .get().count,
      1,
    );
  } finally {
    legacy.close();
  }
});

test("only one parallel monthly Checkout can own the account lock", async () => {
  const userId = "user-checkout-lock";
  const attempts = await Promise.all([
    acquireMonthlyCheckoutLock(userId, "request-parallel-a", "standard"),
    acquireMonthlyCheckoutLock(userId, "request-parallel-b", "standard"),
  ]);
  const winner = attempts.find(Boolean);
  assert.ok(winner);
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM billing_checkout_locks WHERE user_id = ?")
      .get(userId).count,
    1,
  );
  assert.equal(
    await releaseMonthlyCheckoutLock({
      userId,
      lockToken: winner.lockToken,
    }),
    true,
    "a failed Checkout owner can release only its own lock",
  );

  const now = Math.floor(Date.now() / 1_000);
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'standard', 'active', ?, ?, NULL, 0, ?, ?)
    `)
    .run("sub-lock", userId, "cus-lock", "price_standard", now - 60, now + 3_600, now, now);
  assert.equal(
    await acquireMonthlyCheckoutLock(userId, "request-after-active", "starter"),
    null,
    "an active monthly subscription wins over a new Checkout request",
  );
});

test("a current Stripe snapshot prevents an old active event from reviving cancellation", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "user-webhook-order";
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
    `)
    .run(userId, "webhook@example.invalid", "cus-webhook", now, now);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/v1\/subscriptions\/sub-webhook$/);
    return Response.json({
      id: "sub-webhook",
      customer: "cus-webhook",
      status: "canceled",
      current_period_start: now - 600,
      current_period_end: now + 600,
      cancel_at_period_end: false,
      metadata: { app_user_id: userId },
      items: { data: [{ price: { id: "price_standard" } }] },
    });
  };
  try {
    const staleActiveEvent = {
      id: "sub-webhook",
      customer: "cus-webhook",
      status: "active",
      metadata: { app_user_id: userId },
      items: { data: [{ price: { id: "price_standard" } }] },
    };
    await handleSubscriptionChanged(staleActiveEvent);
    await handleSubscriptionChanged(staleActiveEvent);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(
    database.sqlite
      .prepare("SELECT status FROM billing_subscriptions WHERE id = ?")
      .get("sub-webhook").status,
    "canceled",
  );
});

test("delayed parallel subscription refreshes commit in lease order", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "user-webhook-parallel";
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
    `)
    .run(userId, "parallel@example.invalid", "cus-parallel", now, now);

  let fetchCount = 0;
  let markFirstFetchStarted;
  const firstFetchStarted = new Promise((resolve) => {
    markFirstFetchStarted = resolve;
  });
  let releaseStaleFetch;
  const staleFetchGate = new Promise((resolve) => {
    releaseStaleFetch = resolve;
  });
  const snapshot = (status) => ({
    id: "sub-parallel",
    customer: "cus-parallel",
    status,
    current_period_start: now - 600,
    current_period_end: now + 600,
    cancel_at_period_end: false,
    metadata: { app_user_id: userId },
    items: { data: [{ price: { id: "price_standard" } }] },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/v1\/subscriptions\/sub-parallel$/);
    fetchCount += 1;
    if (fetchCount === 1) {
      markFirstFetchStarted();
      await staleFetchGate;
      return Response.json(snapshot("active"));
    }
    return Response.json(snapshot("canceled"));
  };
  try {
    const delayedOldEvent = handleSubscriptionChanged({ id: "sub-parallel" });
    await firstFetchStarted;
    const newerCancellation = handleSubscriptionChanged({ id: "sub-parallel" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    releaseStaleFetch();
    await Promise.all([delayedOldEvent, newerCancellation]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCount, 2);
  assert.equal(
    database.sqlite
      .prepare("SELECT status FROM billing_subscriptions WHERE id = ?")
      .get("sub-parallel").status,
    "canceled",
    "the newer canceled snapshot commits after the delayed active snapshot",
  );
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM billing_subscription_sync_leases WHERE subscription_id = ?",
      )
      .get("sub-parallel").count,
    0,
  );
});

test("refunds invalidate completed monthly previews and accept proration line periods", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const periodStart = now - 1_000;
  const periodEnd = now + 1_000;
  const userId = "user-refund-period";
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
    `)
    .run(userId, "refund@example.invalid", "cus-refund", now, now);
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'standard', 'active', ?, ?, NULL, 0, ?, ?)
    `)
    .run("sub-refund", userId, "cus-refund", "price_standard", periodStart, periodEnd, now, now);
  for (const [id, status] of [
    ["reservation-refund-reserved", "reserved"],
    ["reservation-refund-completed", "completed"],
  ]) {
    database.sqlite
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds, bucket,
          status, created_at, expires_at, completed_at, billing_purchase_id
        ) VALUES (?, ?, ?, 30, 'subscription', ?, ?, ?, ?, NULL)
      `)
      .run(id, userId, `key-${id}`, status, now - 30, now + 3_600, status === "completed" ? now : null);
  }

  assert.equal(
    selectSubscriptionInvoicePeriodStart(
      [
        {
          subscription: "sub-refund",
          price: { id: "price_standard" },
          proration: true,
          period: { start: now - 100, end: periodEnd },
        },
      ],
      "sub-refund",
      "price_standard",
      periodStart - 99_999,
    ),
    now - 100,
    "the matching line wins over the invoice top-level period",
  );
  assert.equal(
    await setSubscriptionPeriodRevocationState(
      "sub-refund",
      now - 100,
      true,
    ),
    "revoked",
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT revoked_period_start FROM billing_subscriptions WHERE id = ?")
      .get("sub-refund").revoked_period_start,
    periodStart,
  );
  const invalidated = database.sqlite
    .prepare(`
      SELECT id, status, expires_at
      FROM usage_reservations
      WHERE user_id = ?
      ORDER BY id
    `)
    .all(userId);
  assert.deepEqual(
    invalidated.map((row) => row.status),
    ["completed", "released"],
  );
  assert.ok(invalidated.every((row) => row.expires_at < now));

  const authorization = await authorizeMeteredAiOperation(
    {
      id: userId,
      email: "refund@example.invalid",
      billingEmail: null,
      fullName: null,
    },
    "reservation-refund-completed",
    "narration_speech",
    "refund-check-action",
  );
  assert.equal(authorization.allowed, false);
  assert.equal(authorization.reason, "reservation_not_found");
  await assert.rejects(
    setSubscriptionPeriodRevocationState(
      "sub-refund",
      periodEnd + 1,
      true,
    ),
    /does not match/,
  );
});

test("a succeeded AI action ID cannot run a different ordinary payload", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "user-action-semantics";
  const currentUser = {
    id: userId,
    email: "actions@example.invalid",
    billingEmail: null,
    fullName: null,
  };
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, currentUser.email, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, billing_purchase_id
      ) VALUES (?, ?, ?, 90, 'free', 'reserved', ?, ?, NULL, NULL)
    `)
    .run("reservation-actions", userId, "key-actions", now, now + 3_600);

  const ordinary = await authorizeMeteredAiOperation(
    currentUser,
    "reservation-actions",
    "narration_script",
    "ordinary-action",
  );
  assert.equal(ordinary.allowed, true);
  assert.equal((await completeMeteredAiOperation(ordinary)).completed, true);
  const replay = await authorizeMeteredAiOperation(
    currentUser,
    "reservation-actions",
    "narration_script",
    "ordinary-action",
  );
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, "action_already_succeeded");

  const firstChunk = await authorizeMeteredAiOperation(
    currentUser,
    "reservation-actions",
    "transcribe",
    "chunked-transcription",
    { continuationMode: "transcription_chunk" },
  );
  assert.equal(firstChunk.allowed, true);
  assert.equal((await completeMeteredAiOperation(firstChunk)).completed, true);
  const secondChunk = await authorizeMeteredAiOperation(
    currentUser,
    "reservation-actions",
    "transcribe",
    "chunked-transcription",
    { continuationMode: "transcription_chunk" },
  );
  assert.equal(secondChunk.allowed, true, "transcription chunks can continue");
  await releaseMeteredAiOperation(secondChunk);

  const initialScript = await authorizeMeteredAiOperation(
    currentUser,
    "reservation-actions",
    "narration_initial",
    "initial-bundle",
    {
      continuationMode: "narration_bundle_phase",
      continueFromAttemptCounts: [],
    },
  );
  assert.equal(initialScript.allowed, true);
  assert.equal((await completeMeteredAiOperation(initialScript)).completed, true);
  const initialSpeech = await authorizeMeteredAiOperation(
    currentUser,
    "reservation-actions",
    "narration_initial",
    "initial-bundle",
    {
      allowCreate: false,
      continuationMode: "narration_bundle_phase",
      continueFromAttemptCounts: [1],
    },
  );
  assert.equal(initialSpeech.allowed, true, "signed bundle phases can continue");
  await releaseMeteredAiOperation(initialSpeech);
});

test("completion races remain atomic against release, refund, and expiry", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "user-completion-races";
  const currentUser = {
    id: userId,
    email: "races@example.invalid",
    billingEmail: null,
    fullName: null,
  };
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
    `)
    .run(userId, currentUser.email, "cus-races", now, now);

  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'free', 'reserved', ?, ?, NULL, NULL)
    `)
    .run("race-release", userId, "key-race-release", now, now + 3_600);
  const [completedAgainstRelease, released] = await Promise.all([
    completeUsage(currentUser, "race-release"),
    releaseUsage(currentUser, "race-release"),
  ]);
  const releaseRaceStatus = database.sqlite
    .prepare("SELECT status FROM usage_reservations WHERE id = 'race-release'")
    .get().status;
  assert.ok(["completed", "released"].includes(releaseRaceStatus));
  assert.equal(completedAgainstRelease, releaseRaceStatus === "completed");
  assert.equal(released, releaseRaceStatus === "released");

  database.sqlite
    .prepare(`
      INSERT INTO billing_purchases (
        id, user_id, stripe_customer_id, stripe_payment_intent_id,
        stripe_price_id, credits, refund_blocking_amount, dispute_state,
        revoked_at, stripe_state_synced_at, stripe_state_sync_started_at,
        purchased_at
      ) VALUES (?, ?, ?, ?, 'price_one_time', 1, 0, NULL, NULL, NULL, ?, ?)
    `)
    .run("purchase-race", userId, "cus-races", "pi-race", now, now);
  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'one_time', 'reserved', ?, ?, NULL, ?)
    `)
    .run(
      "race-refund",
      userId,
      "key-race-refund",
      now,
      now + 3_600,
      "purchase-race",
    );
  const refundClaim = {
    purchaseId: "purchase-race",
    userId,
    revokedAt: null,
    paymentIntentId: "pi-race",
    leaseStartedAt: now,
  };
  const [completedAgainstRefund] = await Promise.all([
    completeUsage(currentUser, "race-refund"),
    finishPurchaseStateSync(refundClaim, {
      refundBlockingAmount: 200,
      disputeState: null,
      blocked: true,
    }, now + 1),
  ]);
  const refundRace = database.sqlite
    .prepare(
      "SELECT status, expires_at FROM usage_reservations WHERE id = 'race-refund'",
    )
    .get();
  assert.ok(["completed", "released"].includes(refundRace.status));
  assert.equal(completedAgainstRefund, refundRace.status === "completed");
  assert.notEqual(
    database.sqlite
      .prepare("SELECT revoked_at FROM billing_purchases WHERE id = 'purchase-race'")
      .get().revoked_at,
    null,
  );

  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'free', 'reserved', ?, ?, NULL, NULL)
    `)
    .run("race-expiry", userId, "key-race-expiry", now, now + 30);
  const [completedAgainstExpiry] = await Promise.all([
    completeUsage(currentUser, "race-expiry"),
    settleExpiredUsageReservations(userId, now + 60),
  ]);
  const expiryRaceStatus = database.sqlite
    .prepare("SELECT status FROM usage_reservations WHERE id = 'race-expiry'")
    .get().status;
  assert.ok(["completed", "released"].includes(expiryRaceStatus));
  assert.equal(completedAgainstExpiry, expiryRaceStatus === "completed");
});

test("discarding an unsaved preview restores its slot but preserves AI history", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "user-unsaved-release";
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, "release@example.invalid", now, now);
  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'free', 'reserved', ?, ?, NULL, NULL)
    `)
    .run("reservation-unsaved", userId, "key-unsaved", now, now + 3_600);
  database.sqlite
    .prepare(`
      INSERT INTO metered_ai_actions (
        id, reservation_id, action_id, operation, status, attempt_count,
        observed_milliseconds, created_at, expires_at, succeeded_at,
        failed_at, updated_at
      ) VALUES (?, ?, ?, 'narration_speech', 'succeeded', 1, 0, ?, ?, ?, NULL, ?)
    `)
    .run("metered-unsaved", "reservation-unsaved", "action-unsaved", now, now + 3_600, now, now);

  assert.equal(
    await releaseUsage(
      {
        id: userId,
        email: "release@example.invalid",
        billingEmail: null,
        fullName: null,
      },
      "reservation-unsaved",
    ),
    true,
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT status FROM usage_reservations WHERE id = ?")
      .get("reservation-unsaved").status,
    "released",
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT status FROM metered_ai_actions WHERE id = ?")
      .get("metered-unsaved").status,
    "succeeded",
  );

  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'free', 'reserved', ?, ?, NULL, NULL)
    `)
    .run("reservation-expired-unsaved", userId, "key-expired-unsaved", now - 7_200, now - 10);
  await settleExpiredUsageReservations(userId, now);
  assert.equal(
    database.sqlite
      .prepare("SELECT status FROM usage_reservations WHERE id = ?")
      .get("reservation-expired-unsaved").status,
    "released",
  );
});

test("released free reservations share one lifetime AI budget across concurrent new reservations", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "user-free-entitlement-budget";
  const currentUser = {
    id: userId,
    email: "free-budget@example.invalid",
    billingEmail: null,
    fullName: null,
  };
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, currentUser.email, now, now);

  const insertReservation = (id) =>
    database.sqlite
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds, bucket,
          status, created_at, expires_at, completed_at, billing_purchase_id
        ) VALUES (?, ?, ?, 30, 'free', 'reserved', ?, ?, NULL, NULL)
      `)
      .run(id, userId, `key-${id}`, now, now + 3_600);

  const completeAction = async (reservationId, actionId) => {
    const authorization = await authorizeMeteredAiOperation(
      currentUser,
      reservationId,
      "narration_speech",
      actionId,
    );
    assert.equal(authorization.allowed, true);
    assert.equal((await completeMeteredAiOperation(authorization)).completed, true);
  };

  insertReservation("free-budget-first");
  await completeAction("free-budget-first", "free-first-action-1");
  await completeAction("free-budget-first", "free-first-action-2");
  await completeAction("free-budget-first", "free-first-action-3");
  assert.equal(await releaseUsage(currentUser, "free-budget-first"), true);

  insertReservation("free-budget-second");
  await completeAction("free-budget-second", "free-second-action-1");
  await completeAction("free-budget-second", "free-second-action-2");
  assert.equal(await releaseUsage(currentUser, "free-budget-second"), true);

  insertReservation("free-budget-race-a");
  insertReservation("free-budget-race-b");
  const race = await Promise.all([
    authorizeMeteredAiOperation(
      currentUser,
      "free-budget-race-a",
      "narration_speech",
      "free-race-action-a",
    ),
    authorizeMeteredAiOperation(
      currentUser,
      "free-budget-race-b",
      "narration_speech",
      "free-race-action-b",
    ),
  ]);
  const winner = race.find((result) => result.allowed);
  const loser = race.find((result) => !result.allowed);
  assert.ok(winner, "one final AI action should be authorized");
  assert.ok(loser, "the concurrent extra action must be rejected");
  assert.equal(loser.reason, "entitlement_ai_capacity");
  assert.equal(loser.remaining, 0);
  assert.equal((await completeMeteredAiOperation(winner)).completed, true);

  insertReservation("free-budget-after-limit");
  const afterLimit = await authorizeMeteredAiOperation(
    currentUser,
    "free-budget-after-limit",
    "narration_speech",
    "free-after-limit-action",
  );
  assert.equal(afterLimit.allowed, false);
  assert.equal(afterLimit.reason, "entitlement_ai_limit");
  assert.equal(afterLimit.entitlementSuccessfulCount, 6);
  assert.equal(afterLimit.remaining, 0);
});

test("paid and operator AI budgets inherit released usage only inside their entitlement scope", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const insertUser = (id, stripeCustomerId) =>
    database.sqlite
      .prepare(`
        INSERT INTO users (
          id, email, billing_email, full_name, stripe_customer_id,
          created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?)
      `)
      .run(id, `${id}@example.invalid`, stripeCustomerId, now, now);
  const insertReservation = ({
    id,
    userId,
    bucket,
    createdAt,
    purchaseId = null,
  }) =>
    database.sqlite
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds, bucket,
          status, created_at, expires_at, completed_at, billing_purchase_id
        ) VALUES (?, ?, ?, 30, ?, 'released', ?, ?, NULL, ?)
      `)
      .run(id, userId, `key-${id}`, bucket, createdAt, createdAt + 3_600, purchaseId);
  const insertSucceededAction = (id, reservationId, createdAt) =>
    database.sqlite
      .prepare(`
        INSERT INTO metered_ai_actions (
          id, reservation_id, action_id, operation, status, attempt_count,
          observed_milliseconds, created_at, expires_at, succeeded_at,
          failed_at, updated_at
        ) VALUES (?, ?, ?, 'narration_speech', 'succeeded', 1, 0, ?, ?, ?, NULL, ?)
      `)
      .run(id, reservationId, `action-${id}`, createdAt, createdAt + 3_600, createdAt, createdAt);

  const purchaseUserId = "user-budget-purchases";
  insertUser(purchaseUserId, "cus-budget-purchases");
  for (const [id, paymentIntent, purchasedAt] of [
    ["budget-purchase-a", "pi-budget-a", now - 20],
    ["budget-purchase-b", "pi-budget-b", now - 10],
  ]) {
    database.sqlite
      .prepare(`
        INSERT INTO billing_purchases (
          id, user_id, stripe_customer_id, stripe_payment_intent_id,
          stripe_price_id, credits, refund_blocking_amount, dispute_state,
          revoked_at, stripe_state_synced_at, stripe_state_sync_started_at,
          purchased_at
        ) VALUES (?, ?, 'cus-budget-purchases', ?, 'price_one_time', 1, 0,
          NULL, NULL, NULL, NULL, ?)
      `)
      .run(id, purchaseUserId, paymentIntent, purchasedAt);
  }
  insertReservation({
    id: "purchase-a-released",
    userId: purchaseUserId,
    bucket: "one_time",
    createdAt: now - 8,
    purchaseId: "budget-purchase-a",
  });
  insertSucceededAction("purchase-a-success", "purchase-a-released", now - 7);
  const purchaseABudget = await getAiEntitlementBudgetForReservation(
    {
      id: "purchase-a-current",
      userId: purchaseUserId,
      bucket: "one_time",
      createdAt: now,
      billingPurchaseId: "budget-purchase-a",
    },
    now,
  );
  const purchaseBBudget = await getAiEntitlementBudgetForReservation(
    {
      id: "purchase-b-current",
      userId: purchaseUserId,
      bucket: "one_time",
      createdAt: now,
      billingPurchaseId: "budget-purchase-b",
    },
    now,
  );
  assert.equal(purchaseABudget.successfulCount, 1, "same purchase inherits released usage");
  assert.equal(purchaseABudget.remaining, 4);
  assert.equal(purchaseBBudget.successfulCount, 0, "a different purchase starts a new budget");
  assert.equal(purchaseBBudget.remaining, 5);

  insertReservation({
    id: "purchase-legacy-released",
    userId: purchaseUserId,
    bucket: "one_time",
    createdAt: now - 6,
  });
  insertSucceededAction(
    "purchase-legacy-success",
    "purchase-legacy-released",
    now - 5,
  );
  const legacyPurchaseBudget = await getAiEntitlementBudgetForReservation(
    {
      id: "purchase-legacy-current",
      userId: purchaseUserId,
      bucket: "one_time",
      createdAt: now,
      billingPurchaseId: null,
    },
    now,
  );
  assert.equal(legacyPurchaseBudget.successfulLimit, 10);
  assert.equal(legacyPurchaseBudget.successfulCount, 1);

  const subscriptionUserId = "user-budget-subscription";
  insertUser(subscriptionUserId, "cus-budget-subscription");
  const periodStart = now - 100;
  const periodEnd = now + 100;
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES (?, ?, 'cus-budget-subscription', 'price_standard', 'standard',
        'active', ?, ?, NULL, 0, ?, ?)
    `)
    .run("budget-subscription", subscriptionUserId, periodStart, periodEnd, now, now);
  insertReservation({
    id: "subscription-previous-period",
    userId: subscriptionUserId,
    bucket: "subscription",
    createdAt: periodStart - 10,
  });
  insertSucceededAction(
    "subscription-previous-success",
    "subscription-previous-period",
    periodStart - 9,
  );
  insertReservation({
    id: "subscription-current-released",
    userId: subscriptionUserId,
    bucket: "subscription",
    createdAt: periodStart + 10,
  });
  insertSucceededAction(
    "subscription-current-success",
    "subscription-current-released",
    periodStart + 11,
  );
  const currentSubscriptionBudget = await getAiEntitlementBudgetForReservation(
    {
      id: "subscription-current",
      userId: subscriptionUserId,
      bucket: "subscription",
      createdAt: now,
      billingPurchaseId: null,
    },
    now,
  );
  assert.equal(currentSubscriptionBudget.successfulCount, 1);
  assert.equal(currentSubscriptionBudget.successfulLimit, 42);

  const nextPeriodStart = periodEnd;
  const nextPeriodEnd = periodEnd + 200;
  database.sqlite
    .prepare(`
      UPDATE billing_subscriptions
      SET current_period_start = ?, current_period_end = ?, updated_at = ?
      WHERE id = 'budget-subscription'
    `)
    .run(nextPeriodStart, nextPeriodEnd, nextPeriodStart);
  const nextSubscriptionBudget = await getAiEntitlementBudgetForReservation(
    {
      id: "subscription-next",
      userId: subscriptionUserId,
      bucket: "subscription",
      createdAt: nextPeriodStart + 1,
      billingPurchaseId: null,
    },
    nextPeriodStart + 1,
  );
  assert.equal(nextSubscriptionBudget.successfulCount, 0, "a renewed period starts fresh");

  const operatorUserId = "user-budget-operator";
  insertUser(operatorUserId, null);
  const jstDayStart =
    Math.floor((now + 9 * 60 * 60) / (24 * 60 * 60)) * (24 * 60 * 60) -
    9 * 60 * 60;
  insertReservation({
    id: "operator-previous-day",
    userId: operatorUserId,
    bucket: "operator",
    createdAt: jstDayStart - 20,
  });
  insertSucceededAction(
    "operator-previous-success",
    "operator-previous-day",
    jstDayStart - 10,
  );
  insertReservation({
    id: "operator-current-released",
    userId: operatorUserId,
    bucket: "operator",
    createdAt: jstDayStart + 10,
  });
  insertSucceededAction(
    "operator-current-success",
    "operator-current-released",
    jstDayStart + 20,
  );
  const currentOperatorBudget = await getAiEntitlementBudgetForReservation(
    {
      id: "operator-current",
      userId: operatorUserId,
      bucket: "operator",
      createdAt: jstDayStart + 30,
      billingPurchaseId: null,
    },
    jstDayStart + 30,
  );
  assert.equal(currentOperatorBudget.successfulCount, 1);
  assert.equal(currentOperatorBudget.successfulLimit, 200);
  const nextOperatorBudget = await getAiEntitlementBudgetForReservation(
    {
      id: "operator-next",
      userId: operatorUserId,
      bucket: "operator",
      createdAt: jstDayStart + 24 * 60 * 60 + 30,
      billingPurchaseId: null,
    },
    jstDayStart + 24 * 60 * 60 + 30,
  );
  assert.equal(nextOperatorBudget.successfulCount, 0, "the next JST day starts fresh");
});

function accountRequest(accountToken, trialId) {
  return new Request("https://torudake-reel.pages.dev/account", {
    headers: {
      cookie: cookieHeader(accountToken, trialId),
      origin: "https://torudake-reel.pages.dev",
      "cf-connecting-ip": "203.0.113.80",
    },
  });
}

function cookieHeader(accountToken, trialId) {
  return [
    accountSessionCookie(accountToken, true).split(";", 1)[0],
    `torudake_trial_id=${trialId}`,
  ].join("; ");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
