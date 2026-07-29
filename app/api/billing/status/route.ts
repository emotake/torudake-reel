import {
  getBillingStatusForUser,
  getOrCreateBillingUser,
  publicBillingStatus,
} from "../../../../lib/billing-store";
import { getCurrentUser } from "../../../../lib/current-user";
import { isBillingConfigured } from "../../../../lib/stripe";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const configured = isBillingConfigured();
  const currentUser = getCurrentUser(request);
  if (!currentUser) {
    return Response.json({
      configured,
      authenticated: false,
    });
  }

  try {
    const user = await getOrCreateBillingUser(currentUser);
    const status = await getBillingStatusForUser(user.id);
    return Response.json({
      configured,
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
    return Response.json(
      { error: "利用状況を読み込めませんでした。" },
      { status: 500 },
    );
  }
}
