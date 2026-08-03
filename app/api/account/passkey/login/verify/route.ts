import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { verifyAuthentication } from "../../../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
  readAuthJson,
} from "../../../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "この画面からもう一度お試しください。", code: "invalid_request_origin" },
      { status: 403 },
    );
  }
  try {
    const credential = (await readAuthJson(request)) as AuthenticationResponseJSON;
    const result = await verifyAuthentication(request, credential);
    const response = privateJson({ authenticated: true });
    response.headers.append("Set-Cookie", result.sessionCookie);
    response.headers.append("Set-Cookie", result.challengeCookie);
    return response;
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}
