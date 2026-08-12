import {
  acquireSubscriptionSyncLease,
  abandonStripeEvent,
  beginStripeEvent,
  finishStripeEvent,
  getBillingUserById,
  getBillingUserByStripeCustomer,
  recordOneTimePurchase,
  releaseMonthlyCheckoutLock,
  releaseSubscriptionSyncLease,
  setStripeCustomerId,
  setStripeCustomerIdentity,
  setSubscriptionPeriodRevocationState,
  upsertSubscription,
} from "../../../../lib/billing-store";
import {
  getStripeConfig,
  isStripeWebhookConfigured,
  stripeGet,
  stripeMonthlyPlanForPrice,
  stripePriceForPlan,
  verifyStripeSignature,
} from "../../../../lib/stripe";
import {
  reconcileOneTimePurchase,
  summarizeStripePurchaseState,
} from "../../../../lib/stripe-purchase-state";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";

type StripeObject = Record<string, unknown>;

type StripeEvent = {
  id: string;
  type: string;
  data: {
    object: StripeObject;
  };
};

const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_STRIPE_LIST_PAGES = 10;
const SUBSCRIPTION_SYNC_WAIT_ATTEMPTS = 20;
const SUBSCRIPTION_SYNC_WAIT_MS = 25;
const PURCHASE_STATE_EVENT_TYPES = new Set([
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]);

export async function POST(request: Request) {
  const { webhookSecret } = getStripeConfig();
  const signature = request.headers.get("stripe-signature");
  if (!isStripeWebhookConfigured() || !webhookSecret) {
    return Response.json(
      { error: "Webhook is not configured." },
      { status: 503 },
    );
  }
  if (!signature) {
    return Response.json({ error: "Stripe signature is missing." }, { status: 400 });
  }

  let rawBody: string;
  try {
    const bytes = await readRequestBodyWithLimit(request, MAX_WEBHOOK_BYTES);
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "Stripe payload is too large."
            : "Invalid Stripe payload.",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!(await verifyStripeSignature(rawBody, signature, webhookSecret))) {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return Response.json({ error: "Invalid Stripe payload." }, { status: 400 });
  }
  if (
    !event.id ||
    event.id.length > 255 ||
    !event.type ||
    event.type.length > 200 ||
    !event.data?.object
  ) {
    return Response.json({ error: "Invalid Stripe event." }, { status: 400 });
  }

  const eventClaim = await beginStripeEvent(event.id, event.type);
  if (eventClaim === "processed") {
    return Response.json({ received: true, duplicate: true });
  }
  if (eventClaim === "busy") {
    return Response.json(
      { error: "Stripe event is already being processed." },
      { status: 409 },
    );
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === "checkout.session.expired") {
      await handleCheckoutExpired(event.data.object);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await handleSubscriptionChanged(event.data.object);
    } else if (
      event.type === "invoice.paid" ||
      event.type === "invoice.payment_failed"
    ) {
      await handleInvoiceChanged(event.data.object);
    } else if (PURCHASE_STATE_EVENT_TYPES.has(event.type)) {
      await handlePurchaseStateChanged(event.type, event.data.object);
    }

    await finishStripeEvent(event.id);
    return Response.json({ received: true });
  } catch (error) {
    await abandonStripeEvent(event.id).catch(() => undefined);
    console.error("Stripe webhook processing failed", event.type, error);
    return Response.json(
      { error: "Stripe webhook processing failed." },
      { status: 500 },
    );
  }
}

