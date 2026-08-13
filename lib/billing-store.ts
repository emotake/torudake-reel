import { and, desc, eq, gt, gte, inArray, isNull, lt, or } from "drizzle-orm";
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
  FREE_AI_OPERATION_SUCCESS_LIMIT,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  getAiOperationSuccessLimit,
  isMonthlyPlanKey,
  monthlyPlanVideoLimit,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  type MonthlyPlanKey,
  OPERATOR_AI_OPERATION_SUCCESS_LIMIT,
  OPERATOR_DAILY_VIDEO_LIMIT,
  startOfTokyoDaySeconds,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
} from "./billing-policy";
import type { CurrentUser } from "./current-user";
import {
  acquireUsageOperationLease,
  continueMeteredAiAction,
  consumeOperatorUsageOperation,
  createMeteredAiAction,
  getMeteredAiAction,
  getMeteredAiActionByOperation,
  getMeteredAiEntitlementUsage,
  getMeteredAiUsageCounts,
  getOperatorUsageOperationCounts,
  isValidMeteredAiActionId,
  isObservedDurationBlocked,
  markMeteredAiActionFailed,
  markMeteredAiActionSucceeded,
  METERED_AI_LEASE_SCOPE,
  releaseUsageOperationLease,
  settleExpiredUsageReservations,
  TRANSCRIPTION_LEASE_TTL_SECONDS,
  type MeteredAiAction,
  type MeteredAiEntitlementScope,
  type MeteredAiOperation,
  type OperatorUsageOperation,
  type UsageOperationLease,
} from "./operator-usage";

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];
const ACTIVE_USAGE_STATUSES = ["reserved", "completed"] as const;
export const USAGE_RESERVATION_LIFETIME_SECONDS = 60 * 60;
// A release beacon can overtake the corresponding reserve request. Keep its
// idempotency tombstone well beyond every Worker/request retry window, while
// still allowing indexed garbage collection.
export const USAGE_RELEASE_INTENT_TTL_SECONDS = 24 * 60 * 60;
// Checkout sessions are explicitly limited to 30 minutes. Keep the database
// lock one minute longer so an expiry webhook and a late browser retry cannot
// overlap a still-completable Stripe session.
const MONTHLY_CHECKOUT_LOCK_SECONDS = 32 * 60;
const SUBSCRIPTION_SYNC_LEASE_SECONDS = 2 * 60;

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
  batch?: (
    statements: AtomicD1BoundStatement[],
  ) => Promise<AtomicD1Result[]>;
};

type QueryD1BoundStatement = AtomicD1BoundStatement & {
  first: <T>() => Promise<T | null>;
};

type QueryD1Database = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => QueryD1BoundStatement;
  };
  batch?: (
    statements: QueryD1BoundStatement[],
  ) => Promise<AtomicD1Result[]>;
};

