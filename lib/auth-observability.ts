import { env } from "cloudflare:workers";
import {
  createRequestLogContext,
  logOperationalEvent,
  type OperationalLogSeverity,
} from "./observability";

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const AUTH_ANALYTICS_INDEX = "line";
const AUTH_TERMINAL_CATEGORIES = new Set([
  "success",
  "cancelled",
  "request",
  "identity",
  "upstream",
  "server",
] as const);

type AuthenticationTerminalCategory =
  | "success"
  | "cancelled"
  | "request"
  | "identity"
  | "upstream"
  | "server";

type AuthAnalyticsDataset = {
  writeDataPoint: (event: {
    indexes: string[];
    blobs: string[];
    doubles: number[];
  }) => void;
};

export type LineAuthenticationEvent =
  | "line_oidc_start_succeeded"
  | "line_oidc_start_rejected"
  | "line_oidc_callback_received"
  | "line_oidc_callback_rejected"
  | "line_oidc_completion_succeeded"
  | "line_oidc_completion_cancelled"
  | "line_oidc_completion_failed";

export type LineAuthenticationLogFields = {
  event: LineAuthenticationEvent;
  operation: "start" | "callback" | "finalize";
  severity: OperationalLogSeverity;
  outcome: "succeeded" | "received" | "cancelled" | "rejected" | "failed";
  status: number;
  errorCode?: string | null;
  category?: AuthenticationTerminalCategory;
  trustedChallenge?: boolean;
};

export function safeAuthenticationErrorCode(value: unknown) {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value)
    ? value
    : undefined;
}

export function lineAuthenticationError(response: Response) {
  const statusHeader = response.headers.get("x-torudake-auth-status") ?? "";
  const status = /^(?:[4-5][0-9]{2})$/u.test(statusHeader)
    ? Number(statusHeader)
    : 500;
  const reportedCategory = response.headers.get("x-torudake-auth-category");
  const category = isAuthenticationTerminalCategory(reportedCategory) &&
      reportedCategory !== "success" && reportedCategory !== "cancelled"
    ? reportedCategory
    : status >= 500
      ? ("server" as const)
      : ("request" as const);
  return {
    errorCode: safeAuthenticationErrorCode(
      response.headers.get("x-torudake-auth-code"),
    ) ?? "oidc_unexpected_error",
    status,
    category,
  };
}

export function classifyLineAuthenticationCompletion(response: Response) {
  const reportedOutcome = response.headers.get("x-torudake-auth-outcome");
  const categoryHeader = response.headers.get("x-torudake-auth-category");
  const category = isAuthenticationTerminalCategory(categoryHeader)
    ? categoryHeader
    : undefined;
  const statusHeader = response.headers.get("x-torudake-auth-status") ?? "";
  const terminalStatus = /^(?:[2-5][0-9]{2})$/u.test(statusHeader)
    ? Number(statusHeader)
    : undefined;
  const trustedChallenge =
    response.headers.get("x-torudake-auth-trust") === "challenge";
  const machineCode = safeAuthenticationErrorCode(
    response.headers.get("x-torudake-auth-code"),
  );
  const outcome =
    reportedOutcome === "succeeded" ||
      reportedOutcome === "cancelled" ||
      reportedOutcome === "failed"
      ? reportedOutcome
      : undefined;

  const validTerminalMetadata = Boolean(
    outcome &&
      category &&
      terminalStatus &&
      ((outcome === "succeeded" &&
          category === "success" &&
          terminalStatus >= 200 && terminalStatus < 300) ||
        (outcome === "cancelled" &&
          category === "cancelled" && terminalStatus >= 400) ||
        (outcome === "failed" &&
          category !== "success" &&
          category !== "cancelled" &&
          terminalStatus >= 400)),
  );
  if (!validTerminalMetadata) {
    const status = response.status >= 400 ? response.status : 500;
    return {
      event: "line_oidc_completion_failed" as const,
      severity: status >= 500 ? ("error" as const) : ("warn" as const),
      outcome: "failed" as const,
      errorCode: "oidc_untrusted_terminal_response",
      status,
      category: status >= 500 ? ("server" as const) : ("request" as const),
      trustedChallenge: false,
    };
  }
  if (outcome === "cancelled") {
    return {
      event: "line_oidc_completion_cancelled" as const,
      severity: "info" as const,
      outcome: "cancelled" as const,
      errorCode: machineCode ?? "oidc_authorization_cancelled",
      status: terminalStatus as number,
      category: "cancelled" as const,
      trustedChallenge,
    };
  }
  if (outcome === "failed") {
    const failureCategory = category as Exclude<
      AuthenticationTerminalCategory,
      "success" | "cancelled"
    >;
    const status = terminalStatus as number;
    return {
      event: "line_oidc_completion_failed" as const,
      severity:
        failureCategory === "upstream" ||
          failureCategory === "server" ||
          status >= 500
          ? ("error" as const)
          : ("warn" as const),
      outcome: "failed" as const,
      errorCode: machineCode ?? `oidc_${failureCategory}_failed`,
      status,
      category: failureCategory,
      trustedChallenge,
    };
  }
  return {
    event: "line_oidc_completion_succeeded" as const,
    severity: "info" as const,
    outcome: "succeeded" as const,
    errorCode: undefined,
    status: terminalStatus as number,
    category: "success" as const,
    trustedChallenge,
  };
}

