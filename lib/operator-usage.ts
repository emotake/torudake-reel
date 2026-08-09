import { env } from "cloudflare:workers";

export type OperatorUsageOperation =
  | "transfer_upload"
  | "transcribe"
  | "narration_initial"
  | "narration_script"
  | "narration_speech"
  | "narration_disclosure";

export type MeteredAiOperation = Extract<
  OperatorUsageOperation,
  | "transcribe"
  | "narration_initial"
  | "narration_script"
  | "narration_speech"
>;

export const METERED_AI_LEASE_SCOPE = "metered_ai" as const;
export type UsageOperationLeaseScope =
  | OperatorUsageOperation
  | typeof METERED_AI_LEASE_SCOPE;

const METERED_AI_OPERATIONS = new Set<MeteredAiOperation>([
  "transcribe",
  "narration_initial",
  "narration_script",
  "narration_speech",
]);

export const METERED_AI_ACTION_ATTEMPT_LIMITS: Record<
  MeteredAiOperation,
  number
> = {
  // A one-hour source can require up to 144 browser-generated 25-second
  // chunks. The observed-duration cap still limits total billable audio.
  transcribe: 160,
  // Initial narration is one logical action: script, speech, and at most one
  // automatic duration adjustment (script + speech).
  narration_initial: 4,
  narration_script: 2,
  narration_speech: 2,
};

export const METERED_AI_ACTION_PENDING_TTL_SECONDS = 15 * 60;

export function isMeteredAiOperation(
  operation: OperatorUsageOperation,
): operation is MeteredAiOperation {
  return METERED_AI_OPERATIONS.has(operation as MeteredAiOperation);
}

export function isValidMeteredAiActionId(actionId: string) {
  return /^[a-zA-Z0-9_-]{8,100}$/.test(actionId);
}

export const OPERATOR_OPERATION_LIMITS: Record<
  OperatorUsageOperation,
  number
> = {
  transfer_upload: 2,
  transcribe: 24,
  narration_initial: 1,
  narration_script: 16,
  narration_speech: 16,
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
    database.prepare(`
      CREATE TABLE IF NOT EXISTS metered_ai_actions (
        id text PRIMARY KEY NOT NULL,
        reservation_id text NOT NULL,
        action_id text NOT NULL,
        operation text NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        attempt_count integer DEFAULT 1 NOT NULL,
        observed_milliseconds integer DEFAULT 0 NOT NULL,
        created_at integer NOT NULL,
        expires_at integer NOT NULL,
        succeeded_at integer,
        failed_at integer,
        updated_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS metered_ai_actions_reservation_action_unique
      ON metered_ai_actions (reservation_id, action_id)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS metered_ai_actions_reservation_status_idx
      ON metered_ai_actions (reservation_id, status)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS metered_ai_actions_expires_at_idx
      ON metered_ai_actions (expires_at)
    `),
  ]);
  operatorUsageSchemaReady = true;
}

export type UsageOperationLease = {
  reservationId: string;
  operation: UsageOperationLeaseScope;
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
  operation: UsageOperationLeaseScope,
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

export type MeteredAiActionStatus = "pending" | "succeeded" | "failed";

export type MeteredAiAction = {
  id: string;
  reservationId: string;
  actionId: string;
  operation: MeteredAiOperation;
  status: MeteredAiActionStatus;
  attemptCount: number;
  observedMilliseconds: number;
  createdAt: number;
  expiresAt: number;
  succeededAt: number | null;
  failedAt: number | null;
  updatedAt: number;
};

type MeteredAiActionRow = {
  id: string;
  reservation_id: string;
  action_id: string;
  operation: MeteredAiOperation;
  status: MeteredAiActionStatus;
  attempt_count: number;
  observed_milliseconds: number;
  created_at: number;
  expires_at: number;
  succeeded_at: number | null;
  failed_at: number | null;
  updated_at: number;
};

function meteredAiActionId(reservationId: string, actionId: string) {
  return `${reservationId}:${actionId}`;
}

function meteredAiLeaseId(reservationId: string) {
  return `${reservationId}:${METERED_AI_LEASE_SCOPE}`;
}

function mapMeteredAiAction(row: MeteredAiActionRow): MeteredAiAction {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    actionId: row.action_id,
    operation: row.operation,
    status: row.status,
    attemptCount: Math.max(0, row.attempt_count),
    observedMilliseconds: Math.max(0, row.observed_milliseconds),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    succeededAt: row.succeeded_at,
    failedAt: row.failed_at,
    updatedAt: row.updated_at,
  };
}

