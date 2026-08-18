import {
  completeOidcAuthorization,
  oidcAuthErrorResponse,
} from "../../../../../../../lib/oidc-auth";
import {
  classifyLineAuthenticationCompletion,
  lineAuthenticationError,
  logLineAuthenticationEvent,
} from "../../../../../../../lib/auth-observability";
import { privateJson } from "../../../../../../../lib/account-auth-http";
import { isSameOriginMutation } from "../../../../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    const response = privateJson(
      {
        error: "この画面からもう一度お試しください。",
        code: "invalid_request_origin",
      },
      { status: 403 },
    );
    logLineAuthenticationEvent(request, {
      event: "line_oidc_callback_rejected",
      operation: "finalize",
      severity: "warn",
      outcome: "rejected",
      status: response.status,
      errorCode: "invalid_request_origin",
    });
    return response;
  }
  try {
    const response = await completeOidcAuthorization(request, "line");
    const completion = classifyLineAuthenticationCompletion(response);
    logLineAuthenticationEvent(request, {
      ...completion,
      operation: "finalize",
      status: response.status,
    });
    return response;
  } catch (error) {
    const normalized = lineAuthenticationError(error);
    const response = oidcAuthErrorResponse(error);
    logLineAuthenticationEvent(request, {
      event: "line_oidc_completion_failed",
      operation: "finalize",
      severity: normalized.status >= 500 ? "error" : "warn",
      outcome: "failed",
      status: response.status,
      errorCode: normalized.errorCode,
    });
    return response;
  }
}
