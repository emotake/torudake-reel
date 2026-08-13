const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_LOG_STRING_LENGTH = 240;

export type OperationalLogSeverity = "error" | "warn" | "info";

export type OperationalLogFields = {
  event: string;
  component:
    | "billing"
    | "stripe_webhook"
    | "ai"
    | "health"
    | "runtime"
    | "account_deletion";
  operation?: string;
  status?: number;
  outcome?: string;
  errorCode?: string | null;
  upstreamRequestId?: string | null;
  upstreamStatus?: number | null;
  eventType?: string | null;
  error?: unknown;
  requestId?: string;
  correlationId?: string;
};

function safeIdentifier(value: string | null) {
  const normalized = value?.trim() ?? "";
  return REQUEST_ID_PATTERN.test(normalized) ? normalized : "";
}

function safeLogString(value: string | null | undefined) {
  if (!value) return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, MAX_LOG_STRING_LENGTH) || undefined;
}

export function getRequestIdentifiers(request: Request) {
  const requestId =
    safeIdentifier(request.headers.get("x-request-id")) || crypto.randomUUID();
  const correlationId =
    safeIdentifier(request.headers.get("x-correlation-id")) || requestId;
  return { requestId, correlationId };
}

export function createRequestLogContext(
  request: Request,
  identifiers?: { requestId?: string; correlationId?: string },
) {
  const generated = getRequestIdentifiers(request);
  const requestId =
    safeIdentifier(identifiers?.requestId ?? null) || generated.requestId;
  const correlationId =
    safeIdentifier(identifiers?.correlationId ?? null) ||
    generated.correlationId ||
    requestId;
  const url = new URL(request.url);
  return {
    requestId,
    correlationId,
    method: request.method,
    path: url.pathname,
    cfRay: safeLogString(request.headers.get("cf-ray")),
  };
}

export function logOperationalEvent(
  severity: OperationalLogSeverity,
  request: Request,
  fields: OperationalLogFields,
) {
  const errorName = fields.error instanceof Error
    ? fields.error.name
    : fields.error
      ? "NonErrorThrown"
      : undefined;
  const payload = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    severity,
    service: "torudake-reel",
    ...createRequestLogContext(request, fields),
    event: safeLogString(fields.event) ?? "operational_event",
    component: fields.component,
    operation: safeLogString(fields.operation),
    status: Number.isInteger(fields.status) ? fields.status : undefined,
    outcome: safeLogString(fields.outcome),
    errorCode: safeLogString(fields.errorCode),
    upstreamRequestId: safeIdentifier(fields.upstreamRequestId ?? null) || undefined,
    upstreamStatus: Number.isInteger(fields.upstreamStatus)
      ? fields.upstreamStatus
      : undefined,
    eventType: safeLogString(fields.eventType),
    errorName,
  };

  // Passing the object itself (instead of interpolating text) keeps each field
  // independently searchable in Workers logs and Pages deployment tails.
  console[severity](payload);
}

export function withRequestIdentifier(
  response: Response,
  request: Request,
  requestId?: string,
) {
  response.headers.set(
    "X-Request-Id",
    safeIdentifier(requestId ?? null) || getRequestIdentifiers(request).requestId,
  );
  return response;
}
