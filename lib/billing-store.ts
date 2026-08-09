import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import {
  billingPurchases,
  billingSubscriptions,
  stripeEvents,
  usageReservations,
  users,
} from "../db/schema";
import {
  type BillingBucket,
  chooseBillingBucket,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  LIGHT_MONTHLY_VIDEO_LIMIT,
  OPERATOR_DAILY_VIDEO_LIMIT,
  startOfTokyoDaySeconds,
} from "./billing-policy";
import type { CurrentUser } from "./current-user";
import {
  acquireUsageOperationLease,
  consumeOperatorUsageOperation,
  getOperatorUsageOperationCounts,
  isObservedDurationBlocked,
  releaseUsageOperationLease,
  releaseOrCompleteUsageReservation,
  settleExpiredUsageReservations,
  TRANSCRIPTION_LEASE_TTL_SECONDS,
  type OperatorUsageOperation,
} from "./operator-usage";

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];
const ACTIVE_USAGE_STATUSES = ["reserved", "completed"] as const;
const RESERVATION_LIFETIME_SECONDS = 60 * 60;

type AtomicD1Result = {
  meta?: { changes?: number };
};

type AtomicD1BoundStatement = {
  run: () => Promise<AtomicD1Result>;
};

type AtomicD1Statement = {
  bind: (...values: unknown[]) => AtomicD1BoundStatement;
};

type AtomicD1Database = {
  prepare: (query: string) => AtomicD1Statement;
};

type QueryD1BoundStatement = AtomicD1BoundStatement & {
  first: <T>() => Promise<T | null>;
};

type QueryD1Database = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => QueryD1BoundStatement;
  };
};

export class UsageLimitError extends Error {
  constructor() {
    super(
      `無料枠を使い切りました。月${LIGHT_MONTHLY_VIDEO_LIMIT}本プランまたは1動画作成を選んでください。`,
    );
    this.name = "UsageLimitError";
  }
}

export class OperatorUsageLimitError extends Error {
  constructor() {
    super(
      `運営端末の1日あたりの安全上限（${OPERATOR_DAILY_VIDEO_LIMIT}本）に達しました。日本時間の午前0時以降にもう一度お試しください。`,
    );
    this.name = "OperatorUsageLimitError";
  }
}

