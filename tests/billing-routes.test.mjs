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

const runtimeEnv = {};
globalThis.__cloudflareEnv = runtimeEnv;

async function loadWorker(suffix, values = {}) {
  for (const key of Object.keys(runtimeEnv)) delete runtimeEnv[key];
  Object.assign(runtimeEnv, { OPENAI_API_KEY: "test-key", ...values });
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(suffix, `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const workerEnv = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const workerContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function createDatabase() {
  const database = new D1Database();
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const fileName of (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()) {
    const source = await readFile(new URL(fileName, migrationDirectory), "utf8");
    database.sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
  }
  return database;
}

async function seedAccountSession(database) {
  const now = Math.floor(Date.now() / 1_000);
  const userId = "provider-off-account";
  const token = "s".repeat(43);
  const tokenHash = await sha256Hex(token);
  database.sqlite
    .prepare(`
      INSERT INTO users (
        id, email, billing_email, full_name, stripe_customer_id,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
    `)
    .run(userId, "line-account@example.invalid", now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_external_identities (
        id, user_id, provider, subject_hash, verified_email,
        created_at, last_used_at, revoked_at
      ) VALUES (?, ?, 'line', ?, NULL, ?, ?, NULL)
    `)
    .run("provider-off-identity", userId, "f".repeat(64), now, now);
  database.sqlite
    .prepare(`
      INSERT INTO account_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at,
        reauthenticated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(tokenHash, userId, now, now, now + 3_600, now);
  return `__Host-torudake_account=${token}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

test("keeps billing disabled until every Stripe secret is configured", async () => {
  const worker = await loadWorker("billing-status");
  const response = await worker.fetch(
    new Request("http://localhost/api/billing/status"),
    workerEnv,
    workerContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: false,
    authenticationAvailable: false,
    billingMode: "unconfigured",
    authenticated: false,
  });

  const checkoutResponse = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "oai-authenticated-user-email": "victim@example.com",
      },
      body: JSON.stringify({
        plan: "one_time",
        requestId: "spoofed-checkout-request",
      }),
    }),
    workerEnv,
    workerContext,
  );
  assert.equal(checkoutResponse.status, 503);
  assert.equal(
    (await checkoutResponse.json()).code,
    "authentication_temporarily_unavailable",
  );
});

test("does not create a checkout session without trusted authentication", async () => {
  const worker = await loadWorker("billing-checkout");
  const response = await worker.fetch(
    new Request("http://localhost/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: "starter",
        requestId: "billing-test-request",
      }),
    }),
    workerEnv,
    workerContext,
  );

  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.code, "authentication_temporarily_unavailable");
});

test("provider-off blocks new login but preserves an existing account session", async () => {
  const database = await createDatabase();
  const cookie = await seedAccountSession(database);
  const worker = await loadWorker("billing-provider-off-session", {
    DB: database,
    OIDC_AUTH_ENABLED: "false",
    LINE_LOGIN_ENABLED: "false",
    GOOGLE_OIDC_ENABLED: "false",
    PASSKEY_AUTH_ENABLED: "false",
  });

  const anonymousCheckout = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: "one_time",
        requestId: "provider-off-anonymous",
      }),
    }),
    workerEnv,
    workerContext,
  );
  assert.equal(anonymousCheckout.status, 503);
  assert.equal(
    (await anonymousCheckout.json()).code,
    "authentication_temporarily_unavailable",
  );

  const checkout = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie,
        origin: "https://torudake-reel.pages.dev",
      },
      body: JSON.stringify({
        plan: "one_time",
        requestId: "provider-off-existing-session",
      }),
    }),
    workerEnv,
    workerContext,
  );
  assert.equal(checkout.status, 503);
  assert.equal((await checkout.json()).code, "billing_not_configured");

  const portal = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/portal", {
      method: "POST",
      headers: {
        cookie,
        origin: "https://torudake-reel.pages.dev",
      },
    }),
    workerEnv,
    workerContext,
  );
  assert.equal(portal.status, 503);
  assert.match((await portal.json()).error, /決済管理は現在準備中/);

  const documents = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/portal", {
      headers: { cookie },
    }),
    workerEnv,
    workerContext,
  );
  assert.equal(documents.status, 503);
  assert.match((await documents.json()).error, /領収書の確認は現在準備中/);

  const status = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/status", {
      headers: { cookie },
    }),
    workerEnv,
    workerContext,
  );
  assert.equal(status.status, 200);
  const payload = await status.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.authenticationAvailable, false);
  assert.equal(payload.configured, false);
  assert.equal(payload.user.hasStripeCustomer, false);

  database.sqlite.close();
});

test("rejects billing mutations from a non-canonical deployment host", async () => {
  const worker = await loadWorker("billing-old-host");
  const response = await worker.fetch(
    new Request("https://old-deployment.torudake-reel.pages.dev/api/billing/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "https://old-deployment.torudake-reel.pages.dev",
      },
      body: JSON.stringify({
        plan: "one_time",
        requestId: "old-host-request",
      }),
    }),
    workerEnv,
    workerContext,
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "non_canonical_billing_origin");
});

test("spoofed identity headers cannot activate billing on public hosting", async () => {
  const worker = await loadWorker("billing-spoofed", {
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    STRIPE_PRICE_STARTER_MONTHLY: "price_starter",
    STRIPE_PRICE_STANDARD_MONTHLY: "price_standard",
    STRIPE_PRICE_LIGHT_MONTHLY: "price_legacy",
    STRIPE_PRICE_ONE_TIME: "price_one_time",
  });
  const response = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/status", {
      headers: {
        "oai-authenticated-user-email": "victim@example.com",
      },
    }),
    workerEnv,
    workerContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: false,
    authenticationAvailable: false,
    billingMode: "test",
    authenticated: false,
  });
});

test("the Cloudflare Pages entry strips identity headers defensively", async () => {
  const values = {
    TRUST_SITES_AUTH_HEADERS: "true",
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    STRIPE_PRICE_STARTER_MONTHLY: "price_starter",
    STRIPE_PRICE_STANDARD_MONTHLY: "price_standard",
    STRIPE_PRICE_LIGHT_MONTHLY: "price_legacy",
    STRIPE_PRICE_ONE_TIME: "price_one_time",
  };
  for (const key of Object.keys(runtimeEnv)) delete runtimeEnv[key];
  Object.assign(runtimeEnv, values);

  const entryUrl = new URL("../cloudflare-pages-entry.mjs", import.meta.url);
  entryUrl.searchParams.set("pages-auth", `${process.pid}-${Date.now()}`);
  const { default: pagesWorker } = await import(entryUrl.href);
  const response = await pagesWorker.fetch(
    new Request("https://torudake-reel.pages.dev/api/billing/status", {
      headers: {
        "oai-authenticated-user-email": "victim@example.com",
      },
    }),
    { ...workerEnv, ...values },
    workerContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: true,
    authenticationAvailable: true,
    billingMode: "test",
    authenticated: false,
  });
});

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
