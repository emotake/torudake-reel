import { checkDatabaseReadiness } from "../../../lib/health";
import { getRequestIdentifiers, logOperationalEvent } from "../../../lib/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { requestId, correlationId } = getRequestIdentifiers(request);
  const database = await checkDatabaseReadiness();
  if (!database.ok) {
    logOperationalEvent("error", request, {
      event: "public_readiness_failed",
      component: "health",
      operation: "database_probe",
      status: 503,
      outcome: "not_ready",
      errorCode: "database_unavailable",
      requestId,
      correlationId,
    });
  }
  return Response.json(
    {
      status: database.ok ? "ready" : "not_ready",
      requestId,
      timestamp: new Date().toISOString(),
    },
    {
      status: database.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
