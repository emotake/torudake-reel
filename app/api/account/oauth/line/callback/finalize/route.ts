import {
  completeOidcAuthorization,
  OidcAuthError,
  oidcBrowserErrorResponse,
} from "../../../../../../../lib/oidc-auth";
import {
  classifyLineAuthenticationCompletion,
  lineAuthenticationError,
  logLineAuthenticationEvent,
} from "../../../../../../../lib/auth-observability";
import { isSameOriginMutation } from "../../../../../../../lib/operator-session";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    const response = oidcBrowserErrorResponse(
      request,
      new OidcAuthError(
        "invalid_request_origin",
        403,
        "この画面からもう一度お試しください。",
      ),
      "complete",
    );
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
    const response = oidcBrowserErrorResponse(request, error, "complete");
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