const METERED_AI_ACTION_RETURNING_COLUMNS = `
  id,
  reservation_id,
  action_id,
  operation,
  status,
  attempt_count,
  observed_milliseconds,
  created_at,
  expires_at,
  succeeded_at,
  failed_at,
  updated_at
`;

export async function getMeteredAiAction(
  reservationId: string,
  actionId: string,
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const row = await database
    .prepare(`
      SELECT ${METERED_AI_ACTION_RETURNING_COLUMNS}
      FROM metered_ai_actions
      WHERE id = ?
        AND reservation_id = ?
        AND action_id = ?
      LIMIT 1
    `)
    .bind(
      meteredAiActionId(reservationId, actionId),
      reservationId,
      actionId,
    )
    .first<MeteredAiActionRow>();
  return row ? mapMeteredAiAction(row) : null;
}

export async function getMeteredAiActionByOperation(
  reservationId: string,
  operation: MeteredAiOperation,
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const row = await database
    .prepare(`
      SELECT ${METERED_AI_ACTION_RETURNING_COLUMNS}
      FROM metered_ai_actions
      WHERE reservation_id = ?
        AND operation = ?
      ORDER BY created_at ASC
      LIMIT 1
    `)
    .bind(reservationId, operation)
    .first<MeteredAiActionRow>();
  return row ? mapMeteredAiAction(row) : null;
}

export async function getMeteredAiUsageCounts(
  reservationId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  const database = env.DB as unknown as D1Database;
  const row = await database
    .prepare(`
      SELECT
        (
          SELECT COALESCE(SUM(successful_count), 0)
          FROM operator_usage_operations
          WHERE reservation_id = ?
            AND operation IN (
              'transcribe',
              'narration_initial',
              'narration_script',
              'narration_speech'
            )
        ) + (
          SELECT COUNT(*)
          FROM metered_ai_actions
          WHERE reservation_id = ?
            AND status = 'succeeded'
        ) AS successful_count,
        (
          SELECT COUNT(*)
          FROM metered_ai_actions
          WHERE reservation_id = ?
            AND status = 'pending'
            AND expires_at > ?
        ) AS pending_count
    `)
    .bind(reservationId, reservationId, reservationId, nowSeconds)
    .first<{ successful_count: number; pending_count: number }>();
  return {
    successfulCount: Math.max(0, row?.successful_count ?? 0),
    pendingCount: Math.max(0, row?.pending_count ?? 0),
  };
}

function hasMatchingMeteredAiLease(
  lease: UsageOperationLease,
  reservationId: string,
) {
  return (
    lease.reservationId === reservationId &&
    lease.operation === METERED_AI_LEASE_SCOPE
  );
}

