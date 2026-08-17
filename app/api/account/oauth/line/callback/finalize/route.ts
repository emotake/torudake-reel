import {
  completeOidcAuthorization,
  oidcAuthErrorResponse,
} from "../../../../../../../lib/oidc-auth";
import { privateJson } from "../../../../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      {
        error: "この画面からもう一度お試しください。",
        code: "invalid_request_origin",
      },
      { status: 403 },
    );
  }
  try {
    return await completeOidcAuthorization(request, "line");
  } catch (error) {
    return oidcAuthErrorResponse(error);
  }
}
