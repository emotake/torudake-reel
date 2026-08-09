import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

globalThis.__cloudflareEnv = {};

const { summarizeStripePurchaseState } = await import(
  "../lib/stripe-purchase-state.ts"
);

const [webhookSource, billingStoreSource, migrationSource] = await Promise.all([
  readFile(
    new URL("../app/api/billing/webhook/route.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../lib/billing-store.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../drizzle/0011_refund_credit_revocation.sql", import.meta.url),
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
    /SELECT COALESCE\(SUM\(credits\), 0\)[\s\S]{0,300}FROM billing_purchases[\s\S]{0,300}user_id = \?[\s\S]{0,200}revoked_at IS NULL/,
  );
});

test("stops an in-flight refunded credit without erasing completed work", () => {
  assert.match(
    billingStoreSource,
    /reservation\.bucket === "one_time"[\s\S]{0,200}oneTimeReservationHasActiveCredit/,
  );
  assert.match(
    billingStoreSource,
    /releaseExcessOneTimeReservations[\s\S]*releaseOrCompleteUsageReservation\(reservation\.id, userId\)/,
  );
  assert.match(
    billingStoreSource,
    /oneTimeReservationHasActiveCredit[\s\S]{0,1200}revoked_at IS NULL/,
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

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
