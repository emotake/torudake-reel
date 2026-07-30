import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "../db";
import {
  billingPurchases,
  billingSubscriptions,
  stripeEvents,
  usageReservations,
  users,
} from "../db/schema";
import {
  chooseBillingBucket,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  LIGHT_MONTHLY_VIDEO_LIMIT,
} from "./billing-policy";
import type { CurrentUser } from "./current-user";

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];
const ACTIVE_USAGE_STATUSES = ["reserved", "completed"] as const;
const RESERVATION_LIFETIME_SECONDS = 60 * 60;

export class UsageLimitError extends Error {
  constructor() {
    super(
      `無料枠を使い切りました。月${LIGHT_MONTHLY_VIDEO_LIMIT}本プランまたは1本購入を選んでください。`,
    );
    this.name = "UsageLimitError";
  }
}

export async function getOrCreateBillingUser(currentUser: CurrentUser) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, currentUser.email))
    .limit(1);

  if (existing[0]) {
    await db
      .update(users)
      .set({
        fullName: currentUser.fullName,
        updatedAt: now,
      })
      .where(eq(users.id, existing[0].id));
    return { ...existing[0], fullName: currentUser.fullName, updatedAt: now };
  }

  const user = {
    id: crypto.randomUUID(),
    email: currentUser.email,
    fullName: currentUser.fullName,
    stripeCustomerId: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(users).values(user);
  return user;
}

