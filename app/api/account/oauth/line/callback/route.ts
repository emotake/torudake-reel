import {
  oidcCallbackFinalizationPage,
  oidcAuthErrorResponse,
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
    const normalized = lineAuthenticationError(error);
    const response = oidcAuthErrorResponse(error);
    logLineAuthenticationEvent(request, {
      event: "line_oidc_callback_rejected",
      operation: "callback",
      severity: normalized.status >= 500 ? "error" : "warn",
      outcome: "rejected",
      status: response.status,
      errorCode: normalized.errorCode,
    });
    return response;
  }
}
