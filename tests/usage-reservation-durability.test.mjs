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
    this.batchTail = Promise.resolve();
  }

  prepare(query) {
    return new D1Statement(this, query);
  }

  async batch(statements) {
    const execute = async () => {
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
    };
    const pending = this.batchTail.then(execute, execute);
    this.batchTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

const database = new D1Database();
const migrationDirectory = new URL("../drizzle/", import.meta.url);
const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
for (const fileName of migrationFiles) {
  const source = await readFile(new URL(fileName, migrationDirectory), "utf8");
  database.sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
}

globalThis.__cloudflareEnv = { DB: database };

const {
  completeUsage,
  getUsageReservationState,
  OperatorUsageLimitError,
  renewUsageReservation,
  requestUsageRelease,
  reserveUsage,
  USAGE_RESERVATION_LIFETIME_SECONDS,
} = await import("../lib/billing-store.ts");
const {
  acquireUsageOperationLease,
  METERED_AI_LEASE_SCOPE,
  releaseUsageOperationLease,
} = await import("../lib/operator-usage.ts");

function user(id) {
  return {
    id,
    email: `${id}@example.invalid`,
    billingEmail: null,
    fullName: null,
  };
}

function addUser(currentUser, now) {
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(currentUser.id, currentUser.email, now, now);
}

function addFreeReservation({ id, currentUser, key, createdAt, expiresAt }) {
  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        status, created_at, expires_at, completed_at, release_requested_at,
        billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'free', 'reserved', ?, ?, NULL, NULL, NULL)
    `)
    .run(id, currentUser.id, key, createdAt, expiresAt);
}

test("renews the same reservation before the 60-minute boundary", async () => {
  const now = 2_000_000_000;
  const currentUser = user("usage-renew-59-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-renew-59-reservation",
    currentUser,
    key: "usage-renew-59-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });

  const renewalTime = now + 59 * 60;
  const renewed = await renewUsageReservation(
    currentUser,
    { idempotencyKey: "usage-renew-59-key" },
    { sourceDurationSeconds: 30 },
    renewalTime,
  );
  assert.equal(renewed.id, "usage-renew-59-reservation");
  assert.equal(renewed.reservationOutcome, "renewed");
  assert.equal(
    renewed.expiresAt,
    renewalTime + USAGE_RESERVATION_LIFETIME_SECONDS,
  );
  const state = await getUsageReservationState(
    currentUser,
    { idempotencyKey: "usage-renew-59-key" },
    renewalTime,
  );
  assert.equal(state.ttlSeconds, USAGE_RESERVATION_LIFETIME_SECONDS);
  assert.equal(renewed.status, "reserved");
});

test("reactivates the same idempotent row after the 60-minute boundary", async () => {
  const now = 2_010_000_000;
  const currentUser = user("usage-renew-61-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-renew-61-reservation",
    currentUser,
    key: "usage-renew-61-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });

  const renewalTime = now + 61 * 60;
  const renewed = await renewUsageReservation(
    currentUser,
    { reservationId: "usage-renew-61-reservation" },
    { sourceDurationSeconds: 30 },
    renewalTime,
  );
  assert.equal(renewed.id, "usage-renew-61-reservation");
  assert.equal(renewed.reservationOutcome, "reactivated");
  assert.equal(renewed.createdAt, renewalTime);
  assert.equal(
    renewed.expiresAt,
    renewalTime + USAGE_RESERVATION_LIFETIME_SECONDS,
  );
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE idempotency_key = ?",
      )
      .get("usage-renew-61-key").count,
    1,
  );
});

test("refuses to renew an operator reservation after operator access is revoked", async () => {
  const now = 2_012_000_000;
  const currentUser = user("usage-revoked-operator-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-revoked-operator-reservation",
    currentUser,
    key: "usage-revoked-operator-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare("UPDATE usage_reservations SET bucket = 'operator' WHERE id = ?")
    .run("usage-revoked-operator-reservation");

  await assert.rejects(
    renewUsageReservation(
      currentUser,
      { idempotencyKey: "usage-revoked-operator-key" },
      { sourceDurationSeconds: 30, operator: false },
      now + 60,
    ),
    OperatorUsageLimitError,
  );
  const unchanged = database.sqlite
    .prepare(
      "SELECT expires_at, release_requested_at FROM usage_reservations WHERE id = ?",
    )
    .get("usage-revoked-operator-reservation");
  assert.equal(unchanged.expires_at, now + USAGE_RESERVATION_LIFETIME_SECONDS);
  assert.equal(unchanged.release_requested_at, null);
});

test("recovers a lost reserve response by idempotency key without double booking", async () => {
  const currentUser = user("usage-response-loss-user");
  addUser(currentUser, Math.floor(Date.now() / 1_000));
  const key = "usage-response-loss-key";
  const first = await reserveUsage(currentUser, 30, key);
  const retry = await reserveUsage(currentUser, 30, key);
  assert.equal(first.reservationOutcome, "created");
  assert.equal(retry.reservationOutcome, "existing");
  assert.equal(retry.id, first.id);

  const release = await requestUsageRelease(currentUser, {
    idempotencyKey: key,
  });
  assert.equal(release.released, true);
  assert.equal(release.reservationId, first.id);

  const concurrent = await Promise.all([
    reserveUsage(currentUser, 30, key),
    reserveUsage(currentUser, 30, key),
  ]);
  assert.ok(concurrent.every((reservation) => reservation.id === first.id));
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE idempotency_key = ?",
      )
      .get(key).count,
    1,
  );
});

test("honors a key-only release intent that arrives before reserve commits", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const currentUser = user("usage-release-before-reserve-user");
  addUser(currentUser, now);
  const key = "usage-release-before-reserve-key";

  const earlyRelease = await requestUsageRelease(
    currentUser,
    { idempotencyKey: key },
    now,
  );
  assert.deepEqual(earlyRelease, {
    released: false,
    pending: true,
    status: "release_pending",
    reservationId: null,
  });

  const reservation = await reserveUsage(currentUser, 30, key);
  assert.equal(reservation.status, "released");
  assert.equal(reservation.releaseRequestedAt, now);
  const retry = await reserveUsage(currentUser, 30, key);
  assert.equal(retry.id, reservation.id);
  assert.equal(retry.status, "released");
  const status = await getUsageReservationState(
    currentUser,
    { idempotencyKey: key },
    now,
  );
  assert.equal(status.status, "released");
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE user_id = ? AND status IN ('reserved', 'completed')",
      )
      .get(currentUser.id).count,
    0,
    "the preempted request must not consume entitlement",
  );
});

test("bounds and idempotently retries release-intent tombstones", async () => {
  const now = 2_015_000_000;
  const currentUser = user("usage-release-intent-cap-user");
  addUser(currentUser, now);
  for (let index = 0; index < 24; index += 1) {
    const key = `usage-cap-key-${String(index).padStart(2, "0")}`;
    await requestUsageRelease(currentUser, { idempotencyKey: key }, now + index);
  }
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_release_intents WHERE user_id = ?",
      )
      .get(currentUser.id).count,
    16,
  );
  const retryKey = "usage-cap-key-23";
  const retried = await requestUsageRelease(
    currentUser,
    { idempotencyKey: retryKey },
    now + 30,
  );
  assert.equal(retried.status, "release_pending");
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_release_intents WHERE user_id = ? AND idempotency_key = ?",
      )
      .get(currentUser.id, retryKey).count,
    1,
  );
});

test("serializes concurrent reserve and key-only release without an active leak", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const currentUser = user("usage-reserve-release-race-user");
  addUser(currentUser, now);
  for (let index = 0; index < 6; index += 1) {
    const key = `usage-reserve-release-race-${index}`;
    const operations =
      index % 2 === 0
        ? [
            requestUsageRelease(currentUser, { idempotencyKey: key }, now),
            reserveUsage(currentUser, 20, key),
          ]
        : [
            reserveUsage(currentUser, 20, key),
            requestUsageRelease(currentUser, { idempotencyKey: key }, now),
          ];
    await Promise.all(operations);
    const state = await getUsageReservationState(
      currentUser,
      { idempotencyKey: key },
      now,
    );
    assert.ok(state);
    assert.ok(
      state.status === "released" || state.status === "release_pending",
    );
    const retry = await reserveUsage(currentUser, 20, key);
    assert.equal(retry.id, state.reservation.id);
    assert.notEqual(retry.status, "completed");
  }
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE user_id = ? AND status IN ('reserved', 'completed')",
      )
      .get(currentUser.id).count,
    0,
  );
});

test("rebinds an unexpired reservation across a natural subscription period rollover", async () => {
  const now = 2_016_000_000;
  const currentUser = user("usage-subscription-rollover-user");
  addUser(currentUser, now);
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES (?, ?, 'cus-rollover', 'price-standard', 'standard', 'active',
        ?, ?, NULL, 0, ?, ?)
    `)
    .run("sub-rollover", currentUser.id, now - 30, now + 30, now - 30, now);
  addFreeReservation({
    id: "usage-subscription-rollover-reservation",
    currentUser,
    key: "usage-subscription-rollover-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare("UPDATE usage_reservations SET bucket = 'subscription' WHERE id = ?")
    .run("usage-subscription-rollover-reservation");
  const renewalTime = now + 60;
  database.sqlite
    .prepare(`
      UPDATE billing_subscriptions
      SET current_period_start = ?, current_period_end = ?, updated_at = ?
      WHERE id = 'sub-rollover'
    `)
    .run(renewalTime - 1, renewalTime + 2_592_000, renewalTime);

  const renewed = await renewUsageReservation(
    currentUser,
    { idempotencyKey: "usage-subscription-rollover-key" },
    { sourceDurationSeconds: 30 },
    renewalTime,
  );
  assert.equal(renewed.id, "usage-subscription-rollover-reservation");
  assert.equal(renewed.bucket, "subscription");
  assert.equal(renewed.createdAt, renewalTime);
  assert.equal(renewed.reservationOutcome, "reactivated");
});

