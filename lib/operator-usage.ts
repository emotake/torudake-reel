import { env } from "cloudflare:workers";

export type OperatorUsageOperation =
  | "transfer_upload"
  | "transcribe"
  | "narration_script"
  | "narration_speech"
  | "narration_disclosure";

export const OPERATOR_OPERATION_LIMITS: Record<
  OperatorUsageOperation,
  number
> = {
  transfer_upload: 2,
  transcribe: 24,
  narration_script: 8,
  narration_speech: 8,
  narration_disclosure: 4,
};

const MIN_OPERATION_LEASE_TTL_SECONDS = 30;
// A timed transcription can retry once, fall back to a second model, and then
// run the optional refinement pass. Keep the lease beyond that worst-case
// request window so a parallel call cannot enter during final refinement.
const MAX_OPERATION_LEASE_TTL_SECONDS = 300;
export const TRANSCRIPTION_LEASE_TTL_SECONDS =
  MAX_OPERATION_LEASE_TTL_SECONDS;

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

let operatorUsageSchemaReady = false;

async function ensureOperatorUsageSchema() {
  if (operatorUsageSchemaReady) return;
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare || !database?.batch) {
    throw new Error("Operator usage database binding is unavailable.");
  }

  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS operator_usage_operations (
        id text PRIMARY KEY NOT NULL,
        reservation_id text NOT NULL,
        operation text NOT NULL,
        count integer DEFAULT 1 NOT NULL,
        successful_count integer DEFAULT 0 NOT NULL,
        updated_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS operator_usage_operations_reservation_id_idx
      ON operator_usage_operations (reservation_id)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS operator_usage_operations_updated_at_idx
      ON operator_usage_operations (updated_at)
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS usage_observed_durations (
        reservation_id text PRIMARY KEY NOT NULL,
        observed_milliseconds integer DEFAULT 0 NOT NULL,
        blocked_at integer,
        updated_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS usage_observed_durations_blocked_at_idx
      ON usage_observed_durations (blocked_at)
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS usage_operation_leases (
        id text PRIMARY KEY NOT NULL,
        reservation_id text NOT NULL,
        operation text NOT NULL,
        lease_token text NOT NULL,
        acquired_at integer NOT NULL,
        expires_at integer NOT NULL,
        updated_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS usage_operation_leases_expires_at_idx
      ON usage_operation_leases (expires_at)
    `),
  ]);
  operatorUsageSchemaReady = true;
}

export type UsageOperationLease = {
  reservationId: string;
  operation: OperatorUsageOperation;
  token: string;
  expiresAt: number;
};

/**
 * Atomically obtains a short-lived, reservation-scoped operation lease.
 * Expired leases can be replaced so a terminated Worker cannot block the
 * reservation forever. The returned random token is required for release.
 */
export async function acquireUsageOperationLease(
  reservationId: string,
  operation: OperatorUsageOperation,
  requestedTtlSeconds = TRANSCRIPTION_LEASE_TTL_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<UsageOperationLease | null> {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const ttlSeconds = Math.min(
    MAX_OPERATION_LEASE_TTL_SECONDS,
    Math.max(
      MIN_OPERATION_LEASE_TTL_SECONDS,
      Math.ceil(Number.isFinite(requestedTtlSeconds) ? requestedTtlSeconds : 0),
    ),
  );
  const expiresAt = nowSeconds + ttlSeconds;
  const id = `${reservationId}:${operation}`;
  const token = crypto.randomUUID();
  const row = await database
    .prepare(`
      INSERT INTO usage_operation_leases (
        id,
        reservation_id,
        operation,
        lease_token,
        acquired_at,
        expires_at,
        updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM usage_reservations
        WHERE id = ?
          AND status IN ('reserved', 'completed')
          AND expires_at >= ?
      )
      ON CONFLICT(id) DO UPDATE SET
        lease_token = excluded.lease_token,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      WHERE usage_operation_leases.expires_at <= ?
        AND EXISTS (
          SELECT 1
          FROM usage_reservations
          WHERE id = excluded.reservation_id
            AND status IN ('reserved', 'completed')
            AND expires_at >= ?
        )
      RETURNING lease_token, expires_at
    `)
    .bind(
      id,
      reservationId,
      operation,
      token,
      nowSeconds,
      expiresAt,
      nowSeconds,
      reservationId,
      nowSeconds,
      nowSeconds,
      nowSeconds,
    )
    .first<{ lease_token: string; expires_at: number }>();

  if (!row || row.lease_token !== token) return null;
  return {
    reservationId,
    operation,
    token,
    expiresAt: row.expires_at,
  };
}

/** Releases only the exact lease held by this Worker invocation. */
export async function releaseUsageOperationLease(
  lease: UsageOperationLease,
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const id = `${lease.reservationId}:${lease.operation}`;
  const row = await database
    .prepare(`
      DELETE FROM usage_operation_leases
      WHERE id = ?
        AND reservation_id = ?
        AND operation = ?
        AND lease_token = ?
      RETURNING id
    `)
    .bind(id, lease.reservationId, lease.operation, lease.token)
    .first<{ id: string }>();
  return row?.id === id;
}

export type ObservedDurationResult =
  | {
      allowed: true;
      reason: null;
      observedSeconds: number;
    }
  | {
      allowed: false;
      reason: "duration_exceeded" | "duration_unverifiable";
      observedSeconds: null;
    };

async function blockObservedDuration(
  reservationId: string,
  nowSeconds: number,
) {
  const database = env.DB as unknown as D1Database;
  await database.batch([
    database
      .prepare(`
        INSERT INTO usage_observed_durations (
          reservation_id,
          observed_milliseconds,
          blocked_at,
          updated_at
        )
        SELECT ?, 0, ?, ?
        FROM usage_reservations
        WHERE id = ?
        ON CONFLICT(reservation_id) DO UPDATE SET
          blocked_at = COALESCE(usage_observed_durations.blocked_at, excluded.blocked_at),
          updated_at = excluded.updated_at
      `)
      .bind(reservationId, nowSeconds, nowSeconds, reservationId),
    database
      .prepare(`
        UPDATE usage_reservations
        SET status = 'completed', completed_at = COALESCE(completed_at, ?)
        WHERE id = ?
          AND status = 'reserved'
      `)
      .bind(nowSeconds, reservationId),
  ]);
}

/**
 * Charges the duration reported by OpenAI after a successful transcription.
 * The tolerance is applied once to the reservation total (not once per chunk):
 * 2%, with a one-second minimum and a three-second maximum.
 */
export async function recordObservedTranscriptionDuration(
  reservationId: string,
  observedSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<ObservedDurationResult> {
  await ensureOperatorUsageSchema();
  if (
    !Number.isFinite(observedSeconds) ||
    observedSeconds <= 0 ||
    observedSeconds > 60 * 60
  ) {
    await blockObservedDuration(reservationId, nowSeconds);
    return {
      allowed: false,
      reason: "duration_unverifiable",
      observedSeconds: null,
    };
  }

  const database = env.DB as unknown as D1Database;
  const observedMilliseconds = Math.max(
    1,
    Math.ceil(observedSeconds * 1_000),
  );
  const row = await database
    .prepare(`
      INSERT INTO usage_observed_durations (
        reservation_id,
        observed_milliseconds,
        blocked_at,
        updated_at
      )
      SELECT ?, ?, NULL, ?
      FROM usage_reservations
      WHERE id = ?
        AND status IN ('reserved', 'completed')
        AND expires_at >= ?
        AND ? <= source_duration_seconds * 1000
          + MIN(MAX(source_duration_seconds * 20, 1000), 3000)
      ON CONFLICT(reservation_id) DO UPDATE SET
        observed_milliseconds =
          usage_observed_durations.observed_milliseconds
          + excluded.observed_milliseconds,
        updated_at = excluded.updated_at
      WHERE usage_observed_durations.blocked_at IS NULL
        AND usage_observed_durations.observed_milliseconds
          + excluded.observed_milliseconds <= COALESCE((
            SELECT source_duration_seconds * 1000
              + MIN(MAX(source_duration_seconds * 20, 1000), 3000)
            FROM usage_reservations
            WHERE id = excluded.reservation_id
              AND status IN ('reserved', 'completed')
              AND expires_at >= ?
          ), -1)
      RETURNING observed_milliseconds
    `)
    .bind(
      reservationId,
      observedMilliseconds,
      nowSeconds,
      reservationId,
      nowSeconds,
      observedMilliseconds,
      nowSeconds,
    )
    .first<{ observed_milliseconds: number }>();

  if (row) {
    return {
      allowed: true,
      reason: null,
      observedSeconds: row.observed_milliseconds / 1_000,
    };
  }

  await blockObservedDuration(reservationId, nowSeconds);
  return {
    allowed: false,
    reason: "duration_exceeded",
    observedSeconds: null,
  };
}

export async function isObservedDurationBlocked(reservationId: string) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const row = await database
    .prepare(`
      SELECT blocked_at
      FROM usage_observed_durations
      WHERE reservation_id = ?
        AND blocked_at IS NOT NULL
      LIMIT 1
    `)
    .bind(reservationId)
    .first<{ blocked_at: number }>();
  return Boolean(row?.blocked_at);
}

export async function consumeOperatorUsageOperation(
  reservationId: string,
  operation: OperatorUsageOperation,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const id = `${reservationId}:${operation}`;
  const row = await database
    .prepare(`
      INSERT INTO operator_usage_operations (
        id,
        reservation_id,
        operation,
        count,
        updated_at
      )
      SELECT ?, ?, ?, 1, ?
      WHERE EXISTS (
        SELECT 1
        FROM usage_reservations
        WHERE id = ?
          AND status IN ('reserved', 'completed')
          AND expires_at >= ?
      )
      ON CONFLICT(id) DO UPDATE SET
        count = operator_usage_operations.count + 1,
        updated_at = excluded.updated_at
      WHERE operator_usage_operations.count < ?
        AND EXISTS (
          SELECT 1
          FROM usage_reservations
          WHERE id = ?
            AND status IN ('reserved', 'completed')
            AND expires_at >= ?
        )
      RETURNING count
    `)
    .bind(
      id,
      reservationId,
      operation,
      nowSeconds,
      reservationId,
      nowSeconds,
      OPERATOR_OPERATION_LIMITS[operation],
      reservationId,
      nowSeconds,
    )
    .first<{ count: number }>();
  return Boolean(row && row.count <= OPERATOR_OPERATION_LIMITS[operation]);
}

export async function getOperatorUsageOperationCounts(
  reservationId: string,
  operation: OperatorUsageOperation,
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const id = `${reservationId}:${operation}`;
  const row = await database
    .prepare(`
      SELECT count, successful_count
      FROM operator_usage_operations
      WHERE id = ?
        AND reservation_id = ?
        AND operation = ?
      LIMIT 1
    `)
    .bind(id, reservationId, operation)
    .first<{ count: number; successful_count: number }>();
  return {
    count: Math.max(0, row?.count ?? 0),
    successfulCount: Math.max(0, row?.successful_count ?? 0),
  };
}

/** Records that an upstream operation returned a usable result. */
export async function markOperatorUsageOperationSucceeded(
  reservationId: string,
  operation: OperatorUsageOperation,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const id = `${reservationId}:${operation}`;
  const row = await database
    .prepare(`
      UPDATE operator_usage_operations
      SET successful_count = successful_count + 1,
          updated_at = ?
      WHERE id = ?
        AND reservation_id = ?
        AND operation = ?
      RETURNING successful_count
    `)
    .bind(nowSeconds, id, reservationId, operation)
    .first<{ successful_count: number }>();
  return Boolean(row && row.successful_count > 0);
}

/**
 * Atomically releases a reservation when all upstream attempts failed. A
 * reservation is completed only after at least one usable result was recorded,
 * so a 429/5xx response does not consume a user's video allowance.
 */
export async function releaseOrCompleteUsageReservation(
  reservationId: string,
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;

  const released = await database
    .prepare(`
      UPDATE usage_reservations
      SET status = 'released'
      WHERE id = ?
        AND user_id = ?
        AND status = 'reserved'
        AND NOT EXISTS (
          SELECT 1
          FROM operator_usage_operations
          WHERE reservation_id = ?
            AND successful_count > 0
        )
      RETURNING id
    `)
    .bind(reservationId, userId, reservationId)
    .first<{ id: string }>();
  if (released?.id) return "released" as const;

  const completed = await database
    .prepare(`
      UPDATE usage_reservations
      SET status = 'completed', completed_at = ?
      WHERE id = ?
        AND user_id = ?
        AND status = 'reserved'
        AND EXISTS (
          SELECT 1
          FROM operator_usage_operations
          WHERE reservation_id = ?
            AND successful_count > 0
        )
      RETURNING id
    `)
    .bind(nowSeconds, reservationId, userId, reservationId)
    .first<{ id: string }>();
  return completed?.id ? ("completed" as const) : null;
}

/**
 * Settles expired reservations without refunding work that was already
 * claimed. The two conditional updates are safe when requests race in D1.
 */
export async function settleExpiredUsageReservations(
  userId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;

  await database.batch([
    database
      .prepare(`
        UPDATE usage_reservations
        SET status = 'completed', completed_at = ?
        WHERE user_id = ?
          AND status = 'reserved'
          AND expires_at < ?
          AND EXISTS (
            SELECT 1
            FROM operator_usage_operations
            WHERE reservation_id = usage_reservations.id
              AND successful_count > 0
          )
      `)
      .bind(nowSeconds, userId, nowSeconds),
    database
      .prepare(`
        UPDATE usage_reservations
        SET status = 'released'
        WHERE user_id = ?
          AND status = 'reserved'
          AND expires_at < ?
          AND NOT EXISTS (
            SELECT 1
            FROM operator_usage_operations
            WHERE reservation_id = usage_reservations.id
              AND successful_count > 0
          )
      `)
      .bind(userId, nowSeconds),
  ]);
}
