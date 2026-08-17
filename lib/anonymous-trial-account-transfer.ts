import {
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
} from "./billing-policy";

export type AnonymousTrialAccountTransferContext = {
  sessionHash: string;
  principalEmail: string;
  userId: string;
};

type D1Result = { meta?: { changes?: number } };

export type AnonymousTrialTransferStatement<TStatement> = {
  bind: (...values: unknown[]) => TStatement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<D1Result>;
};

export type AnonymousTrialTransferDatabase<TStatement> = {
  prepare: (query: string) => TStatement;
};

export type AnonymousTrialTransferTargetProof =
  | {
      kind: "passkey";
      credentialId: string;
    }
  | {
      kind: "external";
      identityId: string;
      provider: "line" | "google" | "email";
      subjectHash: string;
    };

/**
 * Builds the shared, transaction-ready migration used when an anonymous
 * editor signs in to an existing account. Callers append their credential
 * touch to this array and execute the complete list with one D1 batch.
 *
 * The first statement is the authorization gate. It binds only a still-
 * anonymous source with no paid/account credentials to the credential that
 * was just verified. Active free reservations move only when the destination
 * remains within both legacy free caps. Otherwise their identifiers are kept
 * but moved as released rows so a recovering client can renew against a paid
 * bucket without granting another free allocation.
 */
export function anonymousTrialAccountTransferStatements<
  TStatement extends AnonymousTrialTransferStatement<TStatement>,
>(
  database: AnonymousTrialTransferDatabase<TStatement>,
  values: {
    trial: AnonymousTrialAccountTransferContext;
    targetUserId: string;
    targetProof: AnonymousTrialTransferTargetProof;
    now: number;
  },
) {
  const proof = targetProof(values.targetProof, values.targetUserId);
  const boundTrialExists = `
    EXISTS (
      SELECT 1 FROM trial_sessions
      WHERE session_hash = ? AND account_user_id = ? AND expires_at >= ?
    )
  `;

  return [
    database
      .prepare(`
        UPDATE trial_sessions
        SET account_user_id = ?
        WHERE session_hash = ?
          AND account_user_id IS NULL
          AND expires_at >= ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND account_deleted_at IS NULL
          )
          AND ${proof.sql}
          AND EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND email = ? AND account_deleted_at IS NULL
              AND stripe_customer_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM account_passkeys WHERE user_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM account_external_identities WHERE user_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM account_sessions WHERE user_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM billing_subscriptions WHERE user_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM billing_purchases WHERE user_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM usage_reservations
            WHERE user_id = ?
              AND (
                bucket != 'free'
                OR billing_purchase_id IS NOT NULL
                OR save_funding_source != 'bucket'
              )
          )
      `)
      .bind(
        values.targetUserId,
        values.trial.sessionHash,
        values.now,
        values.targetUserId,
        ...proof.bindings,
        values.trial.userId,
        values.trial.principalEmail,
        values.trial.userId,
        values.trial.userId,
        values.trial.userId,
        values.trial.userId,
        values.trial.userId,
        values.trial.userId,
      ),
    database
      .prepare(`
        UPDATE usage_reservations
        SET user_id = ?
        WHERE user_id = ?
          AND bucket = 'free'
          AND billing_purchase_id IS NULL
          AND status IN ('reserved', 'completed')
          AND ${boundTrialExists}
          AND (
            SELECT COUNT(*) FROM usage_reservations AS combined_usage
            WHERE combined_usage.user_id IN (?, ?)
              AND combined_usage.bucket = 'free'
              AND combined_usage.status IN ('reserved', 'completed')
          ) <= ?
          AND (
            SELECT COALESCE(SUM(source_duration_seconds), 0)
            FROM usage_reservations AS combined_usage
            WHERE combined_usage.user_id IN (?, ?)
              AND combined_usage.bucket = 'free'
              AND combined_usage.status IN ('reserved', 'completed')
          ) <= ?
      `)
      .bind(
        values.targetUserId,
        values.trial.userId,
        values.trial.sessionHash,
        values.targetUserId,
        values.now,
        values.trial.userId,
        values.targetUserId,
        FREE_VIDEO_LIMIT,
        values.trial.userId,
        values.targetUserId,
        FREE_SECONDS_LIMIT,
      ),
    database
      .prepare(`
        UPDATE usage_reservations
        SET user_id = ?,
          status = CASE
            WHEN status IN ('reserved', 'completed') THEN 'released'
            ELSE status
          END,
          save_funding_source = 'bucket',
          expires_at = CASE
            WHEN status IN ('reserved', 'completed') THEN MIN(expires_at, ?)
            ELSE expires_at
          END,
          release_requested_at = CASE
            WHEN status IN ('reserved', 'completed')
              THEN COALESCE(release_requested_at, ?)
            ELSE release_requested_at
          END
        WHERE user_id = ?
          AND bucket = 'free'
          AND billing_purchase_id IS NULL
          AND ${boundTrialExists}
      `)
      .bind(
        values.targetUserId,
        values.now - 1,
        values.now,
        values.trial.userId,
        values.trial.sessionHash,
        values.targetUserId,
        values.now,
      ),
    database
      .prepare(`
        UPDATE usage_release_intents
        SET user_id = ?
        WHERE user_id = ?
          AND ${boundTrialExists}
      `)
      .bind(
        values.targetUserId,
        values.trial.userId,
        values.trial.sessionHash,
        values.targetUserId,
        values.now,
      ),
    database
      .prepare(`
        UPDATE video_transfers
        SET owner_email = (
          SELECT email FROM users WHERE id = ? AND account_deleted_at IS NULL
        )
        WHERE owner_email = ?
          AND ${boundTrialExists}
      `)
      .bind(
        values.targetUserId,
        values.trial.principalEmail,
        values.trial.sessionHash,
        values.targetUserId,
        values.now,
      ),
    database
      .prepare(`
        UPDATE ai_disclosure_confirmations
        SET user_id = ?
        WHERE user_id = ?
          AND ${boundTrialExists}
      `)
      .bind(
        values.targetUserId,
        values.trial.userId,
        values.trial.sessionHash,
        values.targetUserId,
        values.now,
      ),
  ];
}

function targetProof(
  proof: AnonymousTrialTransferTargetProof,
  targetUserId: string,
) {
  if (proof.kind === "passkey") {
    return {
      sql: `EXISTS (
        SELECT 1 FROM account_passkeys
        WHERE credential_id = ? AND user_id = ?
      )`,
      bindings: [proof.credentialId, targetUserId],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM account_external_identities
      WHERE id = ? AND user_id = ? AND provider = ?
        AND subject_hash = ? AND revoked_at IS NULL
    )`,
    bindings: [
      proof.identityId,
      targetUserId,
      proof.provider,
      proof.subjectHash,
    ],
  };
}
