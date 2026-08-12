import { authorizeUsageOperation } from "../../../../lib/billing-store";
import { getCurrentUser } from "../../../../lib/current-user";
import { recordNarrationDisclosureConfirmation } from "../../../../lib/narration-disclosure-store";
import { NARRATION_TERMS_VERSION } from "../../../../lib/narration";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { markOperatorUsageOperationSucceeded } from "../../../../lib/operator-usage";
import { isSameOriginMutation } from "../../../../lib/operator-session";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const MAX_DISCLOSURE_REQUEST_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return Response.json(
      { error: "この画面からもう一度お試しください。" },
      { status: 403 },
    );
  }

  const usageEnforcementEnabled = isUsageEnforcementEnabled(request);
  const usagePrincipal = usageEnforcementEnabled
    ? await getUsagePrincipal(request, { allowTrial: true })
    : null;
  const currentUser = usageEnforcementEnabled
    ? usagePrincipal?.currentUser ?? null
    : await getCurrentUser(request);

  let payload: {
    confirmationId?: unknown;
    clientSessionId?: unknown;
    termsVersion?: unknown;
    confirmed?: unknown;
    usageReservationId?: unknown;
  };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_DISCLOSURE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "確認内容の送信サイズが大きすぎます。"
            : "確認内容を読み取れませんでした。",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }

  if (
    payload.confirmed !== true ||
    typeof payload.confirmationId !== "string" ||
    typeof payload.clientSessionId !== "string" ||
    !ID_PATTERN.test(payload.confirmationId) ||
    !ID_PATTERN.test(payload.clientSessionId) ||
    payload.termsVersion !== NARRATION_TERMS_VERSION
  ) {
    return Response.json({ error: "確認内容が正しくありません。" }, { status: 400 });
  }

  let authorizedReservationId: string | null = null;
  if (usageEnforcementEnabled) {
    const reservationId =
      typeof payload.usageReservationId === "string"
        ? payload.usageReservationId.trim()
        : "";
    const authorization =
      currentUser && reservationId
        ? await authorizeUsageOperation(
            currentUser,
            reservationId,
            "narration_disclosure",
          )
        : null;
    if (!authorization?.allowed) {
      return Response.json(
        {
          error:
            authorization?.reason === "operator_operation_limit"
              ? "この動画での確認回数が上限に達しました。"
              : "動画の利用記録を確認できませんでした。画面を開き直してお試しください。",
        },
        {
          status:
            authorization?.reason === "operator_operation_limit"
              ? 429
              : currentUser
                ? 402
                : 401,
        },
      );
    }
    authorizedReservationId = authorization.reservation.id;
  }

  try {
    const confirmation = await recordNarrationDisclosureConfirmation({
      confirmationId: payload.confirmationId,
      clientSessionId: payload.clientSessionId,
      termsVersion: NARRATION_TERMS_VERSION,
      currentUser,
    });
    if (
      authorizedReservationId &&
      !(await markOperatorUsageOperationSucceeded(
        authorizedReservationId,
        "narration_disclosure",
      ))
    ) {
      throw new Error("Failed to record disclosure usage success.");
    }
    return Response.json(
      {
        recorded: true,
        confirmationId: confirmation.confirmationId ?? payload.confirmationId,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("AI narration disclosure confirmation failed", error);
    return Response.json(
      { error: "確認を記録できませんでした。もう一度お試しください。" },
      { status: 500 },
    );
  }
}
