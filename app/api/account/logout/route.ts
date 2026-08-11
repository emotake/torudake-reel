import { revokeAccountSession } from "../../../../lib/account-auth";
import { privateJson } from "../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../lib/operator-session";
import { clearTrialSessionCookie } from "../../../../lib/trial-session";
import { revokeTrialSession } from "../../../../lib/trial-session-store";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
      { status: 403 },
    );
  }
  await revokeTrialSession(request).catch(() => undefined);
  const secure = new URL(request.url).protocol === "https:";
  const response = privateJson({ authenticated: false });
  response.headers.append("Set-Cookie", await revokeAccountSession(request));
  response.headers.append("Set-Cookie", clearTrialSessionCookie(secure));
  return response;
}
