import {
  acquireMonthlyCheckoutLock,
  getBillingStatusForUser,
  getOrCreateBillingUser,
  releaseMonthlyCheckoutLock,
  setStripeCustomerId,
  type MonthlyCheckoutLock,
} from "../../../../lib/billing-store";
import {
  authenticationRequired,
  authenticationUnavailable,
  getCurrentUser,
} from "../../../../lib/current-user";
import {
  isAccountDeletionScheduled,
} from "../../../../lib/account-auth";
import { isAccountAuthenticationAvailable } from "../../../../lib/account-auth-methods";
import {
  isBillingConfigured,
  isCanonicalBillingRequest,
  getStripeReadiness,
  publicOrigin,
  stripeGet,
  stripeMonthlyPlanForPrice,
  stripePriceForPlan,
  stripeRequest,
  type StripePlan,
} from "../../../../lib/stripe";
import { isSameOriginMutation } from "../../../../lib/operator-session";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";
import { recordServerProductEvent } from "../../../../lib/product-analytics";
import {
  billingRateLimitedResponse,
  consumeBillingRateLimit,
} from "../../../../lib/billing-rate-limit";

const MAX_CHECKOUT_REQUEST_BYTES = 16 * 1024;

type StripeCustomer = {
  id: string;
};

type StripeCheckoutSession = {
  id: string;
  url: string | null;
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

function isStripePlan(value: unknown): value is StripePlan {
  return (
    value === "starter" ||
    value === "standard" ||
    value === "one_time"
  );
}

export async function POST(request: Request) {
  if (!isCanonicalBillingRequest(request)) {
    return Response.json(
      {
        error: "最新の公開ページから料金プランを選び直してください。",
        code: "non_canonical_billing_origin",
      },
      { status: 403 },
    );
  }
  const currentUser = await getCurrentUser(request);
  if (!currentUser) {
    if (!isAccountAuthenticationAvailable()) {
      return authenticationUnavailable();
    }
    return authenticationRequired();
  }

  if (!isBillingConfigured()) {
    return Response.json(
      {
        error:
          "決済は現在準備中です。Stripeの本番設定が完了すると利用できます。",
        code: "billing_not_configured",
      },
      { status: 503 },
    );
  }

  if (!isSameOriginMutation(request)) {
    return Response.json(
      {
        error: "決済リクエストを確認できませんでした。ページを再読み込みしてください。",
        code: "invalid_request_origin",
      },
      { status: 403 },
    );
  }

  let payload: { plan?: unknown; requestId?: unknown };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_CHECKOUT_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "送信データが大きすぎます。"
            : "料金プランを選び直してください。",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!isStripePlan(payload.plan)) {
    return Response.json({ error: "料金プランを選び直してください。" }, { status: 400 });
  }

  const requestId =
    typeof payload.requestId === "string" &&
    /^[a-zA-Z0-9_-]{8,80}$/.test(payload.requestId)
      ? payload.requestId
      : crypto.randomUUID();
  let monthlyCheckoutLock: MonthlyCheckoutLock | null = null;
  let checkoutSessionCreated = false;

  try {
    const user = await getOrCreateBillingUser(currentUser);
    if (await isAccountDeletionScheduled(user.id)) {
      return Response.json(
        {
          error:
            "アカウント削除を予約中のため、新しい購入を開始できません。アカウント画面で削除予約を取り消してからお試しください。",
          code: "account_deletion_scheduled",
        },
        { status: 409 },
      );
    }
    if (payload.plan === "one_time") {
      const rateLimit = await consumeBillingRateLimit(
        user.id,
        "one_time_checkout",
      );
      if (!rateLimit.allowed) {
        return billingRateLimitedResponse(
          rateLimit,
          "動画1本プランの決済画面を続けて開いたため、少し待ってからもう一度お試しください。",
        );
      }
    }
    const readiness = await getStripeReadiness();
    if (!readiness.ready) {
      const message =
        readiness.problem === "price_mismatch"
          ? "料金設定を安全に確認できないため、決済を停止しました。運営へお知らせください。"
          : readiness.problem === "account_not_activated"
            ? "Stripeの本人確認が完了していないため、決済を開始できません。"
            : "Stripeの決済設定を確認できませんでした。少し待ってからお試しください。";
      return Response.json(
        { error: message, code: readiness.problem ?? "billing_not_ready" },
        { status: 503 },
      );
    }
    const billingStatus = await getBillingStatusForUser(user.id);
    if (payload.plan !== "one_time") {
      if (billingStatus.monthlySubscriptionActive) {
        return Response.json(
          {
            error:
              "月3本または月7本プランはすでに利用中です。変更や解約はアカウント画面から行えます。",
            code: "subscription_already_active",
          },
          { status: 409 },
        );
      }
      monthlyCheckoutLock = await acquireMonthlyCheckoutLock(
        user.id,
        requestId,
        payload.plan,
      );
      if (!monthlyCheckoutLock) {
        return Response.json(
          {
            error:
              "月3本または月7本プランの決済を別の画面で開始しています。決済画面を確認するか、30分ほど待ってからお試しください。",
            code: "subscription_checkout_in_progress",
          },
          { status: 409 },
        );
      }
    }

    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customerParams = new URLSearchParams();
      customerParams.set("metadata[app_user_id]", user.id);
      if (user.billingEmail) customerParams.set("email", user.billingEmail);
      if (user.fullName) customerParams.set("name", user.fullName);
      const customer = await stripeRequest<StripeCustomer>(
        "/v1/customers",
        customerParams,
        `customer:${user.id}`,
      );
      stripeCustomerId = customer.id;
      await setStripeCustomerId(user.id, customer.id);
    }

    if (monthlyCheckoutLock) {
      const existingSubscriptions = await stripeGet<StripeSubscriptionList>(
        `/v1/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=all&limit=100`,
      );
      if (
        !Array.isArray(existingSubscriptions.data) ||
        typeof existingSubscriptions.has_more !== "boolean"
      ) {
        throw new Error("Stripe returned an invalid subscription list.");
      }
      const monthlyAtStripe = existingSubscriptions.data.some((subscription) => {
        const status = subscription.status;
        const hasAppMonthlyPrice = subscription.items?.data?.some(
          (item) =>
            typeof item.price?.id === "string" &&
            Boolean(stripeMonthlyPlanForPrice(item.price.id)),
        );
        if (!hasAppMonthlyPrice) return false;
        if (typeof status !== "string") {
          throw new Error("Stripe returned an invalid subscription status.");
        }
        // A past-due, unpaid, paused, or incomplete subscription can still
        // become billable. Direct the customer to billing management instead
        // of creating a second monthly contract.
        return !TERMINAL_SUBSCRIPTION_STATUSES.has(status);
      });
      if (existingSubscriptions.has_more && !monthlyAtStripe) {
        throw new Error("Stripe subscription history exceeded its safe scan limit.");
      }
      if (monthlyAtStripe) {
        await releaseMonthlyCheckoutLock({
          userId: monthlyCheckoutLock.userId,
          lockToken: monthlyCheckoutLock.lockToken,
        });
        monthlyCheckoutLock = null;
        return Response.json(
          {
            error:
              "月3本または月7本プランはすでに利用中です。変更や解約はアカウント画面から行えます。",
            code: "subscription_already_active",
          },
          { status: 409 },
        );
      }
    }

    const priceId = stripePriceForPlan(payload.plan);
    const origin = publicOrigin(request);
    const sessionParams = new URLSearchParams();
    sessionParams.set(
      "mode",
      payload.plan === "one_time" ? "payment" : "subscription",
    );
    sessionParams.set("customer", stripeCustomerId);
    sessionParams.set("line_items[0][price]", priceId);
    sessionParams.set("line_items[0][quantity]", "1");
    sessionParams.set("locale", "ja");
    sessionParams.set("allow_promotion_codes", "true");
    sessionParams.set("client_reference_id", user.id);
    sessionParams.set("metadata[app_user_id]", user.id);
    sessionParams.set("metadata[plan]", payload.plan);
    if (monthlyCheckoutLock) {
      sessionParams.set(
        "metadata[checkout_lock_token]",
        monthlyCheckoutLock.lockToken,
      );
    }
    sessionParams.set(
      "success_url",
      `${origin}/account?checkout=success&plan=${payload.plan}&credits_before=${billingStatus.oneTimeCreditsRemaining}&session_id={CHECKOUT_SESSION_ID}`,
    );
    sessionParams.set("cancel_url", `${origin}/account?checkout=cancelled`);

    if (payload.plan !== "one_time") {
      sessionParams.set(
        "subscription_data[metadata][app_user_id]",
        user.id,
      );
      sessionParams.set(
        "subscription_data[metadata][plan]",
        payload.plan,
      );
      if (monthlyCheckoutLock) {
        sessionParams.set(
          "subscription_data[metadata][checkout_lock_token]",
          monthlyCheckoutLock.lockToken,
        );
      }
      sessionParams.set(
        "expires_at",
        String(Math.floor(Date.now() / 1_000) + 31 * 60),
      );
    } else {
      sessionParams.set(
        "payment_intent_data[metadata][app_user_id]",
        user.id,
      );
    }

    const session = await stripeRequest<StripeCheckoutSession>(
      "/v1/checkout/sessions",
      sessionParams,
      `checkout:${user.id}:${payload.plan}:${requestId}`,
    );
    checkoutSessionCreated = true;
    if (!session.url) throw new Error("Stripe Checkout URL was missing.");

    await recordServerProductEvent(request, "checkout_session_created", {
      plan: payload.plan,
      outcome: "created",
    });

    return Response.json({ url: session.url });
  } catch (error) {
    if (monthlyCheckoutLock && !checkoutSessionCreated) {
      await releaseMonthlyCheckoutLock({
        userId: monthlyCheckoutLock.userId,
        lockToken: monthlyCheckoutLock.lockToken,
      }).catch(() => undefined);
    }
    console.error("checkout session creation failed", error);
    await recordServerProductEvent(request, "checkout_session_failed", {
      plan: isStripePlan(payload.plan) ? payload.plan : "unknown",
      outcome: "failed",
      error_code: "stripe_checkout_failed",
    });
    return Response.json(
      { error: "決済画面を開けませんでした。少し待ってからお試しください。" },
      { status: 502 },
    );
  }
}
