import {
  AccountDeletionProcessingError,
  OperatorUsageLimitError,
  getAiEntitlementBudgetForReservation,
  publicUsageReservationState,
  reserveUsage,
  UsageReservationBusyError,
  UsageReservationConflictError,
  UsageLimitError,
} from "../../../../lib/billing-store";
import { getAiOperationSuccessLimit } from "../../../../lib/billing-policy";
import { authenticationRequired } from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";
import { validateVideoInputDuration } from "../../../../lib/video-input-policy";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";

const MAX_USAGE_REQUEST_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!isUsageEnforcementEnabled(request)) {
    return Response.json({ required: false });
  }
  const { currentUser, isOperator } = await getUsagePrincipal(request, {
    allowTrial: true,
  });
  if (!currentUser) return authenticationRequired();

  let payload: {
    sourceDurationSeconds?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_USAGE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "送信データが大きすぎます。"
            : "動画の長さを確認できませんでした。",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }

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
  const duration = durationResult.durationSeconds;
  if (
    typeof payload.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(payload.idempotencyKey)
  ) {
    return Response.json({ error: "もう一度動画を選び直してください。" }, { status: 400 });
  }

  try {
    const reservation = await reserveUsage(
      currentUser,
      duration,
      payload.idempotencyKey,
      { operator: isOperator },
    );
    const perVideoLimit = getAiOperationSuccessLimit(reservation.bucket);
    const entitlementBudget = await getAiEntitlementBudgetForReservation(
      reservation,
    );
    const remaining = Math.min(perVideoLimit, entitlementBudget.remaining);
    const publicState = publicUsageReservationState(reservation);
    return Response.json({
      required: true,
      ...publicState,
      bucket: reservation.bucket,
      reservationOutcome: reservation.reservationOutcome,
      reused: reservation.reservationOutcome !== "created",
      aiOperationLimit: getAiOperationSuccessLimit(reservation.bucket),
      aiOperationsRemaining: remaining,
      // Compatibility for an editor tab opened before this deployment.
      narrationGenerationLimit: perVideoLimit,
      narrationGenerationsRemaining: remaining,
    });
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
    console.error("usage reservation failed", error);
    return Response.json(
      { error: "利用枠を確認できませんでした。" },
      { status: 500 },
    );
  }
}
