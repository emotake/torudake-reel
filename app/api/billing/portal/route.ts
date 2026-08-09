import { getOrCreateBillingUser } from "../../../../lib/billing-store";
import {
  authenticationRequired,
  authenticationUnavailable,
  getCurrentUser,
  isSitesAuthenticationTrusted,
} from "../../../../lib/current-user";
import { isPasskeyAuthenticationConfigured } from "../../../../lib/account-auth";
import {
  isBillingConfigured,
  isCanonicalBillingRequest,
  publicOrigin,
  stripeRequest,
} from "../../../../lib/stripe";
import { isSameOriginMutation } from "../../../../lib/operator-session";

type StripePortalSession = {
  url: string;
};

export async function POST(request: Request) {
  if (!isCanonicalBillingRequest(request)) {
    return Response.json(
      {
        error: "最新の公開ページから決済管理を開いてください。",
        code: "non_canonical_billing_origin",
      },
      { status: 403 },
    );
  }
  if (
    !isSitesAuthenticationTrusted() &&
    !isPasskeyAuthenticationConfigured()
  ) {
    return authenticationUnavailable();
  }
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  if (!isBillingConfigured()) {
    return Response.json(
      { error: "決済管理は現在準備中です。" },
      { status: 503 },
    );
  }
  if (!isSameOriginMutation(request)) {
    return Response.json(
      {
        error: "決済管理リクエストを確認できませんでした。ページを再読み込みしてください。",
        code: "invalid_request_origin",
      },
      { status: 403 },
    );
  }

  try {
    const user = await getOrCreateBillingUser(currentUser);
    if (!user.stripeCustomerId) {
      return Response.json(
        { error: "まだ決済情報がありません。" },
        { status: 404 },
      );
    }
    const params = new URLSearchParams();
    params.set("customer", user.stripeCustomerId);
    params.set("return_url", `${publicOrigin(request)}/account`);
    const session = await stripeRequest<StripePortalSession>(
      "/v1/billing_portal/sessions",
      params,
    );
    return Response.json({ url: session.url });
  } catch (error) {
    console.error("billing portal creation failed", error);
    return Response.json(
      { error: "決済管理画面を開けませんでした。" },
      { status: 502 },
    );
  }
}