export async function createMeteredAiAction(
  reservationId: string,
  actionId: string,
  operation: MeteredAiOperation,
  successfulLimit: number,
  lease: UsageOperationLease,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  if (
    !isValidMeteredAiActionId(actionId) ||
    !hasMatchingMeteredAiLease(lease, reservationId)
  ) {
    return null;
  }
  const limit = Math.max(1, Math.floor(successfulLimit));
  const database = env.DB as unknown as D1Database;
  const id = meteredAiActionId(reservationId, actionId);
  const pendingExpiresAt = nowSeconds + METERED_AI_ACTION_PENDING_TTL_SECONDS;
  const row = await database
    .prepare(`
      INSERT INTO metered_ai_actions (
        id,
        reservation_id,
        action_id,
        operation,
        status,
        attempt_count,
        observed_milliseconds,
        created_at,
        expires_at,
        succeeded_at,
        failed_at,
        updated_at
      )
      SELECT
        ?, ?, ?, ?, 'pending', 1, 0, ?, MIN(reservation.expires_at, ?),
        NULL, NULL, ?
      FROM usage_reservations AS reservation
      WHERE reservation.id = ?
        AND reservation.status IN ('reserved', 'completed')
        AND reservation.expires_at >= ?
        AND EXISTS (
          SELECT 1
          FROM usage_operation_leases
          WHERE id = ?
            AND reservation_id = reservation.id
            AND operation = 'metered_ai'
            AND lease_token = ?
            AND expires_at > ?
        )
        AND (
          (
            SELECT COALESCE(SUM(successful_count), 0)
            FROM operator_usage_operations
            WHERE reservation_id = reservation.id
              AND operation IN (
                'transcribe',
                'narration_initial',
                'narration_script',
                'narration_speech'
              )
          ) + (
            SELECT COUNT(*)
            FROM metered_ai_actions
            WHERE reservation_id = reservation.id
              AND (
                status = 'succeeded'
                OR (status = 'pending' AND expires_at > ?)
              )
          )
        ) < ?
        AND NOT EXISTS (
          SELECT 1
          FROM metered_ai_actions
          WHERE id = ?
        )
      RETURNING ${METERED_AI_ACTION_RETURNING_COLUMNS}
    `)
    .bind(
      id,
      reservationId,
      actionId,
      operation,
      nowSeconds,
      pendingExpiresAt,
      nowSeconds,
      reservationId,
      nowSeconds,
      meteredAiLeaseId(reservationId),
      lease.token,
      nowSeconds,
      nowSeconds,
      limit,
      id,
    )
    .first<MeteredAiActionRow>();
  return row ? mapMeteredAiAction(row) : null;
}

export async function continueMeteredAiAction(
  action: MeteredAiAction,
  lease: UsageOperationLease,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  if (!hasMatchingMeteredAiLease(lease, action.reservationId)) return null;
  const database = env.DB as unknown as D1Database;
  const pendingExpiresAt = nowSeconds + METERED_AI_ACTION_PENDING_TTL_SECONDS;
  const row = await database
    .prepare(`
      UPDATE metered_ai_actions
      SET attempt_count = attempt_count + 1,
          expires_at = MIN(COALESCE((
            SELECT expires_at
            FROM usage_reservations
            WHERE id = ?
              AND status IN ('reserved', 'completed')
              AND expires_at >= ?
          ), expires_at), ?),
          updated_at = ?
      WHERE id = ?
        AND reservation_id = ?
        AND action_id = ?
        AND operation = ?
        AND status IN ('pending', 'succeeded')
        AND expires_at > ?
        AND attempt_count < ?
        AND EXISTS (
          SELECT 1
          FROM usage_reservations
          WHERE id = ?
            AND status IN ('reserved', 'completed')
            AND expires_at >= ?
        )
        AND EXISTS (
          SELECT 1
          FROM usage_operation_leases
          WHERE id = ?
            AND reservation_id = ?
            AND operation = 'metered_ai'
            AND lease_token = ?
            AND expires_at > ?
        )
      RETURNING ${METERED_AI_ACTION_RETURNING_COLUMNS}
    `)
    .bind(
      action.reservationId,
      nowSeconds,
      pendingExpiresAt,
      nowSeconds,
      action.id,
      action.reservationId,
      action.actionId,
      action.operation,
      nowSeconds,
      METERED_AI_ACTION_ATTEMPT_LIMITS[action.operation],
      action.reservationId,
      nowSeconds,
      meteredAiLeaseId(action.reservationId),
      action.reservationId,
      lease.token,
      nowSeconds,
    )
    .first<MeteredAiActionRow>();
  return row ? mapMeteredAiAction(row) : null;
}

