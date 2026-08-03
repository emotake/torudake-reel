import {
  getBillingStatusForUser,
  getOrCreateBillingUser,
  setStripeCustomerId,
} from "../../../../lib/billing-store";
import {
  authenticationRequired,
  authenticationUnavailable,
  getCurrentUser,
  isSitesAuthenticationTrusted,
} from "../../../../lib/current-user";
import {
  isBillingConfigured,
  publicOrigin,
  stripePriceForPlan,
  stripeRequest,
  type StripePlan,
} from "../../../../lib/stripe";
import { LIGHT_MONTHLY_VIDEO_LIMIT } from "../../../../lib/billing-policy";
import { isSameOriginMutation } from "../../../../lib/operator-session";

type StripeCustomer = {
  id: string;
};

type StripeCheckoutSession = {
  id: string;
  url: string | null;
};

function isStripePlan(value: unknown): value is StripePlan {
  return value === "light" || value === "one_time";
}

export async function POST(request: Request) {
  if (!isSitesAuthenticationTrusted()) return authenticationUnavailable();

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

  const currentUser = getCurrentUser(request);
  if (!currentUser) return authenticationRequired();
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
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "料金プランを選び直してください。" }, { status: 400 });
  }
  if (!isStripePlan(payload.plan)) {
    return Response.json({ error: "料金プランを選び直してください。" }, { status: 400 });
  }

  try {
    const user = await getOrCreateBillingUser(currentUser);
    if (payload.plan === "light") {
      const billingStatus = await getBillingStatusForUser(user.id);
      if (billingStatus.monthlyPlanActive) {
        return Response.json(
          {
            error: `月${LIGHT_MONTHLY_VIDEO_LIMIT}本プランはすでに利用中です。変更や解約はアカウント画面から行えます。`,
            code: "subscription_already_active",
          },
          { status: 409 },
        );
      }
    }

    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customerParams = new URLSearchParams();
      customerParams.set("email", user.email);
      customerParams.set("metadata[app_user_id]", user.id);
      if (user.fullName) customerParams.set("name", user.fullName);
      const customer = await stripeRequest<StripeCustomer>(
        "/v1/customers",
        customerParams,
        `customer:${user.id}`,
      );
      stripeCustomerId = customer.id;
      await setStripeCustomerId(user.id, customer.id);
    }

    const priceId = stripePriceForPlan(payload.plan);
    const origin = publicOrigin(request);
    const sessionParams = new URLSearchParams();
    sessionParams.set(
      "mode",
      payload.plan === "light" ? "subscription" : "payment",
    );
    sessionParams.set("customer", stripeCustomerId);
    sessionParams.set("line_items[0][price]", priceId);
    sessionParams.set("line_items[0][quantity]", "1");
    sessionParams.set("locale", "ja");
    sessionParams.set("allow_promotion_codes", "true");
    sessionParams.set("client_reference_id", user.id);
    sessionParams.set("metadata[app_user_id]", user.id);
    sessionParams.set("metadata[plan]", payload.plan);
    sessionParams.set(
      "success_url",
      `${origin}/account?checkout=success`,
    );
    sessionParams.set("cancel_url", `${origin}/account?checkout=cancelled`);

    if (payload.plan === "light") {
      sessionParams.set(
        "subscription_data[metadata][app_user_id]",
        user.id,
      );
      sessionParams.set(
        "subscription_data[metadata][plan]",
        payload.plan,
      );
    } else {
      sessionParams.set(
        "payment_intent_data[metadata][app_user_id]",
        user.id,
      );
    }

    const requestId =
      typeof payload.requestId === "string" &&
      /^[a-zA-Z0-9_-]{8,80}$/.test(payload.requestId)
        ? payload.requestId
        : crypto.randomUUID();
    const session = await stripeRequest<StripeCheckoutSession>(
      "/v1/checkout/sessions",
      sessionParams,
      `checkout:${user.id}:${payload.plan}:${requestId}`,
    );
    if (!session.url) throw new Error("Stripe Checkout URL was missing.");

    return Response.json({ url: session.url });
  } catch (error) {
    console.error("checkout session creation failed", error);
    return Response.json(
      { error: "決済画面を開けませんでした。少し待ってからお試しください。" },
      { status: 502 },
    );
  }
}
