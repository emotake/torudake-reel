import {
  getBillingStatusForUser,
  getOrCreateBillingUser,
  publicBillingStatus,
} from "../../../../lib/billing-store";
import {
  getCurrentUser,
  isSitesAuthenticationTrusted,
} from "../../../../lib/current-user";
import { isBillingConfigured } from "../../../../lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authenticationAvailable = isSitesAuthenticationTrusted();
  const stripeConfigured = isBillingConfigured();
  const configured = authenticationAvailable && stripeConfigured;
  const currentUser = getCurrentUser(request);
  if (!currentUser) {
    return privateJson({
      configured,
      authenticationAvailable,
      authenticated: false,
    });
  }

  try {
    const user = await getOrCreateBillingUser(currentUser);
    const status = await getBillingStatusForUser(user.id);
    return privateJson({
      configured,
      authenticationAvailable,
      authenticated: true,
      user: {
        email: user.email,
        fullName: user.fullName,
        hasStripeCustomer: Boolean(user.stripeCustomerId),
      },
      ...publicBillingStatus(status),
    });
  } catch (error) {
    console.error("billing status failed", error);
    return privateJson(
      { error: "利用状況を読み込めませんでした。" },
      { status: 500 },
    );
  }
}

function privateJson(body: Record<string, unknown>, init: ResponseInit = {}) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "oai-authenticated-user-email, Cookie");
  return response;
}
