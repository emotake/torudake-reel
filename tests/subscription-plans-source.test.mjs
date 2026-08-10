import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [checkoutSource, webhookSource, storeSource, stripeSource] =
  await Promise.all([
    readFile(
      new URL("../app/api/billing/checkout/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/billing/webhook/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/billing-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/stripe.ts", import.meta.url), "utf8"),
  ]);

test("offers only the new subscription plans in Checkout", () => {
  assert.match(checkoutSource, /value === "starter"/);
  assert.match(checkoutSource, /value === "standard"/);
  assert.doesNotMatch(checkoutSource, /value === "light"/);
  assert.match(
    checkoutSource,
    /payload\.plan === "one_time" \? "payment" : "subscription"/,
  );
  assert.match(checkoutSource, /billingStatus\.monthlySubscriptionActive/);
});

test("keeps the old Stripe price webhook-compatible without selling it", () => {
  assert.match(webhookSource, /plan !== "light"/);
  assert.match(webhookSource, /plan === "light" \? "legacy_1480" : plan/);
  assert.match(webhookSource, /stripeMonthlyPlanForPrice\(priceId\)/);
  assert.match(stripeSource, /STRIPE_PRICE_LIGHT_MONTHLY/);
  assert.match(stripeSource, /return "legacy_1480"/);
  assert.doesNotMatch(stripeSource, /StripePlan = [^;]*"light"/);
});

test("enforces the selected subscription's own video limit atomically", () => {
  assert.match(
    storeSource,
    /monthlyPlanVideoLimit\(currentSubscription\.planKey\)/,
  );
  assert.match(storeSource, /status\.monthlyVideoLimit/);
  assert.match(storeSource, /AND plan_key = \?/);
  assert.match(storeSource, /status\.subscription\.planKey/);
  assert.doesNotMatch(
    storeSource,
    /LIGHT_MONTHLY_VIDEO_LIMIT/,
  );
  assert.match(storeSource, /plan: status\.monthlyPlanKey \?\? "free"/);
  assert.match(storeSource, /planKey: status\.monthlyPlanKey/);
  assert.match(storeSource, /accessRevoked: status\.monthlyAccessRevoked/);
});
