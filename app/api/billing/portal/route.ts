import { getOrCreateBillingUser } from "../../../../lib/billing-store";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../../lib/current-user";
import {
  isBillingConfigured,
  publicOrigin,
  stripeRequest,
} from "../../../../lib/stripe";

type StripePortalSession = {
  url: string;
};

export async function POST(request: Request) {
  if (!isBillingConfigured()) {
    return Response.json(
      { error: "決済管理は現在準備中です。" },
      { status: 503 },
    );
  }
  const currentUser = getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

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
