import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker(suffix) {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
  };
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
    authenticated: false,
  });
  delete globalThis.__cloudflareEnv;
});

test("does not create a checkout session with incomplete Stripe settings", async () => {
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
  assert.equal(payload.code, "billing_not_configured");
  delete globalThis.__cloudflareEnv;
});