export class UsageLimitError extends Error {
  constructor() {
    super(
      "無料枠を使い切りました。月3本・月7本プラン、または動画1本プランを選んでください。",
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

export async function getBillingStatusForUser(
  userId: string,
  now = Math.floor(Date.now() / 1000),
) {
  const db = getDb();

  await settleExpiredUsageReservations(userId, now);

  const subscriptions = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.userId, userId),
        inArray(billingSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
        gt(billingSubscriptions.currentPeriodEnd, now),
      ),
    )
    .orderBy(desc(billingSubscriptions.updatedAt))
    .limit(1);
  const currentSubscription = subscriptions[0] ?? null;
  const subscription =
    currentSubscription?.revokedPeriodStart ===
    currentSubscription?.currentPeriodStart
      ? null
      : currentSubscription;
  const operatorDayStart = startOfTokyoDaySeconds(now);
  const monthlyVideoLimit = currentSubscription
    ? monthlyPlanVideoLimit(currentSubscription.planKey)
    : 0;
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Billing database binding is unavailable.");
  }
  const [usageTotals, purchaseTotals] = await Promise.all([
    database
      .prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN bucket = 'free' THEN 1 ELSE 0 END), 0)
            AS free_videos_used,
          COALESCE(SUM(CASE
            WHEN bucket = 'free' THEN source_duration_seconds
            ELSE 0
          END), 0) AS free_seconds_used,
          COALESCE(SUM(CASE
            WHEN bucket = 'operator' AND created_at >= ? THEN 1
            ELSE 0
          END), 0) AS operator_videos_used_today,
          COALESCE(SUM(CASE
            WHEN bucket = 'subscription'
              AND created_at >= ?
              AND created_at < ?
            THEN 1
            ELSE 0
          END), 0) AS monthly_videos_used,
          COALESCE(SUM(CASE
            WHEN bucket = 'one_time'
              AND (
                billing_purchase_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM billing_purchases AS active_purchase
                  WHERE active_purchase.id = usage_reservations.billing_purchase_id
                    AND active_purchase.user_id = usage_reservations.user_id
                    AND active_purchase.revoked_at IS NULL
                )
              )
            THEN 1
            ELSE 0
          END), 0) AS one_time_videos_used
        FROM usage_reservations
        WHERE user_id = ?
          AND status IN ('reserved', 'completed')
      `)
      .bind(
        operatorDayStart,
        currentSubscription?.currentPeriodStart ?? 0,
        currentSubscription?.currentPeriodEnd ?? 0,
        userId,
      )
      .first<{
        free_videos_used: number;
        free_seconds_used: number;
        operator_videos_used_today: number;
        monthly_videos_used: number;
        one_time_videos_used: number;
      }>(),
    database
      .prepare(`
        SELECT COALESCE(SUM(credits), 0) AS purchased_credits
        FROM billing_purchases
        WHERE user_id = ?
          AND revoked_at IS NULL
      `)
      .bind(userId)
      .first<{ purchased_credits: number }>(),
  ]);

  const freeVideosUsed = Math.max(0, usageTotals?.free_videos_used ?? 0);
  const freeSecondsUsed = Math.max(0, usageTotals?.free_seconds_used ?? 0);
  const operatorVideosUsedToday = Math.max(
    0,
    usageTotals?.operator_videos_used_today ?? 0,
  );
  const monthlyVideosUsed = Math.max(
    0,
    usageTotals?.monthly_videos_used ?? 0,
  );
  const oneTimeVideosUsed = Math.max(
    0,
    usageTotals?.one_time_videos_used ?? 0,
  );
  const purchasedCredits = Math.max(
    0,
    purchaseTotals?.purchased_credits ?? 0,
  );

  return {
    subscription,
    currentSubscription,
    freeVideosUsed,
    freeSecondsUsed,
    monthlyVideosUsed,
    monthlyPlanActive: Boolean(subscription),
    monthlySubscriptionActive: Boolean(currentSubscription),
    monthlyAccessRevoked: Boolean(currentSubscription) && !subscription,
    monthlyPlanKey: currentSubscription?.planKey ?? null,
    monthlyVideoLimit,
    operatorVideosUsedToday,
    oneTimeCreditsRemaining: Math.max(
      0,
      purchasedCredits - oneTimeVideosUsed,
    ),
  };
}

export class AccountDeletionProcessingError extends Error {
  readonly code = "account_deletion_processing";

  constructor() {
    super(
      "アカウントの削除処理を確認中のため、新しい動画処理を開始できません。",
    );
    this.name = "AccountDeletionProcessingError";
  }
}

export class UsageReservationConflictError extends Error {
  readonly code:
    | "idempotency_key_owned_by_another_user"
    | "idempotency_payload_mismatch";

  constructor(code: UsageReservationConflictError["code"]) {
    super("The usage reservation cannot be reused for this request.");
    this.name = "UsageReservationConflictError";
    this.code = code;
  }
}

export class UsageReservationBusyError extends Error {
  constructor() {
    super("The usage reservation is waiting for an active operation to finish.");
    this.name = "UsageReservationBusyError";
  }
}

export type UsageReservationApiStatus =
  | "reserved"
  | "release_pending"
  | "expired"
  | "completed"
  | "released";

export type UsageReservationOutcome =
  | "created"
  | "existing"
  | "renewed"
  | "reactivated";

export type MonthlyCheckoutLock = {
  userId: string;
  lockToken: string;
  requestId: string;
  planKey: "starter" | "standard";
  expiresAt: number;
};

export type SubscriptionSyncLease = {
  subscriptionId: string;
  token: string;
  expiresAt: number;
};

/**
 * Serializes every Stripe refresh for one subscription. The lease covers the
 * remote read and the following D1 write, preventing a slower stale refresh
 * from committing after a newer cancellation or payment-failure refresh.
 */
export async function acquireSubscriptionSyncLease(
  subscriptionId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  if (!/^[A-Za-z0-9_-]{5,255}$/.test(subscriptionId)) {
    throw new Error("Stripe subscription ID is invalid.");
  }
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Billing database binding is unavailable.");
  }
  const token = crypto.randomUUID();
  const expiresAt = nowSeconds + SUBSCRIPTION_SYNC_LEASE_SECONDS;
  const row = await database
    .prepare(`
      INSERT INTO billing_subscription_sync_leases (
        subscription_id, lease_token, acquired_at, expires_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(subscription_id) DO UPDATE SET
        lease_token = excluded.lease_token,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE billing_subscription_sync_leases.expires_at <= ?
      RETURNING lease_token, expires_at
    `)
    .bind(subscriptionId, token, nowSeconds, expiresAt, nowSeconds)
    .first<{ lease_token: string; expires_at: number }>();
  if (!row || row.lease_token !== token) return null;
  return {
    subscriptionId,
    token,
    expiresAt: row.expires_at,
  } satisfies SubscriptionSyncLease;
}

export async function releaseSubscriptionSyncLease(
  lease: SubscriptionSyncLease,
) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Billing database binding is unavailable.");
  }
  const released = await database
    .prepare(`
      DELETE FROM billing_subscription_sync_leases
      WHERE subscription_id = ? AND lease_token = ?
    `)
    .bind(lease.subscriptionId, lease.token)
    .run();
  return released.meta?.changes === 1;
}

/**
 * Serializes monthly Checkout creation for one account. The database-level
 * primary key is the final guard against double clicks, parallel browser tabs,
 * and two Worker invocations racing before a Stripe webhook arrives.
 */
export async function acquireMonthlyCheckoutLock(
  userId: string,
  requestId: string,
  planKey: "starter" | "standard",
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const database = env.DB as unknown as AtomicD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Billing database binding is unavailable.");
  }
  await database
    .prepare(`
      DELETE FROM billing_checkout_locks
      WHERE user_id = ? AND expires_at <= ?
    `)
    .bind(userId, nowSeconds)
    .run();

  const lock: MonthlyCheckoutLock = {
    userId,
    lockToken: crypto.randomUUID(),
    requestId,
    planKey,
    expiresAt: nowSeconds + MONTHLY_CHECKOUT_LOCK_SECONDS,
  };
  const inserted = await database
    .prepare(`
      INSERT INTO billing_checkout_locks (
        user_id, lock_token, request_id, plan_key, created_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM billing_subscriptions
        WHERE user_id = ?
          AND status IN ('active', 'trialing')
          AND current_period_end > ?
          AND (
            revoked_period_start IS NULL
            OR revoked_period_start != current_period_start
          )
      )
      ON CONFLICT(user_id) DO NOTHING
    `)
    .bind(
      lock.userId,
      lock.lockToken,
      lock.requestId,
      lock.planKey,
      nowSeconds,
      lock.expiresAt,
      lock.userId,
      nowSeconds,
    )
    .run();
  return inserted.meta?.changes === 1 ? lock : null;
}

export async function releaseMonthlyCheckoutLock(
  values: { userId: string; lockToken?: string | null },
) {
  const database = env.DB as unknown as AtomicD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Billing database binding is unavailable.");
  }
  const released = values.lockToken
    ? await database
        .prepare(`
          DELETE FROM billing_checkout_locks
          WHERE user_id = ? AND lock_token = ?
        `)
        .bind(values.userId, values.lockToken)
        .run()
    : await database
        .prepare("DELETE FROM billing_checkout_locks WHERE user_id = ?")
        .bind(values.userId)
        .run();
  return released.meta?.changes === 1;
}

type UsageReservationRecord = typeof usageReservations.$inferSelect;

export type UsageReservationWithOutcome = UsageReservationRecord & {
  reservationOutcome: UsageReservationOutcome;
};

export type UsageReservationSelector = {
  reservationId?: string | null;
  idempotencyKey?: string | null;
};

function withUsageReservationOutcome(
  reservation: UsageReservationRecord,
  reservationOutcome: UsageReservationOutcome,
): UsageReservationWithOutcome {
  return { ...reservation, reservationOutcome };
}

export function publicUsageReservationState(
  reservation: UsageReservationRecord,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const releasePending =
    reservation.status === "reserved" &&
    reservation.releaseRequestedAt !== null;
  const expired =
    reservation.status === "reserved" && reservation.expiresAt < nowSeconds;
  const status: UsageReservationApiStatus = releasePending
    ? "release_pending"
    : expired
      ? "expired"
      : reservation.status;
  return {
    reservationId: reservation.id,
    idempotencyKey: reservation.idempotencyKey,
    status,
    expiresAt: reservation.expiresAt,
    ttlSeconds: Math.max(0, reservation.expiresAt - nowSeconds),
    releasePending,
    renewable:
      status === "reserved" ||
      status === "release_pending" ||
      status === "expired" ||
      status === "released",
  } as const;
}

async function findUsageReservationForUser(
  userId: string,
  selector: UsageReservationSelector,
) {
  const selectorPredicate =
    selector.reservationId && selector.idempotencyKey
      ? and(
          eq(usageReservations.id, selector.reservationId),
          eq(usageReservations.idempotencyKey, selector.idempotencyKey),
        )
      : selector.reservationId
        ? eq(usageReservations.id, selector.reservationId)
        : selector.idempotencyKey
          ? eq(usageReservations.idempotencyKey, selector.idempotencyKey)
          : null;
  if (!selectorPredicate) return null;
  const rows = await getDb()
    .select()
    .from(usageReservations)
    .where(and(eq(usageReservations.userId, userId), selectorPredicate))
    .limit(1);
  return rows[0] ?? null;
}

export async function getUsageReservationState(
  currentUser: CurrentUser,
  selector: UsageReservationSelector,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const user = await getOrCreateBillingUser(currentUser);
  await settleExpiredUsageReservations(user.id, nowSeconds);
  const reservation = await findUsageReservationForUser(user.id, selector);
  return reservation
    ? {
        reservation,
        ...publicUsageReservationState(reservation, nowSeconds),
      }
    : null;
}

async function materializeReleasedUsageReservation(
  userId: string,
  idempotencyKey: string,
  sourceDurationSeconds: number,
  options: { operator?: boolean },
  nowSeconds: number,
) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  const reservationId = crypto.randomUUID();
  const bucket: BillingBucket = options.operator ? "operator" : "free";
  const inserted = await database
    .prepare(`
      INSERT INTO usage_reservations (
        id, user_id, idempotency_key, source_duration_seconds,
        bucket, status, created_at, expires_at, completed_at,
        release_requested_at, billing_purchase_id
      )
      SELECT ?, ?, ?, ?, ?, 'released', ?, ?, NULL, intent.requested_at, NULL
      FROM usage_release_intents AS intent
      WHERE intent.user_id = ?
        AND intent.idempotency_key = ?
        AND intent.expires_at >= ?
      ON CONFLICT(idempotency_key) DO NOTHING
    `)
    .bind(
      reservationId,
      userId,
      idempotencyKey,
      sourceDurationSeconds,
      bucket,
      nowSeconds,
      nowSeconds - 1,
      userId,
      idempotencyKey,
      nowSeconds,
    )
    .run();
  if (inserted.meta?.changes !== 1) return null;
  return findUsageReservationForUser(userId, { reservationId });
}

async function reconcileUsageReleaseIntent(
  userId: string,
  idempotencyKey: string,
  nowSeconds: number,
) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  return database
    .prepare(`
      UPDATE usage_reservations
      SET release_requested_at = COALESCE(
            release_requested_at,
            (
              SELECT intent.requested_at
              FROM usage_release_intents AS intent
              WHERE intent.user_id = usage_reservations.user_id
                AND intent.idempotency_key = usage_reservations.idempotency_key
                AND intent.expires_at >= ?
            )
          ),
          status = CASE
            WHEN NOT EXISTS (
              SELECT 1
              FROM usage_operation_leases
              WHERE reservation_id = usage_reservations.id
                AND operation = 'metered_ai'
                AND expires_at > ?
            ) THEN 'released'
            ELSE status
          END,
          expires_at = CASE
            WHEN NOT EXISTS (
              SELECT 1
              FROM usage_operation_leases
              WHERE reservation_id = usage_reservations.id
                AND operation = 'metered_ai'
                AND expires_at > ?
            ) THEN MIN(expires_at, ?)
            ELSE expires_at
          END
      WHERE user_id = ?
        AND idempotency_key = ?
        AND status = 'reserved'
        AND EXISTS (
          SELECT 1
          FROM usage_release_intents AS intent
          WHERE intent.user_id = usage_reservations.user_id
            AND intent.idempotency_key = usage_reservations.idempotency_key
            AND intent.expires_at >= ?
        )
      RETURNING id
    `)
    .bind(
      nowSeconds,
      nowSeconds,
      nowSeconds,
      nowSeconds - 1,
      userId,
      idempotencyKey,
      nowSeconds,
    )
    .first<{ id: string }>();
}

async function loadReservationAfterReleaseIntent(
  userId: string,
  idempotencyKey: string,
  nowSeconds: number,
) {
  await reconcileUsageReleaseIntent(userId, idempotencyKey, nowSeconds);
  return findUsageReservationForUser(userId, { idempotencyKey });
}

async function assertAccountDeletionNotProcessing(userId: string) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  const row = await database
    .prepare(`
      SELECT 1 AS processing
      FROM account_deletion_requests
      WHERE user_id = ? AND status = 'processing'
      LIMIT 1
    `)
    .bind(userId)
    .first<{ processing: number }>();
  if (row?.processing === 1) throw new AccountDeletionProcessingError();
}

export async function reserveUsage(
  currentUser: CurrentUser,
  sourceDurationSeconds: number,
  idempotencyKey: string,
  options: { operator?: boolean } = {},
) {
  const db = getDb();
  const user = await getOrCreateBillingUser(currentUser);
  await assertAccountDeletionNotProcessing(user.id);
  const roundedDuration = Math.max(1, Math.ceil(sourceDurationSeconds));
  const requestStartedAt = Math.floor(Date.now() / 1_000);
  const existing = await db
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existing[0]) {
    const reconciled = await loadReservationAfterReleaseIntent(
      user.id,
      idempotencyKey,
      requestStartedAt,
    );
    return reuseExistingUsageReservation(
      reconciled ?? existing[0],
      user.id,
      roundedDuration,
      requestStartedAt,
    );
  }
  const preemptivelyReleased = await materializeReleasedUsageReservation(
    user.id,
    idempotencyKey,
    roundedDuration,
    options,
    requestStartedAt,
  );
  if (preemptivelyReleased) {
    return withUsageReservationOutcome(preemptivelyReleased, "created");
  }

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
      expiresAt: now + USAGE_RESERVATION_LIFETIME_SECONDS,
      completedAt: null,
    };
    if (await insertUsageReservationAtomically(reservation, status)) {
      const inserted = await db
        .select()
        .from(usageReservations)
        .where(eq(usageReservations.id, reservation.id))
        .limit(1);
      if (!inserted[0]) {
        throw new Error("Reserved usage could not be reloaded.");
      }
      return withUsageReservationOutcome(inserted[0], "created");
    }

    const concurrent = await db
      .select()
      .from(usageReservations)
      .where(eq(usageReservations.idempotencyKey, idempotencyKey))
      .limit(1);
    if (concurrent[0]) {
      const reconciled = await loadReservationAfterReleaseIntent(
        user.id,
        idempotencyKey,
        Math.floor(Date.now() / 1_000),
      );
      return reuseExistingUsageReservation(
        reconciled ?? concurrent[0],
        user.id,
        roundedDuration,
        Math.floor(Date.now() / 1_000),
      );
    }
    const releasedAfterRace = await materializeReleasedUsageReservation(
      user.id,
      idempotencyKey,
      roundedDuration,
      options,
      Math.floor(Date.now() / 1_000),
    );
    if (releasedAfterRace) {
      return withUsageReservationOutcome(releasedAfterRace, "created");
    }
  }

  if (options.operator) throw new OperatorUsageLimitError();
  throw new UsageLimitError();
}

async function reuseExistingUsageReservation(
  existing: UsageReservationRecord,
  userId: string,
  roundedDuration: number,
  nowSeconds: number,
): Promise<UsageReservationWithOutcome> {
  if (existing.userId !== userId) {
    throw new UsageReservationConflictError(
      "idempotency_key_owned_by_another_user",
    );
  }
  if (existing.sourceDurationSeconds !== roundedDuration) {
    throw new UsageReservationConflictError("idempotency_payload_mismatch");
  }
  if (existing.status === "completed") {
    // A completed key is terminal: return its explicit state so a recovering
    // client can rotate to a fresh key without charging this row again.
    return withUsageReservationOutcome(existing, "existing");
  }
  if (
    existing.status === "released" ||
    existing.releaseRequestedAt !== null ||
    existing.expiresAt < nowSeconds
  ) {
    // Reserve retries are observational only. Reopening a terminal/pending
    // row requires the explicit renew contract, otherwise a response retry can
    // undo a pagehide release that already won the race.
    return withUsageReservationOutcome(existing, "existing");
  }
  if (
    existing.status === "reserved" &&
    existing.releaseRequestedAt === null &&
    existing.expiresAt >= nowSeconds
  ) {
    return withUsageReservationOutcome(existing, "existing");
  }
  return withUsageReservationOutcome(existing, "existing");
}

async function hasActiveMeteredAiLease(
  reservationId: string,
  nowSeconds: number,
) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  const row = await database
    .prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM usage_operation_leases
        WHERE reservation_id = ?
          AND operation = 'metered_ai'
          AND expires_at > ?
      ) AS active
    `)
    .bind(reservationId, nowSeconds)
    .first<{ active: number }>();
  return row?.active === 1;
}

