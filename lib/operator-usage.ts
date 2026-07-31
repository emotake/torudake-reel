import { env } from "cloudflare:workers";

export type OperatorUsageOperation =
  | "transcribe"
  | "narration_script"
  | "narration_speech";

export const OPERATOR_OPERATION_LIMITS: Record<
  OperatorUsageOperation,
  number
> = {
  transcribe: 24,
  narration_script: 8,
  narration_speech: 8,
};

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
  ]);
  operatorUsageSchemaReady = true;
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
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        count = operator_usage_operations.count + 1,
        updated_at = excluded.updated_at
      WHERE operator_usage_operations.count < ?
      RETURNING count
    `)
    .bind(
      id,
      reservationId,
      operation,
      nowSeconds,
      OPERATOR_OPERATION_LIMITS[operation],
    )
    .first<{ count: number }>();
  return Boolean(row && row.count <= OPERATOR_OPERATION_LIMITS[operation]);
}
