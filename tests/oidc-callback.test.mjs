import assert from "node:assert/strict";
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
}

class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec(`
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
      CREATE TABLE account_oauth_challenges (
        state_hash TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        nonce TEXT NOT NULL,
        pkce_verifier TEXT,
        intent TEXT NOT NULL,
        initiating_user_id TEXT,
        expected_origin TEXT NOT NULL,
        return_to TEXT NOT NULL,
        network_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE account_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reauthenticated_at INTEGER,
        auth_method TEXT NOT NULL,
        external_identity_id TEXT
      );
    `);
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

  close() {
    this.sqlite.close();
  }
}

test("direct existing LINE login consumes its challenge once and sets a bound account session", async (t) => {
  const database = new D1Database();
  const canonicalOrigin = "https://torudake-reel.pages.dev";
  const authSecret = "oidc-test-secret-with-at-least-thirty-two-characters";
  const clientId = "1234567890";
  const subject = "U1234567890abcdef1234567890abcdef";
  const state = "q".repeat(43);
  const nonce = "n".repeat(43);
  const userId = "22222222-2222-4222-8222-222222222222";
  const identityId = "identity-line-a";
  const now = Math.floor(Date.now() / 1_000);
  const subjectHash = await hmacBase64Url(
    authSecret,
    `torudake-oidc-subject-v1\nline\n${clientId}\n${subject}`,
  );
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, 'member@example.com', NULL, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_external_identities (
        id, user_id, provider, subject_hash, verified_email,
        created_at, last_used_at, revoked_at
      ) VALUES (?, ?, 'line', ?, NULL, ?, ?, NULL)
    `)
    .run(identityId, userId, subjectHash, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_oauth_challenges (
        state_hash, provider, nonce, pkce_verifier, intent,
        initiating_user_id, expected_origin, return_to, network_hash,
        created_at, expires_at, consumed_at
      ) VALUES (?, 'line', ?, ?, 'login', NULL, ?,
        '/account?auth_popup=pending', 'network-hash', ?, ?, NULL)
    `)
    .run(
      await sha256Hex(state),
      nonce,
      "v".repeat(64),
      canonicalOrigin,
      now,
      now + 600,
    );

  globalThis.__cloudflareEnv = {
    DB: database,
    OIDC_AUTH_ENABLED: "true",
    OIDC_CANONICAL_ORIGIN: canonicalOrigin,
    OIDC_AUTH_SECRET: authSecret,
    LINE_LOGIN_ENABLED: "true",
    LINE_LOGIN_CHANNEL_ID: clientId,
    LINE_LOGIN_CHANNEL_SECRET: "line-client-secret",
  };
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  let providerSubject = subject;
  let beforeTokenResponse = null;
  globalThis.fetch = async (input, init) => {
    providerCalls += 1;
    if (String(input) === "https://api.line.me/oauth2/v2.1/token") {
      assert.equal(init.redirect, "error");
      assert.match(
        init.body.get("code_verifier"),
        /^[A-Za-z0-9._~-]{43,128}$/,
      );
      const hook = beforeTokenResponse;
      beforeTokenResponse = null;
      if (hook) await hook();
      return Response.json({
        access_token: "line-access-token",
        id_token: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`,
        token_type: "Bearer",
      });
    }
    assert.equal(String(input), "https://api.line.me/oauth2/v2.1/verify");
    const requestedNonce = init.body.get("nonce");
    assert.match(requestedNonce, /^[A-Za-z0-9_-]{43}$/);
    return Response.json({
      iss: "https://access.line.me",
      sub: providerSubject,
      aud: clientId,
      exp: now + 3_600,
      iat: now,
      nonce: requestedNonce,
    });
  };

  try {
    const moduleUrl = new URL("../lib/oidc-auth.ts", import.meta.url);
    moduleUrl.searchParams.set("callback-test", `${process.pid}-${Date.now()}`);
    const { beginOidcAuthorization, completeOidcAuthorization } =
      await import(moduleUrl.href);
    const request = finalizeRequest(canonicalOrigin, {
      code: "authorization-code",
      state,
      cookie: `__Host-torudake_oidc_line=${state}`,
    });

    const response = await completeOidcAuthorization(request, "line");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /window\.close\(\)/);
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    );
    const cookies = response.headers.getSetCookie().join("\n");
    assert.match(cookies, /__Host-torudake_account=[A-Za-z0-9_-]{43}/);
    assert.match(cookies, /__Host-torudake_challenge=;/);
    assert.match(cookies, /__Host-torudake_oidc_line=;/);
    const accountToken = cookies.match(
      /__Host-torudake_account=([A-Za-z0-9_-]{43})/,
    )?.[1];
    assert.ok(accountToken);

    const session = database.sqlite
      .prepare(`
        SELECT user_id, auth_method, external_identity_id
        FROM account_sessions
      `)
      .get();
    assert.deepEqual({ ...session }, {
      user_id: userId,
      auth_method: "line",
      external_identity_id: identityId,
    });
    assert.ok(
      database.sqlite
        .prepare("SELECT consumed_at FROM account_oauth_challenges")
        .get().consumed_at,
    );
    assert.equal(providerCalls, 2);

    const linkedSubject = "U99999999999999999999999999999999";
    const linkOnce = async () => {
      const started = await beginOidcAuthorization(
        new Request(
          `${canonicalOrigin}/api/account/oauth/line/start?popup=1&link=1`,
          {
            headers: {
              Cookie: `__Host-torudake_account=${accountToken}`,
              "CF-Connecting-IP": "203.0.113.20",
            },
          },
        ),
        "line",
      );
      const authorization = new URL(started.headers.get("location"));
      const linkState = authorization.searchParams.get("state");
      assert.ok(linkState);
      const startCookies = started.headers.getSetCookie().join("; ");
      const stateCookie = startCookies.match(
        /__Host-torudake_oidc_line=[A-Za-z0-9_-]{43}/,
      )?.[0];
      const proofCookie = startCookies.match(
        /__Host-torudake_oidc_line_session_proof=[0-9a-f]{64}\.[A-Za-z0-9_-]{43}/,
      )?.[0];
      assert.ok(stateCookie);
      assert.ok(proofCookie);
      providerSubject = linkedSubject;
      return completeOidcAuthorization(
        finalizeRequest(canonicalOrigin, {
          code: "link-code",
          state: linkState,
          cookie: `${stateCookie}; ${proofCookie}; __Host-torudake_account=${accountToken}`,
        }),
        "line",
      );
    };

    const linked = await linkOnce();
    assert.equal(linked.status, 200);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM account_sessions").get().count,
      1,
      "linking must preserve the initiating account session",
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_external_identities WHERE user_id = ?")
        .get(userId).count,
      2,
    );
    assert.equal((await linkOnce()).status, 200);
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_external_identities WHERE user_id = ?")
        .get(userId).count,
      2,
      "a repeated verified link must be idempotent",
    );
    providerSubject = subject;
    const providerCallsAfterLinks = providerCalls;

    const replay = await completeOidcAuthorization(
      finalizeRequest(canonicalOrigin, {
        code: "authorization-code",
        state,
        cookie: `__Host-torudake_oidc_line=${state}`,
      }),
      "line",
    );
    assert.equal(replay.status, 303);
    assert.equal(
      replay.headers.get("location"),
      `${canonicalOrigin}/account?auth_error=expired`,
    );
    assert.equal(
      providerCalls,
      providerCallsAfterLinks,
      "a consumed state must not reach LINE again",
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM account_sessions").get().count,
      1,
    );

    const reauthenticationState = "r".repeat(43);
    database.sqlite
      .prepare(`
        INSERT INTO account_oauth_challenges (
          state_hash, provider, nonce, pkce_verifier, intent,
          initiating_user_id, expected_origin, return_to, network_hash,
          created_at, expires_at, consumed_at
        ) VALUES (?, 'line', ?, ?, 'reauthenticate', ?, ?,
          '/account?auth_popup=pending', 'network-hash', ?, ?, NULL)
      `)
      .run(
        await sha256Hex(reauthenticationState),
        nonce,
        "v".repeat(64),
        userId,
        canonicalOrigin,
        now,
        now + 600,
      );
    const reauthenticationProof = await oidcSessionProof(
      authSecret,
      "line",
      "reauthenticate",
      reauthenticationState,
      accountToken,
    );
    const reauthenticationResponse = await completeOidcAuthorization(
      finalizeRequest(canonicalOrigin, {
        code: "reauth-code",
        state: reauthenticationState,
        cookie: `__Host-torudake_oidc_line=${reauthenticationState}; __Host-torudake_oidc_line_session_proof=${reauthenticationProof}; __Host-torudake_account=${accountToken}`,
      }),
      "line",
    );
    assert.equal(reauthenticationResponse.status, 200);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM account_sessions").get().count,
      2,
    );
    const stepUpSession = database.sqlite
      .prepare(`
        SELECT user_id, auth_method, external_identity_id, reauthenticated_at
        FROM account_sessions
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get();
    assert.equal(stepUpSession.user_id, userId);
    assert.equal(stepUpSession.auth_method, "line");
    assert.equal(stepUpSession.external_identity_id, identityId);
    assert.ok(stepUpSession.reauthenticated_at);

    const otherUserId = "33333333-3333-4333-8333-333333333333";
    const otherIdentityId = "identity-line-b";
    const otherSubject = "Uabcdef1234567890abcdef1234567890";
    const otherSubjectHash = await hmacBase64Url(
      authSecret,
      `torudake-oidc-subject-v1\nline\n${clientId}\n${otherSubject}`,
    );
    database.sqlite
      .prepare(`
        INSERT INTO users (
          id, email, billing_email, full_name, stripe_customer_id,
          account_deleted_at, created_at, updated_at
        ) VALUES (?, 'other@example.com', NULL, NULL, NULL, NULL, ?, ?)
      `)
      .run(otherUserId, now, now);
    database.sqlite
      .prepare(`
        INSERT INTO account_external_identities (
          id, user_id, provider, subject_hash, verified_email,
          created_at, last_used_at, revoked_at
        ) VALUES (?, ?, 'line', ?, NULL, ?, ?, NULL)
      `)
      .run(otherIdentityId, otherUserId, otherSubjectHash, now, now);
    const changedAccountState = "s".repeat(43);
    database.sqlite
      .prepare(`
        INSERT INTO account_oauth_challenges (
          state_hash, provider, nonce, pkce_verifier, intent,
          initiating_user_id, expected_origin, return_to, network_hash,
          created_at, expires_at, consumed_at
        ) VALUES (?, 'line', ?, ?, 'reauthenticate', ?, ?,
          '/account?auth_popup=pending', 'network-hash', ?, ?, NULL)
      `)
      .run(
        await sha256Hex(changedAccountState),
        nonce,
        "v".repeat(64),
        userId,
        canonicalOrigin,
        now,
        now + 600,
      );
    providerSubject = otherSubject;
    const changedAccountProof = await oidcSessionProof(
      authSecret,
      "line",
      "reauthenticate",
      changedAccountState,
      accountToken,
    );
    const changedAccountResponse = await completeOidcAuthorization(
      finalizeRequest(canonicalOrigin, {
        code: "changed-account-code",
        state: changedAccountState,
        cookie: `__Host-torudake_oidc_line=${changedAccountState}; __Host-torudake_oidc_line_session_proof=${changedAccountProof}; __Host-torudake_account=${accountToken}`,
      }),
      "line",
    );
    assert.equal(changedAccountResponse.status, 401);
    assert.doesNotMatch(
      changedAccountResponse.headers.getSetCookie().join("\n"),
      /__Host-torudake_account=/,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM account_sessions").get().count,
      2,
      "a provider identity from another account must not create a step-up session",
    );

    const startBoundFlow = async (sessionToken, intent) => {
      const started = await beginOidcAuthorization(
        new Request(
          `${canonicalOrigin}/api/account/oauth/line/start?popup=1&${intent}=1`,
          {
            headers: {
              Cookie: `__Host-torudake_account=${sessionToken}`,
              "CF-Connecting-IP": "203.0.113.21",
            },
          },
        ),
        "line",
      );
      const authorization = new URL(started.headers.get("location"));
      const flowState = authorization.searchParams.get("state");
      assert.ok(flowState);
      const startCookies = started.headers.getSetCookie().join("; ");
      const stateCookie = startCookies.match(
        /__Host-torudake_oidc_line=[A-Za-z0-9_-]{43}/,
      )?.[0];
      const proofCookie = startCookies.match(
        /__Host-torudake_oidc_line_session_proof=[0-9a-f]{64}\.[A-Za-z0-9_-]{43}/,
      )?.[0];
      assert.ok(stateCookie);
      assert.ok(proofCookie);
      return { flowState, proofCookie, stateCookie };
    };
    const completeBoundFlow = (flow, sessionToken, code) =>
      completeOidcAuthorization(
        finalizeRequest(canonicalOrigin, {
          code,
          state: flow.flowState,
          cookie: `${flow.stateCookie}; ${flow.proofCookie}; __Host-torudake_account=${sessionToken}`,
        }),
        "line",
      );
    const insertBoundSession = async (sessionToken) => {
      const tokenHash = await sha256Hex(sessionToken);
      const createdAt = Math.floor(Date.now() / 1_000);
      database.sqlite
        .prepare(`
          INSERT INTO account_sessions (
            token_hash, user_id, created_at, last_seen_at, expires_at,
            reauthenticated_at, auth_method, external_identity_id
          ) VALUES (?, ?, ?, ?, ?, NULL, 'line', ?)
        `)
        .run(
          tokenHash,
          userId,
          createdAt,
          createdAt,
          createdAt + 3_600,
          identityId,
        );
      return tokenHash;
    };

    await t.test("OIDC link rejects a provider result after the initiating session is deleted", async () => {
      const linkRaceToken = "l".repeat(43);
      const linkRaceTokenHash = await insertBoundSession(linkRaceToken);
      const flow = await startBoundFlow(linkRaceToken, "link");
      const raceSubject = "Urace111111111111111111111111111111";
      const raceSubjectHash = await hmacBase64Url(
        authSecret,
        `torudake-oidc-subject-v1\nline\n${clientId}\n${raceSubject}`,
      );
      providerSubject = raceSubject;
      beforeTokenResponse = async () => {
        database.sqlite
          .prepare("DELETE FROM account_sessions WHERE token_hash = ?")
          .run(linkRaceTokenHash);
      };

      let raceResponse;
      try {
        raceResponse = await completeBoundFlow(
          flow,
          linkRaceToken,
          "link-race-code",
        );
      } finally {
        beforeTokenResponse = null;
      }
      assert.equal(raceResponse.status, 401);
      assert.doesNotMatch(
        raceResponse.headers.getSetCookie().join("\n"),
        /__Host-torudake_account=/,
      );
      assert.equal(
        database.sqlite
          .prepare(`
            SELECT COUNT(*) AS count
            FROM account_external_identities
            WHERE provider = 'line' AND subject_hash = ?
          `)
          .get(raceSubjectHash).count,
        0,
        "the fetched identity must not be linked after logout/revoke-all wins",
      );
      assert.equal(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM account_sessions WHERE token_hash = ?")
          .get(linkRaceTokenHash).count,
        0,
      );
    });

    await t.test("OIDC reauthentication rejects a provider result after the initiating session is deleted", async () => {
      const reauthenticationRaceToken = "u".repeat(43);
      const reauthenticationRaceHash = await insertBoundSession(
        reauthenticationRaceToken,
      );
      const flow = await startBoundFlow(
        reauthenticationRaceToken,
        "reauthenticate",
      );
      const previousLastUsedAt = now - 100;
      database.sqlite
        .prepare(`
          UPDATE account_external_identities
          SET last_used_at = ?
          WHERE id = ?
        `)
        .run(previousLastUsedAt, identityId);
      providerSubject = subject;
      const sessionCountBefore = database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_sessions")
        .get().count;
      beforeTokenResponse = async () => {
        database.sqlite
          .prepare("DELETE FROM account_sessions WHERE token_hash = ?")
          .run(reauthenticationRaceHash);
      };

      let raceResponse;
      try {
        raceResponse = await completeBoundFlow(
          flow,
          reauthenticationRaceToken,
          "reauthentication-race-code",
        );
      } finally {
        beforeTokenResponse = null;
      }
      assert.equal(raceResponse.status, 401);
      assert.doesNotMatch(
        raceResponse.headers.getSetCookie().join("\n"),
        /__Host-torudake_account=/,
      );
      assert.equal(
        database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM account_sessions")
          .get().count,
        sessionCountBefore - 1,
        "reauthentication must not mint a session after logout/revoke-all wins",
      );
      assert.equal(
        database.sqlite
          .prepare(`
            SELECT last_used_at
            FROM account_external_identities
            WHERE id = ?
          `)
          .get(identityId).last_used_at,
        previousLastUsedAt,
        "the identity mutation must also be conditional on the initiating session",
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__cloudflareEnv;
    database.close();
  }
});

async function sha256Hex(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function finalizeRequest(canonicalOrigin, { code, state, cookie }) {
  return new Request(
    `${canonicalOrigin}/api/account/oauth/line/callback/finalize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        Origin: canonicalOrigin,
      },
      body: new URLSearchParams({ code, state, error: "", iss: "" }),
    },
  );
}

async function oidcSessionProof(secret, provider, intent, state, sessionToken) {
  const sessionHash = await sha256Hex(sessionToken);
  const signature = await hmacBase64Url(
    secret,
    `torudake-oidc-session-proof-v1\n${provider}\n${intent}\n${state}\n${sessionHash}`,
  );
  return `${sessionHash}.${signature}`;
}

async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