export async function markMeteredAiActionSucceeded(
  action: MeteredAiAction,
  lease: UsageOperationLease,
  successfulLimit: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  if (!hasMatchingMeteredAiLease(lease, action.reservationId)) return null;
  const database = env.DB as unknown as D1Database;
  const limit = Math.max(1, Math.floor(successfulLimit));
  const row = await database
    .prepare(`
      UPDATE metered_ai_actions
      SET status = 'succeeded',
          succeeded_at = COALESCE(succeeded_at, ?),
          failed_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND reservation_id = ?
        AND action_id = ?
        AND operation = ?
        AND status IN ('pending', 'succeeded')
        AND expires_at > ?
        AND EXISTS (
          SELECT 1
          FROM usage_reservations
          WHERE id = ?
            AND status IN ('reserved', 'completed')
            AND expires_at >= ?
        )
        AND EXISTS (
          SELECT 1
          FROM usage_operation_leases
          WHERE id = ?
            AND reservation_id = ?
            AND operation = 'metered_ai'
            AND lease_token = ?
            AND expires_at > ?
        )
        AND (
          status = 'succeeded'
          OR (
            (
              SELECT COALESCE(SUM(successful_count), 0)
              FROM operator_usage_operations
              WHERE reservation_id = ?
                AND operation IN (
                'transcribe',
                'narration_initial',
                'narration_script',
                'narration_speech'
                )
            ) + (
              SELECT COUNT(*)
              FROM metered_ai_actions AS succeeded_action
              WHERE succeeded_action.reservation_id = ?
                AND succeeded_action.status = 'succeeded'
            )
          ) < ?
        )
      RETURNING ${METERED_AI_ACTION_RETURNING_COLUMNS}
    `)
    .bind(
      nowSeconds,
      nowSeconds,
      action.id,
      action.reservationId,
      action.actionId,
      action.operation,
      nowSeconds,
      action.reservationId,
      nowSeconds,
      meteredAiLeaseId(action.reservationId),
      action.reservationId,
      lease.token,
      nowSeconds,
      action.reservationId,
      action.reservationId,
      limit,
    )
    .first<MeteredAiActionRow>();
  return row ? mapMeteredAiAction(row) : null;
}

