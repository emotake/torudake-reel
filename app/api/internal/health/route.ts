import {
  authorizeDetailedHealth,
  detailedOperationalHealth,
  isDetailedHealthConfigured,
} from "../../../../lib/health";
import {
  getRequestIdentifiers,
  logOperationalEvent,
} from "../../../../lib/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { requestId, correlationId } = getRequestIdentifiers(request);
  if (!isDetailedHealthConfigured()) {
    logOperationalEvent("error", request, {
      event: "detailed_health_unconfigured",
      component: "health",
      operation: "authenticate_probe",
      status: 503,
      outcome: "not_configured",
      errorCode: "operations_secret_missing",
      requestId,
      correlationId,
    });
    return privateJson(
      { error: "Detailed health is unavailable.", requestId },
      { status: 503 },
    );
  }
  if (!(await authorizeDetailedHealth(request))) {
    logOperationalEvent("warn", request, {
      event: "detailed_health_access_denied",
      component: "health",
      operation: "authenticate_probe",
      status: 401,
      outcome: "denied",
      errorCode: "invalid_operations_secret",
      requestId,
      correlationId,
    });
    return privateJson(
      { error: "Authentication required.", requestId },
      { status: 401 },
    );
  }

  const health = await detailedOperationalHealth();
  if (!health.ready) {
    logOperationalEvent("error", request, {
      event: "detailed_readiness_failed",
      component: "health",
      operation: "dependency_probe",
      status: 503,
      outcome: "not_ready",
      errorCode: "dependency_unavailable",
      requestId,
      correlationId,
    });
  }
  return privateJson(
    {
      status: health.ready ? "ready" : "not_ready",
      requestId,
      correlationId,
      timestamp: new Date().toISOString(),
      checks: health.checks,
    },
    { status: health.ready ? 200 : 503 },
  );
}

function privateJson(body: Record<string, unknown>, init: ResponseInit) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Authorization, X-Operations-Key");
  return response;
}
