import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationDirectory = new URL("../drizzle/", import.meta.url);

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
}

class D1Database {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(query) {
    return new D1Statement(this, query);
  }
}

test("account-management migration has an ASCII-safe passkey default", async () => {
  const migration = await readFile(
    new URL("0020_nice_sunfire.sql", migrationDirectory),
    "utf8",
  );
  assert.match(
    migration,
    /ADD `display_name` text DEFAULT 'Device' NOT NULL/,
  );
  assert.doesNotMatch(migration, /登録済み|逋ｻ|縺/);
  assert.ok(
    Buffer.from(migration, "utf8").every((byte) => byte < 0x80),
    "the migration must stay ASCII-only across Windows code pages",
  );
});

test("account-management migration applies and enforces safe constraints", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const fileName of (await readdir(migrationDirectory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      const source = await readFile(new URL(fileName, migrationDirectory), "utf8");
      database.exec(source.replaceAll("--> statement-breakpoint", ""));
    }
    const now = Math.floor(Date.now() / 1_000);
    database
      .prepare(`
        INSERT INTO account_passkeys (
          credential_id, user_id, public_key, counter, transports,
          device_type, backed_up, created_at, updated_at, last_used_at
        ) VALUES ('credential_abcdefghijkl', 'user-a', 'AQID', 0, NULL,
          'singleDevice', 0, ?, ?, ?)
      `)
      .run(now, now, now);
    assert.equal(
      database
        .prepare(
          "SELECT display_name FROM account_passkeys WHERE credential_id = 'credential_abcdefghijkl'",
        )
        .get().display_name,
      "Device",
    );
    database
      .prepare(`
        INSERT INTO billing_rate_limits (
          user_id, action, window_started_at, attempts, updated_at
        ) VALUES ('user-a', 'portal', ?, 1, ?)
      `)
      .run(now, now);
    assert.throws(() =>
      database
        .prepare(`
          INSERT INTO billing_rate_limits (
            user_id, action, window_started_at, attempts, updated_at
          ) VALUES ('user-a', 'portal', ?, 1, ?)
        `)
        .run(now, now),
    );
    database
      .prepare(`
        INSERT INTO account_deletion_requests (
          user_id, status, requested_at, execute_after, updated_at
        ) VALUES ('user-a', 'scheduled', ?, ?, ?)
      `)
      .run(now, now + 30 * 24 * 60 * 60, now);
    assert.equal(
      database
        .prepare(
          "SELECT status FROM account_deletion_requests WHERE user_id = 'user-a'",
        )
        .get().status,
      "scheduled",
    );
  } finally {
    database.close();
  }
});

