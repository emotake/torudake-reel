import { env } from "cloudflare:workers";

export const OPERATOR_ENROLLMENT_MAX_ATTEMPTS = 6;
export const OPERATOR_ENROLLMENT_WINDOW_SECONDS = 15 * 60;

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

let throttleSchemaReady = false;

async function ensureThrottleSchema() {
  if (throttleSchemaReady) return;
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare || !database?.batch) {
    throw new Error("Operator enrollment database binding is unavailable.");
  }
  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS operator_enrollment_attempts (
        fingerprint text PRIMARY KEY NOT NULL,
        window_started_at integer NOT NULL,
        attempts integer DEFAULT 1 NOT NULL,
        blocked_until integer DEFAULT 0 NOT NULL,
        updated_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS operator_enrollment_attempts_updated_at_idx
      ON operator_enrollment_attempts (updated_at)
    `),
  ]);
  throttleSchemaReady = true;
}

export async function isOperatorEnrollmentBlocked(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureThrottleSchema();
  const fingerprint = await enrollmentFingerprint(request);
  const row = await database()
    .prepare(`
      SELECT attempts, window_started_at, blocked_until
      FROM operator_enrollment_attempts
      WHERE fingerprint = ?
      LIMIT 1
    `)
    .bind(fingerprint)
    .first<{
      attempts: number;
      window_started_at: number;
      blocked_until: number;
    }>();
  return Boolean(row && row.blocked_until > nowSeconds);
}

export async function recordOperatorEnrollmentFailure(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureThrottleSchema();
  const fingerprint = await enrollmentFingerprint(request);
  const resetBefore =
    nowSeconds - OPERATOR_ENROLLMENT_WINDOW_SECONDS;
  const blockedUntil =
    nowSeconds + OPERATOR_ENROLLMENT_WINDOW_SECONDS;
  const row = await database()
    .prepare(`
      INSERT INTO operator_enrollment_attempts (
        fingerprint,
        window_started_at,
        attempts,
        blocked_until,
        updated_at
      )
      VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        attempts = CASE
          WHEN operator_enrollment_attempts.window_started_at <= ?
            THEN 1
          ELSE operator_enrollment_attempts.attempts + 1
        END,
        window_started_at = CASE
          WHEN operator_enrollment_attempts.window_started_at <= ?
            THEN ?
          ELSE operator_enrollment_attempts.window_started_at
        END,
        blocked_until = CASE
          WHEN (
            CASE
              WHEN operator_enrollment_attempts.window_started_at <= ?
                THEN 1
              ELSE operator_enrollment_attempts.attempts + 1
            END
          ) >= ?
            THEN ?
          ELSE 0
        END,
        updated_at = excluded.updated_at
      RETURNING attempts, blocked_until
    `)
    .bind(
      fingerprint,
      nowSeconds,
      nowSeconds,
      resetBefore,
      resetBefore,
      nowSeconds,
      resetBefore,
      OPERATOR_ENROLLMENT_MAX_ATTEMPTS,
      blockedUntil,
    )
    .first<{ attempts: number; blocked_until: number }>();
  return {
    attempts: row?.attempts ?? 1,
    blocked: Boolean(row && row.blocked_until > nowSeconds),
  };
}

export async function clearOperatorEnrollmentFailures(request: Request) {
  await ensureThrottleSchema();
  const fingerprint = await enrollmentFingerprint(request);
  await database()
    .prepare(
      "DELETE FROM operator_enrollment_attempts WHERE fingerprint = ?",
    )
    .bind(fingerprint)
    .run();
}

function database() {
  return env.DB as unknown as D1Database;
}

async function enrollmentFingerprint(request: Request) {
  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const source = [
    request.headers.get("cf-connecting-ip")?.trim() ||
      forwardedFor ||
      "unknown-network",
    request.headers.get("user-agent")?.slice(0, 240) || "unknown-agent",
  ].join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
