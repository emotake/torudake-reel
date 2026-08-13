import {
  completeUsage,
  getUsageReservationState,
} from "../../../../lib/billing-store";
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
    return Response.json({ completed: true });
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
  const completed = await completeUsage(currentUser, payload.reservationId);
  const state = await getUsageReservationState(currentUser, {
    reservationId: payload.reservationId,
  });
  const publicState = state
    ? {
        reservationId: state.reservationId,
        idempotencyKey: state.idempotencyKey,
        status: state.status,
        expiresAt: state.expiresAt,
        ttlSeconds: state.ttlSeconds,
        releasePending: state.releasePending,
        renewable: state.renewable,
      }
    : {};
  return Response.json(
    {
      completed,
      status: state?.status ?? "not_found",
      ...publicState,
    },
    {
      status: completed ? 200 : state ? 409 : 404,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