test("keeps concurrent subscription-period rebinds on one quota row", async () => {
  const now = 2_016_500_000;
  const currentUser = user("usage-concurrent-rollover-user");
  addUser(currentUser, now);
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES ('sub-concurrent-rollover', ?, 'cus-concurrent-rollover',
        'price-standard', 'standard', 'active', ?, ?, NULL, 0, ?, ?)
    `)
    .run(currentUser.id, now + 1, now + 2_592_000, now, now);
  addFreeReservation({
    id: "usage-concurrent-rollover-reservation",
    currentUser,
    key: "usage-concurrent-rollover-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare("UPDATE usage_reservations SET bucket = 'subscription' WHERE id = ?")
    .run("usage-concurrent-rollover-reservation");

  const renewals = await Promise.all([
    renewUsageReservation(
      currentUser,
      { idempotencyKey: "usage-concurrent-rollover-key" },
      { sourceDurationSeconds: 30 },
      now + 2,
    ),
    renewUsageReservation(
      currentUser,
      { idempotencyKey: "usage-concurrent-rollover-key" },
      { sourceDurationSeconds: 30 },
      now + 2,
    ),
  ]);
  assert.ok(
    renewals.every(
      (reservation) =>
        reservation.id === "usage-concurrent-rollover-reservation" &&
        reservation.bucket === "subscription",
    ),
  );
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE idempotency_key = ?",
      )
      .get("usage-concurrent-rollover-key").count,
    1,
  );
});

test("upgrades one-time reservations to a new subscription without spending credit", async () => {
  const now = 2_017_000_000;
  const currentUser = user("usage-one-time-upgrade-user");
  addUser(currentUser, now);
  database.sqlite
    .prepare(`
      INSERT INTO billing_purchases (
        id, user_id, stripe_customer_id, stripe_payment_intent_id,
        stripe_price_id, credits, refund_blocking_amount, dispute_state,
        revoked_at, stripe_state_synced_at, stripe_state_sync_started_at,
        purchased_at
      ) VALUES (?, ?, 'cus-upgrade', 'pi-upgrade', 'price-once', 1,
        0, NULL, NULL, ?, NULL, ?)
    `)
    .run("purchase-upgrade", currentUser.id, now, now);
  addFreeReservation({
    id: "usage-one-time-upgrade-reservation",
    currentUser,
    key: "usage-one-time-upgrade-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare(
      "UPDATE usage_reservations SET bucket = 'one_time', billing_purchase_id = 'purchase-upgrade' WHERE id = ?",
    )
    .run("usage-one-time-upgrade-reservation");
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES ('sub-upgrade', ?, 'cus-upgrade', 'price-standard', 'standard',
        'active', ?, ?, NULL, 0, ?, ?)
    `)
    .run(currentUser.id, now, now + 2_592_000, now, now + 1);

  const renewed = await renewUsageReservation(
    currentUser,
    { idempotencyKey: "usage-one-time-upgrade-key" },
    { sourceDurationSeconds: 30 },
    now + 2,
  );
  assert.equal(renewed.bucket, "subscription");
  assert.equal(renewed.billingPurchaseId, null);
  assert.equal(renewed.reservationOutcome, "reactivated");
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE billing_purchase_id = 'purchase-upgrade' AND status IN ('reserved', 'completed')",
      )
      .get().count,
    0,
  );
});