async function reactivateUsageReservationAtomically(
  existing: UsageReservationRecord,
  bucket: BillingBucket,
  status: Awaited<ReturnType<typeof getBillingStatusForUser>>,
  nowSeconds: number,
) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare || !database.batch) {
    throw new Error("Usage database binding is unavailable.");
  }
  const expiresAt = nowSeconds + USAGE_RESERVATION_LIFETIME_SECONDS;
  let statement: QueryD1BoundStatement;
  if (bucket === "operator") {
    statement = database
      .prepare(`
        UPDATE usage_reservations
        SET bucket = 'operator',
            status = 'reserved',
            created_at = ?,
            expires_at = ?,
            completed_at = NULL,
            release_requested_at = NULL,
            billing_purchase_id = NULL
        WHERE id = ? AND user_id = ? AND status != 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM usage_operation_leases
            WHERE reservation_id = usage_reservations.id
              AND operation = 'metered_ai' AND expires_at > ?
          )
          AND (
            SELECT COUNT(*) FROM usage_reservations AS active_reservation
            WHERE active_reservation.user_id = ?
              AND active_reservation.bucket = 'operator'
              AND active_reservation.status IN ('reserved', 'completed')
              AND active_reservation.id != usage_reservations.id
              AND active_reservation.created_at >= ?
          ) < ?
      `)
      .bind(
        nowSeconds,
        expiresAt,
        existing.id,
        existing.userId,
        nowSeconds,
        existing.userId,
        startOfTokyoDaySeconds(nowSeconds),
        OPERATOR_DAILY_VIDEO_LIMIT,
      );
  } else if (bucket === "subscription" && status.subscription) {
    statement = database
      .prepare(`
        UPDATE usage_reservations
        SET bucket = 'subscription',
            status = 'reserved',
            created_at = ?,
            expires_at = ?,
            completed_at = NULL,
            release_requested_at = NULL,
            billing_purchase_id = NULL
        WHERE id = ? AND user_id = ? AND status != 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM usage_operation_leases
            WHERE reservation_id = usage_reservations.id
              AND operation = 'metered_ai' AND expires_at > ?
          )
          AND EXISTS (
            SELECT 1 FROM billing_subscriptions
            WHERE id = ? AND user_id = ?
              AND status IN ('active', 'trialing')
              AND current_period_start = ? AND current_period_end = ?
              AND current_period_end > ? AND plan_key = ?
              AND (revoked_period_start IS NULL OR revoked_period_start != current_period_start)
          )
          AND (
            SELECT COUNT(*) FROM usage_reservations AS active_reservation
            WHERE active_reservation.user_id = ?
              AND active_reservation.bucket = 'subscription'
              AND active_reservation.status IN ('reserved', 'completed')
              AND active_reservation.id != usage_reservations.id
              AND active_reservation.created_at >= ?
              AND active_reservation.created_at < ?
          ) < ?
      `)
      .bind(
        nowSeconds,
        expiresAt,
        existing.id,
        existing.userId,
        nowSeconds,
        status.subscription.id,
        existing.userId,
        status.subscription.currentPeriodStart,
        status.subscription.currentPeriodEnd,
        nowSeconds,
        status.subscription.planKey,
        existing.userId,
        status.subscription.currentPeriodStart,
        status.subscription.currentPeriodEnd,
        status.monthlyVideoLimit,
      );
  } else if (bucket === "one_time") {
    statement = database
      .prepare(`
        UPDATE usage_reservations
        SET bucket = 'one_time',
            status = 'reserved',
            created_at = ?,
            expires_at = ?,
            completed_at = NULL,
            release_requested_at = NULL,
            billing_purchase_id = (
              SELECT purchase.id
              FROM billing_purchases AS purchase
              WHERE purchase.user_id = usage_reservations.user_id
                AND purchase.revoked_at IS NULL
                AND (
                  SELECT COUNT(*) FROM usage_reservations AS active_reservation
                  WHERE active_reservation.billing_purchase_id = purchase.id
                    AND active_reservation.status IN ('reserved', 'completed')
                    AND active_reservation.id != usage_reservations.id
                ) < purchase.credits
              ORDER BY purchase.purchased_at, purchase.id
              LIMIT 1
            )
        WHERE id = ? AND user_id = ? AND status != 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM usage_operation_leases
            WHERE reservation_id = usage_reservations.id
              AND operation = 'metered_ai' AND expires_at > ?
          )
          AND EXISTS (
            SELECT 1 FROM billing_purchases AS purchase
            WHERE purchase.user_id = usage_reservations.user_id
              AND purchase.revoked_at IS NULL
              AND (
                SELECT COUNT(*) FROM usage_reservations AS active_reservation
                WHERE active_reservation.billing_purchase_id = purchase.id
                  AND active_reservation.status IN ('reserved', 'completed')
                  AND active_reservation.id != usage_reservations.id
              ) < purchase.credits
          )
      `)
      .bind(nowSeconds, expiresAt, existing.id, existing.userId, nowSeconds);
  } else {
    statement = database
      .prepare(`
        UPDATE usage_reservations
        SET bucket = 'free',
            status = 'reserved',
            created_at = ?,
            expires_at = ?,
            completed_at = NULL,
            release_requested_at = NULL,
            billing_purchase_id = NULL
        WHERE id = ? AND user_id = ? AND status != 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM usage_operation_leases
            WHERE reservation_id = usage_reservations.id
              AND operation = 'metered_ai' AND expires_at > ?
          )
          AND (
            SELECT COUNT(*) FROM usage_reservations AS active_reservation
            WHERE active_reservation.user_id = ?
              AND active_reservation.bucket = 'free'
              AND active_reservation.status IN ('reserved', 'completed')
              AND active_reservation.id != usage_reservations.id
          ) < ?
          AND COALESCE((
            SELECT SUM(active_reservation.source_duration_seconds)
            FROM usage_reservations AS active_reservation
            WHERE active_reservation.user_id = ?
              AND active_reservation.bucket = 'free'
              AND active_reservation.status IN ('reserved', 'completed')
              AND active_reservation.id != usage_reservations.id
          ), 0) + source_duration_seconds <= ?
      `)
      .bind(
        nowSeconds,
        expiresAt,
        existing.id,
        existing.userId,
        nowSeconds,
        existing.userId,
        FREE_VIDEO_LIMIT,
        existing.userId,
        FREE_SECONDS_LIMIT,
      );
  }

  const results = await database.batch([
    statement,
    database
      .prepare(`
        DELETE FROM usage_release_intents
        WHERE user_id = ? AND idempotency_key = ?
          AND EXISTS (
            SELECT 1 FROM usage_reservations
            WHERE id = ? AND user_id = ?
              AND status = 'reserved'
              AND release_requested_at IS NULL
              AND created_at = ? AND expires_at = ?
          )
      `)
      .bind(
        existing.userId,
        existing.idempotencyKey,
        existing.id,
        existing.userId,
        nowSeconds,
        expiresAt,
      ),
  ]);
  if (results[0]?.meta?.changes !== 1) return null;
  const rows = await getDb()
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.id, existing.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function renewUsageReservation(
  currentUser: CurrentUser,
  selector: UsageReservationSelector,
  options: { sourceDurationSeconds?: number; operator?: boolean } = {},
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<UsageReservationWithOutcome | null> {
  const user = await getOrCreateBillingUser(currentUser);
  await assertAccountDeletionNotProcessing(user.id);
  const existing = await findUsageReservationForUser(user.id, selector);
  if (!existing) return null;
  const roundedDuration =
    options.sourceDurationSeconds === undefined
      ? existing.sourceDurationSeconds
      : Math.max(1, Math.ceil(options.sourceDurationSeconds));
  if (roundedDuration !== existing.sourceDurationSeconds) {
    throw new UsageReservationConflictError("idempotency_payload_mismatch");
  }
  if (existing.status === "completed") {
    return withUsageReservationOutcome(existing, "existing");
  }
  if (existing.bucket === "operator" && options.operator !== true) {
    throw new OperatorUsageLimitError();
  }

  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare || !database.batch) {
    throw new Error("Usage database binding is unavailable.");
  }
  const expiresAt = nowSeconds + USAGE_RESERVATION_LIFETIME_SECONDS;
  const currentStatus = await getBillingStatusForUser(user.id, nowSeconds);
  const preferredBucket = chooseBillingBucket(
    {
      ...currentStatus,
      operatorActive: options.operator === true,
    },
    roundedDuration,
  );
  const shouldUpgradePaidPriority =
    (existing.bucket === "free" &&
      (preferredBucket === "subscription" || preferredBucket === "one_time")) ||
    (existing.bucket === "one_time" && preferredBucket === "subscription");
  if (
    existing.status === "reserved" &&
    existing.expiresAt >= nowSeconds &&
    !shouldUpgradePaidPriority
  ) {
    // Renewal is the sole explicit resume action. Deleting the key tombstone
    // and extending the currently-bound entitlement share one D1 transaction,
    // so a concurrent release is ordered entirely before or after the resume.
    const results = await database.batch([
      database
        .prepare(`
          UPDATE usage_reservations
          SET expires_at = MAX(expires_at, ?),
              release_requested_at = NULL
          WHERE id = ? AND user_id = ? AND status = 'reserved'
            AND expires_at >= ?
            AND (
              bucket = 'free'
              OR (bucket = 'operator' AND ? = 1)
              OR (
                bucket = 'subscription'
                AND EXISTS (
                  SELECT 1 FROM billing_subscriptions
                  WHERE user_id = usage_reservations.user_id
                    AND status IN ('active', 'trialing')
                    AND current_period_start <= usage_reservations.created_at
                    AND current_period_end > usage_reservations.created_at
                    AND current_period_end > ?
                    AND (revoked_period_start IS NULL OR revoked_period_start != current_period_start)
                )
              )
              OR (
                bucket = 'one_time'
                AND (
                  (
                    billing_purchase_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM billing_purchases
                      WHERE id = usage_reservations.billing_purchase_id
                        AND user_id = usage_reservations.user_id
                        AND revoked_at IS NULL
                    )
                  )
                  OR (
                    billing_purchase_id IS NULL
                    AND (
                      SELECT COALESCE(SUM(credits), 0)
                      FROM billing_purchases
                      WHERE user_id = usage_reservations.user_id
                        AND revoked_at IS NULL
                    ) >= (
                      SELECT COUNT(*)
                      FROM usage_reservations AS ranked_reservation
                      WHERE ranked_reservation.user_id = usage_reservations.user_id
                        AND ranked_reservation.bucket = 'one_time'
                        AND ranked_reservation.status IN ('reserved', 'completed')
                        AND (
                          ranked_reservation.created_at < usage_reservations.created_at
                          OR (
                            ranked_reservation.created_at = usage_reservations.created_at
                            AND ranked_reservation.id <= usage_reservations.id
                          )
                        )
                    )
                  )
                )
              )
            )
        `)
        .bind(
          expiresAt,
          existing.id,
          user.id,
          nowSeconds,
          options.operator === true ? 1 : 0,
          nowSeconds,
        ),
      database
        .prepare(`
          DELETE FROM usage_release_intents
          WHERE user_id = ? AND idempotency_key = ?
            AND EXISTS (
              SELECT 1 FROM usage_reservations
              WHERE id = ? AND user_id = ?
                AND status = 'reserved'
                AND release_requested_at IS NULL
                AND expires_at >= ?
            )
        `)
        .bind(
          user.id,
          existing.idempotencyKey,
          existing.id,
          user.id,
          expiresAt,
        ),
    ]);
    if (results[0]?.meta?.changes === 1) {
      const renewed = await findUsageReservationForUser(user.id, {
        reservationId: existing.id,
      });
      return renewed
        ? withUsageReservationOutcome(renewed, "renewed")
        : null;
    }
  }

  // The old entitlement can legitimately become stale while the reservation
  // is still within its TTL (for example, a subscription period rollover or a
  // refunded one-time credit). Rebind the same idempotent row to the best
  // entitlement available now, never while upstream AI still owns its lease.
  if (await hasActiveMeteredAiLease(existing.id, nowSeconds)) {
    throw new UsageReservationBusyError();
  }
  const bucket = preferredBucket;
  if (!bucket) {
    if (options.operator) throw new OperatorUsageLimitError();
    throw new UsageLimitError();
  }
  if (
    (existing.bucket === "subscription" || existing.bucket === "one_time") &&
    bucket === "free"
  ) {
    throw new UsageLimitError();
  }
  const reactivated = await reactivateUsageReservationAtomically(
    existing,
    bucket,
    currentStatus,
    nowSeconds,
  );
  if (reactivated) {
    return withUsageReservationOutcome(reactivated, "reactivated");
  }
  const concurrent = await findUsageReservationForUser(user.id, {
    reservationId: existing.id,
  });
  if (concurrent) {
    return withUsageReservationOutcome(concurrent, "existing");
  }
  return null;
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
        WHERE NOT EXISTS (
          SELECT 1 FROM usage_release_intents
          WHERE user_id = ? AND idempotency_key = ? AND expires_at >= ?
        )
        AND (
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
        reservation.idempotencyKey,
        reservation.createdAt,
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
        WHERE NOT EXISTS (
          SELECT 1 FROM usage_release_intents
          WHERE user_id = ? AND idempotency_key = ? AND expires_at >= ?
        )
        AND EXISTS (
          SELECT 1
          FROM billing_subscriptions
          WHERE id = ?
            AND user_id = ?
            AND status IN ('active', 'trialing')
            AND current_period_start = ?
            AND current_period_end = ?
            AND current_period_end > ?
            AND plan_key = ?
            AND (
              revoked_period_start IS NULL
              OR revoked_period_start != current_period_start
            )
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
        reservation.userId,
        reservation.idempotencyKey,
        reservation.createdAt,
        status.subscription.id,
        reservation.userId,
        status.subscription.currentPeriodStart,
        status.subscription.currentPeriodEnd,
        reservation.createdAt,
        status.subscription.planKey,
        reservation.userId,
        status.subscription.currentPeriodStart,
        status.subscription.currentPeriodEnd,
        status.monthlyVideoLimit,
      );
  } else if (reservation.bucket === "one_time") {
    statement = database
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds,
          bucket, status, created_at, expires_at, completed_at,
          billing_purchase_id
        )
        SELECT ?, ?, ?, ?, 'one_time', 'reserved', ?, ?, NULL, purchase.id
        FROM billing_purchases AS purchase
        WHERE purchase.user_id = ?
          AND purchase.revoked_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM usage_release_intents
            WHERE user_id = ? AND idempotency_key = ? AND expires_at >= ?
          )
          AND (
            SELECT COUNT(*)
            FROM usage_reservations
            WHERE billing_purchase_id = purchase.id
              AND status IN ('reserved', 'completed')
          ) < purchase.credits
        ORDER BY purchase.purchased_at, purchase.id
        LIMIT 1
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .bind(
        ...values,
        reservation.userId,
        reservation.userId,
        reservation.idempotencyKey,
        reservation.createdAt,
      );
  } else {
    statement = database
      .prepare(`
        INSERT INTO usage_reservations (
          id, user_id, idempotency_key, source_duration_seconds,
          bucket, status, created_at, expires_at, completed_at
        )
        SELECT ?, ?, ?, ?, 'free', 'reserved', ?, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM usage_release_intents
          WHERE user_id = ? AND idempotency_key = ? AND expires_at >= ?
        )
        AND (
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
        reservation.idempotencyKey,
        reservation.createdAt,
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
  if (
    reservation.bucket === "subscription" &&
    !(await subscriptionReservationHasActivePeriod(reservation))
  ) {
    return null;
  }
  return reservation;
}

async function subscriptionReservationHasActivePeriod(reservation: {
  userId: string;
  createdAt: number;
}) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  const now = Math.floor(Date.now() / 1_000);
  const result = await database
    .prepare(`
      SELECT EXISTS (
        SELECT 1
        FROM billing_subscriptions
        WHERE user_id = ?
          AND status IN ('active', 'trialing')
          AND current_period_start <= ?
          AND current_period_end > ?
          AND current_period_end > ?
          AND (
            revoked_period_start IS NULL
            OR revoked_period_start != current_period_start
          )
      ) AS allowed
    `)
    .bind(
      reservation.userId,
      reservation.createdAt,
      reservation.createdAt,
      now,
    )
    .first<{ allowed: number }>();
  return result?.allowed === 1;
}

async function oneTimeReservationHasActiveCredit(reservation: {
  id: string;
  userId: string;
  createdAt: number;
  billingPurchaseId: string | null;
}) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  if (reservation.billingPurchaseId) {
    const result = await database
      .prepare(`
        SELECT EXISTS (
          SELECT 1
          FROM billing_purchases
          WHERE id = ?
            AND user_id = ?
            AND revoked_at IS NULL
        ) AS allowed
      `)
      .bind(reservation.billingPurchaseId, reservation.userId)
      .first<{ allowed: number }>();
    return result?.allowed === 1;
  }

  // Compatibility path for reservations created before purchase assignment
  // was introduced. New reservations always use the exact purchase check.
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
  const user = await getOrCreateBillingUser(currentUser);
  const now = Math.floor(Date.now() / 1_000);
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }

  // The entitlement check and state transition intentionally live in one
  // SQLite statement. A refund, subscription revocation, explicit release, or
  // expiry that wins first makes this UPDATE affect zero rows.
  const completed = await database
    .prepare(`
      UPDATE usage_reservations
      SET status = 'completed', completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
        AND user_id = ?
        AND status IN ('reserved', 'completed')
        AND expires_at >= ?
        AND release_requested_at IS NULL
        AND (
          bucket IN ('free', 'operator')
          OR (
            bucket = 'subscription'
            AND EXISTS (
              SELECT 1
              FROM billing_subscriptions
              WHERE user_id = usage_reservations.user_id
                AND status IN ('active', 'trialing')
                AND current_period_start <= usage_reservations.created_at
                AND current_period_end > usage_reservations.created_at
                AND current_period_end > ?
                AND (
                  revoked_period_start IS NULL
                  OR revoked_period_start != current_period_start
                )
            )
          )
          OR (
            bucket = 'one_time'
            AND (
              (
                billing_purchase_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM billing_purchases
                  WHERE id = usage_reservations.billing_purchase_id
                    AND user_id = usage_reservations.user_id
                    AND revoked_at IS NULL
                )
              )
              OR (
                billing_purchase_id IS NULL
                AND (
                  SELECT COALESCE(SUM(credits), 0)
                  FROM billing_purchases
                  WHERE user_id = usage_reservations.user_id
                    AND revoked_at IS NULL
                ) >= (
                  SELECT COUNT(*)
                  FROM usage_reservations AS ranked_reservation
                  WHERE ranked_reservation.user_id = usage_reservations.user_id
                    AND ranked_reservation.bucket = 'one_time'
                    AND ranked_reservation.status IN ('reserved', 'completed')
                    AND (
                      ranked_reservation.created_at < usage_reservations.created_at
                      OR (
                        ranked_reservation.created_at = usage_reservations.created_at
                        AND ranked_reservation.id <= usage_reservations.id
                      )
                    )
                )
              )
            )
          )
        )
      RETURNING id
    `)
    .bind(now, reservationId, user.id, now, now)
    .first<{ id: string }>();
  return Boolean(completed?.id);
}

export type UsageReleaseResult = {
  released: boolean;
  pending: boolean;
  status: UsageReservationApiStatus | "not_found";
  reservationId: string | null;
};

const MAX_ACTIVE_USAGE_RELEASE_INTENTS_PER_USER = 16;

async function persistUsageReleaseIntentAndReconcile(
  userId: string,
  idempotencyKey: string,
  nowSeconds: number,
) {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare || !database.batch) {
    throw new Error("Usage database binding is unavailable.");
  }
  const intentExpiresAt = nowSeconds + USAGE_RELEASE_INTENT_TTL_SECONDS;
  await database.batch([
    database
      .prepare(`
        DELETE FROM usage_release_intents
        WHERE expires_at < ?
      `)
      .bind(nowSeconds),
    database
      .prepare(`
        INSERT INTO usage_release_intents (
          user_id, idempotency_key, requested_at, expires_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, idempotency_key) DO UPDATE SET
          requested_at = MIN(requested_at, excluded.requested_at),
          expires_at = MAX(expires_at, excluded.expires_at)
      `)
      .bind(userId, idempotencyKey, nowSeconds, intentExpiresAt),
    database
      .prepare(`
        DELETE FROM usage_release_intents
        WHERE user_id = ?
          AND idempotency_key IN (
            SELECT idempotency_key
            FROM usage_release_intents
            WHERE user_id = ? AND expires_at >= ?
            ORDER BY requested_at DESC, idempotency_key DESC
            LIMIT -1 OFFSET ?
          )
      `)
      .bind(
        userId,
        userId,
        nowSeconds,
        MAX_ACTIVE_USAGE_RELEASE_INTENTS_PER_USER,
      ),
    database
      .prepare(`
        UPDATE usage_reservations
        SET release_requested_at = COALESCE(
              release_requested_at,
              (
                SELECT intent.requested_at
                FROM usage_release_intents AS intent
                WHERE intent.user_id = usage_reservations.user_id
                  AND intent.idempotency_key = usage_reservations.idempotency_key
                  AND intent.expires_at >= ?
              )
            ),
            status = CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM usage_operation_leases
                WHERE reservation_id = usage_reservations.id
                  AND operation = 'metered_ai'
                  AND expires_at > ?
              ) THEN 'released'
              ELSE status
            END,
            expires_at = CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM usage_operation_leases
                WHERE reservation_id = usage_reservations.id
                  AND operation = 'metered_ai'
                  AND expires_at > ?
              ) THEN MIN(expires_at, ?)
              ELSE expires_at
            END
        WHERE user_id = ?
          AND idempotency_key = ?
          AND status = 'reserved'
          AND EXISTS (
            SELECT 1
            FROM usage_release_intents AS intent
            WHERE intent.user_id = usage_reservations.user_id
              AND intent.idempotency_key = usage_reservations.idempotency_key
              AND intent.expires_at >= ?
          )
      `)
      .bind(
        nowSeconds,
        nowSeconds,
        nowSeconds,
        nowSeconds - 1,
        userId,
        idempotencyKey,
        nowSeconds,
      ),
  ]);
}

export async function requestUsageRelease(
  currentUser: CurrentUser,
  selector: string | UsageReservationSelector,
  now = Math.floor(Date.now() / 1_000),
): Promise<UsageReleaseResult> {
  // The key tombstone is persisted even when reserve has not committed yet.
  // D1 serializes its insertion and reservation reconciliation in one batch,
  // so either reserve sees the tombstone or this request sees the reservation.
  const user = await getOrCreateBillingUser(currentUser);
  const normalizedSelector =
    typeof selector === "string" ? { reservationId: selector } : selector;
  const initiallyExisting = await findUsageReservationForUser(
    user.id,
    normalizedSelector,
  );
  if (initiallyExisting?.status === "completed") {
    return {
      released: false,
      pending: false,
      status: "completed",
      reservationId: initiallyExisting.id,
    };
  }
  const idempotencyKey =
    normalizedSelector.idempotencyKey ?? initiallyExisting?.idempotencyKey;
  if (!idempotencyKey) {
    return {
      released: false,
      pending: false,
      status: "not_found",
      reservationId: null,
    };
  }
  await persistUsageReleaseIntentAndReconcile(user.id, idempotencyKey, now);
  const existing = await findUsageReservationForUser(user.id, {
    idempotencyKey,
  });
  if (!existing) {
    return {
      released: false,
      pending: true,
      status: "release_pending",
      reservationId: null,
    };
  }
  if (existing.status === "completed") {
    return {
      released: false,
      pending: false,
      status: "completed",
      reservationId: existing.id,
    };
  }
  const released = existing.status === "released";
  return {
    released,
    pending: !released && existing.releaseRequestedAt !== null,
    status: released ? "released" : "release_pending",
    reservationId: existing.id,
  };
}

export async function releaseUsage(
  currentUser: CurrentUser,
  selector: string | UsageReservationSelector,
) {
  const result = await requestUsageRelease(currentUser, selector);
  return result.released;
}

type StripeSubscriptionRecord = {
  id: string;
  customerId: string;
  priceId: string;
  planKey: MonthlyPlanKey;
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
      planKey: subscription.planKey,
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
        planKey: subscription.planKey,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        updatedAt: now,
      },
    });
}

/**
 * Revokes only the subscription period paid by a refunded invoice. Keeping
 * the period boundary instead of a permanent flag lets a later paid renewal
 * resume access without manual intervention.
 */
export async function setSubscriptionPeriodRevocationState(
  subscriptionId: string,
  periodStart: number,
  blocked: boolean,
) {
  if (!Number.isSafeInteger(periodStart) || periodStart <= 0) {
    throw new Error("Refunded subscription period is invalid.");
  }
  const db = getDb();
  const rows = await db
    .select({
      userId: billingSubscriptions.userId,
      currentPeriodStart: billingSubscriptions.currentPeriodStart,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      revokedPeriodStart: billingSubscriptions.revokedPeriodStart,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.id, subscriptionId))
    .limit(1);
  const subscription = rows[0];
  if (!subscription) {
    throw new Error("Refunded subscription was not found.");
  }

  // A refund for an older, already-ended period cannot restore current
  // access, so it is safely recorded as historical. A future period is a
  // malformed Stripe relationship and must be retried instead of ignored.
  if (periodStart < subscription.currentPeriodStart) {
    return "historical" as const;
  }
  if (periodStart >= subscription.currentPeriodEnd) {
    throw new Error("Refunded subscription period does not match the current period.");
  }

  if (blocked) {
    const updated = await db
      .update(billingSubscriptions)
      .set({ revokedPeriodStart: subscription.currentPeriodStart })
      .where(
        and(
          eq(billingSubscriptions.id, subscriptionId),
          eq(
            billingSubscriptions.currentPeriodStart,
            subscription.currentPeriodStart,
          ),
        ),
      )
      .returning({
        userId: billingSubscriptions.userId,
        currentPeriodStart: billingSubscriptions.currentPeriodStart,
        currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      });
    if (!updated[0]) {
      throw new Error("Subscription changed while its refund was being applied.");
    }
    const now = Math.floor(Date.now() / 1_000);
    await db
      .update(usageReservations)
      .set({ expiresAt: now - 1 })
      .where(
        and(
          eq(usageReservations.userId, updated[0].userId),
          eq(usageReservations.bucket, "subscription"),
          inArray(usageReservations.status, [...ACTIVE_USAGE_STATUSES]),
          gte(
            usageReservations.createdAt,
            updated[0].currentPeriodStart,
          ),
          lt(usageReservations.createdAt, updated[0].currentPeriodEnd),
        ),
      );
    await db
      .update(usageReservations)
      .set({ status: "released" })
      .where(
        and(
          eq(usageReservations.userId, updated[0].userId),
          eq(usageReservations.bucket, "subscription"),
          eq(usageReservations.status, "reserved"),
          gte(
            usageReservations.createdAt,
            updated[0].currentPeriodStart,
          ),
          lt(usageReservations.createdAt, updated[0].currentPeriodEnd),
        ),
      );
    return "revoked" as const;
  }
  const restored = await db
    .update(billingSubscriptions)
    .set({ revokedPeriodStart: null })
    .where(
      and(
        eq(billingSubscriptions.id, subscriptionId),
        eq(
          billingSubscriptions.currentPeriodStart,
          subscription.currentPeriodStart,
        ),
        eq(
          billingSubscriptions.revokedPeriodStart,
          subscription.currentPeriodStart,
        ),
      ),
    )
    .returning({ id: billingSubscriptions.id });
  if (!restored[0] && subscription.revokedPeriodStart !== null) {
    throw new Error("Subscription changed while its refund was being cleared.");
  }
  return "restored" as const;
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
    await stopOneTimeReservationsForPurchase(
      claim.userId,
      claim.purchaseId,
    );
  }
}

/**
 * Authorizes one logical billable AI action. All metered operation types use
 * the same reservation-scoped lease, so a client cannot race transcription,
 * script, and speech requests past the shared successful-action limit.
 */
type OwnedUsageReservation = NonNullable<
  Awaited<ReturnType<typeof findOwnedUsageReservation>>
>;

export type MeteredAiAuthorizationResult =
  | {
      allowed: true;
      reason: null;
      reservation: OwnedUsageReservation;
      lease: UsageOperationLease;
      action: MeteredAiAction;
      successfulLimit: number;
      successfulCount: number;
      remaining: number;
      entitlementLimit?: number;
      entitlementSuccessfulCount?: number;
      entitlementPendingCount?: number;
      entitlementRemaining?: number;
      entitlementScope?: MeteredAiEntitlementScope;
      alreadySucceeded: boolean;
    }
  | {
      allowed: false;
      reason:
        | "invalid_action_id"
        | "reservation_not_found"
        | "observed_duration_exceeded"
        | "operation_in_progress"
        | "action_conflict"
        | "action_not_found"
        | "action_phase_mismatch"
        | "action_failed"
        | "action_expired"
        | "action_already_succeeded"
        | "action_attempt_limit"
        | "initial_action_used"
        | "operator_success_limit"
        | "ai_action_capacity"
        | "entitlement_ai_limit"
        | "entitlement_ai_capacity"
        | "operator_operation_limit";
      reservation: OwnedUsageReservation | null;
      lease: null;
      action: MeteredAiAction | null;
      successfulLimit: number;
      successfulCount: number;
      remaining: number;
      entitlementLimit?: number;
      entitlementSuccessfulCount?: number;
      entitlementPendingCount?: number;
      entitlementRemaining?: number;
    };

export type MeteredAiAuthorizationOptions = {
  /** Refuse to create a new action; used by later phases of a bundle. */
  allowCreate?: boolean;
  /** Existing attempt counts from which this request is allowed to continue. */
  continueFromAttemptCounts?: readonly number[];
  /**
   * Explicitly permits the only two multi-request action protocols. Ordinary
   * script and speech actions may never reuse a succeeded action ID.
   */
  continuationMode?: "transcription_chunk" | "narration_bundle_phase";
};

type AiBudgetReservation = {
  id: string;
  userId: string;
  bucket: BillingBucket;
  createdAt: number;
  billingPurchaseId: string | null;
};

async function meteredAiEntitlementScope(
  reservation: AiBudgetReservation,
  nowSeconds: number,
): Promise<MeteredAiEntitlementScope> {
  const database = env.DB as unknown as QueryD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  if (reservation.bucket === "free") {
    return {
      kind: "free",
      userId: reservation.userId,
      periodStart: null,
      periodEnd: null,
      purchaseId: null,
      successfulLimit: FREE_VIDEO_LIMIT * FREE_AI_OPERATION_SUCCESS_LIMIT,
    };
  }
  if (reservation.bucket === "operator") {
    const periodStart = startOfTokyoDaySeconds(nowSeconds);
    return {
      kind: "operator",
      userId: reservation.userId,
      periodStart,
      periodEnd: periodStart + 24 * 60 * 60,
      purchaseId: null,
      successfulLimit:
        OPERATOR_DAILY_VIDEO_LIMIT * OPERATOR_AI_OPERATION_SUCCESS_LIMIT,
    };
  }
  if (reservation.bucket === "one_time") {
    let credits = 1;
    if (reservation.billingPurchaseId) {
      const purchase = await database
        .prepare(`
          SELECT credits
          FROM billing_purchases
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL
          LIMIT 1
        `)
        .bind(reservation.billingPurchaseId, reservation.userId)
        .first<{ credits: number }>();
      credits = Math.max(1, Math.floor(purchase?.credits ?? 1));
    } else {
      const purchases = await database
        .prepare(`
          SELECT COALESCE(SUM(credits), 0) AS credits
          FROM billing_purchases
          WHERE user_id = ? AND revoked_at IS NULL
        `)
        .bind(reservation.userId)
        .first<{ credits: number }>();
      credits = Math.max(1, Math.floor(purchases?.credits ?? 1));
    }
    return {
      kind: "one_time",
      userId: reservation.userId,
      periodStart: null,
      periodEnd: null,
      purchaseId: reservation.billingPurchaseId,
      successfulLimit: credits * ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
    };
  }

  const subscription = await database
    .prepare(`
      SELECT plan_key, current_period_start, current_period_end
      FROM billing_subscriptions
      WHERE user_id = ?
        AND status IN ('active', 'trialing')
        AND current_period_start <= ?
        AND current_period_end > ?
        AND current_period_end > ?
        AND (
          revoked_period_start IS NULL
          OR revoked_period_start != current_period_start
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .bind(
      reservation.userId,
      reservation.createdAt,
      reservation.createdAt,
      nowSeconds,
    )
    .first<{
      plan_key: string;
      current_period_start: number;
      current_period_end: number;
    }>();
  if (!subscription || !isMonthlyPlanKey(subscription.plan_key)) {
    throw new Error("Subscription AI entitlement is unavailable.");
  }
  return {
    kind: "subscription",
    userId: reservation.userId,
    periodStart: subscription.current_period_start,
    periodEnd: subscription.current_period_end,
    purchaseId: null,
    successfulLimit:
      monthlyPlanVideoLimit(subscription.plan_key) *
      SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
  };
}

