import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  FREE_AI_OPERATION_SUCCESS_LIMIT,
  getAiOperationSuccessLimit,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  OPERATOR_AI_OPERATION_SUCCESS_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
} from "../lib/billing-policy.ts";

const runtimeEnv = {};

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

function createDatabase() {
  const database = new D1Database();
  database.sqlite.exec(`
    CREATE TABLE usage_reservations (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      source_duration_seconds integer NOT NULL,
      bucket text NOT NULL,
      status text DEFAULT 'reserved' NOT NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL,
      completed_at integer
    )
  `);
  return database;
}

function addReservation(database, id, now, duration = 90) {
  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, source_duration_seconds, bucket, status,
        created_at, expires_at, completed_at
      ) VALUES (?, 'user-1', ?, 'free', 'reserved', ?, ?, NULL)
    `)
    .run(id, duration, now, now + 3_600);
}

test("maps every billing bucket to its shared AI action limit", () => {
  assert.equal(FREE_AI_OPERATION_SUCCESS_LIMIT, 3);
  assert.equal(SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT, 10);
  assert.equal(ONE_TIME_AI_OPERATION_SUCCESS_LIMIT, 5);
  assert.equal(OPERATOR_AI_OPERATION_SUCCESS_LIMIT, 10);
  assert.equal(getAiOperationSuccessLimit("free"), 3);
  assert.equal(getAiOperationSuccessLimit("subscription"), 10);
  assert.equal(getAiOperationSuccessLimit("one_time"), 5);
  assert.equal(getAiOperationSuccessLimit("operator"), 10);
});

test("counts logical actions once, resumes chunks, and closes release races", async () => {
  const database = createDatabase();
  const now = 2_000_000_000;
  addReservation(database, "video-1", now);
  addReservation(database, "video-failed", now);
  addReservation(database, "video-race", now);
  addReservation(database, "video-attempt", now);
  addReservation(database, "video-duration", now);
  addReservation(database, "video-legacy", now);
  runtimeEnv.DB = database;
  globalThis.__cloudflareEnv = runtimeEnv;

  try {
    const moduleUrl = new URL("../lib/operator-usage.ts", import.meta.url);
    moduleUrl.searchParams.set("metered", `${process.pid}-${Date.now()}`);
    const usage = await import(moduleUrl.href);
    const {
      METERED_AI_LEASE_SCOPE,
      acquireUsageOperationLease,
      continueMeteredAiAction,
      createMeteredAiAction,
      getMeteredAiAction,
      getMeteredAiUsageCounts,
      markMeteredAiActionFailed,
      markMeteredAiActionSucceeded,
      recordMeteredAiTranscriptionDuration,
      releaseOrCompleteUsageReservation,
      releaseUsageOperationLease,
    } = usage;

    let lease = await acquireUsageOperationLease(
      "video-1",
      METERED_AI_LEASE_SCOPE,
      300,
      now,
    );
    assert.ok(lease);
    assert.equal(
      await acquireUsageOperationLease(
        "video-1",
        METERED_AI_LEASE_SCOPE,
        300,
        now + 1,
      ),
      null,
      "different AI operation types share one reservation lease",
    );

    let action = await createMeteredAiAction(
      "video-1",
      "transcribe_action_1",
      "transcribe",
      3,
      lease,
      now,
    );
    assert.ok(action);
    assert.deepEqual(await getMeteredAiUsageCounts("video-1", now), {
      successfulCount: 0,
      pendingCount: 1,
    });
    assert.deepEqual(
      await recordMeteredAiTranscriptionDuration(action, lease, 30, now),
      { allowed: true, reason: null, observedSeconds: 30 },
    );
    action = await markMeteredAiActionSucceeded(action, lease, 3, now);
    assert.ok(action);
    assert.equal(action.status, "succeeded");
    assert.equal(await releaseUsageOperationLease(lease), true);
    assert.deepEqual(await getMeteredAiUsageCounts("video-1", now), {
      successfulCount: 1,
      pendingCount: 0,
    });

    lease = await acquireUsageOperationLease(
      "video-1",
      METERED_AI_LEASE_SCOPE,
      300,
      now + 2,
    );
    assert.ok(lease);
    action = await getMeteredAiAction("video-1", "transcribe_action_1");
    action = await continueMeteredAiAction(action, lease, now + 2);
    assert.ok(action, "a later chunk can resume an already successful action");
    assert.equal(action.attemptCount, 2);
    assert.deepEqual(
      await recordMeteredAiTranscriptionDuration(action, lease, 30, now + 2),
      { allowed: true, reason: null, observedSeconds: 60 },
    );
    action = await markMeteredAiActionSucceeded(action, lease, 3, now + 2);
    assert.ok(action, "completion is idempotent for the same action ID");
    await releaseUsageOperationLease(lease);
    assert.equal(
      (await getMeteredAiUsageCounts("video-1", now + 2)).successfulCount,
      1,
      "chunks and retries do not decrement the shared quota twice",
    );

    for (const [index, operation] of [
      [2, "narration_script"],
      [3, "narration_speech"],
    ]) {
      lease = await acquireUsageOperationLease(
        "video-1",
        METERED_AI_LEASE_SCOPE,
        300,
        now + index,
      );
      action = await createMeteredAiAction(
        "video-1",
        `logical_action_${index}`,
        operation,
        3,
        lease,
        now + index,
      );
      assert.ok(action);
      assert.ok(
        await markMeteredAiActionSucceeded(action, lease, 3, now + index),
      );
      await releaseUsageOperationLease(lease);
    }
    assert.equal(
      (await getMeteredAiUsageCounts("video-1", now + 4)).successfulCount,
      3,
    );
    lease = await acquireUsageOperationLease(
      "video-1",
      METERED_AI_LEASE_SCOPE,
      300,
      now + 5,
    );
    assert.equal(
      await createMeteredAiAction(
        "video-1",
        "logical_action_4",
        "narration_script",
        3,
        lease,
        now + 5,
      ),
      null,
      "the fourth distinct successful slot is refused atomically",
    );
    await releaseUsageOperationLease(lease);

    lease = await acquireUsageOperationLease(
      "video-failed",
      METERED_AI_LEASE_SCOPE,
      300,
      now,
    );
    action = await createMeteredAiAction(
      "video-failed",
      "failed_action_1",
      "narration_script",
      3,
      lease,
      now,
    );
    assert.ok(await markMeteredAiActionFailed(action, lease, now));
    await releaseUsageOperationLease(lease);
    assert.deepEqual(await getMeteredAiUsageCounts("video-failed", now), {
      successfulCount: 0,
      pendingCount: 0,
    });

    lease = await acquireUsageOperationLease(
      "video-attempt",
      METERED_AI_LEASE_SCOPE,
      300,
      now,
    );
    action = await createMeteredAiAction(
      "video-attempt",
      "bounded_speech_action",
      "narration_speech",
      3,
      lease,
      now,
    );
    action = await markMeteredAiActionSucceeded(action, lease, 3, now);
    await releaseUsageOperationLease(lease);
    lease = await acquireUsageOperationLease(
      "video-attempt",
      METERED_AI_LEASE_SCOPE,
      300,
      now + 1,
    );
    action = await continueMeteredAiAction(action, lease, now + 1);
    assert.equal(action.attemptCount, 2);
    await releaseUsageOperationLease(lease);
    lease = await acquireUsageOperationLease(
      "video-attempt",
      METERED_AI_LEASE_SCOPE,
      300,
      now + 2,
    );
    assert.equal(
      await continueMeteredAiAction(action, lease, now + 2),
      null,
      "same-action retries stop at the operation-specific attempt cap",
    );
    await releaseUsageOperationLease(lease);

    for (const [offset, actionId] of [
      [0, "duration_action_1"],
      [2, "duration_action_2"],
    ]) {
      lease = await acquireUsageOperationLease(
        "video-duration",
        METERED_AI_LEASE_SCOPE,
        300,
        now + offset,
      );
      action = await createMeteredAiAction(
        "video-duration",
        actionId,
        "transcribe",
        3,
        lease,
        now + offset,
      );
      assert.deepEqual(
        await recordMeteredAiTranscriptionDuration(
          action,
          lease,
          90,
          now + offset,
        ),
        { allowed: true, reason: null, observedSeconds: 90 },
        "each logical transcription action has an independent duration total",
      );
      assert.ok(
        await markMeteredAiActionSucceeded(
          action,
          lease,
          3,
          now + offset,
        ),
      );
      await releaseUsageOperationLease(lease);
    }

    database.sqlite
      .prepare(`
        INSERT INTO operator_usage_operations (
          id, reservation_id, operation, count, successful_count, updated_at
        ) VALUES (?, ?, 'narration_speech', 1, 1, ?)
      `)
      .run("video-legacy:narration_speech", "video-legacy", now);
    lease = await acquireUsageOperationLease(
      "video-legacy",
      METERED_AI_LEASE_SCOPE,
      300,
      now,
    );
    action = await createMeteredAiAction(
      "video-legacy",
      "new_action_after_deploy",
      "narration_script",
      3,
      lease,
      now,
    );
    action = await markMeteredAiActionSucceeded(action, lease, 3, now);
    assert.ok(await markMeteredAiActionSucceeded(action, lease, 3, now));
    await releaseUsageOperationLease(lease);
    assert.equal(
      (await getMeteredAiUsageCounts("video-legacy", now)).successfulCount,
      2,
      "legacy counters are included once and new action completion is idempotent",
    );

    lease = await acquireUsageOperationLease(
      "video-race",
      METERED_AI_LEASE_SCOPE,
      300,
      now,
    );
    action = await createMeteredAiAction(
      "video-race",
      "race_action_1",
      "narration_speech",
      3,
      lease,
      now,
    );
    assert.equal(
      await releaseOrCompleteUsageReservation(
        "video-race",
        "user-1",
        now + 1,
      ),
      null,
      "an active shared AI lease blocks a concurrent refund",
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT status FROM usage_reservations WHERE id = ?")
        .get("video-race").status,
      "reserved",
    );
    assert.ok(await markMeteredAiActionFailed(action, lease, now + 1));
    await releaseUsageOperationLease(lease);
    assert.equal(
      await releaseOrCompleteUsageReservation(
        "video-race",
        "user-1",
        now + 2,
      ),
      "released",
    );
  } finally {
    database.sqlite.close();
    delete runtimeEnv.DB;
  }
});

test("counts all four initial narration phases as one successful AI action", async () => {
  const database = createDatabase();
  const now = 2_100_000_000;
  addReservation(database, "video-initial", now);
  runtimeEnv.DB = database;
  globalThis.__cloudflareEnv = runtimeEnv;

  try {
    const moduleUrl = new URL("../lib/operator-usage.ts", import.meta.url);
    moduleUrl.searchParams.set("initial-bundle", `${process.pid}-${Date.now()}`);
    const {
      METERED_AI_LEASE_SCOPE,
      acquireUsageOperationLease,
      continueMeteredAiAction,
      createMeteredAiAction,
      getMeteredAiAction,
      getMeteredAiUsageCounts,
      markMeteredAiActionSucceeded,
      releaseUsageOperationLease,
    } = await import(moduleUrl.href);

    let lease = await acquireUsageOperationLease(
      "video-initial",
      METERED_AI_LEASE_SCOPE,
      300,
      now,
    );
    let action = await createMeteredAiAction(
      "video-initial",
      "initial_narration_action",
      "narration_initial",
      3,
      lease,
      now,
    );
    assert.ok(action);
    assert.equal(action.attemptCount, 1, "phase 1 is the initial script");
    assert.ok(await markMeteredAiActionSucceeded(action, lease, 3, now));
    await releaseUsageOperationLease(lease);
    assert.deepEqual(await getMeteredAiUsageCounts("video-initial", now), {
      successfulCount: 1,
      pendingCount: 0,
    });

    for (const phase of [2, 3, 4]) {
      lease = await acquireUsageOperationLease(
        "video-initial",
        METERED_AI_LEASE_SCOPE,
        300,
        now + phase,
      );
      action = await getMeteredAiAction(
        "video-initial",
        "initial_narration_action",
      );
      action = await continueMeteredAiAction(action, lease, now + phase);
      assert.ok(action);
      assert.equal(action.attemptCount, phase);
      assert.ok(
        await markMeteredAiActionSucceeded(action, lease, 3, now + phase),
      );
      await releaseUsageOperationLease(lease);
      assert.equal(
        (await getMeteredAiUsageCounts("video-initial", now + phase))
          .successfulCount,
        1,
        `phase ${phase} must remain part of the first successful action`,
      );
    }

    lease = await acquireUsageOperationLease(
      "video-initial",
      METERED_AI_LEASE_SCOPE,
      300,
      now + 5,
    );
    action = await getMeteredAiAction(
      "video-initial",
      "initial_narration_action",
    );
    assert.equal(action.attemptCount, 4);
    assert.equal(
      await continueMeteredAiAction(action, lease, now + 5),
      null,
      "a fifth initial narration phase is refused",
    );
    await releaseUsageOperationLease(lease);
    assert.equal(
      (await getMeteredAiUsageCounts("video-initial", now + 5))
        .successfulCount,
      1,
    );
  } finally {
    database.sqlite.close();
    delete runtimeEnv.DB;
  }
});