test("upgrades an unexpired free reservation after a one-time purchase", async () => {
  const now = 2_017_500_000;
  const currentUser = user("usage-free-paid-upgrade-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-free-paid-upgrade-reservation",
    currentUser,
    key: "usage-free-paid-upgrade-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare(`
      INSERT INTO billing_purchases (
        id, user_id, stripe_customer_id, stripe_payment_intent_id,
        stripe_price_id, credits, refund_blocking_amount, dispute_state,
        revoked_at, stripe_state_synced_at, stripe_state_sync_started_at,
        purchased_at
      ) VALUES ('purchase-free-upgrade', ?, 'cus-free-upgrade',
        'pi-free-upgrade', 'price-once', 1, 0, NULL, NULL, ?, NULL, ?)
    `)
    .run(currentUser.id, now, now);

  const renewed = await renewUsageReservation(
    currentUser,
    { idempotencyKey: "usage-free-paid-upgrade-key" },
    { sourceDurationSeconds: 30 },
    now + 1,
  );
  assert.equal(renewed.bucket, "one_time");
  assert.equal(renewed.billingPurchaseId, "purchase-free-upgrade");
  assert.equal(renewed.reservationOutcome, "reactivated");
});

test("moves a revoked one-time reservation to an active subscription", async () => {
  const now = 2_018_000_000;
  const currentUser = user("usage-revoked-one-time-user");
  addUser(currentUser, now);
  database.sqlite
    .prepare(`
      INSERT INTO billing_purchases (
        id, user_id, stripe_customer_id, stripe_payment_intent_id,
        stripe_price_id, credits, refund_blocking_amount, dispute_state,
        revoked_at, stripe_state_synced_at, stripe_state_sync_started_at,
        purchased_at
      ) VALUES ('purchase-revoked', ?, 'cus-revoked', 'pi-revoked',
        'price-once', 1, 200, NULL, ?, ?, NULL, ?)
    `)
    .run(currentUser.id, now, now, now);
  addFreeReservation({
    id: "usage-revoked-one-time-reservation",
    currentUser,
    key: "usage-revoked-one-time-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare(
      "UPDATE usage_reservations SET bucket = 'one_time', billing_purchase_id = 'purchase-revoked' WHERE id = ?",
    )
    .run("usage-revoked-one-time-reservation");
  database.sqlite
    .prepare(`
      INSERT INTO billing_subscriptions (
        id, user_id, stripe_customer_id, stripe_price_id, plan_key, status,
        current_period_start, current_period_end, revoked_period_start,
        cancel_at_period_end, created_at, updated_at
      ) VALUES ('sub-after-refund', ?, 'cus-revoked', 'price-standard',
        'standard', 'active', ?, ?, NULL, 0, ?, ?)
    `)
    .run(currentUser.id, now, now + 2_592_000, now, now + 1);

  const renewed = await renewUsageReservation(
    currentUser,
    { idempotencyKey: "usage-revoked-one-time-key" },
    { sourceDurationSeconds: 30 },
    now + 2,
  );
  assert.equal(renewed.bucket, "subscription");
  assert.equal(renewed.billingPurchaseId, null);
});

test("does not rebind an entitlement while a metered AI lease is active", async () => {
  const now = 2_019_000_000;
  const currentUser = user("usage-rebind-lease-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-rebind-lease-reservation",
    currentUser,
    key: "usage-rebind-lease-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  database.sqlite
    .prepare("UPDATE usage_reservations SET bucket = 'subscription' WHERE id = ?")
    .run("usage-rebind-lease-reservation");
  const lease = await acquireUsageOperationLease(
    "usage-rebind-lease-reservation",
    METERED_AI_LEASE_SCOPE,
    300,
    now,
  );
  assert.ok(lease);
  await assert.rejects(
    renewUsageReservation(
      currentUser,
      { idempotencyKey: "usage-rebind-lease-key" },
      { sourceDurationSeconds: 30 },
      now + 1,
    ),
    /active operation/i,
  );
  assert.equal(await releaseUsageOperationLease(lease, now + 2), true);
});

test("returns completed idempotency keys as terminal without charging again", async () => {
  const currentUser = user("usage-completed-terminal-user");
  addUser(currentUser, Math.floor(Date.now() / 1_000));
  const key = "usage-completed-terminal-key";
  const reservation = await reserveUsage(currentUser, 30, key);
  assert.equal(await completeUsage(currentUser, reservation.id), true);

  const retry = await reserveUsage(currentUser, 30, key);
  assert.equal(retry.id, reservation.id);
  assert.equal(retry.status, "completed");
  assert.equal(retry.reservationOutcome, "existing");
  assert.equal(
    database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM usage_reservations WHERE idempotency_key = ?",
      )
      .get(key).count,
    1,
  );
});

test("persists pagehide release intent until the active AI lease finishes", async () => {
  const now = 2_020_000_000;
  const currentUser = user("usage-release-pending-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-release-pending-reservation",
    currentUser,
    key: "usage-release-pending-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  const lease = await acquireUsageOperationLease(
    "usage-release-pending-reservation",
    METERED_AI_LEASE_SCOPE,
    300,
    now,
  );
  assert.ok(lease);

  const release = await requestUsageRelease(
    currentUser,
    { idempotencyKey: "usage-release-pending-key" },
    now + 1,
  );
  assert.deepEqual(release, {
    released: false,
    pending: true,
    status: "release_pending",
    reservationId: "usage-release-pending-reservation",
  });
  assert.equal(
    await completeUsage(currentUser, "usage-release-pending-reservation"),
    false,
    "a pending pagehide release wins over completion",
  );
  assert.equal(
    await acquireUsageOperationLease(
      "usage-release-pending-reservation",
      METERED_AI_LEASE_SCOPE,
      300,
      now + 301,
    ),
    null,
    "a persisted release request blocks replacement leases",
  );
  assert.equal(await releaseUsageOperationLease(lease, now + 302), true);

  const state = await getUsageReservationState(
    currentUser,
    { reservationId: "usage-release-pending-reservation" },
    now + 302,
  );
  assert.equal(state.status, "released");
  assert.equal(state.releasePending, false);
});

test("treats renewal of release_pending as an explicit resume", async () => {
  const now = 2_022_000_000;
  const currentUser = user("usage-release-resume-user");
  addUser(currentUser, now);
  addFreeReservation({
    id: "usage-release-resume-reservation",
    currentUser,
    key: "usage-release-resume-key",
    createdAt: now,
    expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
  });
  const lease = await acquireUsageOperationLease(
    "usage-release-resume-reservation",
    METERED_AI_LEASE_SCOPE,
    300,
    now,
  );
  assert.ok(lease);
  const release = await requestUsageRelease(
    currentUser,
    { idempotencyKey: "usage-release-resume-key" },
    now + 1,
  );
  assert.equal(release.status, "release_pending");

  const pendingState = await getUsageReservationState(
    currentUser,
    { idempotencyKey: "usage-release-resume-key" },
    now + 1,
  );
  assert.equal(pendingState.status, "release_pending");
  assert.equal(pendingState.renewable, true);

  const resumed = await renewUsageReservation(
    currentUser,
    { idempotencyKey: "usage-release-resume-key" },
    { sourceDurationSeconds: 30 },
    now + 2,
  );
  assert.equal(resumed.reservationOutcome, "renewed");
  assert.equal(resumed.releaseRequestedAt, null);
  assert.equal(resumed.status, "reserved");
  assert.equal(await releaseUsageOperationLease(lease, now + 3), true);
  const state = await getUsageReservationState(
    currentUser,
    { idempotencyKey: "usage-release-resume-key" },
    now + 3,
  );
  assert.equal(state.status, "reserved");
});

test("exposes the renewal contract and keeps schema DDL out of request code", async () => {
  const [
    reserveRoute,
    renewRoute,
    statusRoute,
    releaseRoute,
    operatorSource,
    migration,
  ] = await Promise.all([
    readFile(new URL("../app/api/usage/reserve/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/usage/renew/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/usage/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/usage/release/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/operator-usage.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0018_steady_legion.sql", import.meta.url), "utf8"),
  ]);

  assert.match(reserveRoute, /publicUsageReservationState\(reservation\)/);
  assert.match(reserveRoute, /reservationOutcome:/);
  assert.match(renewRoute, /renewUsageReservation\(/);
  assert.match(statusRoute, /getUsageReservationState\(/);
  assert.match(releaseRoute, /idempotencyKey/);
  assert.match(releaseRoute, /requestUsageRelease\(/);
  assert.doesNotMatch(operatorSource, /CREATE\s+(?:TABLE|INDEX)/i);
  assert.doesNotMatch(operatorSource, /ensureOperatorUsageSchema/);
  assert.match(migration, /release_requested_at/);
  assert.match(migration, /usage_reservations_user_status_expires_idx/);
  assert.match(
    migration,
    /usage_operation_leases_reservation_operation_expires_idx/,
  );
  assert.match(migration, /PRAGMA optimize/);
});

test("applies the new usage migration directly after the existing history", async () => {
  const migrationDatabase = new DatabaseSync(":memory:");
  try {
    for (const fileName of migrationFiles.filter(
      (name) =>
        name !== "0018_steady_legion.sql" &&
        name !== "0019_slim_alice.sql",
    )) {
      const source = await readFile(
        new URL(fileName, migrationDirectory),
        "utf8",
      );
      migrationDatabase.exec(source.replaceAll("--> statement-breakpoint", ""));
    }
    const migration = await readFile(
      new URL("0018_steady_legion.sql", migrationDirectory),
      "utf8",
    );
    migrationDatabase.exec(
      migration.replaceAll("--> statement-breakpoint", ""),
    );

    const columns = migrationDatabase
      .prepare("PRAGMA table_info(usage_reservations)")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes("release_requested_at"));
    const reservationIndexes = migrationDatabase
      .prepare("PRAGMA index_list(usage_reservations)")
      .all()
      .map((index) => index.name);
    assert.ok(
      reservationIndexes.includes("usage_reservations_user_status_expires_idx"),
    );
    assert.ok(
      reservationIndexes.includes(
        "usage_reservations_user_status_bucket_created_idx",
      ),
    );
    const leaseIndexes = migrationDatabase
      .prepare("PRAGMA index_list(usage_operation_leases)")
      .all()
      .map((index) => index.name);
    assert.ok(
      leaseIndexes.includes(
        "usage_operation_leases_reservation_operation_expires_idx",
      ),
    );
  } finally {
    migrationDatabase.close();
  }
});

test("applies and safely reapplies migration 0019 after migration 0018", async () => {
  const migrationDatabase = new DatabaseSync(":memory:");
  try {
    for (const fileName of migrationFiles.filter(
      (name) => name !== "0019_slim_alice.sql",
    )) {
      const source = await readFile(
        new URL(fileName, migrationDirectory),
        "utf8",
      );
      migrationDatabase.exec(source.replaceAll("--> statement-breakpoint", ""));
    }
    const migration = await readFile(
      new URL("0019_slim_alice.sql", migrationDirectory),
      "utf8",
    );
    const source = migration.replaceAll("--> statement-breakpoint", "");
    migrationDatabase.exec(source);
    migrationDatabase.exec(source);
    const columns = migrationDatabase
      .prepare("PRAGMA table_info(usage_release_intents)")
      .all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      "user_id",
      "idempotency_key",
      "requested_at",
      "expires_at",
    ]);
  } finally {
    migrationDatabase.close();
  }
});

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
