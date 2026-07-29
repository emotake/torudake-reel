import { releaseUsage } from "../../../../lib/billing-store";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../../lib/current-user";
import { isBillingConfigured } from "../../../../lib/stripe";

export async function POST(request: Request) {
  if (!isBillingConfigured()) return Response.json({ released: true });
  const currentUser = getCurrentUser(request);
  if (!currentUser) return authenticationRequired();
  const payload = (await request.json().catch(() => null)) as {
    reservationId?: string;
  } | null;
  if (!payload?.reservationId) {
    return Response.json({ error: "利用記録が見つかりません。" }, { status: 400 });
  }
  const released = await releaseUsage(currentUser, payload.reservationId);
  return Response.json({ released });
}
