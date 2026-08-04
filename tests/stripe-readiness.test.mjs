import assert from "node:assert/strict";
import test from "node:test";

const runtimeEnv = {
  STRIPE_SECRET_KEY: "sk_test_safe",
  STRIPE_WEBHOOK_SECRET: "whsec_safe",
  STRIPE_PRICE_LIGHT_MONTHLY: "price_light",
  STRIPE_PRICE_ONE_TIME: "price_one",
};
globalThis.__cloudflareEnv = runtimeEnv;

function stripeFetch(lightAmount = 1480, usageType = "licensed") {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/prices/price_light")) {
      return Response.json({
        id: "price_light",
        active: true,
        currency: "jpy",
        unit_amount: lightAmount,
        type: "recurring",
        recurring: { interval: "month", interval_count: 1, usage_type: usageType },
      });
    }
    if (url.endsWith("/v1/prices/price_one")) {
      return Response.json({
        id: "price_one",
        active: true,
        currency: "jpy",
        unit_amount: 200,
        type: "one_time",
        recurring: null,
      });
    }
    if (url.endsWith("/v1/account")) {
      return Response.json({ charges_enabled: false, details_submitted: false });
    }
    return Response.json({ error: { message: "unexpected path" } }, { status: 404 });
  };
}

test("accepts the exact sandbox catalog without requiring live activation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stripeFetch();
  try {
    const url = new URL("../lib/stripe.ts", import.meta.url);
    url.searchParams.set("ready", `${process.pid}-${Date.now()}`);
    const { getStripeReadiness } = await import(url.href);
    assert.deepEqual(await getStripeReadiness(), {
      ready: true,
      mode: "test",
      catalogValid: true,
      chargesEnabled: false,
      detailsSubmitted: false,
      problem: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when a configured Stripe price would charge another amount", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stripeFetch(1980);
  try {
    const url = new URL("../lib/stripe.ts", import.meta.url);
    url.searchParams.set("mismatch", `${process.pid}-${Date.now()}`);
    const { getStripeReadiness } = await import(url.href);
    const readiness = await getStripeReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.problem, "price_mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when the monthly price is usage based", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stripeFetch(1480, "metered");
  try {
    const url = new URL("../lib/stripe.ts", import.meta.url);
    url.searchParams.set("metered", `${process.pid}-${Date.now()}`);
    const { getStripeReadiness } = await import(url.href);
    const readiness = await getStripeReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.problem, "price_mismatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
