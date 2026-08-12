import type {
  SafeProductProperties,
  ServerProductEvent,
} from "./product-analytics-schema";

type StripeTelemetryDescriptor = {
  eventName: ServerProductEvent;
  properties: SafeProductProperties;
};

const CHECKOUT_PLANS = new Set([
  "starter",
  "standard",
  "one_time",
  "light",
  "legacy_1480",
]);

const SUBSCRIPTION_STATUSES = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

const REFUND_STATUSES = new Set([
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "canceled",
]);

const DISPUTE_STATUSES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
]);

/**
 * Maps verified Stripe webhook payloads to content-free aggregate telemetry.
 * This is intentionally separate from the billing state transition itself.
 */
export function describeStripeProductTelemetry(
  eventType: string,
  object: Record<string, unknown>,
): StripeTelemetryDescriptor | null {
  if (
    eventType === "checkout.session.completed" ||
    eventType === "checkout.session.async_payment_succeeded"
  ) {
    const plan = metadataString(object, "plan");
    const paymentStatus = stringValue(object.payment_status);
    if (
      !plan ||
      !CHECKOUT_PLANS.has(plan) ||
      (paymentStatus !== "paid" && paymentStatus !== "no_payment_required")
    ) {
      return null;
    }
    return {
      eventName: "stripe_purchase_completed",
      properties: { plan, outcome: paymentStatus },
    };
  }

  if (eventType === "checkout.session.async_payment_failed") {
    const plan = metadataString(object, "plan");
    if (!plan || !CHECKOUT_PLANS.has(plan)) return null;
    return {
      eventName: "stripe_purchase_failed",
      properties: { plan, outcome: "failed" },
    };
  }

  if (eventType.startsWith("customer.subscription.")) {
    const status = allowedStatus(object.status, SUBSCRIPTION_STATUSES);
    return {
      eventName: "stripe_subscription_updated",
      properties: { status, outcome: "synchronized" },
    };
  }

  if (eventType === "charge.refunded") {
    return {
      eventName: "stripe_refund_updated",
      properties: { status: "succeeded", outcome: "synchronized" },
    };
  }

  if (
    eventType === "refund.created" ||
    eventType === "refund.updated" ||
    eventType === "refund.failed"
  ) {
    const status =
      eventType === "refund.failed"
        ? "failed"
        : allowedStatus(object.status, REFUND_STATUSES);
    return {
      eventName:
        status === "failed" ? "stripe_refund_failed" : "stripe_refund_updated",
      properties: { status, outcome: "synchronized" },
    };
  }

  if (eventType.startsWith("charge.dispute.")) {
    return {
      eventName: "stripe_dispute_updated",
      properties: {
        status: allowedStatus(object.status, DISPUTE_STATUSES),
        outcome: "synchronized",
      },
    };
  }

  return null;
}

function allowedStatus(value: unknown, allowed: ReadonlySet<string>) {
  const status = stringValue(value);
  return status && allowed.has(status) ? status : "unknown";
}

function metadataString(object: Record<string, unknown>, key: string) {
  const metadata = recordValue(object.metadata);
  return metadata ? stringValue(metadata[key]) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length <= 80 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
