import { env } from "cloudflare:workers";
import {
  AccountAuthError,
  getAccountIdentity,
  requireRecentAccountSession,
} from "../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
  readAuthJson,
} from "../../../../lib/account-auth-http";
import {
  getBillingStatusForUser,
  getBillingUserById,
} from "../../../../lib/billing-store";
import { isSameOriginMutation } from "../../../../lib/operator-session";
import {
  isBillingConfigured,
  stripeGet,
  stripeMonthlyPlanForPrice,
} from "../../../../lib/stripe";

const DELETION_GRACE_SECONDS = 30 * 24 * 60 * 60;

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
};

type DeletionRow = {
  status: "scheduled" | "processing" | "cancelled" | "completed";
  requested_at: number;
  execute_after: number;
};

type StripeSubscriptionList = {
  has_more?: unknown;
  data?: Array<{
    status?: unknown;
    items?: { data?: Array<{ price?: { id?: unknown } }> };
  }>;
};

const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

export async function GET(request: Request) {
  try {
    const identity = await getAccountIdentity(request);
    if (!identity) {
      return privateJson(
        { error: "続けるにはアカウントへのログインが必要です。" },
        { status: 401 },
      );
    }
    return privateJson({ deletion: await getScheduledDeletion(identity.id) });
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return invalidOrigin();
  try {
    const payload = await readAuthJson(request);
    if (!("confirmDeletion" in payload) || payload.confirmDeletion !== true) {
      return privateJson(
        {
          error: "アカウント削除の確認が必要です。",
          code: "deletion_confirmation_required",
        },
        { status: 400 },
      );
    }
    const session = await requireRecentAccountSession(request);
    const [billing, billingUser] = await Promise.all([
      getBillingStatusForUser(session.userId),
      getBillingUserById(session.userId),
    ]);
    if (billingUser?.stripeCustomerId && !isBillingConfigured()) {
      throw new Error("Billing configuration is unavailable.");
    }
    const blockingStripeSubscription = billingUser?.stripeCustomerId
      ? await hasNonterminalStripeSubscription(billingUser.stripeCustomerId)
      : false;
    if (billing.monthlySubscriptionActive || blockingStripeSubscription) {
      return privateJson(
        {
          error:
            "月額プランの利用期間中は削除を予約できません。先にStripeで自動更新を解約し、利用期間の終了後にもう一度お試しください。",
          code: "active_subscription_must_end_first",
          openBillingPortal: true,
        },
        { status: 409 },
      );
    }
    if (
      billing.oneTimeCreditsRemaining > 0 &&
      (!("confirmUnusedCredits" in payload) ||
        payload.confirmUnusedCredits !== true)
    ) {
      return privateJson(
        {
          error: `動画1本プランの保存枠が${billing.oneTimeCreditsRemaining}本残っています。削除すると利用できなくなります。内容を確認してからもう一度お試しください。`,
          code: "unused_credits_confirmation_required",
          oneTimeCreditsRemaining: billing.oneTimeCreditsRemaining,
        },
        { status: 409 },
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    const executeAfter = now + DELETION_GRACE_SECONDS;
    const scheduled = await databaseOrThrow()
      .prepare(`
        INSERT INTO account_deletion_requests (
          user_id, status, requested_at, execute_after, cancelled_at,
          completed_at, updated_at
        ) VALUES (?, 'scheduled', ?, ?, NULL, NULL, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          status = 'scheduled',
          requested_at = excluded.requested_at,
          execute_after = excluded.execute_after,
          cancelled_at = NULL,
          completed_at = NULL,
          execution_token = NULL,
          execution_started_at = NULL,
          last_block_reason = NULL,
          last_error_code = NULL,
          updated_at = excluded.updated_at
        WHERE account_deletion_requests.status IN ('scheduled', 'cancelled')
      `)
      .bind(session.userId, now, executeAfter, now)
      .run();
    if (scheduled.meta?.changes !== 1) {
      const current = await getScheduledDeletion(session.userId);
      if (current?.status === "processing") {
        return privateJson(
          {
            error:
              "削除処理の安全確認を開始しているため、予約内容を変更できません。処理結果を確認してからもう一度お試しください。",
            code: "account_deletion_processing",
          },
          { status: 409 },
        );
      }
    }
    return privateJson({
      scheduled: true,
      requestedAt: now,
      executeAfter,
      message:
        "アカウント削除を予約しました。30日間は取り消せます。猶予期間中はログインできます。",
    });
  } catch (error) {
    return deletionErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  if (!isSameOriginMutation(request)) return invalidOrigin();
  try {
    const identity = await getAccountIdentity(request);
    if (!identity) {
      return privateJson(
        { error: "続けるにはアカウントへのログインが必要です。" },
        { status: 401 },
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    const cancelled = await databaseOrThrow()
      .prepare(`
        UPDATE account_deletion_requests
        SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE user_id = ? AND status = 'scheduled'
      `)
      .bind(now, now, identity.id)
      .run();
    if (cancelled.meta?.changes !== 1) {
      const current = await getScheduledDeletion(identity.id);
      if (current?.status === "processing") {
        return privateJson(
          {
            error:
              "削除処理の安全確認を開始しているため、現在は取り消せません。処理結果を確認してからもう一度お試しください。",
            code: "account_deletion_processing",
          },
          { status: 409 },
        );
      }
    }
    return privateJson({ cancelled: true });
  } catch (error) {
    return deletionErrorResponse(error);
  }
}

async function getScheduledDeletion(userId: string) {
  const row = await databaseOrThrow()
    .prepare(`
      SELECT status, requested_at, execute_after
      FROM account_deletion_requests
      WHERE user_id = ? AND status IN ('scheduled', 'processing')
      LIMIT 1
    `)
    .bind(userId)
    .first<DeletionRow>();
  return row
    ? {
        status: row.status,
        requestedAt: row.requested_at,
        executeAfter: row.execute_after,
      }
    : null;
}

async function hasNonterminalStripeSubscription(stripeCustomerId: string) {
  const subscriptions = await stripeGet<StripeSubscriptionList>(
    `/v1/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=all&limit=100`,
  );
  if (
    !Array.isArray(subscriptions.data) ||
    typeof subscriptions.has_more !== "boolean"
  ) {
    throw new Error("Stripe returned an invalid subscription list.");
  }
  const blocking = subscriptions.data.some((subscription) => {
    const appSubscription = subscription.items?.data?.some(
      (item) =>
        typeof item.price?.id === "string" &&
        Boolean(stripeMonthlyPlanForPrice(item.price.id)),
    );
    if (!appSubscription) return false;
    if (typeof subscription.status !== "string") {
      throw new Error("Stripe returned an invalid subscription status.");
    }
    return !TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status);
  });
  if (subscriptions.has_more && !blocking) {
    throw new Error("Stripe subscription history exceeded its safe scan limit.");
  }
  return blocking;
}

function deletionErrorResponse(error: unknown) {
  if (error instanceof AccountAuthError) return accountAuthErrorResponse(error);
  console.error("account deletion request failed", error);
  return privateJson(
    {
      error:
        "契約状況を安全に確認できなかったため、削除手続きを開始しませんでした。少し待ってからもう一度お試しください。",
      code: "account_deletion_billing_check_failed",
    },
    { status: 502 },
  );
}

function databaseOrThrow() {
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare) throw new Error("Account database is unavailable.");
  return database;
}

function invalidOrigin() {
  return privateJson(
    { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
    { status: 403 },
  );
}
