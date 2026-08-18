import {
  beginOidcAuthorization,
  oidcAuthErrorResponse,
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
    const normalized = lineAuthenticationError(error);
    const response = oidcAuthErrorResponse(error);
    logLineAuthenticationEvent(request, {
      event: "line_oidc_start_rejected",
      operation: "start",
      severity: normalized.status >= 500 ? "error" : "warn",
      outcome: "rejected",
      status: response.status,
      errorCode: normalized.errorCode,
    });
    return response;
  }
}