async function handleCheckoutCompleted(session: StripeObject) {
  const plan = metadataValue(session, "plan");
  if (
    plan !== "starter" &&
    plan !== "standard" &&
    plan !== "light" &&
    plan !== "one_time"
  ) {
    // The Stripe account can contain products unrelated to this service.
    return;
  }

  const checkoutSessionId = stringValue(session.id);
  const customerId = objectId(session.customer);
  if (!checkoutSessionId || !customerId) {
    throw new Error("Checkout session identifiers are incomplete.");
  }
  const user = await resolveCheckoutUser(session, customerId);
  const customerDetails = recordValue(session.customer_details);
  const billingEmail = normalizedEmail(customerDetails?.email);
  const billingName = normalizedName(customerDetails?.name);
  await setStripeCustomerIdentity(user.id, {
    stripeCustomerId: customerId,
    ...(billingEmail ? { billingEmail } : {}),
    ...(billingName ? { fullName: billingName } : {}),
  });

  const mode = stringValue(session.mode);
  if (plan !== "one_time") {
    if (mode !== "subscription") {
      throw new Error("Monthly checkout has an unexpected mode.");
    }
    const subscriptionId = objectId(session.subscription);
    if (!subscriptionId) {
      throw new Error("Monthly checkout has no subscription.");
    }
    await withSubscriptionSyncLease(subscriptionId, async () => {
      const subscription = await stripeGet<StripeObject>(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      if (objectId(subscription.customer) !== customerId) {
        throw new Error("Checkout and subscription customers do not match.");
      }
      const item = firstSubscriptionItem(subscription);
      const actualPlan = item
        ? stripeMonthlyPlanForPrice(objectId(item.price) ?? "")
        : null;
      const expectedPlan = plan === "light" ? "legacy_1480" : plan;
      if (actualPlan !== expectedPlan) {
        throw new Error("Checkout subscription does not match the selected plan.");
      }
      await persistSubscription(user.id, subscription);
    });
    const checkoutLockToken = metadataValue(session, "checkout_lock_token");
    if (checkoutLockToken) {
      await releaseMonthlyCheckoutLock({
        userId: user.id,
        lockToken: checkoutLockToken,
      });
    }
    return;
  }

  const paymentStatus = stringValue(session.payment_status);
  if (mode !== "payment") {
    throw new Error("One-time checkout has an unexpected mode.");
  }
  if (paymentStatus !== "paid") return;

  const paymentIntentId = objectId(session.payment_intent);
  if (!paymentIntentId) {
    throw new Error("Paid checkout has no payment intent.");
  }
  const expectedPriceId = stripePriceForPlan("one_time");
  await verifyCheckoutLineItem(checkoutSessionId, expectedPriceId);
  await recordOneTimePurchase({
    checkoutSessionId,
    userId: user.id,
    stripeCustomerId: customerId,
    stripePaymentIntentId: paymentIntentId,
    stripePriceId: expectedPriceId,
  });
  await reconcileOneTimePurchase(paymentIntentId);
}

async function handleCheckoutExpired(session: StripeObject) {
  const plan = metadataValue(session, "plan");
  if (plan !== "starter" && plan !== "standard" && plan !== "light") return;
  const userId =
    stringValue(session.client_reference_id) ??
    metadataValue(session, "app_user_id");
  const lockToken = metadataValue(session, "checkout_lock_token");
  if (!userId || !lockToken) return;
  const user = await getBillingUserById(userId);
  if (!user) return;
  await releaseMonthlyCheckoutLock({ userId: user.id, lockToken });
}

async function handlePurchaseStateChanged(
  eventType: string,
  object: StripeObject,
) {
  let paymentIntentId = objectId(object.payment_intent);
  if (!paymentIntentId) {
    let chargeId = objectId(object.charge);
    if (!chargeId && eventType === "charge.refunded") {
      chargeId = stringValue(object.id);
    }
    if (!chargeId) {
      throw new Error("Refund or dispute has no payment identifier.");
    }
    const charge = await stripeGet<StripeObject>(
      `/v1/charges/${encodeURIComponent(chargeId)}`,
    );
    paymentIntentId = objectId(charge.payment_intent);
  }
  if (!paymentIntentId) {
    throw new Error("Refund or dispute charge has no payment intent.");
  }

  // One-time purchases and monthly invoices share the same Stripe account.
  // Reconcile the former first, then resolve an invoiced subscription only
  // when the PaymentIntent belongs to a known monthly price.
  const purchaseState = await reconcileOneTimePurchase(paymentIntentId);
  if (purchaseState === "missing") {
    await reconcileMonthlySubscriptionPaymentState(paymentIntentId);
  }
}

async function reconcileMonthlySubscriptionPaymentState(
  paymentIntentId: string,
) {
  const paymentIntent = await stripeGet<StripeObject>(
    `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
  );
  let invoiceId = objectId(paymentIntent.invoice);
  if (!invoiceId) {
    const chargeId = objectId(paymentIntent.latest_charge);
    if (chargeId) {
      const charge = await stripeGet<StripeObject>(
        `/v1/charges/${encodeURIComponent(chargeId)}`,
      );
      invoiceId = objectId(charge.invoice);
    }
  }
  if (!invoiceId) return;

  const invoice = await stripeGet<StripeObject>(
    `/v1/invoices/${encodeURIComponent(invoiceId)}`,
  );
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;

  await withSubscriptionSyncLease(subscriptionId, async () => {
    const subscription = await stripeGet<StripeObject>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    const item = firstSubscriptionItem(subscription);
    const priceId = item ? objectId(item.price) : null;
    if (!priceId || !stripeMonthlyPlanForPrice(priceId)) return;
    const periodStart = await invoicePeriodStart(
      invoiceId,
      invoice,
      subscriptionId,
      priceId,
    );
    if (!periodStart) {
      throw new Error("Subscription invoice has no matching billing period.");
    }

    // Persist the latest Stripe subscription snapshot and its period-specific
    // revocation while the same subscription lease is held.
    await persistSubscriptionForResolvedUser(subscription);
    const [refunds, disputes] = await Promise.all([
      listStripePaymentObjects("/v1/refunds", paymentIntentId),
      listStripePaymentObjects("/v1/disputes", paymentIntentId),
    ]);
    const paymentState = summarizeStripePurchaseState(refunds, disputes);
    await setSubscriptionPeriodRevocationState(
      subscriptionId,
      periodStart,
      paymentState.blocked,
    );
  });
}

async function listStripePaymentObjects(
  path: "/v1/refunds" | "/v1/disputes",
  paymentIntentId: string,
) {
  const objects: StripeObject[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < MAX_STRIPE_LIST_PAGES; page += 1) {
    const parameters = new URLSearchParams({
      payment_intent: paymentIntentId,
      limit: "100",
    });
    if (startingAfter) parameters.set("starting_after", startingAfter);
    const list = await stripeGet<{ data?: unknown[]; has_more?: boolean }>(
      `${path}?${parameters}`,
    );
    if (!Array.isArray(list.data) || typeof list.has_more !== "boolean") {
      throw new Error("Stripe returned an invalid payment-state list.");
    }
    const pageRefunds = list.data.map(recordValue);
    if (pageRefunds.some((refund) => refund === null)) {
      throw new Error("Stripe returned an invalid payment-state object.");
    }
    objects.push(...(pageRefunds as StripeObject[]));
    if (!list.has_more) return objects;
    startingAfter = stringValue(pageRefunds.at(-1)?.id);
    if (!startingAfter) {
      throw new Error("Stripe payment-state pagination has no cursor.");
    }
  }
  throw new Error("Stripe payment-state pagination exceeded its limit.");
}

async function handleInvoiceChanged(invoice: StripeObject) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  await handleSubscriptionChanged({ id: subscriptionId });
}

function subscriptionIdFromInvoice(invoice: StripeObject) {
  return (
    objectId(invoice.subscription) ??
    objectId(
      recordValue(recordValue(invoice.parent)?.subscription_details)
        ?.subscription,
    )
  );
}

async function invoicePeriodStart(
  invoiceId: string,
  invoice: StripeObject,
  subscriptionId: string,
  priceId: string,
) {
  const lines = await listStripeInvoiceLines(invoiceId);
  return selectSubscriptionInvoicePeriodStart(
    lines,
    subscriptionId,
    priceId,
    numberValue(invoice.period_start),
  );
}

export function selectSubscriptionInvoicePeriodStart(
  lines: StripeObject[],
  subscriptionId: string,
  priceId: string,
  fallbackPeriodStart: number | null,
) {
  const ranked = lines
    .map((line) => {
      const periodStart = numberValue(recordValue(line.period)?.start);
      if (!periodStart) return null;
      const subscriptionMatches =
        invoiceLineSubscriptionId(line) === subscriptionId;
      const priceMatches = invoiceLinePriceId(line) === priceId;
      if (!subscriptionMatches && !priceMatches) return null;
      const score =
        (subscriptionMatches ? 4 : 0) +
        (priceMatches ? 2 : 0) +
        (line.proration === true ? 0 : 1);
      return { periodStart, score };
    })
    .filter(
      (item): item is { periodStart: number; score: number } => item !== null,
    )
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.periodStart ?? fallbackPeriodStart;
}

async function listStripeInvoiceLines(invoiceId: string) {
  const lines: StripeObject[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < MAX_STRIPE_LIST_PAGES; page += 1) {
    const parameters = new URLSearchParams({ limit: "100" });
    if (startingAfter) parameters.set("starting_after", startingAfter);
    const list = await stripeGet<{ data?: unknown[]; has_more?: boolean }>(
      `/v1/invoices/${encodeURIComponent(invoiceId)}/lines?${parameters}`,
    );
    if (!Array.isArray(list.data) || typeof list.has_more !== "boolean") {
      throw new Error("Stripe returned an invalid invoice-line list.");
    }
    const pageLines = list.data.map(recordValue);
    if (pageLines.some((line) => line === null)) {
      throw new Error("Stripe returned an invalid invoice line.");
    }
    lines.push(...(pageLines as StripeObject[]));
    if (!list.has_more) return lines;
    startingAfter = stringValue(pageLines.at(-1)?.id);
    if (!startingAfter) {
      throw new Error("Stripe invoice-line pagination has no cursor.");
    }
  }
  throw new Error("Stripe invoice-line pagination exceeded its limit.");
}

function invoiceLineSubscriptionId(line: StripeObject) {
  return (
    objectId(line.subscription) ??
    objectId(
      recordValue(recordValue(line.parent)?.subscription_item_details)
        ?.subscription,
    )
  );
}

function invoiceLinePriceId(line: StripeObject) {
  return (
    objectId(line.price) ??
    objectId(recordValue(recordValue(line.pricing)?.price_details)?.price)
  );
}

async function resolveCheckoutUser(
  session: StripeObject,
  customerId: string,
) {
  const referencedUserId = stringValue(session.client_reference_id);
  const metadataUserId = metadataValue(session, "app_user_id");
  if (
    referencedUserId &&
    metadataUserId &&
    referencedUserId !== metadataUserId
  ) {
    throw new Error("Checkout user references do not match.");
  }

  const customerUser = await getBillingUserByStripeCustomer(customerId);
  const userId = referencedUserId ?? metadataUserId ?? customerUser?.id ?? null;
  if (!userId) throw new Error("Checkout session has no app user.");
  if (customerUser && customerUser.id !== userId) {
    throw new Error("Stripe customer belongs to a different app user.");
  }

  const user = await getBillingUserById(userId);
  if (!user) throw new Error("Checkout user was not found.");
  if (user.stripeCustomerId && user.stripeCustomerId !== customerId) {
    throw new Error("App user belongs to a different Stripe customer.");
  }
  if (!user.stripeCustomerId) await setStripeCustomerId(user.id, customerId);
  return user;
}

async function verifyCheckoutLineItem(
  checkoutSessionId: string,
  expectedPriceId: string,
) {
  const lineItems = await stripeGet<{ data?: unknown[] }>(
    `/v1/checkout/sessions/${encodeURIComponent(checkoutSessionId)}/line_items?limit=10`,
  );
  const items = Array.isArray(lineItems.data)
    ? lineItems.data.map(recordValue).filter((item) => item !== null)
    : [];
  if (
    items.length !== 1 ||
    objectId(items[0].price) !== expectedPriceId ||
    numberValue(items[0].quantity) !== 1
  ) {
    throw new Error("Checkout line item does not match the configured price.");
  }
}

export async function handleSubscriptionChanged(subscription: StripeObject) {
  const subscriptionId = stringValue(subscription.id);
  if (!subscriptionId) throw new Error("Subscription has no Stripe ID.");
  await withSubscriptionSyncLease(subscriptionId, async () => {
    const latestSubscription = await stripeGet<StripeObject>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    await persistSubscriptionForResolvedUser(latestSubscription);
  });
}

export async function withSubscriptionSyncLease<T>(
  subscriptionId: string,
  work: () => Promise<T>,
) {
  for (let attempt = 0; attempt < SUBSCRIPTION_SYNC_WAIT_ATTEMPTS; attempt += 1) {
    const lease = await acquireSubscriptionSyncLease(subscriptionId);
    if (lease) {
      try {
        return await work();
      } finally {
        await releaseSubscriptionSyncLease(lease).catch(() => undefined);
      }
    }
    if (attempt + 1 < SUBSCRIPTION_SYNC_WAIT_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, SUBSCRIPTION_SYNC_WAIT_MS),
      );
    }
  }
  throw new Error("Stripe subscription reconciliation is already in progress.");
}

async function persistSubscriptionForResolvedUser(subscription: StripeObject) {
  const customerId = objectId(subscription.customer);
  const item = firstSubscriptionItem(subscription);
  const priceId = item ? objectId(item.price) : null;
  if (!priceId || !stripeMonthlyPlanForPrice(priceId)) {
    // Ignore subscriptions for other products in the same Stripe account.
    return;
  }
  if (!customerId) throw new Error("Subscription has no Stripe customer.");

  let userId = metadataValue(subscription, "app_user_id");
  const customerUser = await getBillingUserByStripeCustomer(customerId);
  if (!userId) userId = customerUser?.id ?? null;
  if (!userId) throw new Error("Subscription has no app user.");
  if (customerUser && customerUser.id !== userId) {
    throw new Error("Subscription customer belongs to another app user.");
  }
  const user = await getBillingUserById(userId);
  if (!user) throw new Error("Subscription user was not found.");
  if (user.stripeCustomerId && user.stripeCustomerId !== customerId) {
    throw new Error("Subscription user belongs to another Stripe customer.");
  }
  await persistSubscription(userId, subscription);
}

async function persistSubscription(userId: string, subscription: StripeObject) {
  const subscriptionId = stringValue(subscription.id);
  const customerId = objectId(subscription.customer);
  const item = firstSubscriptionItem(subscription);
  const priceId = item ? objectId(item.price) : null;
  const currentPeriodStart =
    numberValue(subscription.current_period_start) ??
    numberValue(item?.current_period_start);
  const currentPeriodEnd =
    numberValue(subscription.current_period_end) ??
    numberValue(item?.current_period_end);
  const status = stringValue(subscription.status);
  const metadataUserId = metadataValue(subscription, "app_user_id");
  const planKey = priceId ? stripeMonthlyPlanForPrice(priceId) : null;

  if (
    !subscriptionId ||
    !customerId ||
    !priceId ||
    !planKey ||
    !status ||
    !currentPeriodStart ||
    !currentPeriodEnd
  ) {
    throw new Error("Subscription payload is incomplete.");
  }
  if (!planKey) {
    throw new Error("Subscription price does not match the configured plan.");
  }
  if (metadataUserId && metadataUserId !== userId) {
    throw new Error("Subscription metadata belongs to another app user.");
  }

  await setStripeCustomerId(userId, customerId);
  await upsertSubscription(userId, {
    id: subscriptionId,
    customerId,
    priceId,
    planKey,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  });
  const checkoutLockToken = metadataValue(
    subscription,
    "checkout_lock_token",
  );
  if (checkoutLockToken) {
    await releaseMonthlyCheckoutLock({ userId, lockToken: checkoutLockToken });
  }
}

function firstSubscriptionItem(subscription: StripeObject) {
  const items = recordValue(subscription.items);
  const data = Array.isArray(items?.data) ? items.data : [];
  return recordValue(data[0]);
}

function metadataValue(object: StripeObject, key: string) {
  return stringValue(recordValue(object.metadata)?.[key]);
}

function objectId(value: unknown) {
  if (typeof value === "string") return value;
  return stringValue(recordValue(value)?.id);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

function normalizedName(value: unknown) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, 120);
  return name || null;
}

function recordValue(value: unknown): StripeObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StripeObject)
    : null;
}
