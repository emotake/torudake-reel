import { env } from "cloudflare:workers";

export type BillingRateLimitAction =
  | "one_time_checkout"
  | "portal"
  | "billing_documents";

const POLICIES: Record<
  BillingRateLimitAction,
  { limit: number; windowSeconds: number }
> = {
  one_time_checkout: { limit: 5, windowSeconds: 10 * 60 },
  portal: { limit: 10, windowSeconds: 10 * 60 },
  billing_documents: { limit: 20, windowSeconds: 10 * 60 },
};

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
};

export type BillingRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Fixed-window, per-account limiter persisted in D1. The UPSERT is one atomic
 * statement, so parallel requests cannot all observe the same old counter.
 */
export async function consumeBillingRateLimit(
  userId: string,
  action: BillingRateLimitAction,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<BillingRateLimitResult> {
  if (!userId || userId.length > 255) {
    throw new Error("Billing rate-limit user is invalid.");
  }
  const database = databaseOrThrow();
  const policy = POLICIES[action];
  const resetBefore = nowSeconds - policy.windowSeconds;
  const row = await database
    .prepare(`
      INSERT INTO billing_rate_limits (
        user_id, action, window_started_at, attempts, updated_at
      ) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(user_id, action) DO UPDATE SET
        window_started_at = CASE
          WHEN billing_rate_limits.window_started_at <= ?
            THEN excluded.window_started_at
          ELSE billing_rate_limits.window_started_at
        END,
        attempts = CASE
          WHEN billing_rate_limits.window_started_at <= ? THEN 1
          ELSE billing_rate_limits.attempts + 1
        END,
        updated_at = excluded.updated_at
      RETURNING attempts, window_started_at
    `)
    .bind(
      userId,
      action,
      nowSeconds,
      nowSeconds,
      resetBefore,
      resetBefore,
    )
    .first<{ attempts: number; window_started_at: number }>();
  if (!row) throw new Error("Billing rate limit could not be recorded.");

  const attempts = Math.max(0, Number(row.attempts) || 0);
  const windowStartedAt = Number(row.window_started_at) || nowSeconds;
  const allowed = attempts <= policy.limit;
  return {
    allowed,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - attempts),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, windowStartedAt + policy.windowSeconds - nowSeconds),
  };
}

export function billingRateLimitedResponse(
  result: BillingRateLimitResult,
  message = "操作が続いたため、少し待ってからもう一度お試しください。",
) {
  const response = Response.json(
    {
      error: message,
      code: "billing_rate_limited",
      retryAfterSeconds: result.retryAfterSeconds,
    },
    { status: 429 },
  );
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Retry-After", String(result.retryAfterSeconds));
  response.headers.set("Vary", "Cookie");
  return response;
}

function databaseOrThrow() {
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare) {
    throw new Error("Billing database binding is unavailable.");
  }
  return database;
}
