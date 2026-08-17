import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  authenticateVerifiedExternalIdentity,
  ExternalAccountAuthError,
  linkVerifiedExternalIdentity,
} from "../lib/external-account-auth.ts";

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
    this.batchTail = Promise.resolve();
    this.sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL UNIQUE,
        billing_email TEXT,
        full_name TEXT,
        stripe_customer_id TEXT,
        account_deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE trial_sessions (
        session_hash TEXT PRIMARY KEY NOT NULL,
        account_user_id TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE account_external_identities (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        verified_email TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE UNIQUE INDEX account_external_identities_provider_subject_unique
        ON account_external_identities(provider, subject_hash);
      CREATE TABLE account_passkeys (user_id TEXT NOT NULL);
      CREATE TABLE account_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE billing_subscriptions (user_id TEXT NOT NULL);
      CREATE TABLE billing_purchases (user_id TEXT NOT NULL);
      CREATE TABLE usage_reservations (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        source_duration_seconds INTEGER NOT NULL DEFAULT 1,
        bucket TEXT NOT NULL,
        creation_type TEXT NOT NULL DEFAULT 'legacy',
        save_funding_source TEXT NOT NULL DEFAULT 'bucket',
        status TEXT NOT NULL DEFAULT 'reserved',
        created_at INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER NOT NULL DEFAULT 9999999999,
        completed_at INTEGER,
        release_requested_at INTEGER,
        billing_purchase_id TEXT
      );
      CREATE TABLE usage_release_intents (
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL
      );
      CREATE TABLE video_transfers (
        id TEXT PRIMARY KEY NOT NULL,
        owner_email TEXT NOT NULL
      );
      CREATE TABLE ai_disclosure_confirmations (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL
      );
    `);
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

  close() {
    this.sqlite.close();
  }
}

const now = 2_000_000_000;
const sessionHash = "a".repeat(64);
const linkSessionHash = "b".repeat(64);
const subjectHash = "s".repeat(43);
const sourceUserId = "11111111-1111-4111-8111-111111111111";
const targetUserId = "22222222-2222-4222-8222-222222222222";
const sourceEmail = `trial-${"a".repeat(48)}@anonymous.torudake.invalid`;

test("existing provider subject atomically receives the anonymous free reservation", async () => {
  const database = seededDatabase({ existingIdentity: true });
  try {
    database.sqlite.exec(`
      INSERT INTO usage_reservations (id, user_id, bucket, billing_purchase_id)
      VALUES ('reservation-a', '${sourceUserId}', 'free', NULL);
      INSERT INTO usage_release_intents VALUES ('${sourceUserId}', 'request-a');
      INSERT INTO video_transfers VALUES ('transfer-a', '${sourceEmail}');
      INSERT INTO ai_disclosure_confirmations VALUES ('disclosure-a', '${sourceUserId}');
    `);

    const result = await authenticateVerifiedExternalIdentity({
      database,
      trial: trialContext(),
      provider: "google",
      subjectHash,
      verifiedEmail: "verified@example.com",
      now,
    });

    assert.deepEqual(result, { identityId: "identity-a", userId: targetUserId });
    assert.equal(row(database, "SELECT account_user_id AS value FROM trial_sessions").value, targetUserId);
    assert.equal(row(database, "SELECT user_id AS value FROM usage_reservations").value, targetUserId);
    assert.equal(row(database, "SELECT user_id AS value FROM usage_release_intents").value, targetUserId);
    assert.equal(row(database, "SELECT owner_email AS value FROM video_transfers").value, "member@example.com");
    assert.equal(row(database, "SELECT user_id AS value FROM ai_disclosure_confirmations").value, targetUserId);
    assert.equal(
      row(database, "SELECT verified_email AS value FROM account_external_identities").value,
      "verified@example.com",
    );
  } finally {
    database.close();
  }
});

test("a new provider subject binds to the current trial owner without changing reservation ownership", async () => {
  const database = seededDatabase({ existingIdentity: false });
  try {
    database.sqlite.exec(`
      INSERT INTO usage_reservations (id, user_id, bucket, billing_purchase_id)
      VALUES ('reservation-a', '${sourceUserId}', 'free', NULL);
    `);

    const result = await authenticateVerifiedExternalIdentity({
      database,
      trial: trialContext(),
      provider: "line",
      subjectHash,
      verifiedEmail: null,
      now,
    });

    assert.equal(result.userId, sourceUserId);
    assert.equal(row(database, "SELECT account_user_id AS value FROM trial_sessions").value, sourceUserId);
    assert.equal(row(database, "SELECT user_id AS value FROM usage_reservations").value, sourceUserId);
    const identity = row(
      database,
      "SELECT user_id, provider, subject_hash FROM account_external_identities",
    );
    assert.deepEqual({ ...identity }, {
      user_id: sourceUserId,
      provider: "line",
      subject_hash: subjectHash,
    });
  } finally {
    database.close();
  }
});

test("an existing provider identity can log in without a trial, but a new identity cannot register", async () => {
  const existingDatabase = seededDatabase({ existingIdentity: true });
  try {
    const result = await authenticateVerifiedExternalIdentity({
      database: existingDatabase,
      trial: null,
      provider: "google",
      subjectHash,
      verifiedEmail: "login@example.com",
      now: now + 10,
    });
    assert.deepEqual(result, { identityId: "identity-a", userId: targetUserId });
    const identity = row(
      existingDatabase,
      "SELECT verified_email, last_used_at FROM account_external_identities",
    );
    assert.equal(identity.verified_email, "login@example.com");
    assert.equal(identity.last_used_at, now + 10);
    assert.equal(
      row(existingDatabase, "SELECT account_user_id AS value FROM trial_sessions").value,
      null,
    );
  } finally {
    existingDatabase.close();
  }

  const newIdentityDatabase = seededDatabase({ existingIdentity: false });
  try {
    await assert.rejects(
      authenticateVerifiedExternalIdentity({
        database: newIdentityDatabase,
        trial: null,
        provider: "line",
        subjectHash,
        verifiedEmail: null,
        now,
      }),
      (error) =>
        error instanceof ExternalAccountAuthError &&
        error.code === "external_identity_not_registered",
    );
    assert.equal(
      row(
        newIdentityDatabase,
        "SELECT COUNT(*) AS value FROM account_external_identities",
      ).value,
      0,
    );
  } finally {
    newIdentityDatabase.close();
  }
});

test("links a verified subject only to the selected account and retries idempotently", async () => {
  const database = seededDatabase({ existingIdentity: false });
  try {
    const first = await linkVerifiedExternalIdentity({
      database,
      userId: targetUserId,
      provider: "google",
      subjectHash,
      verifiedEmail: "linked@example.com",
      initiatingSessionTokenHash: linkSessionHash,
      now,
    });
    assert.equal(first.userId, targetUserId);
    assert.equal(first.reused, false);

    const retried = await linkVerifiedExternalIdentity({
      database,
      userId: targetUserId,
      provider: "google",
      subjectHash,
      verifiedEmail: "updated@example.com",
      initiatingSessionTokenHash: linkSessionHash,
      now: now + 1,
    });
    assert.deepEqual(retried, {
      identityId: first.identityId,
      userId: targetUserId,
      reused: true,
    });
    assert.deepEqual(
      { ...row(database, `
        SELECT user_id, verified_email, last_used_at
        FROM account_external_identities
      `) },
      {
        user_id: targetUserId,
        verified_email: "updated@example.com",
        last_used_at: now + 1,
      },
    );
    assert.equal(
      row(database, "SELECT COUNT(*) AS value FROM account_external_identities").value,
      1,
    );
    assert.equal(
      row(database, `SELECT email AS value FROM users WHERE id = '${targetUserId}'`).value,
      "member@example.com",
      "verified email metadata must not merge or rewrite users",
    );
    assert.equal(
      row(database, "SELECT account_user_id AS value FROM trial_sessions").value,
      null,
      "linking must not bind or transfer a trial",
    );
  } finally {
    database.close();
  }
});

test("rejects a subject owned by another account and never revives a revoked identity", async () => {
  for (const revoked of [false, true]) {
    const database = seededDatabase({ existingIdentity: true });
    try {
      if (revoked) {
        database.sqlite.exec(
          `UPDATE account_external_identities SET revoked_at = ${now}`,
        );
      }
      await assert.rejects(
        linkVerifiedExternalIdentity({
          database,
          userId: sourceUserId,
          provider: "google",
          subjectHash,
          verifiedEmail: sourceEmail,
          initiatingSessionTokenHash: linkSessionHash,
          now: now + 1,
        }),
        (error) =>
          error instanceof ExternalAccountAuthError &&
          error.code === "external_identity_already_linked" &&
          error.status === 409,
      );
      assert.equal(
        row(database, "SELECT user_id AS value FROM account_external_identities").value,
        targetUserId,
      );
      assert.equal(
        row(database, "SELECT revoked_at AS value FROM account_external_identities").value,
        revoked ? now : null,
      );
    } finally {
      database.close();
    }
  }
});

test("does not revive a revoked identity already owned by the same account", async () => {
  const database = seededDatabase({ existingIdentity: true });
  try {
    database.sqlite.exec(
      `UPDATE account_external_identities SET revoked_at = ${now}`,
    );
    await assert.rejects(
      linkVerifiedExternalIdentity({
        database,
        userId: targetUserId,
        provider: "google",
        subjectHash,
        verifiedEmail: "linked@example.com",
        initiatingSessionTokenHash: linkSessionHash,
        now: now + 1,
      }),
      (error) =>
        error instanceof ExternalAccountAuthError &&
        error.code === "external_identity_unavailable",
    );
    assert.equal(
      row(database, "SELECT revoked_at AS value FROM account_external_identities").value,
      now,
    );
  } finally {
    database.close();
  }
});

test("paid or previously authenticated trial owners cannot be merged into another account", async () => {
  for (const unsafeRow of [
    `INSERT INTO billing_subscriptions VALUES ('${sourceUserId}')`,
    `INSERT INTO account_sessions VALUES ('${"c".repeat(64)}', '${sourceUserId}', ${now}, ${now + 600})`,
    `INSERT INTO usage_reservations (id, user_id, bucket, billing_purchase_id)
     VALUES ('reservation-paid', '${sourceUserId}', 'subscription', NULL)`,
  ]) {
    const database = seededDatabase({ existingIdentity: true });
    try {
      database.sqlite.exec(`
        INSERT INTO usage_reservations (id, user_id, bucket, billing_purchase_id)
        VALUES ('reservation-free', '${sourceUserId}', 'free', NULL);
        ${unsafeRow};
      `);

      await assert.rejects(
        authenticateVerifiedExternalIdentity({
          database,
          trial: trialContext(),
          provider: "google",
          subjectHash,
          verifiedEmail: null,
          now,
        }),
        (error) =>
          error instanceof ExternalAccountAuthError &&
          error.code === "unsafe_trial_account_merge",
      );
      assert.equal(row(database, "SELECT account_user_id AS value FROM trial_sessions").value, null);
      assert.equal(
        row(
          database,
          "SELECT user_id AS value FROM usage_reservations WHERE id = 'reservation-free'",
        ).value,
        sourceUserId,
      );
    } finally {
      database.close();
    }
  }
});

function seededDatabase({ existingIdentity }) {
  const database = new D1Database();
  const insertUser = database.sqlite.prepare(`
    INSERT INTO users (
      id, email, billing_email, full_name, stripe_customer_id,
      account_deleted_at, created_at, updated_at
    ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);
  insertUser.run(sourceUserId, sourceEmail, now, now);
  insertUser.run(targetUserId, "member@example.com", now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(linkSessionHash, targetUserId, now, now + 600);
  database.sqlite
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash, account_user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, NULL, ?, ?, ?)
    `)
    .run(sessionHash, now, now, now + 600);
  if (existingIdentity) {
    database.sqlite
      .prepare(`
        INSERT INTO account_external_identities (
          id, user_id, provider, subject_hash, verified_email,
          created_at, last_used_at, revoked_at
        ) VALUES ('identity-a', ?, 'google', ?, NULL, ?, ?, NULL)
      `)
      .run(targetUserId, subjectHash, now, now);
  }
  return database;
}

function trialContext() {
  return {
    sessionId: "browser-session-id",
    sessionHash,
    principalEmail: sourceEmail,
    userId: sourceUserId,
  };
}

function row(database, query) {
  return database.sqlite.prepare(query).get();
}
