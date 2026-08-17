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
      CREATE TABLE trial_sessions (
        session_hash TEXT PRIMARY KEY NOT NULL,
        account_user_id TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
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
  const trialUserId = "77777777-7777-4777-8777-777777777777";
  const trialSessionId = "44444444-4444-4444-8444-444444444444";
  const trialSessionHash = await sha256Hex(trialSessionId);
  const trialPrincipalEmail =
    `trial-${trialSessionHash.slice(0, 48)}@anonymous.torudake.invalid`;
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
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        account_deleted_at, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `)
    .run(trialUserId, trialPrincipalEmail, now, now);
  database.sqlite
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash, account_user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, NULL, ?, ?, ?)
    `)
    .run(trialSessionHash, now, now, now + 600);
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
  let deauthorizationMode = "success";
  globalThis.fetch = async (input, init) => {
    providerCalls += 1;
    const endpoint = String(input);
    if (endpoint === "https://api.line.me/oauth2/v2.1/token") {
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
    if (endpoint === "https://api.line.me/oauth2/v2.1/verify") {
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
    }
    if (endpoint === "https://api.line.me/oauth2/v3/token") {
      assert.equal(init.redirect, "error");
      assert.equal(init.body.get("grant_type"), "client_credentials");
      assert.equal(init.body.get("client_id"), clientId);
      assert.equal(init.body.get("client_secret"), "line-client-secret");
      return Response.json({
        access_token: "line-stateless-channel-token",
        token_type: "Bearer",
        expires_in: 900,
      });
    }
    if (endpoint === "https://api.line.me/user/v1/deauthorize") {
      assert.equal(init.redirect, "error");
      assert.equal(
        init.headers.Authorization,
        "Bearer line-stateless-channel-token",
      );
      assert.deepEqual(JSON.parse(init.body), {
        userAccessToken: "line-access-token",
      });
      if (deauthorizationMode === "rejected") {
        return Response.json({ message: "rejected" }, { status: 400 });
      }
      if (deauthorizationMode === "server_error") {
        return Response.json({ message: "unavailable" }, { status: 500 });
      }
      if (deauthorizationMode === "oversize") {
        return new Response("x".repeat(4 * 1024 + 1), { status: 500 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected LINE endpoint: ${endpoint}`);
  };

  try {
    const moduleUrl = new URL("../lib/oidc-auth.ts", import.meta.url);
    moduleUrl.searchParams.set("callback-test", `${process.pid}-${Date.now()}`);
    const { beginOidcAuthorization, completeOidcAuthorization } =
      await import(moduleUrl.href);
    const lineStartRouteUrl = new URL(
      "../app/api/account/oauth/line/start/route.ts",
      import.meta.url,
    );
    lineStartRouteUrl.searchParams.set(
      "callback-test",
      `${process.pid}-${Date.now()}`,
    );
    const { GET: startLineAuthorization } = await import(lineStartRouteUrl.href);
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
        SELECT user_id, auth_method, external_identity_id, reauthenticated_at
        FROM account_sessions
      `)
      .get();
    assert.deepEqual({ ...session }, {
      user_id: userId,
      auth_method: "line",
      external_identity_id: identityId,
      reauthenticated_at: null,
    });
    const deletionRouteUrl = new URL(
      "../app/api/account/deletion/route.ts",
      import.meta.url,
    );
    deletionRouteUrl.searchParams.set(
      "line-initial-session-test",
      `${process.pid}-${Date.now()}`,
    );
    const { POST: scheduleAccountDeletion } = await import(
      deletionRouteUrl.href
    );
    const directDeletion = await scheduleAccountDeletion(
      new Request(`${canonicalOrigin}/api/account/deletion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `__Host-torudake_account=${accountToken}`,
          Origin: canonicalOrigin,
        },
        body: JSON.stringify({ confirmDeletion: true }),
      }),
    );
    assert.equal(directDeletion.status, 401);
    assert.equal(
      (await directDeletion.json()).code,
      "reauthentication_required",
      "a fresh login is not the explicit step-up required for deletion",
    );
    assert.ok(
      database.sqlite
        .prepare("SELECT consumed_at FROM account_oauth_challenges")
        .get().consumed_at,
    );
    assert.equal(providerCalls, 4);

    for (const [mode, stateCharacter, intent, initiatingUserId] of [
      ["rejected", "d", "login", trialUserId],
      ["server_error", "e", "reauthenticate", userId],
      ["oversize", "f", "login", null],
    ]) {
      await t.test(`LINE ${mode} deauthorization leaves identity and sessions unchanged`, async () => {
        const failedState = stateCharacter.repeat(43);
        database.sqlite
          .prepare(`
            INSERT INTO account_oauth_challenges (
              state_hash, provider, nonce, pkce_verifier, intent,
              initiating_user_id, expected_origin, return_to, network_hash,
              created_at, expires_at, consumed_at
            ) VALUES (?, 'line', ?, ?, ?, ?, ?,
              '/account?auth_popup=pending', 'network-hash', ?, ?, NULL)
          `)
          .run(
            await sha256Hex(failedState),
            nonce,
            "v".repeat(64),
            intent,
            initiatingUserId,
            canonicalOrigin,
            now,
            now + 600,
          );
        const accountTokenHash = await sha256Hex(accountToken);
        if (intent === "reauthenticate") {
          database.sqlite
            .prepare(
              "UPDATE account_sessions SET last_seen_at = ? WHERE token_hash = ?",
            )
            .run(now - 2 * 24 * 60 * 60, accountTokenHash);
        }
        const sessionsBefore = database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM account_sessions")
          .get().count;
        const identitiesBefore = database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM account_external_identities")
          .get().count;
        const lastUsedBefore = database.sqlite
          .prepare(
            "SELECT last_used_at FROM account_external_identities WHERE id = ?",
          )
          .get(identityId).last_used_at;
        const sessionLastSeenBefore = database.sqlite
          .prepare(
            "SELECT last_seen_at FROM account_sessions WHERE token_hash = ?",
          )
          .get(accountTokenHash).last_seen_at;
        providerSubject = subject;
        deauthorizationMode = mode;
        const logged = [];
        const originalConsoleError = console.error;
        console.error = (...values) => logged.push(values);

        let failedResponse;
        try {
          const proof = intent === "reauthenticate"
            ? await oidcSessionProof(
                authSecret,
                "line",
                "reauthenticate",
                failedState,
                accountToken,
              )
            : null;
          failedResponse = await completeOidcAuthorization(
            finalizeRequest(canonicalOrigin, {
              code: `failed-deauthorization-${mode}`,
              state: failedState,
              cookie: [
                `__Host-torudake_oidc_line=${failedState}`,
                ...(proof
                  ? [
                      `__Host-torudake_oidc_line_session_proof=${proof}`,
                      `__Host-torudake_account=${accountToken}`,
                    ]
                  : []),
                ...(initiatingUserId === trialUserId
                  ? [`torudake_trial_id=${trialSessionId}`]
                  : []),
              ].join("; "),
            }),
            "line",
          );
        } finally {
          console.error = originalConsoleError;
          deauthorizationMode = "success";
        }

        assert.equal(failedResponse.status, 400);
        assert.doesNotMatch(
          failedResponse.headers.getSetCookie().join("\n"),
          /__Host-torudake_account=/,
        );
        assert.equal(
          database.sqlite
            .prepare("SELECT COUNT(*) AS count FROM account_sessions")
            .get().count,
          sessionsBefore,
        );
        assert.equal(
          database.sqlite
            .prepare("SELECT COUNT(*) AS count FROM account_external_identities")
            .get().count,
          identitiesBefore,
        );
        assert.equal(
          database.sqlite
            .prepare(
              "SELECT last_used_at FROM account_external_identities WHERE id = ?",
            )
            .get(identityId).last_used_at,
          lastUsedBefore,
        );
        assert.equal(
          database.sqlite
            .prepare(
              "SELECT last_seen_at FROM account_sessions WHERE token_hash = ?",
            )
            .get(accountTokenHash).last_seen_at,
          sessionLastSeenBefore,
          "a failed deauthorization must not touch the initiating session",
        );
        assert.equal(
          database.sqlite
            .prepare(
              "SELECT account_user_id FROM trial_sessions WHERE session_hash = ?",
            )
            .get(trialSessionHash).account_user_id,
          null,
          "a failed deauthorization must not bind the anonymous trial",
        );
        const serializedLogs = JSON.stringify(logged);
        assert.equal(serializedLogs.includes("line-access-token"), false);
        assert.equal(serializedLogs.includes("line-client-secret"), false);
        assert.equal(
          serializedLogs.includes("line-stateless-channel-token"),
          false,
        );
      });
    }

    const identitiesBeforeLinkRejection = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_external_identities")
      .get().count;
    const sessionsBeforeLinkRejection = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_sessions")
      .get().count;
    const challengesBeforeLinkRejection = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account_oauth_challenges")
      .get().count;
    const providerCallsBeforeLinkRejection = providerCalls;
    const rejectedLinkStart = await startLineAuthorization(
      new Request(
        `${canonicalOrigin}/api/account/oauth/line/start?popup=1&link=1`,
        {
          headers: {
            Cookie: `__Host-torudake_account=${accountToken}`,
            "CF-Connecting-IP": "203.0.113.20",
          },
        },
      ),
    );
    assert.equal(rejectedLinkStart.status, 409);
    assert.equal(
      rejectedLinkStart.headers.get("cache-control"),
      "private, no-store",
    );
    assert.equal(
      (await rejectedLinkStart.json()).code,
      "authentication_method_unavailable",
    );
    assert.equal(providerCalls, providerCallsBeforeLinkRejection);
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_oauth_challenges")
        .get().count,
      challengesBeforeLinkRejection,
      "a rejected LINE link start must not create a challenge",
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_external_identities")
        .get().count,
      identitiesBeforeLinkRejection,
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_sessions")
        .get().count,
      sessionsBeforeLinkRejection,
    );

    const seededLinkState = "g".repeat(43);
    database.sqlite
      .prepare(`
        INSERT INTO account_oauth_challenges (
          state_hash, provider, nonce, pkce_verifier, intent,
          initiating_user_id, expected_origin, return_to, network_hash,
          created_at, expires_at, consumed_at
        ) VALUES (?, 'line', ?, ?, 'link', ?, ?,
          '/account?auth_popup=pending', 'network-hash', ?, ?, NULL)
      `)
      .run(
        await sha256Hex(seededLinkState),
        nonce,
        "v".repeat(64),
        userId,
        canonicalOrigin,
        now,
        now + 600,
      );
    const seededLinkProof = await oidcSessionProof(
      authSecret,
      "line",
      "link",
      seededLinkState,
      accountToken,
    );
    const providerCallsBeforeSeededLink = providerCalls;
    const linkIdentityLastUsedBefore = database.sqlite
      .prepare(
        "SELECT last_used_at FROM account_external_identities WHERE id = ?",
      )
      .get(identityId).last_used_at;
    const accountTokenHashForLink = await sha256Hex(accountToken);
    const linkSessionLastSeenBefore = database.sqlite
      .prepare("SELECT last_seen_at FROM account_sessions WHERE token_hash = ?")
      .get(accountTokenHashForLink).last_seen_at;
    const seededLinkResponse = await completeOidcAuthorization(
      finalizeRequest(canonicalOrigin, {
        code: "seeded-link-code",
        state: seededLinkState,
        cookie: `__Host-torudake_oidc_line=${seededLinkState}; __Host-torudake_oidc_line_session_proof=${seededLinkProof}; __Host-torudake_account=${accountToken}`,
      }),
      "line",
    );
    assert.equal(seededLinkResponse.status, 409);
    assert.equal(
      providerCalls,
      providerCallsBeforeSeededLink,
      "a seeded LINE link transaction must not call LINE or deauthorize",
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_external_identities")
        .get().count,
      identitiesBeforeLinkRejection,
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM account_sessions")
        .get().count,
      sessionsBeforeLinkRejection,
    );
    assert.equal(
      database.sqlite
        .prepare(
          "SELECT last_used_at FROM account_external_identities WHERE id = ?",
        )
        .get(identityId).last_used_at,
      linkIdentityLastUsedBefore,
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT last_seen_at FROM account_sessions WHERE token_hash = ?")
        .get(accountTokenHashForLink).last_seen_at,
      linkSessionLastSeenBefore,
    );
    assert.ok(
      database.sqlite
        .prepare(
          "SELECT consumed_at FROM account_oauth_challenges WHERE state_hash = ?",
        )
        .get(await sha256Hex(seededLinkState)).consumed_at,
      "the rejected seeded challenge remains one-time",
    );
    providerSubject = subject;
    const providerCallsAfterLinkDenials = providerCalls;

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
      providerCallsAfterLinkDenials,
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
        WHERE reauthenticated_at IS NOT NULL
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

    const startReauthenticationFlow = async (sessionToken) => {
      const started = await beginOidcAuthorization(
        new Request(
          `${canonicalOrigin}/api/account/oauth/line/start?popup=1&reauthenticate=1`,
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
      assert.equal(
        authorization.searchParams.get("prompt"),
        "login",
        "LINE reauthentication must disable automatic SSO login",
      );
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

    await t.test("OIDC reauthentication rejects a provider result after the initiating session is deleted", async () => {
      const reauthenticationRaceToken = "u".repeat(43);
      const reauthenticationRaceHash = await insertBoundSession(
        reauthenticationRaceToken,
      );
      const flow = await startReauthenticationFlow(reauthenticationRaceToken);
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