export async function getOrCreateBillingUser(currentUser: CurrentUser) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .select()
    .from(users)
    .where(
      currentUser.id
        ? eq(users.id, currentUser.id)
        : eq(users.email, currentUser.email),
    )
    .limit(1);

  if (existing[0]) {
    const billingEmail = currentUser.billingEmail ?? existing[0].billingEmail;
    await db
      .update(users)
      .set({
        fullName: currentUser.fullName,
        billingEmail,
        updatedAt: now,
      })
      .where(eq(users.id, existing[0].id));
    return {
      ...existing[0],
      fullName: currentUser.fullName,
      billingEmail,
      updatedAt: now,
    };
  }

  const user = {
    id: currentUser.id ?? crypto.randomUUID(),
    email: currentUser.email,
    billingEmail: currentUser.billingEmail,
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

export async function setStripeCustomerIdentity(
  userId: string,
  values: { stripeCustomerId: string; billingEmail?: string | null; fullName?: string | null },
) {
  const update: {
    stripeCustomerId: string;
    updatedAt: number;
    billingEmail?: string | null;
    fullName?: string | null;
  } = {
    stripeCustomerId: values.stripeCustomerId,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  if (values.billingEmail !== undefined) update.billingEmail = values.billingEmail;
  if (values.fullName !== undefined) update.fullName = values.fullName;
  await getDb().update(users).set(update).where(eq(users.id, userId));
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

  await settleExpiredUsageReservations(userId, now);

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
    .where(
      and(
        eq(billingPurchases.userId, userId),
        isNull(billingPurchases.revokedAt),
      ),
    );
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
  const operatorDayStart = startOfTokyoDaySeconds(now);
  const operatorVideosUsedToday = usage.filter(
    (item) =>
      item.bucket === "operator" &&
      item.createdAt >= operatorDayStart,
  ).length;
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
    operatorVideosUsedToday,
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
  options: { operator?: boolean } = {},
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

  const roundedDuration = Math.max(1, Math.ceil(sourceDurationSeconds));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const status = await getBillingStatusForUser(user.id);
    const bucket = chooseBillingBucket(
      {
        ...status,
        operatorActive: options.operator === true,
      },
      roundedDuration,
    );
    if (!bucket) break;

    const now = Math.floor(Date.now() / 1000);
    const reservation: AtomicUsageReservation = {
      id: crypto.randomUUID(),
      userId: user.id,
      idempotencyKey,
      sourceDurationSeconds: roundedDuration,
      bucket,
      status: "reserved",
      createdAt: now,
      expiresAt: now + RESERVATION_LIFETIME_SECONDS,
      completedAt: null,
    };
    if (await insertUsageReservationAtomically(reservation, status)) {
      return reservation;
    }

    const concurrent = await db
      .select()
      .from(usageReservations)
      .where(eq(usageReservations.idempotencyKey, idempotencyKey))
      .limit(1);
    if (concurrent[0]?.userId === user.id) return concurrent[0];
  }

  if (options.operator) throw new OperatorUsageLimitError();
  throw new UsageLimitError();
}

type AtomicUsageReservation = {
  id: string;
  userId: string;
  idempotencyKey: string;
  sourceDurationSeconds: number;
  bucket: BillingBucket;
  status: "reserved";
  createdAt: number;
  expiresAt: number;
  completedAt: null;
};

async function insertUsageReservationAtomically(
  reservation: AtomicUsageReservation,
  status: Awaited<ReturnType<typeof getBillingStatusForUser>>,
) {
  const database = env.DB as unknown as AtomicD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }

  const values = [
    reservation.id,
    reservation.userId,
    reservation.idempotencyKey,
    reservation.sourceDurationSeconds,
    reservation.createdAt,
    reservation.expiresAt,
  ] as const;
  let statement: AtomicD1BoundStatement;

  if (reservation.bucket === "operator") {
    statement = database
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds,
          bucket, status, created_at, expires_at, completed_at
        )
        SELECT ?, ?, ?, ?, 'operator', 'reserved', ?, ?, NULL
        WHERE (
          SELECT COUNT(*)
          FROM usage_reservations
          WHERE user_id = ?
            AND bucket = 'operator'
            AND status IN ('reserved', 'completed')
            AND created_at >= ?
        ) < ?
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .bind(
        ...values,
        reservation.userId,
        startOfTokyoDaySeconds(reservation.createdAt),
        OPERATOR_DAILY_VIDEO_LIMIT,
      );
  } else if (reservation.bucket === "subscription" && status.subscription) {
    statement = database
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds,
          bucket, status, created_at, expires_at, completed_at
        )
        SELECT ?, ?, ?, ?, 'subscription', 'reserved', ?, ?, NULL
        WHERE EXISTS (
          SELECT 1
          FROM billing_subscriptions
          WHERE id = ?
            AND user_id = ?
            AND status IN ('active', 'trialing')
            AND current_period_end > ?
        )
        AND (
          SELECT COUNT(*)
          FROM usage_reservations
          WHERE user_id = ?
            AND bucket = 'subscription'
            AND status IN ('reserved', 'completed')
            AND created_at >= ?
            AND created_at < ?
        ) < ?
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .bind(
        ...values,
        status.subscription.id,
        reservation.userId,
        reservation.createdAt,
        reservation.userId,
        status.subscription.currentPeriodStart,
        status.subscription.currentPeriodEnd,
        LIGHT_MONTHLY_VIDEO_LIMIT,
      );
  } else if (reservation.bucket === "one_time") {
    statement = database
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds,
          bucket, status, created_at, expires_at, completed_at
        )
        SELECT ?, ?, ?, ?, 'one_time', 'reserved', ?, ?, NULL
        WHERE (
          SELECT COALESCE(SUM(credits), 0)
          FROM billing_purchases
          WHERE user_id = ?
            AND revoked_at IS NULL
        ) > (
          SELECT COUNT(*)
          FROM usage_reservations
          WHERE user_id = ?
            AND bucket = 'one_time'
            AND status IN ('reserved', 'completed')
        )
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .bind(...values, reservation.userId, reservation.userId);
  } else {
    statement = database
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds,
          bucket, status, created_at, expires_at, completed_at
        )
        SELECT ?, ?, ?, ?, 'free', 'reserved', ?, ?, NULL
        WHERE (
          SELECT COUNT(*)
          FROM usage_reservations
          WHERE user_id = ?
            AND bucket = 'free'
            AND status IN ('reserved', 'completed')
        ) < ?
        AND COALESCE((
          SELECT SUM(source_duration_seconds)
          FROM usage_reservations
          WHERE user_id = ?
            AND bucket = 'free'
            AND status IN ('reserved', 'completed')
        ), 0) + ? <= ?
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .bind(
        ...values,
        reservation.userId,
        FREE_VIDEO_LIMIT,
        reservation.userId,
        reservation.sourceDurationSeconds,
        FREE_SECONDS_LIMIT,
      );
  }

  const result = await statement.run();
  return result.meta?.changes === 1;
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
  if (
    reservation.bucket === "one_time" &&
    !(await oneTimeReservationHasActiveCredit(reservation))
  ) {
    return null;
  }
  return reservation;
}