export async function markMeteredAiActionFailed(
  action: MeteredAiAction,
  lease: UsageOperationLease,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorUsageSchema();
  if (!hasMatchingMeteredAiLease(lease, action.reservationId)) return null;
  const database = env.DB as unknown as D1Database;
  const row = await database
    .prepare(`
      UPDATE metered_ai_actions
      SET status = 'failed',
          failed_at = ?,
          expires_at = ?,
          updated_at = ?
      WHERE id = ?
        AND reservation_id = ?
        AND action_id = ?
        AND operation = ?
        AND status = 'pending'
        AND EXISTS (
          SELECT 1
          FROM usage_operation_leases
          WHERE id = ?
            AND reservation_id = ?
            AND operation = 'metered_ai'
            AND lease_token = ?
            AND expires_at > ?
        )
      RETURNING ${METERED_AI_ACTION_RETURNING_COLUMNS}
    `)
    .bind(
      nowSeconds,
      nowSeconds,
      nowSeconds,
      action.id,
      action.reservationId,
      action.actionId,
      action.operation,
      meteredAiLeaseId(action.reservationId),
      action.reservationId,
      lease.token,
      nowSeconds,
    )
    .first<MeteredAiActionRow>();
  return row ? mapMeteredAiAction(row) : null;
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

/**
 * Accumulates chunk durations inside one logical transcription action. A new
 * high-accuracy action gets its own allowance, while retries and chunks using
 * the same action ID share one source-duration ceiling.
 */
export async function recordMeteredAiTranscriptionDuration(
  action: MeteredAiAction,
  lease: UsageOperationLease,
  observedSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<ObservedDurationResult> {
  await ensureOperatorUsageSchema();
  if (
    action.operation !== "transcribe" ||
    !hasMatchingMeteredAiLease(lease, action.reservationId)
  ) {
    return {
      allowed: false,
      reason: "duration_unverifiable",
      observedSeconds: null,
    };
  }
  if (
    !Number.isFinite(observedSeconds) ||
    observedSeconds <= 0 ||
    observedSeconds > 60 * 60
  ) {
    await markMeteredAiActionFailed(action, lease, nowSeconds);
    await blockObservedDuration(action.reservationId, nowSeconds);
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
      UPDATE metered_ai_actions
      SET observed_milliseconds = observed_milliseconds + ?,
          updated_at = ?
      WHERE id = ?
        AND reservation_id = ?
        AND action_id = ?
        AND operation = 'transcribe'
        AND status IN ('pending', 'succeeded')
        AND expires_at > ?
        AND EXISTS (
          SELECT 1
          FROM usage_operation_leases
          WHERE id = ?
            AND reservation_id = ?
            AND operation = 'metered_ai'
            AND lease_token = ?
            AND expires_at > ?
        )
        AND observed_milliseconds + ? <= COALESCE((
          SELECT source_duration_seconds * 1000
            + MIN(MAX(source_duration_seconds * 20, 1000), 3000)
          FROM usage_reservations
          WHERE id = ?
            AND status IN ('reserved', 'completed')
            AND expires_at >= ?
        ), -1)
      RETURNING observed_milliseconds
    `)
    .bind(
      observedMilliseconds,
      nowSeconds,
      action.id,
      action.reservationId,
      action.actionId,
      nowSeconds,
      meteredAiLeaseId(action.reservationId),
      action.reservationId,
      lease.token,
      nowSeconds,
      observedMilliseconds,
      action.reservationId,
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

  const currentAction = await getMeteredAiAction(
    action.reservationId,
    action.actionId,
  );
  const stillCurrent =
    currentAction?.id === action.id &&
    currentAction.operation === "transcribe" &&
    (currentAction.status === "pending" ||
      currentAction.status === "succeeded") &&
    currentAction.expiresAt > nowSeconds;
  if (stillCurrent) {
    await markMeteredAiActionFailed(currentAction, lease, nowSeconds);
    await blockObservedDuration(action.reservationId, nowSeconds);
    return {
      allowed: false,
      reason: "duration_exceeded",
      observedSeconds: null,
    };
  }
  return {
    allowed: false,
    reason: "duration_unverifiable",
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
        AND NOT EXISTS (
          SELECT 1
          FROM metered_ai_actions
          WHERE reservation_id = ?
            AND status = 'succeeded'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM usage_operation_leases
          WHERE reservation_id = ?
            AND operation = 'metered_ai'
            AND expires_at > ?
        )
      RETURNING id
    `)
    .bind(
      reservationId,
      userId,
      reservationId,
      reservationId,
      reservationId,
      nowSeconds,
    )
    .first<{ id: string }>();
  if (released?.id) return "released" as const;

  const completed = await database
    .prepare(`
      UPDATE usage_reservations
      SET status = 'completed', completed_at = ?
      WHERE id = ?
        AND user_id = ?
        AND status = 'reserved'
        AND (
          EXISTS (
            SELECT 1
            FROM operator_usage_operations
            WHERE reservation_id = ?
              AND successful_count > 0
          )
          OR EXISTS (
            SELECT 1
            FROM metered_ai_actions
            WHERE reservation_id = ?
              AND status = 'succeeded'
          )
        )
      RETURNING id
    `)
    .bind(
      nowSeconds,
      reservationId,
      userId,
      reservationId,
      reservationId,
    )
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
          AND (
            EXISTS (
              SELECT 1
              FROM operator_usage_operations
              WHERE reservation_id = usage_reservations.id
                AND successful_count > 0
            )
            OR EXISTS (
              SELECT 1
              FROM metered_ai_actions
              WHERE reservation_id = usage_reservations.id
                AND status = 'succeeded'
            )
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
          AND NOT EXISTS (
            SELECT 1
            FROM metered_ai_actions
            WHERE reservation_id = usage_reservations.id
              AND status = 'succeeded'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM usage_operation_leases
            WHERE reservation_id = usage_reservations.id
              AND operation = 'metered_ai'
              AND expires_at > ?
          )
      `)
      .bind(userId, nowSeconds, nowSeconds),
  ]);
}
