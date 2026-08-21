import {
  oidcCallbackFinalizationPage,
  oidcBrowserErrorResponse,
} from "../../../../../../lib/oidc-auth";
import {
  lineAuthenticationError,
  logLineAuthenticationEvent,
} from "../../../../../../lib/auth-observability";

export async function GET(request: Request) {
  try {
    const response = oidcCallbackFinalizationPage(request, "line");
    logLineAuthenticationEvent(request, {
      event: "line_oidc_callback_received",
      operation: "callback",
      severity: "info",
      outcome: "received",
      status: response.status,
    });
    return response;
  } catch (error) {
    const response = oidcBrowserErrorResponse(request, error, "complete");
    const normalized = lineAuthenticationError(response);
    logLineAuthenticationEvent(request, {
      event: "line_oidc_callback_rejected",
      operation: "callback",
      severity: normalized.status >= 500 ? "error" : "warn",
      outcome: "rejected",
      status: response.status,
      errorCode: normalized.errorCode,
      category: normalized.category,
      trustedChallenge: false,
    });
    return response;
  }
}
