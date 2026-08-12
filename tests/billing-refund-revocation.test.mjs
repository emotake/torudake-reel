import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.__cloudflareEnv = {};

const { summarizeStripePurchaseState } = await import(
  "../lib/stripe-purchase-state.ts"
);

const [
  webhookSource,
  billingStoreSource,
  migrationSource,
  assignmentMigrationSource,
  subscriptionPlanMigrationSource,
] = await Promise.all([
  readFile(
    new URL("../app/api/billing/webhook/route.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../lib/billing-store.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../drizzle/0011_refund_credit_revocation.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../drizzle/0012_one_time_purchase_assignment.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../drizzle/0014_known_multiple_man.sql", import.meta.url),
    "utf8",
  ),
]);

test("blocks a one-time credit for partial, pending, and succeeded refunds", () => {
  assert.deepEqual(
    summarizeStripePurchaseState([{ status: "succeeded", amount: 1 }], []),
    {
      refundBlockingAmount: 1,
      disputeState: null,
      blocked: true,
    },
  );
  assert.deepEqual(
    summarizeStripePurchaseState([{ status: "pending", amount: 75 }], []),
    {
      refundBlockingAmount: 75,
      disputeState: null,
      blocked: true,
    },
  );
  assert.deepEqual(
    summarizeStripePurchaseState([{ status: "succeeded", amount: 200 }], []),
    {
      refundBlockingAmount: 200,
      disputeState: null,
      blocked: true,
    },
  );
});

test("restores a one-time credit when every refund failed or was canceled", () => {
  assert.deepEqual(
    summarizeStripePurchaseState(
      [
        { status: "failed", amount: 200 },
        { status: "canceled", amount: 200 },
      ],
      [],
    ),
    {
      refundBlockingAmount: 0,
      disputeState: null,
      blocked: false,
    },
  );
});

test("blocks an open dispute and restores the credit after the dispute is won", () => {
  assert.deepEqual(
    summarizeStripePurchaseState([], [{ status: "needs_response" }]),
    {
      refundBlockingAmount: 0,
      disputeState: "needs_response",
      blocked: true,
    },
  );
  assert.deepEqual(summarizeStripePurchaseState([], [{ status: "won" }]), {
    refundBlockingAmount: 0,
    disputeState: "won",
    blocked: false,
  });
});

test("keeps the credit revoked for a refund even after a dispute is won", () => {
  assert.deepEqual(
    summarizeStripePurchaseState(
      [{ status: "succeeded", amount: 200 }],
      [{ status: "won" }],
    ),
    {
      refundBlockingAmount: 200,
      disputeState: "won",
      blocked: true,
    },
  );
});

test("subscribes the webhook handler to refund and dispute state changes", () => {
  for (const eventType of [
    "refund.created",
    "refund.updated",
    "refund.failed",
    "charge.refunded",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
  ]) {
    assert.match(webhookSource, new RegExp(`"${eventType.replaceAll(".", "\\.")}"`));
  }
  assert.match(
    webhookSource,
    /PURCHASE_STATE_EVENT_TYPES\.has\(event\.type\)[\s\S]*handlePurchaseStateChanged/,
  );
});

test("excludes revoked purchases in the atomic one-time reservation decision", () => {
  assert.match(
    billingStoreSource,
    /FROM billing_purchases AS purchase[\s\S]{0,300}purchase\.user_id = \?[\s\S]{0,200}purchase\.revoked_at IS NULL/,
  );
});

test("atomically stops an in-flight refunded credit without erasing completed work", () => {
  assert.match(
    billingStoreSource,
    /reservation\.bucket === "one_time"[\s\S]{0,200}oneTimeReservationHasActiveCredit/,
  );
  assert.match(
    billingStoreSource,
    /stopOneTimeReservationsForPurchase[\s\S]*UPDATE usage_reservations[\s\S]*billing_purchase_id = \?[\s\S]*status = 'reserved'/,
  );
  assert.match(
    billingStoreSource,
    /oneTimeReservationHasActiveCredit[\s\S]{0,1200}revoked_at IS NULL/,
  );
});

