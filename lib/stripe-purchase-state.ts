import {
  abandonPurchaseStateSync,
  beginPurchaseStateSync,
  finishPurchaseStateSync,
} from "./billing-store";
import { stripeGet } from "./stripe";

type StripeObject = Record<string, unknown>;

type StripeList = {
  data?: unknown[];
  has_more?: boolean;
};

const NON_BLOCKING_REFUND_STATUSES = new Set(["failed", "canceled"]);
const NON_BLOCKING_DISPUTE_STATUSES = new Set(["won", "warning_closed"]);
const MAX_STRIPE_LIST_PAGES = 10;

export class PurchaseStateSyncBusyError extends Error {
  constructor() {
    super("Stripe purchase state is already being synchronized.");
    this.name = "PurchaseStateSyncBusyError";
  }
}

export function summarizeStripePurchaseState(
  refunds: StripeObject[],
  disputes: StripeObject[],
) {
  let refundBlockingAmount = 0;
  for (const refund of refunds) {
    const status = stringValue(refund.status);
    if (status && NON_BLOCKING_REFUND_STATUSES.has(status)) continue;
    const amount = positiveInteger(refund.amount) ?? 1;
    refundBlockingAmount = Math.min(
      Number.MAX_SAFE_INTEGER,
      refundBlockingAmount + amount,
    );
  }

  const disputeStatuses = disputes.map(
    (dispute) => stringValue(dispute.status) ?? "unknown",
  );
  const blockingDispute = disputeStatuses.find(
    (status) => !NON_BLOCKING_DISPUTE_STATUSES.has(status),
  );
  const disputeState =
    blockingDispute ?? disputeStatuses.at(0) ?? null;

  return {
    refundBlockingAmount,
    disputeState,
    blocked: refundBlockingAmount > 0 || Boolean(blockingDispute),
  };
}

/**
 * Rebuilds the local credit decision from Stripe's current state. Webhook
 * payloads only trigger this function; they are not treated as the source of
 * truth because Stripe can deliver related events more than once or out of
 * order.
 */
export async function reconcileOneTimePurchase(paymentIntentId: string) {
  const claim = await beginPurchaseStateSync(paymentIntentId);
  if (claim === "missing") return "missing" as const;
  if (claim === "busy") throw new PurchaseStateSyncBusyError();

  try {
    const [refunds, disputes] = await Promise.all([
      listStripeObjects("/v1/refunds", paymentIntentId),
      listStripeObjects("/v1/disputes", paymentIntentId),
    ]);
    const state = summarizeStripePurchaseState(refunds, disputes);
    await finishPurchaseStateSync(claim, state);
    return state.blocked ? ("revoked" as const) : ("active" as const);
  } catch (error) {
    await abandonPurchaseStateSync(claim).catch(() => undefined);
    throw error;
  }
}

async function listStripeObjects(path: string, paymentIntentId: string) {
  const results: StripeObject[] = [];
  let startingAfter: string | null = null;

  for (let page = 0; page < MAX_STRIPE_LIST_PAGES; page += 1) {
    const parameters = new URLSearchParams({
      payment_intent: paymentIntentId,
      limit: "100",
    });
    if (startingAfter) parameters.set("starting_after", startingAfter);
    const list = await stripeGet<StripeList>(`${path}?${parameters}`);
    if (!Array.isArray(list.data) || typeof list.has_more !== "boolean") {
      throw new Error("Stripe returned an invalid purchase-state list.");
    }

    const objects = list.data.map(recordValue);
    if (objects.some((object) => object === null)) {
      throw new Error("Stripe returned an invalid purchase-state object.");
    }
    results.push(...(objects as StripeObject[]));
    if (!list.has_more) return results;

    startingAfter = stringValue(objects.at(-1)?.id);
    if (!startingAfter) {
      throw new Error("Stripe purchase-state pagination has no cursor.");
    }
  }

  throw new Error("Stripe purchase-state pagination exceeded its limit.");
}

function positiveInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function recordValue(value: unknown): StripeObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StripeObject)
    : null;
}
