import { revokeAllAccountSessions } from "../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
} from "../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../lib/operator-session";
import { clearTrialSessionCookie } from "../../../../lib/trial-session";
import { revokeTrialSession } from "../../../../lib/trial-session-store";

export async function DELETE(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
      { status: 403 },
    );
  }
  try {
    const accountCookie = await revokeAllAccountSessions(request);
    await revokeTrialSession(request).catch(() => undefined);
    const secure = new URL(request.url).protocol === "https:";
    const response = privateJson({ authenticated: false, revoked: true });
    response.headers.append("Set-Cookie", accountCookie);
    response.headers.append("Set-Cookie", clearTrialSessionCookie(secure));
    return response;
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}
