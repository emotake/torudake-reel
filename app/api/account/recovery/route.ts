import { createAccountRecoveryChallenge } from "../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
  readAuthJson,
} from "../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
      { status: 403 },
    );
  }
  try {
    const payload = await readAuthJson(request);
    const result = await createAccountRecoveryChallenge(
      request,
      "billingEmail" in payload ? payload.billingEmail : undefined,
    );
    return privateJson({
      accepted: true,
      reference: result.reference,
      message:
        "該当するアカウントがある場合もない場合も、同じ受付結果を表示しています。受付番号を添えて運営へご連絡ください。",
    });
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}