test("assigns each one-time use to its exact purchase", () => {
  assert.match(
    assignmentMigrationSource,
    /ADD `billing_purchase_id` text/,
  );
  assert.match(
    assignmentMigrationSource,
    /usage_reservations_billing_purchase_id_idx/,
  );
  assert.match(
    billingStoreSource,
    /billing_purchase_id[\s\S]{0,800}FROM billing_purchases AS purchase[\s\S]{0,800}billing_purchase_id = purchase\.id/,
  );
  assert.match(
    billingStoreSource,
    /activePurchaseIds[\s\S]{0,400}item\.billingPurchaseId/,
  );
});

test("migration persists every Stripe reconciliation and revocation field", () => {
  for (const column of [
    "refund_blocking_amount",
    "dispute_state",
    "revoked_at",
    "stripe_state_synced_at",
    "stripe_state_sync_started_at",
  ]) {
    assert.match(migrationSource, new RegExp(`ADD ${"`"}${column}${"`"}`));
  }
  assert.match(
    migrationSource,
    /ADD `refund_blocking_amount` integer DEFAULT 0 NOT NULL/,
  );
});

test("reconciles Stripe state immediately after recording a paid checkout", () => {
  const checkoutHandler = webhookSource.slice(
    webhookSource.indexOf("async function handleCheckoutCompleted"),
    webhookSource.indexOf("async function handlePurchaseStateChanged"),
  );
  const recordPosition = checkoutHandler.indexOf("await recordOneTimePurchase(");
  const reconcilePosition = checkoutHandler.indexOf(
    "await reconcileOneTimePurchase(paymentIntentId)",
  );

  assert.ok(recordPosition >= 0, "paid checkout must be recorded");
  assert.ok(
    reconcilePosition > recordPosition,
    "the recorded purchase must be reconciled before checkout handling completes",
  );
});

test("revokes only the refunded monthly billing period", () => {
  assert.match(
    webhookSource,
    /purchaseState === "missing"[\s\S]{0,200}reconcileMonthlySubscriptionPaymentState/,
  );
  assert.match(
    webhookSource,
    /listStripePaymentObjects\("\/v1\/refunds"/,
  );
  assert.match(
    webhookSource,
    /listStripePaymentObjects\("\/v1\/disputes"/,
  );
  assert.match(
    webhookSource,
    /summarizeStripePurchaseState\(refunds, disputes\)/,
  );
  assert.match(
    webhookSource,
    /setSubscriptionPeriodRevocationState\([\s\S]{0,200}periodStart,[\s\S]{0,100}paymentState\.blocked/,
  );
  assert.match(
    billingStoreSource,
    /currentSubscription\?\.revokedPeriodStart ===[\s\S]{0,100}currentSubscription\?\.currentPeriodStart/,
  );
  assert.match(
    billingStoreSource,
    /revoked_period_start IS NULL[\s\S]{0,100}revoked_period_start != current_period_start/,
  );
  assert.match(
    billingStoreSource,
    /setSubscriptionPeriodRevocationState[\s\S]*revokedPeriodStart: subscription\.currentPeriodStart[\s\S]*expiresAt: now - 1[\s\S]*status: "released"/,
  );
  assert.match(
    billingStoreSource,
    /reservation\.bucket === "subscription"[\s\S]{0,200}subscriptionReservationHasActivePeriod/,
  );
});

test("subscription migration preserves the old plan and refund period", () => {
  assert.match(
    subscriptionPlanMigrationSource,
    /ADD `plan_key` text DEFAULT 'legacy_1480' NOT NULL/,
  );
  assert.match(
    subscriptionPlanMigrationSource,
    /ADD `revoked_period_start` integer/,
  );
});

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