async function oneTimeReservationHasActiveCredit(reservation: {
  id: string;
  userId: string;
  createdAt: number;
}) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  const result = await database
    .prepare(`
      SELECT (
        SELECT COALESCE(SUM(credits), 0)
        FROM billing_purchases
        WHERE user_id = ?
          AND revoked_at IS NULL
      ) >= (
        SELECT COUNT(*)
        FROM usage_reservations
        WHERE user_id = ?
          AND bucket = 'one_time'
          AND status IN ('reserved', 'completed')
          AND (
            created_at < ?
            OR (created_at = ? AND id <= ?)
          )
      ) AS allowed
    `)
    .bind(
      reservation.userId,
      reservation.userId,
      reservation.createdAt,
      reservation.createdAt,
      reservation.id,
    )
    .first<{ allowed: number }>();
  return result?.allowed === 1;
}

export async function authorizeUsageOperation(
  currentUser: CurrentUser,
  reservationId: string,
  operation: OperatorUsageOperation,
) {
  const reservation = await findOwnedUsageReservation(
    currentUser,
    reservationId,
  );
  if (!reservation) {
    return {
      allowed: false,
      reason: "reservation_not_found",
      reservation: null,
    } as const;
  }
  if (await isObservedDurationBlocked(reservation.id)) {
    return {
      allowed: false,
      reason: "observed_duration_exceeded",
      reservation,
    } as const;
  }
  const allowed = await consumeOperatorUsageOperation(
    reservation.id,
    operation,
  );
  return allowed
    ? {
        allowed: true,
        reason: null,
        reservation,
      } as const
    : {
        allowed: false,
        reason: "operator_operation_limit",
        reservation,
      } as const;
}

/**
 * Authorizes an expensive operation only after obtaining its D1 lease. This
 * order means a parallel request rejected as busy does not consume the
 * reservation's operation count and cannot reach the upstream API.
 */
