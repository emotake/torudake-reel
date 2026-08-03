import assert from "node:assert/strict";
import test from "node:test";

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
        plan: "light",
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

test("spoofed identity headers cannot activate billing on public hosting", async () => {
  const worker = await loadWorker("billing-spoofed", {
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    STRIPE_PRICE_LIGHT_MONTHLY: "price_light",
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
    STRIPE_PRICE_LIGHT_MONTHLY: "price_light",
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
