import { releaseUsage } from "../../../../lib/billing-store";
import { authenticationRequired } from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";

const MAX_USAGE_REQUEST_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!isUsageEnforcementEnabled(request)) {
    return Response.json({ released: true });
  }
  const { currentUser } = await getUsagePrincipal(request, {
    allowTrial: true,
  });
  if (!currentUser) return authenticationRequired();
  let payload: { reservationId?: string } | null = null;
  try {
    payload = await parseJsonBodyWithLimit<{ reservationId?: string }>(
      request,
      MAX_USAGE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      { error: "利用記録を確認できませんでした。" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!payload?.reservationId) {
    return Response.json({ error: "利用記録が見つかりません。" }, { status: 400 });
  }
  const released = await releaseUsage(currentUser, payload.reservationId);
  return Response.json({ released });
}
