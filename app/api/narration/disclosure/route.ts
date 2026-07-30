import { getCurrentUser } from "../../../../lib/current-user";
import { recordNarrationDisclosureConfirmation } from "../../../../lib/narration-disclosure-store";
import { NARRATION_TERMS_VERSION } from "../../../../lib/narration";

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;

export async function POST(request: Request) {
  let payload: {
    confirmationId?: unknown;
    clientSessionId?: unknown;
    termsVersion?: unknown;
    confirmed?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "確認内容を読み取れませんでした。" }, { status: 400 });
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

  try {
    const confirmation = await recordNarrationDisclosureConfirmation({
      confirmationId: payload.confirmationId,
      clientSessionId: payload.clientSessionId,
      termsVersion: NARRATION_TERMS_VERSION,
      currentUser: getCurrentUser(request),
    });
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