test("account UI discloses pending checkout before authentication", async () => {
  const source = await readFile(
    new URL("../app/account/account-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /選択中のプラン/);
  assert.match(source, /解約するまで1か月ごとに自動更新/);
  assert.match(source, /1回払い・自動更新なし/);
  assert.match(source, /ログインしたあと、Stripeの決済画面を開きます/);
  assert.match(source, /Googleでアカウントを作成またはログイン/);
  assert.match(source, /登録済みのパスキーでもログイン/);
  assert.match(source, /\/api\/account\/passkeys/);
  assert.match(
    source,
    /mutationJson<\{ updated: boolean \}>\([\s\S]*?"\/api\/account\/passkeys",[\s\S]*?"PATCH"/,
  );
  assert.match(
    source,
    /mutationJson<\{ deleted: boolean \}>\([\s\S]*?"\/api\/account\/passkeys",[\s\S]*?"DELETE"/,
  );
  assert.match(source, /\/api\/account\/sessions/);
  assert.match(source, /\/api\/account\/recovery/);
  assert.match(source, /領収書・請求書と契約管理/);
  assert.match(source, /本人確認して削除を予約/);
  assert.match(source, /先にStripeで自動更新を解約/);
});

test("dangerous account actions require recent same-account reauthentication", async () => {
  const [source, client, gate] = await Promise.all([
    readFile(new URL("../lib/account-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/account/account-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/authentication-gate.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /last_passkey_cannot_be_deleted/);
  assert.match(source, /requireRecentAccountSession\(request\)/);
  assert.match(source, /reauthentication_identity_changed/);
  assert.match(source, /challenge\.user_id !== passkey\.user_id/);
  assert.match(source, /DELETE FROM account_sessions\s+WHERE user_id = \?/);
  assert.doesNotMatch(client, /\/api\/account\/passkey\/reauth\/options/);
  assert.match(client, /mode="reauthenticate"/);
  assert.match(client, /reason="account"/);
  assert.ok(
    client.indexOf("open={accountReauthenticationOpen}") >
      client.indexOf("const freeVideosRemaining"),
    "the step-up gate must render in the authenticated account branch",
  );
  assert.match(gate, /\/api\/account\/passkey\/reauth\/options/);
  assert.match(gate, /reauthenticate=1/);
  assert.match(gate, /methods\.accountMethods\.google/);
  assert.match(gate, /methods\.accountMethods\.passkey/);
  assert.match(
    gate,
    /mode === "reauthenticate"[\s\S]{0,300}\/api\/account\/passkey\/reauth\/options/,
  );

  const registerPasskey = client.slice(
    client.indexOf("async function registerPasskey()"),
    client.indexOf("async function loginPasskey()"),
  );
  assert.match(registerPasskey, /status\?\.authenticated !== true/);
  assert.match(registerPasskey, /await reauthenticate\(\)/);
  assert.doesNotMatch(registerPasskey, /\/api\/session\/trial/);
  assert.ok(
    registerPasskey.indexOf("await reauthenticate()") <
      registerPasskey.indexOf("/api/account/passkey/register/options"),
    "first and backup passkeys must both follow recent step-up",
  );
});

test("recovery records no plaintext email and never grants authentication", async () => {
  const source = await readFile(
    new URL("../lib/account-auth.ts", import.meta.url),
    "utf8",
  );
  const route = await readFile(
    new URL("../app/api/account/recovery/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /contactHash = await recoveryValueHash/);
  assert.match(source, /challenge_hash, status/);
  assert.match(source, /matchingUser\?\.id \?\? null/);
  assert.doesNotMatch(route, /sessionCookie|Set-Cookie|authenticated: true/);
});

test("billing entry points consume D1 account rate limits", async () => {
  const [checkout, portal, status, methods] = await Promise.all([
    readFile(new URL("../app/api/billing/checkout/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/billing/portal/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/billing/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/account-auth-methods.ts", import.meta.url), "utf8"),
  ]);
  assert.match(checkout, /consumeBillingRateLimit\([\s\S]*"one_time_checkout"/);
  assert.match(checkout, /isAccountDeletionScheduled\(user\.id\)/);
  assert.match(checkout, /account_deletion_scheduled/);
  assert.match(portal, /consumeBillingRateLimit\(user\.id, "portal"\)/);
  assert.match(portal, /"billing_documents"/);
  assert.match(portal, /safeStripeDocumentUrl/);
  assert.match(portal, /customer=\$\{customer\}/);
  for (const route of [checkout, portal, status]) {
    assert.match(route, /isAccountAuthenticationAvailable\(\)/);
    assert.doesNotMatch(route, /isPasskeyAuthenticationConfigured\(\)/);
  }
  assert.match(methods, /isOidcProviderConfigured\("google"\)/);
  assert.match(methods, /line: false/);
  assert.match(methods, /email: false/);
});

test("account deletion is delayed, reauthenticated, and blocked by active billing", async () => {
  const route = await readFile(
    new URL("../app/api/account/deletion/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /requireRecentAccountSession\(request\)/);
  assert.match(route, /billing\.monthlySubscriptionActive/);
  assert.match(route, /hasNonterminalStripeSubscription/);
  assert.match(route, /status=all&limit=100/);
  assert.match(route, /incomplete_expired/);
  assert.match(route, /active_subscription_must_end_first/);
  assert.match(route, /DELETION_GRACE_SECONDS = 30 \* 24 \* 60 \* 60/);
  assert.match(route, /status = 'cancelled'/);
  assert.doesNotMatch(route, /DELETE FROM users|DELETE FROM account_passkeys/);
});

test("one-time billing rate limit is atomic and resets after its window", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE billing_rate_limits (
        user_id text NOT NULL,
        action text NOT NULL,
        window_started_at integer NOT NULL,
        attempts integer DEFAULT 1 NOT NULL,
        updated_at integer NOT NULL,
        PRIMARY KEY(user_id, action)
      );
    `);
    globalThis.__cloudflareEnv = { DB: new D1Database(sqlite) };
    const { consumeBillingRateLimit } = await import(
      "../lib/billing-rate-limit.ts"
    );
    const now = 1_900_000_000;
    const attempts = [];
    for (let count = 0; count < 6; count += 1) {
      attempts.push(
        await consumeBillingRateLimit("user-rate-limit", "one_time_checkout", now),
      );
    }
    assert.deepEqual(
      attempts.map((attempt) => attempt.allowed),
      [true, true, true, true, true, false],
    );
    assert.equal(attempts.at(-1).retryAfterSeconds, 600);
    assert.equal(
      (
        await consumeBillingRateLimit(
          "user-rate-limit",
          "one_time_checkout",
          now + 601,
        )
      ).allowed,
      true,
    );
  } finally {
    delete globalThis.__cloudflareEnv;
    sqlite.close();
  }
});
