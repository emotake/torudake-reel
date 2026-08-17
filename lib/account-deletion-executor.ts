import { env } from "cloudflare:workers";
import { getMediaBucket } from "./transfers";
import {
  isBillingConfigured,
  stripeGet,
  stripeMonthlyPlanForPrice,
} from "./stripe";

const MAX_EXECUTION_BATCH = 25;
const DEFAULT_EXECUTION_BATCH = 5;
const EXECUTION_LEASE_SECONDS = 30 * 60;
const MAX_MEDIA_TRANSFERS_PER_ACCOUNT = 500;
const MAX_DISPUTED_CHARGES_PER_ACCOUNT = 20;
const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);
const TERMINAL_DISPUTE_STATUSES = new Set([
  "lost",
  "prevented",
  "warning_closed",
  "won",
]);
const OPEN_DISPUTE_STATUSES = new Set([
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review",
]);

type D1Result = { meta?: { changes?: number } };
type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<D1Result>;
};
type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

type DeletionCandidate = {
  user_id: string;
  status: "scheduled" | "processing";
  requested_at: number;
  execute_after: number;
  email: string | null;
  billing_email: string | null;
  stripe_customer_id: string | null;
};

type DeletionSummary = {
  passkeys: number;
  externalIdentities: number;
  sessions: number;
  recoveryRequests: number;
  reservations: number;
  completedPaidReservations: number;
  transfers: number;
};

type StripeSubscriptionList = {
  data?: unknown[];
  has_more?: unknown;
};

type StripeChargeList = {
  data?: unknown[];
  has_more?: unknown;
};

type StripeDisputeList = {
  data?: unknown[];
  has_more?: unknown;
};

type MediaTransferRow = {
  id: string;
  object_key: string;
  upload_id: string;
  status: "uploading" | "complete" | "deleted";
};

export type AccountDeletionRunResult = {
  dryRun: boolean;
  limit: number;
  scanned: number;
  ready: number;
  completed: number;
  blocked: number;
  failed: number;
  skipped: number;
  results: Array<{
    accountReference: string;
    outcome: "ready" | "completed" | "blocked" | "failed" | "skipped";
    reasonCode: string | null;
  }>;
};

export class AccountDeletionExecutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AccountDeletionExecutionError";
    this.code = code;
  }
}

/**
 * Executes due deletion requests in a bounded batch. A dry run still appends a
 * privacy-minimal audit row, but never claims a request or changes account data.
 */
