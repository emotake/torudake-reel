import { releaseUsage } from "../../../../lib/billing-store";
import { authenticationRequired } from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";

export async function POST(request: Request) {
  if (!isUsageEnforcementEnabled()) {
    return Response.json({ released: true });
  }
  const { currentUser } = await getUsagePrincipal(request, {
    allowTrial: true,
  });
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
