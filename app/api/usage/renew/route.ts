import {
  AccountDeletionProcessingError,
  getAiEntitlementBudgetForReservation,
  OperatorUsageLimitError,
  publicUsageReservationState,
  renewUsageReservation,
  UsageLimitError,
  UsageReservationBusyError,
  UsageReservationConflictError,
} from "../../../../lib/billing-store";
import { getAiOperationSuccessLimit } from "../../../../lib/billing-policy";
import { authenticationRequired } from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";
import { validateVideoInputDuration } from "../../../../lib/video-input-policy";

const MAX_USAGE_REQUEST_BYTES = 8 * 1024;
const USAGE_KEY_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

export async function POST(request: Request) {
  if (!isUsageEnforcementEnabled(request)) {
    return Response.json({ required: false });
  }
  const { currentUser, isOperator } = await getUsagePrincipal(request, {
    allowTrial: true,
  });
  if (!currentUser) return authenticationRequired();

  let payload: {
    reservationId?: unknown;
    idempotencyKey?: unknown;
    sourceDurationSeconds?: unknown;
  };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_USAGE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      { error: "Usage reservation could not be renewed." },
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

  let duration: number | undefined;
  if (payload.sourceDurationSeconds !== undefined) {
    const durationResult = validateVideoInputDuration(
      payload.sourceDurationSeconds,
    );
    if (!durationResult.ok) {
      return Response.json(
        {
          error: durationResult.message,
          code: durationResult.code,
          maximumSeconds: durationResult.maximumSeconds,
        },
        { status: 400 },
      );
    }
    duration = durationResult.durationSeconds;
  }

  try {
    const reservation = await renewUsageReservation(
      currentUser,
      { reservationId, idempotencyKey },
      { sourceDurationSeconds: duration, operator: isOperator },
    );
    if (!reservation) {
      return Response.json(
        { required: true, status: "not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const perVideoLimit = getAiOperationSuccessLimit(reservation.bucket);
    const entitlementBudget = await getAiEntitlementBudgetForReservation(
      reservation,
    );
    const remaining = Math.min(perVideoLimit, entitlementBudget.remaining);
    return Response.json(
      {
        required: true,
        ...publicUsageReservationState(reservation),
        bucket: reservation.bucket,
        reservationOutcome: reservation.reservationOutcome,
        reused: true,
        aiOperationLimit: perVideoLimit,
        aiOperationsRemaining: remaining,
        narrationGenerationLimit: perVideoLimit,
        narrationGenerationsRemaining: remaining,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AccountDeletionProcessingError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 409 },
      );
    }
    if (error instanceof UsageReservationConflictError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 409 },
      );
    }
    if (error instanceof UsageReservationBusyError) {
      return Response.json(
        { error: error.message, code: "usage_reservation_busy" },
        { status: 409 },
      );
    }
    if (error instanceof OperatorUsageLimitError) {
      return Response.json(
        { error: error.message, code: "operator_daily_limit_reached" },
        { status: 429 },
      );
    }
    if (error instanceof UsageLimitError) {
      return Response.json(
        { error: error.message, code: "usage_limit_reached" },
        { status: 402 },
      );
    }
    console.error("usage reservation renewal failed", error);
    return Response.json(
      { error: "Usage reservation could not be renewed." },
      { status: 500 },
    );
  }
}
