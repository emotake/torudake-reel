import {
  getBillingStatusForUser,
  getOrCreateBillingUser,
  publicBillingStatus,
} from "../../../../lib/billing-store";
import {
  getCurrentUser,
} from "../../../../lib/current-user";
import { isAccountAuthenticationAvailable } from "../../../../lib/account-auth-methods";
import {
  isBillingConfigured,
  getStripeReadiness,
  stripeBillingMode,
} from "../../../../lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authenticationAvailable = isAccountAuthenticationAvailable();
  const stripeConfigured = isBillingConfigured();
  const billingMode = stripeBillingMode();
  const currentUser = await getCurrentUser(request);
  if (!currentUser) {
    return privateJson({
      configured: authenticationAvailable && stripeConfigured,
      authenticationAvailable,
      billingMode,
      authenticated: false,
    });
  }

  try {
    const readiness = stripeConfigured
      ? await getStripeReadiness()
      : null;
    const user = await getOrCreateBillingUser(currentUser);
    const status = await getBillingStatusForUser(user.id);
    return privateJson({
      configured: stripeConfigured && readiness?.ready === true,
      authenticationAvailable,
      billingMode,
      billingReadiness: readiness
        ? {
            catalogValid: readiness.catalogValid,
            chargesEnabled: readiness.chargesEnabled,
            detailsSubmitted: readiness.detailsSubmitted,
            problem: readiness.problem,
          }
        : null,
      authenticated: true,
      user: {
        email: user.billingEmail,
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