export function shouldWriteLineAuthenticationAnalytics(
  fields: LineAuthenticationLogFields,
) {
  if (fields.status >= 500) return true;
  if (fields.event === "line_oidc_start_succeeded") return true;
  return fields.trustedChallenge === true &&
    (fields.event === "line_oidc_completion_succeeded" ||
      fields.event === "line_oidc_completion_cancelled" ||
      fields.event === "line_oidc_completion_failed");
}

export function logLineAuthenticationEvent(
  request: Request,
  fields: LineAuthenticationLogFields,
  analytics: AuthAnalyticsDataset | undefined = env.AUTH_OBSERVABILITY,
) {
  // Public request/correlation headers are useful for routine operations, but
  // authentication telemetry must not persist an attacker-selected value. A
  // fresh server UUID also prevents a syntactically valid JWT fragment from
  // being smuggled into the durable Analytics Engine dataset.
  const requestId = crypto.randomUUID();
  const context = createRequestLogContext(request, {
    requestId,
    correlationId: requestId,
  });
  const errorCode = safeAuthenticationErrorCode(fields.errorCode);
  logOperationalEvent(fields.severity, request, {
    event: fields.event,
    component: "authentication",
    operation: fields.operation,
    status: fields.status,
    outcome: fields.outcome,
    errorCode,
    requestId: context.requestId,
    correlationId: context.correlationId,
  });

  if (!shouldWriteLineAuthenticationAnalytics(fields)) return;

  if (!analytics) {
    console.warn({
      schemaVersion: 1,
      severity: "warn",
      service: "torudake-reel",
      component: "authentication",
      event: "line_auth_analytics_binding_missing",
      operation: fields.operation,
      outcome: "degraded",
      requestId: context.requestId,
      correlationId: context.correlationId,
      method: context.method,
      path: context.path,
    });
    return;
  }
  try {
    // Column order is a versioned contract documented in
    // docs/operations/line-auth-observability.md. Values intentionally omit
    // URL queries, authorization codes, state/nonce values, provider subjects,
    // identity hashes, email addresses, cookies, IP addresses and user agents.
    analytics.writeDataPoint({
      indexes: [AUTH_ANALYTICS_INDEX],
      blobs: [
        "1",
        fields.event,
        fields.severity,
        fields.operation,
        fields.outcome,
        errorCode ?? "",
        context.method,
        context.path,
        context.requestId,
        context.correlationId,
      ],
      doubles: [fields.status],
    });
  } catch {
    console.warn({
      schemaVersion: 1,
      severity: "warn",
      service: "torudake-reel",
      component: "authentication",
      event: "line_auth_analytics_write_failed",
      operation: fields.operation,
      outcome: "degraded",
      requestId: context.requestId,
      correlationId: context.correlationId,
      method: context.method,
      path: context.path,
    });
  }
}

function isAuthenticationTerminalCategory(
  value: unknown,
): value is AuthenticationTerminalCategory {
  return typeof value === "string" &&
    AUTH_TERMINAL_CATEGORIES.has(value as AuthenticationTerminalCategory);
}
