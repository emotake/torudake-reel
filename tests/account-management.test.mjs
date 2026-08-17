import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isoCBOR } from "@simplewebauthn/server/helpers";

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
    this.beforeBatch = null;
  }

  prepare(query) {
    return new D1Statement(this, query);
  }

  async batch(statements) {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    if (beforeBatch) await beforeBatch(statements);
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
  PASSKEY_AUTH_ENABLED: "true",
  TRIAL_ISSUANCE_SECRET: "test-secret-with-at-least-thirty-two-characters",
};

const {
  AccountAuthError,
  authenticationOptions,
  deleteAccountPasskey,
  getAccountAuthenticationState,
  getAccountPasskeys,
  reauthenticationOptions,
  registrationOptions,
  revokeAllAccountSessions,
  verifyAuthentication,
  verifyRegistration,
} = await import("../lib/account-auth.ts");
const {
  accountSessionCookie,
  base64UrlToBytes,
  bytesToBase64Url,
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

test("first passkey registration requires a logged-in recently reauthenticated account", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const trialId = "10000000-0000-4000-8000-000000000023";
  const trialHash = await sha256Hex(trialId);
  database.sqlite
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash, account_user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, NULL, ?, ?, ?)
    `)
    .run(trialHash, now, now, now + 3_600);

  await assert.rejects(
    registrationOptions(trialRequest(trialId)),
    hasAuthCode("external_identity_authentication_required"),
  );

  const fixture = await createAccountFixture("first-passkey");
  database.sqlite
    .prepare(`
      INSERT INTO account_external_identities (
        id, user_id, provider, subject_hash, verified_email,
        created_at, last_used_at, revoked_at
      ) VALUES (?, ?, 'email', ?, 'first-passkey@example.invalid', ?, ?, NULL)
    `)
    .run(
      "identity-first-passkey",
      fixture.userId,
      "f".repeat(43),
      now,
      now,
    );
  const ordinaryLoginState = await getAccountAuthenticationState(
    accountRequest(fixture.token),
  );
  assert.equal(
    ordinaryLoginState.recentlyAuthenticated,
    false,
    "a fresh ordinary session must not bypass explicit passkey-add step-up",
  );
  await assert.rejects(
    registrationOptions(accountRequest(fixture.token)),
    hasAuthCode("backup_passkey_reauthentication_required"),
  );
  database.sqlite
    .prepare(`
      UPDATE account_sessions
      SET reauthenticated_at = ?
      WHERE token_hash = ?
    `)
    .run(now, fixture.tokenHash);

  const prepared = await registrationOptions(accountRequest(fixture.token));
  assert.equal(prepared.options.excludeCredentials?.length ?? 0, 0);
  const challengeToken = cookieValue(prepared.cookie);
  const challenge = database.sqlite
    .prepare(`
      SELECT requires_reauthentication
      FROM account_auth_challenges
      WHERE token_hash = ?
    `)
    .get(await hashAccountToken(challengeToken));
  assert.equal(challenge.requires_reauthentication, 1);
});

test("backup passkey registration requires same-account recent explicit reauthentication", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const fixture = await createAccountFixture("backup-passkey", 11 * 60);
  const authenticator = await createAuthenticatorCredential();
  insertPasskey(
    fixture.userId,
    authenticator.id,
    "現在のパスキー",
    authenticator.publicKey,
  );

  await assert.rejects(
    registrationOptions(accountRequest(fixture.token)),
    hasAuthCode("backup_passkey_reauthentication_required"),
    "an old ordinary login session is not an explicit reauthentication",
  );
  database.sqlite
    .prepare(`
      UPDATE account_sessions
      SET created_at = ?
      WHERE token_hash = ?
    `)
    .run(now, fixture.tokenHash);
  await assert.rejects(
    registrationOptions(accountRequest(fixture.token)),
    hasAuthCode("backup_passkey_reauthentication_required"),
    "even a fresh ordinary login session is not an explicit reauthentication",
  );
  database.sqlite
    .prepare(`
      UPDATE account_sessions
      SET reauthenticated_at = ?
      WHERE token_hash = ?
    `)
    .run(now - 11 * 60, fixture.tokenHash);
  await assert.rejects(
    registrationOptions(accountRequest(fixture.token)),
    hasAuthCode("backup_passkey_reauthentication_required"),
    "an old explicit marker cannot authorize a new backup credential",
  );

  const firstReauthentication = await completeReauthentication(
    fixture.token,
    authenticator,
    1,
  );
  const firstReauthenticatedHash = await hashAccountToken(
    firstReauthentication.token,
  );
  assert.ok(
    database.sqlite
      .prepare(`
        SELECT reauthenticated_at
        FROM account_sessions
        WHERE token_hash = ?
      `)
      .get(firstReauthenticatedHash).reauthenticated_at >= now,
  );

  const firstBackupChallenge = await registrationOptions(
    accountRequest(firstReauthentication.token),
  );
  assert.equal(
    database.sqlite
      .prepare(`
        SELECT requires_reauthentication
        FROM account_auth_challenges
        WHERE token_hash = ?
      `)
      .get(await hashAccountToken(cookieValue(firstBackupChallenge.cookie)))
      .requires_reauthentication,
    1,
  );

  database.sqlite
    .prepare(`
      UPDATE account_sessions
      SET reauthenticated_at = NULL
      WHERE token_hash = ?
    `)
    .run(firstReauthenticatedHash);
  await assert.rejects(
    verifyRegistration(
      accountRequest(
        firstReauthentication.token,
        cookiePair(firstBackupChallenge.cookie),
      ),
      {},
      "予備端末",
    ),
    hasAuthCode("backup_passkey_reauthentication_required"),
    "verification checks the marker again instead of trusting the options step",
  );

  const secondReauthentication = await completeReauthentication(
    firstReauthentication.token,
    authenticator,
    2,
  );
  const finalBackupChallenge = await registrationOptions(
    accountRequest(secondReauthentication.token),
  );
  const backupCredential = await createAuthenticatorCredential();
  const registrationResponse = await createRegistrationResponse(
    finalBackupChallenge.options,
    backupCredential,
  );
  await verifyRegistration(
    accountRequest(
      secondReauthentication.token,
      cookiePair(finalBackupChallenge.cookie),
    ),
    registrationResponse,
    "予備端末",
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_passkeys WHERE user_id = ?")
      .get(fixture.userId).count,
    2,
  );
});

test("a reauthentication challenge cannot cross account sessions", async () => {
  const left = await createAccountFixture("reauth-left");
  const right = await createAccountFixture("reauth-right");
  insertPasskey(
    left.userId,
    "credential_reauth_left_abcdefgh",
    "左の端末",
  );
  insertPasskey(
    right.userId,
    "credential_reauth_right_abcdefg",
    "右の端末",
  );
  const rightChallenge = await reauthenticationOptions(
    accountRequest(right.token),
  );
  await assert.rejects(
    verifyAuthentication(
      accountRequest(left.token, cookiePair(rightChallenge.cookie)),
      { id: "credential_reauth_right_abcdefg" },
    ),
    hasAuthCode("reauthentication_identity_changed"),
  );
});

test("passkey registration fails if its initiating session is deleted after verification", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const fixture = await createAccountFixture("registration-session-race");
  const existingAuthenticator = await createAuthenticatorCredential();
  insertPasskey(
    fixture.userId,
    existingAuthenticator.id,
    "Existing passkey",
    existingAuthenticator.publicKey,
  );
  database.sqlite
    .prepare(`
      UPDATE account_sessions
      SET reauthenticated_at = ?
      WHERE token_hash = ?
    `)
    .run(now, fixture.tokenHash);

  const prepared = await registrationOptions(accountRequest(fixture.token));
  const newAuthenticator = await createAuthenticatorCredential();
  const response = await createRegistrationResponse(
    prepared.options,
    newAuthenticator,
  );
  database.beforeBatch = async () => {
    database.sqlite
      .prepare("DELETE FROM account_sessions WHERE token_hash = ?")
      .run(fixture.tokenHash);
  };

  await assert.rejects(
    verifyRegistration(
      accountRequest(fixture.token, cookiePair(prepared.cookie)),
      response,
      "Racing passkey",
    ),
    hasAuthCode("backup_passkey_reauthentication_required"),
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_passkeys WHERE user_id = ?")
      .get(fixture.userId).count,
    1,
    "the verified credential must not be registered after its session is revoked",
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?")
      .get(fixture.userId).count,
    0,
    "registration must not mint a replacement session",
  );
});

test("passkey reauthentication fails if its initiating session is deleted after verification", async () => {
  const fixture = await createAccountFixture("reauthentication-session-race");
  const authenticator = await createAuthenticatorCredential();
  insertPasskey(
    fixture.userId,
    authenticator.id,
    "Reauthentication passkey",
    authenticator.publicKey,
  );
  const prepared = await reauthenticationOptions(accountRequest(fixture.token));
  const response = await createAuthenticationResponse(
    prepared.options,
    authenticator,
    1,
  );
  database.beforeBatch = async () => {
    database.sqlite
      .prepare("DELETE FROM account_sessions WHERE token_hash = ?")
      .run(fixture.tokenHash);
  };

  await assert.rejects(
    verifyAuthentication(
      accountRequest(fixture.token, cookiePair(prepared.cookie)),
      response,
    ),
    hasAuthCode("reauthentication_identity_changed"),
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT counter FROM account_passkeys WHERE credential_id = ?")
      .get(authenticator.id).counter,
    0,
    "a revoked reauthentication must not advance the passkey counter",
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?")
      .get(fixture.userId).count,
    0,
    "reauthentication must not mint a replacement session",
  );
});

test("normal passkey login fails if the credential is deleted after verification", async () => {
  const fixture = await createAccountFixture("login-credential-race");
  const authenticator = await createAuthenticatorCredential();
  insertPasskey(
    fixture.userId,
    authenticator.id,
    "Deleted passkey",
    authenticator.publicKey,
  );
  database.sqlite
    .prepare("DELETE FROM account_sessions WHERE user_id = ?")
    .run(fixture.userId);

  const prepared = await authenticationOptions(loginRequest());
  const response = await createAuthenticationResponse(
    prepared.options,
    authenticator,
    1,
  );
  database.beforeBatch = async () => {
    database.sqlite
      .prepare("DELETE FROM account_passkeys WHERE credential_id = ?")
      .run(authenticator.id);
  };

  await assert.rejects(
    verifyAuthentication(loginRequest(cookiePair(prepared.cookie)), response),
    hasAuthCode("passkey_no_longer_available"),
  );
  assert.equal(
    database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE user_id = ?")
      .get(fixture.userId).count,
    0,
    "a deleted credential must not mint an account session",
  );
});

test("existing passkey login atomically transfers the current anonymous reservation", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const targetUserId = "passkey-transfer-target";
  const sourceUserId = "passkey-transfer-source";
  const trialId = "30000000-0000-4000-8000-000000000031";
  const trialHash = await sha256Hex(trialId);
  const sourceEmail = `trial-${trialHash.slice(0, 48)}@anonymous.torudake.invalid`;
  const authenticator = await createAuthenticatorCredential();
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `)
    .run(targetUserId, "passkey-transfer@example.com", now, now);
  insertPasskey(
    targetUserId,
    authenticator.id,
    "既存パスキー",
    authenticator.publicKey,
  );
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `)
    .run(sourceUserId, sourceEmail, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash, account_user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, NULL, ?, ?, ?)
    `)
    .run(trialHash, now, now, now + 3_600);
  database.sqlite
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds, bucket,
        creation_type, save_funding_source, status, created_at, expires_at,
        completed_at, release_requested_at, billing_purchase_id
      ) VALUES (?, ?, ?, 30, 'free', 'single', 'bucket', 'reserved', ?, ?,
        NULL, NULL, NULL)
    `)
    .run(
      "passkey-transfer-reservation",
      sourceUserId,
      "passkey-transfer-attempt",
      now,
      now + 3_600,
    );

  const prepared = await authenticationOptions(trialRequest(trialId));
  const response = await createAuthenticationResponse(
    prepared.options,
    authenticator,
    1,
  );
  const authenticated = await verifyAuthentication(
    trialRequest(trialId, cookiePair(prepared.cookie)),
    response,
  );

  assert.match(authenticated.sessionCookie, /^__Host-torudake_account=/);
  assert.equal(
    database.sqlite
      .prepare("SELECT account_user_id FROM trial_sessions WHERE session_hash = ?")
      .get(trialHash).account_user_id,
    targetUserId,
  );
  assert.deepEqual(
    {
      ...database.sqlite
        .prepare(`
          SELECT user_id, status
          FROM usage_reservations
          WHERE id = 'passkey-transfer-reservation'
        `)
        .get(),
    },
    { user_id: targetUserId, status: "reserved" },
  );
});

test("trial transfer releases the source reservation when the destination free cap is spent", async () => {
  const now = Math.floor(Date.now() / 1_000);
  const targetUserId = "passkey-cap-target";
  const sourceUserId = "passkey-cap-source";
  const trialId = "30000000-0000-4000-8000-000000000032";
  const trialHash = await sha256Hex(trialId);
  const sourceEmail = `trial-${trialHash.slice(0, 48)}@anonymous.torudake.invalid`;
  const authenticator = await createAuthenticatorCredential();
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?),
        (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `)
    .run(
      targetUserId,
      "passkey-cap@example.com",
      now,
      now,
      sourceUserId,
      sourceEmail,
      now,
      now,
    );
  insertPasskey(targetUserId, authenticator.id, "既存パスキー", authenticator.publicKey);
  database.sqlite
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash, account_user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, NULL, ?, ?, ?)
    `)
    .run(trialHash, now, now, now + 3_600);
  const insertUsage = database.sqlite.prepare(`
    INSERT INTO usage_reservations (
      id, user_id, idempotency_key, source_duration_seconds, bucket,
      creation_type, save_funding_source, status, created_at, expires_at,
      completed_at, release_requested_at, billing_purchase_id
    ) VALUES (?, ?, ?, ?, 'free', 'single', 'bucket', ?, ?, ?, ?, NULL, NULL)
  `);
  insertUsage.run("cap-target-a", targetUserId, "cap-target-attempt-a", 90, "completed", now - 10, now + 3_600, now - 5);
  insertUsage.run("cap-target-b", targetUserId, "cap-target-attempt-b", 90, "completed", now - 9, now + 3_600, now - 4);
  insertUsage.run("cap-source", sourceUserId, "cap-source-attempt", 30, "reserved", now, now + 3_600, null);

  const prepared = await authenticationOptions(trialRequest(trialId));
  const response = await createAuthenticationResponse(prepared.options, authenticator, 1);
  await verifyAuthentication(
    trialRequest(trialId, cookiePair(prepared.cookie)),
    response,
  );

  assert.deepEqual(
    {
      ...database.sqlite
        .prepare("SELECT user_id, status, save_funding_source FROM usage_reservations WHERE id = 'cap-source'")
        .get(),
    },
    {
      user_id: targetUserId,
      status: "released",
      save_funding_source: "bucket",
    },
  );
  assert.deepEqual(
    {
      ...database.sqlite
        .prepare(`
          SELECT COUNT(*) AS videos, COALESCE(SUM(source_duration_seconds), 0) AS seconds
          FROM usage_reservations
          WHERE user_id = ? AND bucket = 'free'
            AND status IN ('reserved', 'completed')
        `)
        .get(targetUserId),
    },
    { videos: 2, seconds: 180 },
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

test("external-only accounts expose their linked step-up method and obey the same recent-session window", async () => {
  const fixture = await createAccountFixture("external-only");
  const now = Math.floor(Date.now() / 1_000);
  database.sqlite
    .prepare(`
      INSERT INTO account_external_identities (
        id, user_id, provider, subject_hash, verified_email,
        created_at, last_used_at, revoked_at
      ) VALUES (?, ?, 'email', ?, 'person@example.com', ?, ?, NULL)
    `)
    .run(
      "external-only-email-identity",
      fixture.userId,
      "e".repeat(43),
      now,
      now,
    );
  database.sqlite
    .prepare(
      "UPDATE account_sessions SET reauthenticated_at = ? WHERE token_hash = ?",
    )
    .run(now, fixture.tokenHash);

  assert.deepEqual(
    await getAccountAuthenticationState(accountRequest(fixture.token)),
    {
      authenticated: true,
      recentlyAuthenticated: true,
      accountMethods: {
        passkey: false,
        line: false,
        google: false,
        email: true,
      },
    },
  );

  database.sqlite
    .prepare(`
      UPDATE account_sessions
      SET created_at = ?, reauthenticated_at = ?
      WHERE token_hash = ?
    `)
    .run(now - 11 * 60, now - 11 * 60, fixture.tokenHash);
  const stale = await getAccountAuthenticationState(accountRequest(fixture.token));
  assert.equal(stale.authenticated, true);
  assert.equal(stale.recentlyAuthenticated, false);
  await assert.rejects(
    revokeAllAccountSessions(accountRequest(fixture.token)),
    hasAuthCode("reauthentication_required"),
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

function insertPasskey(
  userId,
  credentialId,
  displayName,
  publicKey = "AQID",
) {
  const now = Math.floor(Date.now() / 1_000);
  database.sqlite
    .prepare(`
      INSERT INTO account_passkeys (
        credential_id, user_id, public_key, counter, transports,
        device_type, backed_up, display_name, created_at, updated_at,
        last_used_at
      ) VALUES (?, ?, ?, 0, NULL, 'singleDevice', 0, ?, ?, ?, ?)
    `)
    .run(credentialId, userId, publicKey, displayName, now, now, now);
}

function accountRequest(token, additionalCookie = "") {
  return new Request("https://torudake-reel.pages.dev/account", {
    headers: {
      cookie: [
        cookiePair(accountSessionCookie(token, true)),
        additionalCookie,
      ]
        .filter(Boolean)
        .join("; "),
      origin: "https://torudake-reel.pages.dev",
      "cf-connecting-ip": "203.0.113.100",
    },
  });
}

function trialRequest(trialId, additionalCookie = "") {
  return new Request("https://torudake-reel.pages.dev/account", {
    headers: {
      cookie: [`torudake_trial_id=${trialId}`, additionalCookie]
        .filter(Boolean)
        .join("; "),
      origin: "https://torudake-reel.pages.dev",
      "cf-connecting-ip": "203.0.113.100",
    },
  });
}

function loginRequest(additionalCookie = "") {
  return new Request("https://torudake-reel.pages.dev/account", {
    headers: {
      cookie: additionalCookie,
      origin: "https://torudake-reel.pages.dev",
      "cf-connecting-ip": "203.0.113.101",
    },
  });
}

async function completeReauthentication(token, authenticator, counter) {
  const prepared = await reauthenticationOptions(accountRequest(token));
  const response = await createAuthenticationResponse(
    prepared.options,
    authenticator,
    counter,
  );
  const result = await verifyAuthentication(
    accountRequest(token, cookiePair(prepared.cookie)),
    response,
  );
  return { token: cookieValue(result.sessionCookie) };
}

async function createAuthenticatorCredential() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const credentialId = crypto.getRandomValues(new Uint8Array(24));
  const publicKeyBytes = isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, base64UrlToBytes(publicJwk.x)],
      [-3, base64UrlToBytes(publicJwk.y)],
    ]),
  );
  return {
    id: bytesToBase64Url(credentialId),
    idBytes: credentialId,
    privateKey: keyPair.privateKey,
    publicKey: bytesToBase64Url(publicKeyBytes),
    publicKeyBytes,
  };
}

async function createAuthenticationResponse(options, authenticator, counter) {
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: "https://torudake-reel.pages.dev",
    }),
  );
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);
  const authenticatorData = concatBytes(
    await sha256Bytes(new TextEncoder().encode(options.rpId)),
    new Uint8Array([0x05]),
    counterBytes,
  );
  const signatureBase = concatBytes(
    authenticatorData,
    await sha256Bytes(clientData),
  );
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      authenticator.privateKey,
      signatureBase,
    ),
  );
  return {
    id: authenticator.id,
    rawId: authenticator.id,
    response: {
      authenticatorData: bytesToBase64Url(authenticatorData),
      clientDataJSON: bytesToBase64Url(clientData),
      signature: bytesToBase64Url(rawEcdsaSignatureToDer(rawSignature)),
      userHandle: null,
    },
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

async function createRegistrationResponse(options, authenticator) {
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: "https://torudake-reel.pages.dev",
    }),
  );
  const credentialLength = new Uint8Array(2);
  new DataView(credentialLength.buffer).setUint16(
    0,
    authenticator.idBytes.length,
    false,
  );
  const authenticatorData = concatBytes(
    await sha256Bytes(new TextEncoder().encode(options.rp.id)),
    new Uint8Array([0x45]),
    new Uint8Array(4),
    new Uint8Array(16),
    credentialLength,
    authenticator.idBytes,
    authenticator.publicKeyBytes,
  );
  const attestationObject = isoCBOR.encode(
    new Map([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authenticatorData],
    ]),
  );
  return {
    id: authenticator.id,
    rawId: authenticator.id,
    response: {
      attestationObject: bytesToBase64Url(attestationObject),
      clientDataJSON: bytesToBase64Url(clientData),
      transports: ["internal"],
    },
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

function rawEcdsaSignatureToDer(signature) {
  if (signature[0] === 0x30) return signature;
  assert.equal(signature.length, 64);
  const encodeInteger = (value) => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start += 1;
    const trimmed = value.slice(start);
    const positive =
      trimmed[0] & 0x80
        ? concatBytes(new Uint8Array([0]), trimmed)
        : trimmed;
    return concatBytes(new Uint8Array([0x02, positive.length]), positive);
  };
  const r = encodeInteger(signature.slice(0, 32));
  const s = encodeInteger(signature.slice(32));
  return concatBytes(new Uint8Array([0x30, r.length + s.length]), r, s);
}

function concatBytes(...values) {
  const result = new Uint8Array(
    values.reduce((total, value) => total + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

async function sha256Hex(value) {
  return Buffer.from(
    await sha256Bytes(new TextEncoder().encode(value)),
  ).toString("hex");
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
}

function cookieValue(setCookie) {
  return decodeURIComponent(cookiePair(setCookie).split("=", 2)[1]);
}

function hasAuthCode(code) {
  return (error) => error instanceof AccountAuthError && error.code === code;
}

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