export async function authorizeLeasedUsageOperation(
  currentUser: CurrentUser,
  reservationId: string,
  operation: OperatorUsageOperation,
  options: { successfulLimit?: number } = {},
) {
  const reservation = await findOwnedUsageReservation(
    currentUser,
    reservationId,
  );
  if (!reservation) {
    return {
      allowed: false,
      reason: "reservation_not_found",
      reservation: null,
      lease: null,
    } as const;
  }
  if (await isObservedDurationBlocked(reservation.id)) {
    return {
      allowed: false,
      reason: "observed_duration_exceeded",
      reservation,
      lease: null,
    } as const;
  }

  const lease = await acquireUsageOperationLease(
    reservation.id,
    operation,
    TRANSCRIPTION_LEASE_TTL_SECONDS,
  );
  if (!lease) {
    return {
      allowed: false,
      reason: "operation_in_progress",
      reservation,
      lease: null,
    } as const;
  }

  try {
    // Recheck after acquiring the lease in case a previous invocation blocked
    // the duration immediately before its lease expired.
    if (await isObservedDurationBlocked(reservation.id)) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "observed_duration_exceeded",
        reservation,
        lease: null,
      } as const;
    }
    const successfulLimit =
      Number.isFinite(options.successfulLimit) &&
      Number(options.successfulLimit) > 0
        ? Math.floor(Number(options.successfulLimit))
        : null;
    const operationCounts = successfulLimit
      ? await getOperatorUsageOperationCounts(reservation.id, operation)
      : { count: 0, successfulCount: 0 };
    if (
      successfulLimit &&
      operationCounts.successfulCount >= successfulLimit
    ) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "operator_success_limit",
        reservation,
        lease: null,
        successfulCount: operationCounts.successfulCount,
      } as const;
    }
    const allowed = await consumeOperatorUsageOperation(
      reservation.id,
      operation,
    );
    if (!allowed) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "operator_operation_limit",
        reservation,
        lease: null,
      } as const;
    }
    return {
      allowed: true,
      reason: null,
      reservation,
      lease,
      successfulCount: operationCounts.successfulCount,
    } as const;
  } catch (error) {
    await releaseUsageOperationLease(lease).catch(() => undefined);
    throw error;
  }
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
  // A release response can be lost after the database update. Treat an
  // already-released reservation as success so the browser can safely retry
  // without leaving its editor locked or reusing a dead reservation.
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
  if (!reservation) return false;
  if (reservation.status === "released") return true;
  if (
    reservation.status !== "reserved" ||
    reservation.expiresAt < Math.floor(Date.now() / 1000)
  ) {
    return false;
  }

  return Boolean(
    await releaseOrCompleteUsageReservation(
      reservation.id,
      reservation.userId,
    ),
  );
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

const PURCHASE_STATE_SYNC_LEASE_SECONDS = 5 * 60;

export type PurchaseStateSyncClaim = {
  purchaseId: string;
  userId: string;
  paymentIntentId: string;
  leaseStartedAt: number;
  revokedAt: number | null;
};

/**
 * Serializes Stripe reconciliation per PaymentIntent. Stripe can deliver
 * different events for the same refund concurrently and does not guarantee
 * their order, so only the current lease owner may publish a state snapshot.
 */
