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
    return { results: this.database.sqlite.prepare(this.query).all(...this.values) };
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
globalThis.__cloudflareEnv = {
  DB: database,
  TRIAL_ISSUANCE_SECRET: "test-secret-with-at-least-thirty-two-characters",
};

const {
  AccountAuthError,
  deleteAccountPasskey,
  getAccountPasskeys,
  revokeAllAccountSessions,
} = await import("../lib/account-auth.ts");
const {
  accountSessionCookie,
  hashAccountToken,
  randomAccountToken,
} = await import("../lib/account-session.ts");

test("lists named passkeys and localizes the ASCII migration default", async () => {
  const fixture = await createAccountFixture("list");
  insertPasskey(fixture.userId, "credential_list_abcdefghijkl", "Device");
  insertPasskey(fixture.userId, "credential_named_abcdefghijk", "自分のiPhone");

  const passkeys = await getAccountPasskeys(accountRequest(fixture.token));
  assert.deepEqual(
    new Set(passkeys.map((passkey) => passkey.displayName)),
    new Set(["登録済みの端末", "自分のiPhone"]),
  );
});

test("passkey deletion requires recent verification and preserves the final key", async () => {
  const fixture = await createAccountFixture("delete", 11 * 60);
  insertPasskey(fixture.userId, "credential_delete_abcdefghij", "古い端末");
  insertPasskey(fixture.userId, "credential_keep_abcdefghijkl", "今の端末");

  await assert.rejects(
    deleteAccountPasskey(
      accountRequest(fixture.token),
      "credential_delete_abcdefghij",
    ),
    (error) =>
      error instanceof AccountAuthError &&
      error.code === "reauthentication_required",
  );
  database.sqlite
    .prepare("UPDATE account_sessions SET created_at = ? WHERE token_hash = ?")
    .run(Math.floor(Date.now() / 1_000), fixture.tokenHash);
  database.sqlite
    .prepare(`
      INSERT INTO account_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at
      ) VALUES ('other-session', ?, 1, 1, 9999999999)
    `)
    .run(fixture.userId);

  assert.deepEqual(
    await deleteAccountPasskey(
      accountRequest(fixture.token),
      "credential_delete_abcdefghij",
    ),
    { remaining: 1 },
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?")
      .get(fixture.userId).count,
    1,
  );
  await assert.rejects(
    deleteAccountPasskey(
      accountRequest(fixture.token),
      "credential_keep_abcdefghijkl",
    ),
    (error) =>
      error instanceof AccountAuthError &&
      error.code === "last_passkey_cannot_be_deleted",
  );
});

test("revoking all sessions removes the freshly verified session too", async () => {
  const fixture = await createAccountFixture("sessions");
  insertPasskey(fixture.userId, "credential_sessions_abcdefgh", "端末");
  const cookie = await revokeAllAccountSessions(accountRequest(fixture.token));
  assert.match(cookie, /Max-Age=0/);
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?")
      .get(fixture.userId).count,
    0,
  );
});

async function createAccountFixture(suffix, ageSeconds = 0) {
  const now = Math.floor(Date.now() / 1_000);
  const userId = `account-management-${suffix}`;
  const token = randomAccountToken();
  const tokenHash = await hashAccountToken(token);
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, `${suffix}@example.invalid`, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(tokenHash, userId, now - ageSeconds, now, now + 3_600);
  return { userId, token, tokenHash };
}

function insertPasskey(userId, credentialId, displayName) {
  const now = Math.floor(Date.now() / 1_000);
  database.sqlite
    .prepare(`
      INSERT INTO account_passkeys (
        credential_id, user_id, public_key, counter, transports,
        device_type, backed_up, display_name, created_at, updated_at,
        last_used_at
      ) VALUES (?, ?, 'AQID', 0, NULL, 'singleDevice', 0, ?, ?, ?, ?)
    `)
    .run(credentialId, userId, displayName, now, now, now);
}

function accountRequest(token) {
  return new Request("https://torudake-reel.pages.dev/account", {
    headers: {
      cookie: accountSessionCookie(token, true).split(";", 1)[0],
      origin: "https://torudake-reel.pages.dev",
      "cf-connecting-ip": "203.0.113.100",
    },
  });
}

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
