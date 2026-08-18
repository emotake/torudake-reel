import {
  applyOidcTerminalResponseHeaders,
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
    applyOidcTerminalResponseHeaders(response, {
      errorCode: "invalid_request_origin",
      status: 403,
      category: "request",
      trustedChallenge: false,
    });
    logLineAuthenticationEvent(request, {
      event: "line_oidc_callback_rejected",
      operation: "finalize",
      severity: "warn",
      outcome: "rejected",
      status: response.status,
      errorCode: "invalid_request_origin",
      category: "request",
      trustedChallenge: false,
    });
    return response;
  }
  try {
    const response = await completeOidcAuthorization(request, "line");
    const completion = classifyLineAuthenticationCompletion(response);
    logLineAuthenticationEvent(request, {
      ...completion,
      operation: "finalize",
    });
    return response;
  } catch (error) {
    const response = oidcAuthErrorResponse(error);
    const normalized = lineAuthenticationError(response);
    logLineAuthenticationEvent(request, {
      event: "line_oidc_completion_failed",
      operation: "finalize",
      severity: normalized.status >= 500 ? "error" : "warn",
      outcome: "failed",
      status: response.status,
      errorCode: normalized.errorCode,
      category: normalized.category,
      trustedChallenge: false,
    });
    return response;
  }
}