export async function beginPurchaseStateSync(
  paymentIntentId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const db = getDb();
  const claimed = await db
    .update(billingPurchases)
    .set({ stripeStateSyncStartedAt: nowSeconds })
    .where(
      and(
        eq(billingPurchases.stripePaymentIntentId, paymentIntentId),
        or(
          isNull(billingPurchases.stripeStateSyncStartedAt),
          lt(
            billingPurchases.stripeStateSyncStartedAt,
            nowSeconds - PURCHASE_STATE_SYNC_LEASE_SECONDS,
          ),
        ),
      ),
    )
    .returning({
      purchaseId: billingPurchases.id,
      userId: billingPurchases.userId,
      revokedAt: billingPurchases.revokedAt,
    });
  if (claimed[0]) {
    return {
      ...claimed[0],
      paymentIntentId,
      leaseStartedAt: nowSeconds,
    } satisfies PurchaseStateSyncClaim;
  }

  const existing = await db
    .select({ id: billingPurchases.id })
    .from(billingPurchases)
    .where(eq(billingPurchases.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  return existing[0] ? ("busy" as const) : ("missing" as const);
}

export async function finishPurchaseStateSync(
  claim: PurchaseStateSyncClaim,
  state: {
    refundBlockingAmount: number;
    disputeState: string | null;
    blocked: boolean;
  },
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const updated = await getDb()
    .update(billingPurchases)
    .set({
      refundBlockingAmount: state.refundBlockingAmount,
      disputeState: state.disputeState,
      revokedAt: state.blocked ? (claim.revokedAt ?? nowSeconds) : null,
      stripeStateSyncedAt: nowSeconds,
      stripeStateSyncStartedAt: null,
    })
    .where(
      and(
        eq(billingPurchases.id, claim.purchaseId),
        eq(billingPurchases.stripePaymentIntentId, claim.paymentIntentId),
        eq(
          billingPurchases.stripeStateSyncStartedAt,
          claim.leaseStartedAt,
        ),
      ),
    )
    .returning({ id: billingPurchases.id });
  if (!updated[0]) {
    throw new Error("Stripe purchase-state lease was lost.");
  }
  if (state.blocked) {
    await releaseExcessOneTimeReservations(claim.userId);
  }
}

export async function abandonPurchaseStateSync(claim: PurchaseStateSyncClaim) {
  await getDb()
    .update(billingPurchases)
    .set({ stripeStateSyncStartedAt: null })
    .where(
      and(
        eq(billingPurchases.id, claim.purchaseId),
        eq(
          billingPurchases.stripeStateSyncStartedAt,
          claim.leaseStartedAt,
        ),
      ),
    );
}

async function releaseExcessOneTimeReservations(userId: string) {
  const db = getDb();
  const [activePurchases, activeUsage] = await Promise.all([
    db
      .select({ credits: billingPurchases.credits })
      .from(billingPurchases)
      .where(
        and(
          eq(billingPurchases.userId, userId),
          isNull(billingPurchases.revokedAt),
        ),
      ),
    db
      .select({
        id: usageReservations.id,
        status: usageReservations.status,
      })
      .from(usageReservations)
      .where(
        and(
          eq(usageReservations.userId, userId),
          eq(usageReservations.bucket, "one_time"),
          inArray(usageReservations.status, [...ACTIVE_USAGE_STATUSES]),
        ),
      )
      .orderBy(desc(usageReservations.createdAt)),
  ]);
  const activeCredits = activePurchases.reduce(
    (total, purchase) => total + purchase.credits,
    0,
  );
  let releasesNeeded = Math.max(0, activeUsage.length - activeCredits);
  if (releasesNeeded === 0) return;

  // Stop the newest in-progress reservations first. Work that already
  // produced a usable upstream result is completed instead of refunded, and
  // the per-operation credit check above prevents that overage reservation
  // from continuing while the Stripe payment remains revoked.
  for (const reservation of activeUsage) {
    if (releasesNeeded === 0) break;
    if (reservation.status !== "reserved") continue;
    await releaseOrCompleteUsageReservation(reservation.id, userId);
    releasesNeeded -= 1;
  }
}

export async function beginStripeEvent(eventId: string, eventType: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db
    .insert(stripeEvents)
    .values({
      id: eventId,
      type: eventType,
      createdAt: now,
      processedAt: null,
    })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  if (inserted.length === 1) return "claimed" as const;

  const existing = await db
    .select({
      type: stripeEvents.type,
      createdAt: stripeEvents.createdAt,
      processedAt: stripeEvents.processedAt,
    })
    .from(stripeEvents)
    .where(eq(stripeEvents.id, eventId))
    .limit(1);
  if (existing[0]?.processedAt) return "processed" as const;
  if (!existing[0] || existing[0].type !== eventType) return "busy" as const;

  // Reclaim a Worker invocation that terminated after claiming the event but
  // before recording completion. The conditional update keeps the claim
  // exclusive even when Stripe sends concurrent retries.
  const reclaimed = await db
    .update(stripeEvents)
    .set({ createdAt: now })
    .where(
      and(
        eq(stripeEvents.id, eventId),
        isNull(stripeEvents.processedAt),
        lt(stripeEvents.createdAt, now - 5 * 60),
      ),
    )
    .returning({ id: stripeEvents.id });
  return reclaimed.length === 1 ? ("claimed" as const) : ("busy" as const);
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