export async function runDueAccountDeletions(options: {
  dryRun?: boolean;
  limit?: number;
  requestId: string;
  nowSeconds?: number;
}): Promise<AccountDeletionRunResult> {
  const dryRun = options.dryRun !== false;
  const limit = normalizeLimit(options.limit);
  const requestId = normalizeRequestId(options.requestId);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const database = databaseOrThrow();
  const staleBefore = now - EXECUTION_LEASE_SECONDS;
  const candidates = await database
    .prepare(`
      SELECT requests.user_id, requests.status, requests.requested_at,
        requests.execute_after, users.email, users.billing_email,
        users.stripe_customer_id
      FROM account_deletion_requests AS requests
      LEFT JOIN users ON users.id = requests.user_id
      WHERE requests.execute_after <= ?
        AND (
          requests.status = 'scheduled'
          OR (
            requests.status = 'processing'
            AND COALESCE(requests.execution_started_at, 0) <= ?
          )
        )
      ORDER BY requests.execute_after ASC, requests.requested_at ASC
      LIMIT ?
    `)
    .bind(now, staleBefore, limit)
    .all<DeletionCandidate>();

  const result: AccountDeletionRunResult = {
    dryRun,
    limit,
    scanned: candidates.results?.length ?? 0,
    ready: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  for (const candidate of candidates.results ?? []) {
    const accountReference = await deletionAccountReference(candidate.user_id);
    const startedAt = Math.floor(Date.now() / 1_000);
    if (dryRun) {
      await inspectDryRun(
        database,
        candidate,
        accountReference,
        requestId,
        now,
        startedAt,
        result,
      );
      continue;
    }
    await executeCandidate(
      database,
      candidate.user_id,
      accountReference,
      requestId,
      now,
      startedAt,
      result,
    );
  }
  return result;
}

async function inspectDryRun(
  database: D1Database,
  candidate: DeletionCandidate,
  accountReference: string,
  requestId: string,
  now: number,
  startedAt: number,
  aggregate: AccountDeletionRunResult,
) {
  try {
    assertCandidateHasUser(candidate);
    const summary = await collectDeletionSummary(database, candidate);
    const blockReason = await deletionBlockReason(database, candidate, now);
    const outcome = blockReason ? "blocked" : "ready";
    if (blockReason) aggregate.blocked += 1;
    else aggregate.ready += 1;
    await appendAudit(database, {
      accountReference,
      requestId,
      dryRun: true,
      outcome,
      reasonCode: blockReason,
      summary,
      startedAt,
    });
    aggregate.results.push({ accountReference, outcome, reasonCode: blockReason });
  } catch (error) {
    const reasonCode = executionErrorCode(error);
    aggregate.failed += 1;
    await appendAudit(database, {
      accountReference,
      requestId,
      dryRun: true,
      outcome: "failed",
      reasonCode,
      summary: emptySummary(),
      startedAt,
    });
    aggregate.results.push({ accountReference, outcome: "failed", reasonCode });
  }
}

async function executeCandidate(
  database: D1Database,
  userId: string,
  accountReference: string,
  requestId: string,
  now: number,
  startedAt: number,
  aggregate: AccountDeletionRunResult,
) {
  const executionToken = crypto.randomUUID();
  const claimed = await database
    .prepare(`
      UPDATE account_deletion_requests
      SET status = 'processing', execution_token = ?, execution_started_at = ?,
        attempt_count = attempt_count + 1, last_block_reason = NULL,
        last_error_code = NULL, updated_at = ?
      WHERE user_id = ? AND execute_after <= ?
        AND (
          status = 'scheduled'
          OR (
            status = 'processing'
            AND COALESCE(execution_started_at, 0) <= ?
          )
        )
      RETURNING user_id
    `)
    .bind(
      executionToken,
      now,
      now,
      userId,
      now,
      now - EXECUTION_LEASE_SECONDS,
    )
    .first<{ user_id: string }>();
  if (!claimed) {
    aggregate.skipped += 1;
    aggregate.results.push({
      accountReference,
      outcome: "skipped",
      reasonCode: "claim_unavailable",
    });
    return;
  }

  let summary = emptySummary();
  try {
    const candidate = await loadClaimedCandidate(database, userId, executionToken);
    assertCandidateHasUser(candidate);
    summary = await collectDeletionSummary(database, candidate);
    const blockReason = await deletionBlockReason(database, candidate, now);
    if (blockReason) {
      await releaseBlockedExecution(database, {
        userId,
        executionToken,
        accountReference,
        requestId,
        blockReason,
        summary,
        startedAt,
        now,
      });
      aggregate.blocked += 1;
      aggregate.results.push({
        accountReference,
        outcome: "blocked",
        reasonCode: blockReason,
      });
      return;
    }

    await removeOwnedMedia(candidate);
    await completeDeletion(database, {
      candidate,
      executionToken,
      accountReference,
      requestId,
      summary,
      startedAt,
      now,
    });
    aggregate.completed += 1;
    aggregate.results.push({
      accountReference,
      outcome: "completed",
      reasonCode: null,
    });
  } catch (error) {
    const reasonCode = executionErrorCode(error);
    await releaseFailedExecution(database, {
      userId,
      executionToken,
      accountReference,
      requestId,
      reasonCode,
      summary,
      startedAt,
      now,
    }).catch(() => undefined);
    aggregate.failed += 1;
    aggregate.results.push({ accountReference, outcome: "failed", reasonCode });
  }
}

async function loadClaimedCandidate(
  database: D1Database,
  userId: string,
  executionToken: string,
) {
  const candidate = await database
    .prepare(`
      SELECT requests.user_id, requests.status, requests.requested_at,
        requests.execute_after, users.email, users.billing_email,
        users.stripe_customer_id
      FROM account_deletion_requests AS requests
      LEFT JOIN users ON users.id = requests.user_id
      WHERE requests.user_id = ? AND requests.status = 'processing'
        AND requests.execution_token = ?
      LIMIT 1
    `)
    .bind(userId, executionToken)
    .first<DeletionCandidate>();
  if (!candidate) {
    throw new AccountDeletionExecutionError("execution_claim_lost");
  }
  return candidate;
}

function assertCandidateHasUser(
  candidate: DeletionCandidate,
): asserts candidate is DeletionCandidate & { email: string } {
  if (!candidate.email) {
    throw new AccountDeletionExecutionError("account_record_missing");
  }
}

async function deletionBlockReason(
  database: D1Database,
  candidate: DeletionCandidate & { email: string },
  now: number,
) {
  const local = await database
    .prepare(`
      SELECT
        (
          EXISTS (
            SELECT 1 FROM usage_reservations
            WHERE user_id = ? AND status = 'reserved' AND expires_at > ?
          )
          OR EXISTS (
            SELECT 1 FROM usage_operation_leases AS leases
            INNER JOIN usage_reservations AS reservations
              ON reservations.id = leases.reservation_id
            WHERE reservations.user_id = ? AND leases.expires_at > ?
          )
          OR EXISTS (
            SELECT 1 FROM metered_ai_actions AS actions
            INNER JOIN usage_reservations AS reservations
              ON reservations.id = actions.reservation_id
            WHERE reservations.user_id = ? AND actions.status = 'pending'
              AND actions.expires_at > ?
          )
        ) AS active_usage,
        EXISTS (
          SELECT 1 FROM billing_subscription_sync_leases AS leases
          INNER JOIN billing_subscriptions AS subscriptions
            ON subscriptions.id = leases.subscription_id
          WHERE subscriptions.user_id = ? AND leases.expires_at > ?
        ) AS active_subscription_sync,
        EXISTS (
          SELECT 1 FROM billing_purchases
          WHERE user_id = ? AND stripe_state_sync_started_at IS NOT NULL
            AND stripe_state_sync_started_at > ?
        ) AS active_purchase_sync
    `)
    .bind(
      candidate.user_id,
      now,
      candidate.user_id,
      now,
      candidate.user_id,
      now,
      candidate.user_id,
      now,
      candidate.user_id,
      now - EXECUTION_LEASE_SECONDS,
    )
    .first<{
      active_usage: number;
      active_subscription_sync: number;
      active_purchase_sync: number;
    }>();
  if (local?.active_usage === 1) return "active_usage_operation";
  if (
    local?.active_subscription_sync === 1 ||
    local?.active_purchase_sync === 1
  ) {
    return "billing_sync_in_progress";
  }

  if (!candidate.stripe_customer_id) {
    const ledger = await database
      .prepare(`
        SELECT
          EXISTS (
            SELECT 1 FROM billing_subscriptions
            WHERE user_id = ?
              AND status NOT IN ('canceled', 'incomplete_expired')
          ) AS active_subscription,
          EXISTS (
            SELECT 1 FROM billing_purchases
            WHERE user_id = ? AND dispute_state IN (
              'needs_response', 'under_review',
              'warning_needs_response', 'warning_under_review'
            )
          ) AS open_dispute
      `)
      .bind(candidate.user_id, candidate.user_id)
      .first<{ active_subscription: number; open_dispute: number }>();
    if (ledger?.active_subscription === 1) return "active_subscription";
    if (ledger?.open_dispute === 1) return "open_dispute";
    return null;
  }

  if (!isBillingConfigured()) {
    throw new AccountDeletionExecutionError("billing_guard_unavailable");
  }
  if (await hasLiveSubscription(candidate.stripe_customer_id)) {
    return "active_subscription";
  }
  if (await hasOpenStripeDispute(candidate.stripe_customer_id)) {
    return "open_dispute";
  }
  return null;
}

async function hasLiveSubscription(stripeCustomerId: string) {
  const subscriptions = await stripeGet<StripeSubscriptionList>(
    `/v1/subscriptions?customer=${encodeURIComponent(stripeCustomerId)}&status=all&limit=100`,
  );
  const values = validatedStripeList(
    subscriptions,
    "stripe_subscription_state_invalid",
  );
  let blocking = false;
  for (const value of values) {
    const status = stringField(value, "status");
    const items = recordValue(value.items)?.data;
    if (!Array.isArray(items)) {
      throw new AccountDeletionExecutionError("stripe_subscription_state_invalid");
    }
    const appSubscription = items.some((item) => {
      const priceId = stringField(recordValue(recordValue(item)?.price), "id");
      return Boolean(priceId && stripeMonthlyPlanForPrice(priceId));
    });
    if (!appSubscription) continue;
    if (!status) {
      throw new AccountDeletionExecutionError("stripe_subscription_state_invalid");
    }
    if (!TERMINAL_SUBSCRIPTION_STATUSES.has(status)) blocking = true;
  }
  if (subscriptions.has_more === true && !blocking) {
    throw new AccountDeletionExecutionError(
      "stripe_subscription_history_truncated",
    );
  }
  return blocking;
}

async function hasOpenStripeDispute(stripeCustomerId: string) {
  const charges = await stripeGet<StripeChargeList>(
    `/v1/charges?customer=${encodeURIComponent(stripeCustomerId)}&limit=100`,
  );
  const values = validatedStripeList(charges, "stripe_charge_state_invalid");
  if (charges.has_more === true) {
    throw new AccountDeletionExecutionError("stripe_charge_history_truncated");
  }
  const disputedCharges: string[] = [];
  for (const charge of values) {
    if (typeof charge.disputed !== "boolean") {
      throw new AccountDeletionExecutionError("stripe_charge_state_invalid");
    }
    if (!charge.disputed) continue;
    const id = stringField(charge, "id");
    if (!id) {
      throw new AccountDeletionExecutionError("stripe_charge_state_invalid");
    }
    disputedCharges.push(id);
  }
  if (disputedCharges.length > MAX_DISPUTED_CHARGES_PER_ACCOUNT) {
    throw new AccountDeletionExecutionError("stripe_dispute_history_truncated");
  }
  for (const chargeId of disputedCharges) {
    const disputes = await stripeGet<StripeDisputeList>(
      `/v1/disputes?charge=${encodeURIComponent(chargeId)}&limit=100`,
    );
    const disputeValues = validatedStripeList(
      disputes,
      "stripe_dispute_state_invalid",
    );
    if (disputes.has_more === true || !disputeValues.length) {
      throw new AccountDeletionExecutionError("stripe_dispute_state_invalid");
    }
    for (const dispute of disputeValues) {
      const status = stringField(dispute, "status");
      if (!status) {
        throw new AccountDeletionExecutionError("stripe_dispute_state_invalid");
      }
      if (OPEN_DISPUTE_STATUSES.has(status)) return true;
      if (!TERMINAL_DISPUTE_STATUSES.has(status)) {
        throw new AccountDeletionExecutionError("stripe_dispute_state_unknown");
      }
    }
  }
  return false;
}

function validatedStripeList(
  value: { data?: unknown[]; has_more?: unknown },
  code: string,
) {
  if (!Array.isArray(value.data) || typeof value.has_more !== "boolean") {
    throw new AccountDeletionExecutionError(code);
  }
  const records = value.data.map(recordValue);
  if (records.some((record) => record === null)) {
    throw new AccountDeletionExecutionError(code);
  }
  return records as Array<Record<string, unknown>>;
}

async function collectDeletionSummary(
  database: D1Database,
  candidate: DeletionCandidate & { email: string },
): Promise<DeletionSummary> {
  const ownerEmail = candidate.email.toLowerCase();
  const row = await database
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM account_passkeys WHERE user_id = ?) AS passkeys,
        (SELECT COUNT(*) FROM account_external_identities WHERE user_id = ?)
          AS external_identities,
        (SELECT COUNT(*) FROM account_sessions WHERE user_id = ?) AS sessions,
        (SELECT COUNT(*) FROM account_recovery_challenges WHERE user_id = ?)
          AS recovery_requests,
        (SELECT COUNT(*) FROM usage_reservations WHERE user_id = ?)
          AS reservations,
        (SELECT COUNT(*) FROM usage_reservations
          WHERE user_id = ? AND status = 'completed'
            AND bucket IN ('subscription', 'one_time'))
          AS completed_paid_reservations,
        (SELECT COUNT(*) FROM video_transfers
          WHERE lower(owner_email) = ?) AS transfers
    `)
    .bind(
      candidate.user_id,
      candidate.user_id,
      candidate.user_id,
      candidate.user_id,
      candidate.user_id,
      candidate.user_id,
      ownerEmail,
    )
    .first<Record<string, unknown>>();
  return {
    passkeys: safeCount(row?.passkeys),
    externalIdentities: safeCount(row?.external_identities),
    sessions: safeCount(row?.sessions),
    recoveryRequests: safeCount(row?.recovery_requests),
    reservations: safeCount(row?.reservations),
    completedPaidReservations: safeCount(row?.completed_paid_reservations),
    transfers: safeCount(row?.transfers),
  };
}

async function removeOwnedMedia(
  candidate: DeletionCandidate & { email: string },
) {
  const ownerEmail = candidate.email.toLowerCase();
  const rows = await databaseOrThrow()
    .prepare(`
      SELECT id, object_key, upload_id, status
      FROM video_transfers
      WHERE lower(owner_email) = ?
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .bind(ownerEmail, MAX_MEDIA_TRANSFERS_PER_ACCOUNT + 1)
    .all<MediaTransferRow>();
  const transfers = rows.results ?? [];
  if (transfers.length > MAX_MEDIA_TRANSFERS_PER_ACCOUNT) {
    throw new AccountDeletionExecutionError("media_transfer_limit_exceeded");
  }
  const active = transfers.filter((transfer) => transfer.status !== "deleted");
  if (!active.length) return;
  const bucket = getMediaBucket();
  for (let index = 0; index < active.length; index += 8) {
    const results = await Promise.allSettled(
      active.slice(index, index + 8).map(async (transfer) => {
        if (transfer.status === "uploading") {
          // Fail closed. R2 does not expose a stable, typed "already absent"
          // result through this binding, so treating an arbitrary abort error
          // as success could delete D1 ownership metadata while uploaded parts
          // remain in storage. A later bounded run retries the same request.
          await bucket
            .resumeMultipartUpload(transfer.object_key, transfer.upload_id)
            .abort();
          return;
        }
        await bucket.delete(transfer.object_key);
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new AccountDeletionExecutionError("media_cleanup_failed");
    }
  }
}

async function completeDeletion(
  database: D1Database,
  values: {
    candidate: DeletionCandidate & { email: string };
    executionToken: string;
    accountReference: string;
    requestId: string;
    summary: DeletionSummary;
    startedAt: number;
    now: number;
  },
) {
  const { candidate } = values;
  const ownerEmail = candidate.email.toLowerCase();
  const anonymousEmail = `deleted+${crypto.randomUUID().replaceAll("-", "")}@anonymous.torudake.invalid`;
  const auditId = crypto.randomUUID();
  const auditSummary = JSON.stringify(values.summary);
  const statements = [
    database
      .prepare(`
        DELETE FROM video_transfer_parts
        WHERE transfer_id IN (
          SELECT id FROM video_transfers WHERE lower(owner_email) = ?
        )
      `)
      .bind(ownerEmail),
    database
      .prepare("DELETE FROM video_transfers WHERE lower(owner_email) = ?")
      .bind(ownerEmail),
    database
      .prepare(`
        DELETE FROM operator_usage_operations
        WHERE reservation_id IN (
          SELECT id FROM usage_reservations WHERE user_id = ?
        )
      `)
      .bind(candidate.user_id),
    database
      .prepare(`
        DELETE FROM usage_observed_durations
        WHERE reservation_id IN (
          SELECT id FROM usage_reservations WHERE user_id = ?
        )
      `)
      .bind(candidate.user_id),
    database
      .prepare(`
        DELETE FROM usage_operation_leases
        WHERE reservation_id IN (
          SELECT id FROM usage_reservations WHERE user_id = ?
        )
      `)
      .bind(candidate.user_id),
    database
      .prepare(`
        DELETE FROM metered_ai_actions
        WHERE reservation_id IN (
          SELECT id FROM usage_reservations WHERE user_id = ?
        )
      `)
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM usage_release_intents WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM usage_reservations WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare(`
        UPDATE ai_disclosure_confirmations
        SET user_id = NULL, session_hash = 'deleted:' || id
        WHERE user_id = ? OR session_hash IN (
          SELECT session_hash FROM trial_sessions WHERE account_user_id = ?
        )
      `)
      .bind(candidate.user_id, candidate.user_id),
    database
      .prepare(`
        DELETE FROM trial_issuance_fingerprints
        WHERE session_hash IN (
          SELECT session_hash FROM trial_sessions WHERE account_user_id = ?
        )
      `)
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM trial_sessions WHERE account_user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM caption_profiles WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_oauth_challenges WHERE initiating_user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_email_challenges WHERE initiating_user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_auth_challenges WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_recovery_challenges WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_sessions WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_external_identities WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM account_passkeys WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM billing_checkout_locks WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare("DELETE FROM billing_rate_limits WHERE user_id = ?")
      .bind(candidate.user_id),
    database
      .prepare(`
        UPDATE users
        SET email = ?, billing_email = NULL, full_name = NULL,
          account_deleted_at = ?, updated_at = ?
        WHERE id = ? AND account_deleted_at IS NULL
      `)
      .bind(anonymousEmail, values.now, values.now, candidate.user_id),
    database
      .prepare(`
        UPDATE account_deletion_requests
        SET status = 'completed', completed_at = ?, execution_token = NULL,
          execution_started_at = NULL, last_block_reason = NULL,
          last_error_code = NULL, updated_at = ?
        WHERE user_id = ? AND status = 'processing' AND execution_token = ?
      `)
      .bind(
        values.now,
        values.now,
        candidate.user_id,
        values.executionToken,
      ),
    auditStatement(database, {
      id: auditId,
      accountReference: values.accountReference,
      requestId: values.requestId,
      dryRun: false,
      outcome: "completed",
      reasonCode: null,
      summary: auditSummary,
      startedAt: values.startedAt,
      completedAt: values.now,
    }),
  ];
  await database.batch(statements);
}

async function releaseBlockedExecution(
  database: D1Database,
  values: {
    userId: string;
    executionToken: string;
    accountReference: string;
    requestId: string;
    blockReason: string;
    summary: DeletionSummary;
    startedAt: number;
    now: number;
  },
) {
  await database.batch([
    database
      .prepare(`
        UPDATE account_deletion_requests
        SET status = 'scheduled', execution_token = NULL,
          execution_started_at = NULL, last_block_reason = ?,
          last_error_code = NULL, updated_at = ?
        WHERE user_id = ? AND status = 'processing' AND execution_token = ?
      `)
      .bind(
        values.blockReason,
        values.now,
        values.userId,
        values.executionToken,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      accountReference: values.accountReference,
      requestId: values.requestId,
      dryRun: false,
      outcome: "blocked",
      reasonCode: values.blockReason,
      summary: JSON.stringify(values.summary),
      startedAt: values.startedAt,
      completedAt: values.now,
    }),
  ]);
}

async function releaseFailedExecution(
  database: D1Database,
  values: {
    userId: string;
    executionToken: string;
    accountReference: string;
    requestId: string;
    reasonCode: string;
    summary: DeletionSummary;
    startedAt: number;
    now: number;
  },
) {
  await database.batch([
    database
      .prepare(`
        UPDATE account_deletion_requests
        SET status = 'scheduled', execution_token = NULL,
          execution_started_at = NULL, last_error_code = ?, updated_at = ?
        WHERE user_id = ? AND status = 'processing' AND execution_token = ?
      `)
      .bind(
        values.reasonCode,
        values.now,
        values.userId,
        values.executionToken,
      ),
    auditStatement(database, {
      id: crypto.randomUUID(),
      accountReference: values.accountReference,
      requestId: values.requestId,
      dryRun: false,
      outcome: "failed",
      reasonCode: values.reasonCode,
      summary: JSON.stringify(values.summary),
      startedAt: values.startedAt,
      completedAt: values.now,
    }),
  ]);
}

async function appendAudit(
  database: D1Database,
  values: {
    accountReference: string;
    requestId: string;
    dryRun: boolean;
    outcome: "ready" | "blocked" | "failed";
    reasonCode: string | null;
    summary: DeletionSummary;
    startedAt: number;
  },
) {
  await auditStatement(database, {
    id: crypto.randomUUID(),
    accountReference: values.accountReference,
    requestId: values.requestId,
    dryRun: values.dryRun,
    outcome: values.outcome,
    reasonCode: values.reasonCode,
    summary: JSON.stringify(values.summary),
    startedAt: values.startedAt,
    completedAt: Math.floor(Date.now() / 1_000),
  }).run();
}

function auditStatement(
  database: D1Database,
  values: {
    id: string;
    accountReference: string;
    requestId: string;
    dryRun: boolean;
    outcome: "ready" | "blocked" | "completed" | "failed";
    reasonCode: string | null;
    summary: string;
    startedAt: number;
    completedAt: number;
  },
) {
  return database
    .prepare(`
      INSERT INTO account_deletion_execution_audit (
        id, account_reference, request_id, dry_run, outcome, reason_code,
        summary, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      values.id,
      values.accountReference,
      values.requestId,
      values.dryRun ? 1 : 0,
      values.outcome,
      values.reasonCode,
      values.summary,
      values.startedAt,
      values.completedAt,
    );
}

async function deletionAccountReference(userId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`account-deletion-audit-v1\n${userId}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function emptySummary(): DeletionSummary {
  return {
    passkeys: 0,
    externalIdentities: 0,
    sessions: 0,
    recoveryRequests: 0,
    reservations: 0,
    completedPaidReservations: 0,
    transfers: 0,
  };
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown> | null, field: string) {
  const candidate = value?.[field];
  return typeof candidate === "string" && candidate ? candidate : null;
}

function executionErrorCode(error: unknown) {
  return error instanceof AccountDeletionExecutionError
    ? error.code
    : "account_deletion_execution_failed";
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_EXECUTION_BATCH;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXECUTION_BATCH) {
    throw new AccountDeletionExecutionError("invalid_execution_limit");
  }
  return value;
}

function normalizeRequestId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new AccountDeletionExecutionError("invalid_request_id");
  }
  return normalized;
}

function databaseOrThrow() {
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare || !database.batch) {
    throw new AccountDeletionExecutionError("account_database_unavailable");
  }
  return database;
}
