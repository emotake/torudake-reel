import { getUsageReservationState } from "../../../../lib/billing-store";
import { authenticationRequired } from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";

const MAX_USAGE_REQUEST_BYTES = 8 * 1024;
const USAGE_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

export async function POST(request: Request) {
  if (!isUsageEnforcementEnabled(request)) {
    return Response.json({ required: false });
  }
  const { currentUser } = await getUsagePrincipal(request, {
    allowTrial: true,
  });
  if (!currentUser) return authenticationRequired();

  let payload: { reservationId?: unknown; idempotencyKey?: unknown };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_USAGE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      { error: "Usage reservation status could not be read." },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  const reservationId =
    typeof payload.reservationId === "string" &&
    USAGE_KEY_PATTERN.test(payload.reservationId)
      ? payload.reservationId
      : null;
  const idempotencyKey =
    typeof payload.idempotencyKey === "string" &&
    USAGE_KEY_PATTERN.test(payload.idempotencyKey)
      ? payload.idempotencyKey
      : null;
  if (!reservationId && !idempotencyKey) {
    return Response.json(
      { error: "A reservation ID or idempotency key is required." },
      { status: 400 },
    );
  }

  const state = await getUsageReservationState(currentUser, {
    reservationId,
    idempotencyKey,
  });
  if (!state) {
    return Response.json(
      { required: true, status: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { reservation, ...publicState } = state;
  return Response.json(
    { required: true, ...publicState, bucket: reservation.bucket },
    { headers: { "Cache-Control": "no-store" } },
  );
}