export async function getAiEntitlementBudgetForReservation(
  reservation: AiBudgetReservation,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const scope = await meteredAiEntitlementScope(reservation, nowSeconds);
  const usage = await getMeteredAiEntitlementUsage(scope, nowSeconds);
  return {
    scope,
    successfulLimit: scope.successfulLimit,
    successfulCount: usage.successfulCount,
    pendingCount: usage.pendingCount,
    remaining: Math.max(
      0,
      scope.successfulLimit - usage.successfulCount - usage.pendingCount,
    ),
  };
}

export async function authorizeMeteredAiOperation(
  currentUser: CurrentUser,
  reservationId: string,
  operation: MeteredAiOperation,
  actionId: string,
  options: MeteredAiAuthorizationOptions = {},
): Promise<MeteredAiAuthorizationResult> {
  if (!isValidMeteredAiActionId(actionId)) {
    return {
      allowed: false,
      reason: "invalid_action_id",
      reservation: null,
      lease: null,
      action: null,
      successfulLimit: 0,
      successfulCount: 0,
      remaining: 0,
    } as const;
  }

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
      action: null,
      successfulLimit: 0,
      successfulCount: 0,
      remaining: 0,
    } as const;
  }
  const successfulLimit = getAiOperationSuccessLimit(reservation.bucket);
  const initialEntitlement = await getAiEntitlementBudgetForReservation(
    reservation,
  );
  const initialEntitlementFields = {
    entitlementLimit: initialEntitlement.successfulLimit,
    entitlementSuccessfulCount: initialEntitlement.successfulCount,
    entitlementPendingCount: initialEntitlement.pendingCount,
    entitlementRemaining: initialEntitlement.remaining,
  };
  const entitlementAwareRemaining = (perVideoRemaining: number) =>
    Math.min(perVideoRemaining, initialEntitlement.remaining);
  if (await isObservedDurationBlocked(reservation.id)) {
    const usage = await getMeteredAiUsageCounts(reservation.id);
    return {
      allowed: false,
      reason: "observed_duration_exceeded",
      reservation,
      lease: null,
      action: null,
      successfulLimit,
      successfulCount: usage.successfulCount,
      remaining: entitlementAwareRemaining(
        Math.max(0, successfulLimit - usage.successfulCount),
      ),
      ...initialEntitlementFields,
    } as const;
  }

  const lease = await acquireUsageOperationLease(
    reservation.id,
    METERED_AI_LEASE_SCOPE,
    TRANSCRIPTION_LEASE_TTL_SECONDS,
  );
  if (!lease) {
    const usage = await getMeteredAiUsageCounts(reservation.id);
    return {
      allowed: false,
      reason: "operation_in_progress",
      reservation,
      lease: null,
      action: null,
      successfulLimit,
      successfulCount: usage.successfulCount,
      remaining: entitlementAwareRemaining(
        Math.max(0, successfulLimit - usage.successfulCount),
      ),
      ...initialEntitlementFields,
    } as const;
  }

  try {
    if (await isObservedDurationBlocked(reservation.id)) {
      const usage = await getMeteredAiUsageCounts(reservation.id);
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "observed_duration_exceeded",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usage.successfulCount,
        remaining: entitlementAwareRemaining(
          Math.max(0, successfulLimit - usage.successfulCount),
        ),
        ...initialEntitlementFields,
      } as const;
    }

    const existingAction = await getMeteredAiAction(
      reservation.id,
      actionId,
    );
    const usageBefore = await getMeteredAiUsageCounts(reservation.id);
    const remainingBefore = entitlementAwareRemaining(
      Math.max(0, successfulLimit - usageBefore.successfulCount),
    );

    if (existingAction) {
      if (existingAction.operation !== operation) {
        await releaseUsageOperationLease(lease);
        return {
          allowed: false,
          reason: "action_conflict",
          reservation,
          lease: null,
          action: existingAction,
          successfulLimit,
          successfulCount: usageBefore.successfulCount,
          remaining: remainingBefore,
        } as const;
      }
      if (existingAction.status === "failed") {
        await releaseUsageOperationLease(lease);
        return {
          allowed: false,
          reason: "action_failed",
          reservation,
          lease: null,
          action: existingAction,
          successfulLimit,
          successfulCount: usageBefore.successfulCount,
          remaining: remainingBefore,
        } as const;
      }
      if (
        existingAction.status === "succeeded" &&
        !(
          (operation === "transcribe" &&
            options.continuationMode === "transcription_chunk") ||
          (operation === "narration_initial" &&
            options.continuationMode === "narration_bundle_phase" &&
            options.continueFromAttemptCounts !== undefined)
        )
      ) {
        await releaseUsageOperationLease(lease);
        return {
          allowed: false,
          reason: "action_already_succeeded",
          reservation,
          lease: null,
          action: existingAction,
          successfulLimit,
          successfulCount: usageBefore.successfulCount,
          remaining: remainingBefore,
        } as const;
      }
      if (existingAction.expiresAt <= Math.floor(Date.now() / 1_000)) {
        await markMeteredAiActionFailed(existingAction, lease);
        await releaseUsageOperationLease(lease);
        return {
          allowed: false,
          reason: "action_expired",
          reservation,
          lease: null,
          action: existingAction,
          successfulLimit,
          successfulCount: usageBefore.successfulCount,
          remaining: remainingBefore,
        } as const;
      }
      if (
        options.continueFromAttemptCounts &&
        !options.continueFromAttemptCounts.includes(existingAction.attemptCount)
      ) {
        await releaseUsageOperationLease(lease);
        return {
          allowed: false,
          reason: "action_phase_mismatch",
          reservation,
          lease: null,
          action: existingAction,
          successfulLimit,
          successfulCount: usageBefore.successfulCount,
          remaining: remainingBefore,
        } as const;
      }
      const continuedAction = await continueMeteredAiAction(
        existingAction,
        lease,
      );
      if (!continuedAction) {
        await releaseUsageOperationLease(lease);
        return {
          allowed: false,
          reason: "action_attempt_limit",
          reservation,
          lease: null,
          action: existingAction,
          successfulLimit,
          successfulCount: usageBefore.successfulCount,
          remaining: remainingBefore,
        } as const;
      }
      return {
        allowed: true,
        reason: null,
        reservation,
        lease,
        action: continuedAction,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: remainingBefore,
        ...initialEntitlementFields,
        entitlementScope: initialEntitlement.scope,
        alreadySucceeded: existingAction.status === "succeeded",
      } as const;
    }

    if (options.allowCreate === false) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "action_not_found",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: remainingBefore,
      } as const;
    }

    if (
      operation === "narration_initial" &&
      (await getMeteredAiActionByOperation(reservation.id, operation))
    ) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "initial_action_used",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: remainingBefore,
      } as const;
    }

    if (usageBefore.successfulCount >= successfulLimit) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "operator_success_limit",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: 0,
      } as const;
    }
    if (
      usageBefore.successfulCount + usageBefore.pendingCount >=
      successfulLimit
    ) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "ai_action_capacity",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: remainingBefore,
      } as const;
    }

    const entitlementBefore = await getAiEntitlementBudgetForReservation(
      reservation,
    );
    const entitlementFields = {
      entitlementLimit: entitlementBefore.successfulLimit,
      entitlementSuccessfulCount: entitlementBefore.successfulCount,
      entitlementPendingCount: entitlementBefore.pendingCount,
      entitlementRemaining: entitlementBefore.remaining,
    };
    if (
      entitlementBefore.successfulCount >= entitlementBefore.successfulLimit
    ) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "entitlement_ai_limit",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: 0,
        ...entitlementFields,
      } as const;
    }
    if (entitlementBefore.remaining <= 0) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "entitlement_ai_capacity",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: 0,
        ...entitlementFields,
      } as const;
    }

    // The legacy per-operation count remains a second, deliberately stricter
    // abuse ceiling. It is consumed once per logical action, never per chunk.
    if (!(await consumeOperatorUsageOperation(reservation.id, operation))) {
      await releaseUsageOperationLease(lease);
      return {
        allowed: false,
        reason: "operator_operation_limit",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageBefore.successfulCount,
        remaining: remainingBefore,
      } as const;
    }

    const action = await createMeteredAiAction(
      reservation.id,
      actionId,
      operation,
      successfulLimit,
      lease,
      undefined,
      entitlementBefore.scope,
    );
    if (!action) {
      const usageAfter = await getMeteredAiUsageCounts(reservation.id);
      const entitlementAfter = await getAiEntitlementBudgetForReservation(
        reservation,
      );
      await releaseUsageOperationLease(lease);
      const entitlementExhausted =
        entitlementAfter.successfulCount >= entitlementAfter.successfulLimit;
      const entitlementAtCapacity = entitlementAfter.remaining <= 0;
      return {
        allowed: false,
        reason:
          entitlementExhausted
            ? "entitlement_ai_limit"
            : entitlementAtCapacity
              ? "entitlement_ai_capacity"
          : usageAfter.successfulCount >= successfulLimit
            ? "operator_success_limit"
            : "ai_action_capacity",
        reservation,
        lease: null,
        action: null,
        successfulLimit,
        successfulCount: usageAfter.successfulCount,
        remaining: Math.min(
          Math.max(0, successfulLimit - usageAfter.successfulCount),
          entitlementAfter.remaining,
        ),
        entitlementLimit: entitlementAfter.successfulLimit,
        entitlementSuccessfulCount: entitlementAfter.successfulCount,
        entitlementPendingCount: entitlementAfter.pendingCount,
        entitlementRemaining: entitlementAfter.remaining,
      } as const;
    }

    return {
      allowed: true,
      reason: null,
      reservation,
      lease,
      action,
      successfulLimit,
      successfulCount: usageBefore.successfulCount,
      remaining: Math.min(
        remainingBefore,
        Math.max(0, entitlementBefore.remaining - 1),
      ),
      entitlementLimit: entitlementBefore.successfulLimit,
      entitlementSuccessfulCount: entitlementBefore.successfulCount,
      entitlementPendingCount: entitlementBefore.pendingCount + 1,
      entitlementRemaining: Math.max(0, entitlementBefore.remaining - 1),
      entitlementScope: entitlementBefore.scope,
      alreadySucceeded: false,
    } as const;
  } catch (error) {
    await releaseUsageOperationLease(lease).catch(() => undefined);
    throw error;
  }
}

