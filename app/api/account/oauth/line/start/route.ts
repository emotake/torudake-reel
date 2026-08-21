import {
  beginOidcAuthorization,
  oidcBrowserErrorResponse,
} from "../../../../../../lib/oidc-auth";
import {
  lineAuthenticationError,
  logLineAuthenticationEvent,
} from "../../../../../../lib/auth-observability";

export async function GET(request: Request) {
  try {
    const response = await beginOidcAuthorization(request, "line");
    logLineAuthenticationEvent(request, {
      event: "line_oidc_start_succeeded",
      operation: "start",
      severity: "info",
      outcome: "succeeded",
      status: response.status,
    });
    return response;
  } catch (error) {
    const response = oidcBrowserErrorResponse(request, error, "start");
    const normalized = lineAuthenticationError(response);
    logLineAuthenticationEvent(request, {
      event: "line_oidc_start_rejected",
      operation: "start",
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
