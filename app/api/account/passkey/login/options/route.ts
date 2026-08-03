import { authenticationOptions } from "../../../../../../lib/account-auth";
import {
  accountAuthErrorResponse,
  privateJson,
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
    const result = await authenticationOptions(request);
    const response = privateJson({ options: result.options });
    response.headers.append("Set-Cookie", result.cookie);
    return response;
  } catch (error) {
    return accountAuthErrorResponse(error);
  }
}