export type AuthorizedMeteredAiOperation = Extract<
  Awaited<ReturnType<typeof authorizeMeteredAiOperation>>,
  { allowed: true }
>;

/** Marks one logical action successful and always releases its shared lease. */
export async function completeMeteredAiOperation(
  authorization: AuthorizedMeteredAiOperation,
) {
  try {
    const action = await markMeteredAiActionSucceeded(
      authorization.action,
      authorization.lease,
      authorization.successfulLimit,
    );
    if (!action) {
      return {
        completed: false,
        successfulCount: authorization.successfulCount,
        remaining: authorization.remaining,
      } as const;
    }
    const usage = await getMeteredAiUsageCounts(
      authorization.reservation.id,
    );
    const entitlement = authorization.entitlementScope
      ? await getMeteredAiEntitlementUsage(authorization.entitlementScope)
      : null;
    return {
      completed: true,
      successfulCount: usage.successfulCount,
      remaining: Math.max(
        0,
        Math.min(
          authorization.successfulLimit - usage.successfulCount,
          entitlement
            ? authorization.entitlementScope!.successfulLimit -
                entitlement.successfulCount -
                entitlement.pendingCount
            : authorization.successfulLimit - usage.successfulCount,
        ),
      ),
    } as const;
  } finally {
    await releaseUsageOperationLease(authorization.lease).catch(
      () => undefined,
    );
  }
}