export async function getBillingUserById(userId: string) {
  const rows = await getDb()
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function setStripeCustomerId(
  userId: string,
  stripeCustomerId: string,
) {
  await getDb()
    .update(users)
    .set({
      stripeCustomerId,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(users.id, userId));
}

export async function getBillingUserByStripeCustomer(
  stripeCustomerId: string,
) {
  const rows = await getDb()
    .select()
    .from(users)
    .where(eq(users.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getBillingStatusForUser(userId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  await db
    .update(usageReservations)
    .set({ status: "released" })
    .where(
      and(
        eq(usageReservations.userId, userId),
        eq(usageReservations.status, "reserved"),
        lt(usageReservations.expiresAt, now),
      ),
    );

  const subscriptions = await db
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId))
    .orderBy(desc(billingSubscriptions.updatedAt));
  const subscription =
    subscriptions.find(
      (item) =>
        ACTIVE_SUBSCRIPTION_STATUSES.includes(item.status) &&
        item.currentPeriodEnd > now,
    ) ?? null;

  const purchases = await db
    .select()
    .from(billingPurchases)
    .where(eq(billingPurchases.userId, userId));
  const usage = await db
    .select()
    .from(usageReservations)
    .where(
      and(
        eq(usageReservations.userId, userId),
        inArray(usageReservations.status, [...ACTIVE_USAGE_STATUSES]),
      ),
    );

  const freeUsage = usage.filter((item) => item.bucket === "free");
  const oneTimeUsage = usage.filter((item) => item.bucket === "one_time");
  const monthlyUsage = subscription
    ? usage.filter(
        (item) =>
          item.bucket === "subscription" &&
          item.createdAt >= subscription.currentPeriodStart &&
          item.createdAt < subscription.currentPeriodEnd,
      )
    : [];
  const purchasedCredits = purchases.reduce(
    (total, purchase) => total + purchase.credits,
    0,
  );

  return {
    subscription,
    freeVideosUsed: freeUsage.length,
    freeSecondsUsed: freeUsage.reduce(
      (total, item) => total + item.sourceDurationSeconds,
      0,
    ),
    monthlyVideosUsed: monthlyUsage.length,
    monthlyPlanActive: Boolean(subscription),
    oneTimeCreditsRemaining: Math.max(
      0,
      purchasedCredits - oneTimeUsage.length,
    ),
  };
}

export async function reserveUsage(
  currentUser: CurrentUser,
  sourceDurationSeconds: number,
  idempotencyKey: string,
) {
  const db = getDb();
  const user = await getOrCreateBillingUser(currentUser);
  const existing = await db
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing[0] && existing[0].userId === user.id) {
    return existing[0];
  }

  const status = await getBillingStatusForUser(user.id);
  const roundedDuration = Math.max(1, Math.ceil(sourceDurationSeconds));
  const bucket = chooseBillingBucket(status, roundedDuration);
  if (!bucket) throw new UsageLimitError();

  const now = Math.floor(Date.now() / 1000);
  const reservation = {
    id: crypto.randomUUID(),
    userId: user.id,
    idempotencyKey,
    sourceDurationSeconds: roundedDuration,
    bucket,
    status: "reserved" as const,
    createdAt: now,
    expiresAt: now + RESERVATION_LIFETIME_SECONDS,
    completedAt: null,
  };
  await db.insert(usageReservations).values(reservation);
  return reservation;
}

export async function findOwnedUsageReservation(
  currentUser: CurrentUser,
  reservationId: string,
) {
  const user = await getOrCreateBillingUser(currentUser);
  const rows = await getDb()
    .select()
    .from(usageReservations)
    .where(
      and(
        eq(usageReservations.id, reservationId),
        eq(usageReservations.userId, user.id),
      ),
    )
    .limit(1);
  const reservation = rows[0];
  if (!reservation || reservation.status === "released") return null;
  if (reservation.expiresAt < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return reservation;
}

export async function completeUsage(
  currentUser: CurrentUser,
  reservationId: string,
) {
  const reservation = await findOwnedUsageReservation(
    currentUser,
    reservationId,
  );
  if (!reservation) return false;
  if (reservation.status === "completed") return true;

  await getDb()
    .update(usageReservations)
    .set({
      status: "completed",
      completedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(usageReservations.id, reservation.id));
  return true;
}

export async function releaseUsage(
  currentUser: CurrentUser,
  reservationId: string,
) {
  const reservation = await findOwnedUsageReservation(
    currentUser,
    reservationId,
  );
  if (!reservation || reservation.status !== "reserved") return false;

  await getDb()
    .update(usageReservations)
    .set({ status: "released" })
    .where(eq(usageReservations.id, reservation.id));
  return true;
}

type StripeSubscriptionRecord = {
  id: string;
  customerId: string;
  priceId: string;
  status: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
};

export async function upsertSubscription(
  userId: string,
  subscription: StripeSubscriptionRecord,
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(billingSubscriptions)
    .values({
      id: subscription.id,
      userId,
      stripeCustomerId: subscription.customerId,
      stripePriceId: subscription.priceId,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: billingSubscriptions.id,
      set: {
        userId,
        stripeCustomerId: subscription.customerId,
        stripePriceId: subscription.priceId,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        updatedAt: now,
      },
    });
}

export async function recordOneTimePurchase(values: {
  checkoutSessionId: string;
  userId: string;
  stripeCustomerId: string;
  stripePaymentIntentId: string | null;
  stripePriceId: string;
}) {
  await getDb()
    .insert(billingPurchases)
    .values({
      id: values.checkoutSessionId,
      userId: values.userId,
      stripeCustomerId: values.stripeCustomerId,
      stripePaymentIntentId: values.stripePaymentIntentId,
      stripePriceId: values.stripePriceId,
      credits: 1,
      purchasedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoNothing();
}

export async function beginStripeEvent(eventId: string, eventType: string) {
  const db = getDb();
  const existing = await db
    .select()
    .from(stripeEvents)
    .where(eq(stripeEvents.id, eventId))
    .limit(1);
  if (existing[0]?.processedAt) return false;

  await db
    .insert(stripeEvents)
    .values({
      id: eventId,
      type: eventType,
      createdAt: Math.floor(Date.now() / 1000),
      processedAt: null,
    })
    .onConflictDoNothing();
  return true;
}

export async function finishStripeEvent(eventId: string) {
  await getDb()
    .update(stripeEvents)
    .set({ processedAt: Math.floor(Date.now() / 1000) })
    .where(eq(stripeEvents.id, eventId));
}

export async function abandonStripeEvent(eventId: string) {
  await getDb().delete(stripeEvents).where(eq(stripeEvents.id, eventId));
}

export function publicBillingStatus(
  status: Awaited<ReturnType<typeof getBillingStatusForUser>>,
) {
  return {
    plan: status.monthlyPlanActive ? "light" : "free",
    free: {
      videosUsed: status.freeVideosUsed,
      videoLimit: FREE_VIDEO_LIMIT,
      secondsUsed: status.freeSecondsUsed,
      secondsLimit: FREE_SECONDS_LIMIT,
    },
    monthly: {
      active: status.monthlyPlanActive,
      videosUsed: status.monthlyVideosUsed,
      videoLimit: LIGHT_MONTHLY_VIDEO_LIMIT,
      renewsAt: status.subscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: status.subscription?.cancelAtPeriodEnd ?? false,
    },
    oneTimeCredits: status.oneTimeCreditsRemaining,
  };
}
