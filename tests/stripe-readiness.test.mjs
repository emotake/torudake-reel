import assert from "node:assert/strict";
import test from "node:test";

const runtimeEnv = {
  STRIPE_SECRET_KEY: "sk_test_safe",
  STRIPE_WEBHOOK_SECRET: "whsec_safe",
  STRIPE_PRICE_STARTER_MONTHLY: "price_starter",
  STRIPE_PRICE_STANDARD_MONTHLY: "price_standard",
  STRIPE_PRICE_LIGHT_MONTHLY: "price_legacy",
  STRIPE_PRICE_ONE_TIME: "price_one",
};
globalThis.__cloudflareEnv = runtimeEnv;

function stripeFetch({
  starterAmount = 500,
  standardAmount = 1000,
  standardUsageType = "licensed",
  legacyActive = false,
} = {}) {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/prices/price_starter")) {
      return Response.json({
        id: "price_starter",
        active: true,
        currency: "jpy",
        unit_amount: starterAmount,
        type: "recurring",
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      });
    }
    if (url.endsWith("/v1/prices/price_standard")) {
      return Response.json({
        id: "price_standard",
        active: true,
        currency: "jpy",
        unit_amount: standardAmount,
        type: "recurring",
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: standardUsageType,
        },
      });
    }
    if (url.endsWith("/v1/prices/price_legacy")) {
      return Response.json({
        id: "price_legacy",
        active: legacyActive,
        currency: "jpy",
        unit_amount: 1480,
        type: "recurring",
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
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
    const { getStripeReadiness, stripeMonthlyPlanForPrice } = await import(
      url.href
    );
    assert.deepEqual(await getStripeReadiness(), {
      ready: true,
      mode: "test",
      catalogValid: true,
      chargesEnabled: false,
      detailsSubmitted: false,
      problem: null,
    });
    assert.equal(stripeMonthlyPlanForPrice("price_starter"), "starter");
    assert.equal(stripeMonthlyPlanForPrice("price_standard"), "standard");
    assert.equal(stripeMonthlyPlanForPrice("price_legacy"), "legacy_1480");
    assert.equal(stripeMonthlyPlanForPrice("price_other"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when a configured Stripe price would charge another amount", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stripeFetch({ starterAmount: 600 });
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
  globalThis.fetch = stripeFetch({ standardUsageType: "metered" });
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

test("requires both new monthly prices before enabling new sales", async () => {
  const originalFetch = globalThis.fetch;
  const originalStandard = runtimeEnv.STRIPE_PRICE_STANDARD_MONTHLY;
  delete runtimeEnv.STRIPE_PRICE_STANDARD_MONTHLY;
  globalThis.fetch = stripeFetch();
  try {
    const url = new URL("../lib/stripe.ts", import.meta.url);
    url.searchParams.set("missing-standard", `${process.pid}-${Date.now()}`);
    const { getStripeReadiness, isStripeWebhookConfigured } = await import(
      url.href
    );
    const readiness = await getStripeReadiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.problem, "not_configured");
    assert.equal(isStripeWebhookConfigured(), true);
  } finally {
    runtimeEnv.STRIPE_PRICE_STANDARD_MONTHLY = originalStandard;
    globalThis.fetch = originalFetch;
  }
});

test("allows a fresh launch without a legacy subscriber price", async () => {
  const originalFetch = globalThis.fetch;
  const originalLegacy = runtimeEnv.STRIPE_PRICE_LIGHT_MONTHLY;
  delete runtimeEnv.STRIPE_PRICE_LIGHT_MONTHLY;
  globalThis.fetch = stripeFetch();
  try {
    const url = new URL("../lib/stripe.ts", import.meta.url);
    url.searchParams.set("no-legacy", `${process.pid}-${Date.now()}`);
    const { getStripeReadiness } = await import(url.href);
    assert.equal((await getStripeReadiness()).ready, true);
  } finally {
    runtimeEnv.STRIPE_PRICE_LIGHT_MONTHLY = originalLegacy;
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
