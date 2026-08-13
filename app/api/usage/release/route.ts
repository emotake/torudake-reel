import { requestUsageRelease } from "../../../../lib/billing-store";
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
  let payload: { reservationId?: string; idempotencyKey?: string } | null = null;
  try {
    payload = await parseJsonBodyWithLimit<{
      reservationId?: string;
      idempotencyKey?: string;
    }>(
      request,
      MAX_USAGE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      { error: "利用記録を確認できませんでした。" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const reservationId =
    typeof payload?.reservationId === "string" &&
    /^[a-zA-Z0-9_-]{8,100}$/.test(payload.reservationId)
      ? payload.reservationId
      : null;
  const idempotencyKey =
    typeof payload?.idempotencyKey === "string" &&
    /^[a-zA-Z0-9_-]{8,100}$/.test(payload.idempotencyKey)
      ? payload.idempotencyKey
      : null;
  if (!reservationId && !idempotencyKey) {
    return Response.json({ error: "利用記録が見つかりません。" }, { status: 400 });
  }
  const result = await requestUsageRelease(currentUser, {
    reservationId,
    idempotencyKey,
  });
  return Response.json(result, {
    status: result.status === "not_found" ? 404 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
