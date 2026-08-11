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
  releaseMonthlyCheckoutLock,
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
