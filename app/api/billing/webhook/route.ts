import {
  abandonStripeEvent,
  beginStripeEvent,
  finishStripeEvent,
  getBillingUserById,
  getBillingUserByStripeCustomer,
  recordOneTimePurchase,
  setStripeCustomerId,
  upsertSubscription,
} from "../../../../lib/billing-store";
import {
  getStripeConfig,
  stripeGet,
  stripePriceForPlan,
  verifyStripeSignature,
} from "../../../../lib/stripe";

type StripeObject = Record<string, unknown>;

type StripeEvent = {
  id: string;
  type: string;
  data: {
    object: StripeObject;
  };
};

export async function POST(request: Request) {
  const { webhookSecret } = getStripeConfig();
  const signature = request.headers.get("stripe-signature");
  if (!webhookSecret || !signature) {
    return Response.json({ error: "Webhook is not configured." }, { status: 400 });
  }

  const rawBody = await request.text();
  if (!(await verifyStripeSignature(rawBody, signature, webhookSecret))) {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return Response.json({ error: "Invalid Stripe payload." }, { status: 400 });
  }
  if (!event.id || !event.type || !event.data?.object) {
    return Response.json({ error: "Invalid Stripe event." }, { status: 400 });
  }

  const shouldProcess = await beginStripeEvent(event.id, event.type);
  if (!shouldProcess) return Response.json({ received: true, duplicate: true });

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await handleCheckoutCompleted(event.data.object);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await handleSubscriptionChanged(event.data.object);
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
  const customerId = objectId(session.customer);
  let userId =
    stringValue(session.client_reference_id) ??
    metadataValue(session, "app_user_id");

  if (!userId && customerId) {
    userId = (await getBillingUserByStripeCustomer(customerId))?.id ?? null;
  }
  if (!userId) throw new Error("Checkout session has no app user.");

  const user = await getBillingUserById(userId);
  if (!user) throw new Error("Checkout user was not found.");
  if (customerId && user.stripeCustomerId !== customerId) {
    await setStripeCustomerId(user.id, customerId);
  }

  const mode = stringValue(session.mode);
  if (mode === "subscription") {
    const subscriptionId = objectId(session.subscription);
    if (subscriptionId) {
      const subscription = await stripeGet<StripeObject>(
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      await saveSubscription(user.id, subscription);
    }
    return;
  }

  const paymentStatus = stringValue(session.payment_status);
  if (mode === "payment" && paymentStatus === "paid" && customerId) {
    await recordOneTimePurchase({
      checkoutSessionId: stringValue(session.id) ?? crypto.randomUUID(),
      userId: user.id,
      stripeCustomerId: customerId,
      stripePaymentIntentId: objectId(session.payment_intent),
      stripePriceId: stripePriceForPlan("one_time"),
    });
  }
}

async function handleSubscriptionChanged(subscription: StripeObject) {
  const customerId = objectId(subscription.customer);
  let userId = metadataValue(subscription, "app_user_id");
  if (!userId && customerId) {
    userId = (await getBillingUserByStripeCustomer(customerId))?.id ?? null;
  }
  if (!userId) throw new Error("Subscription has no app user.");
  await saveSubscription(userId, subscription);
}

async function saveSubscription(userId: string, subscription: StripeObject) {
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

  if (
    !subscriptionId ||
    !customerId ||
    !priceId ||
    !status ||
    !currentPeriodStart ||
    !currentPeriodEnd
  ) {
    throw new Error("Subscription payload is incomplete.");
  }

  await setStripeCustomerId(userId, customerId);
  await upsertSubscription(userId, {
    id: subscriptionId,
    customerId,
    priceId,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  });
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

function recordValue(value: unknown): StripeObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StripeObject)
    : null;
}