/** Releases a chunk lease while preserving its pending logical action. */
export async function releaseMeteredAiOperation(
  authorization: AuthorizedMeteredAiOperation,
) {
  return releaseUsageOperationLease(authorization.lease);
}

/** Records a terminal failure without consuming successful-action quota. */
export async function abandonMeteredAiOperation(
  authorization: AuthorizedMeteredAiOperation,
) {
  try {
    return Boolean(
      await markMeteredAiActionFailed(
        authorization.action,
        authorization.lease,
      ),
    );
  } finally {
    await releaseUsageOperationLease(authorization.lease).catch(
      () => undefined,
    );
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

async function stopOneTimeReservationsForPurchase(
  userId: string,
  purchaseId: string,
) {
  const database = env.DB as unknown as AtomicD1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Usage database binding is unavailable.");
  }
  const now = Math.floor(Date.now() / 1_000);
  // A paid save slot is consumed only by explicit export completion. A refund
  // therefore releases every still-previewing reservation in one statement,
  // even when AI preview work had already succeeded.
  await database
    .prepare(`
      UPDATE usage_reservations
      SET status = 'released', expires_at = ?
      WHERE user_id = ?
        AND billing_purchase_id = ?
        AND bucket = 'one_time'
        AND status = 'reserved'
    `)
    .bind(now - 1, userId, purchaseId)
    .run();
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
    plan: status.monthlyPlanKey ?? "free",
    free: {
      videosUsed: status.freeVideosUsed,
      videoLimit: FREE_VIDEO_LIMIT,
      secondsUsed: status.freeSecondsUsed,
      secondsLimit: FREE_SECONDS_LIMIT,
    },
    monthly: {
      active: status.monthlySubscriptionActive,
      accessRevoked: status.monthlyAccessRevoked,
      planKey: status.monthlyPlanKey,
      videosUsed: status.monthlyVideosUsed,
      videoLimit: status.monthlyVideoLimit,
      renewsAt: status.currentSubscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd:
        status.currentSubscription?.cancelAtPeriodEnd ?? false,
    },
    oneTimeCredits: status.oneTimeCreditsRemaining,
  };
}
