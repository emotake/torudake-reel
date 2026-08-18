import {
  purgeExpiredAccountChallenges,
  runDueAccountDeletions,
} from "../../../../lib/account-deletion-executor";
import {
  authorizeAccountDeletionOperations,
  isAccountDeletionOperationsConfigured,
} from "../../../../lib/account-deletion-operations-auth";
import {
  getRequestIdentifiers,
  logOperationalEvent,
  withRequestIdentifier,
} from "../../../../lib/observability";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;
const EXECUTION_CONFIRMATION = "execute-due-account-deletions";

export async function POST(request: Request) {
  const { requestId, correlationId } = getRequestIdentifiers(request);
  if (!isAccountDeletionOperationsConfigured()) {
    return response(
      request,
      { error: "Account deletion operations are unavailable.", requestId },
      503,
      requestId,
    );
  }
  if (!(await authorizeAccountDeletionOperations(request))) {
    logOperationalEvent("warn", request, {
      event: "account_deletion_access_denied",
      component: "account_deletion",
      operation: "authenticate_operator",
      outcome: "denied",
      status: 401,
      errorCode: "invalid_account_deletion_operations_secret",
      requestId,
      correlationId,
    });
    return response(
      request,
      { error: "Authentication required.", requestId },
      401,
      requestId,
    );
  }

  let payload: { dryRun?: unknown; limit?: unknown; confirmation?: unknown };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_BODY_BYTES,
    );
  } catch (error) {
    return response(
      request,
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "Request body is too large."
            : "Invalid request body.",
        requestId,
      },
      error instanceof RequestBodyTooLargeError ? 413 : 400,
      requestId,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return response(
      request,
      { error: "Invalid request body.", requestId },
      400,
      requestId,
    );
  }
  const dryRun = payload.dryRun !== false;
  const limit = payload.limit === undefined ? undefined : Number(payload.limit);
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
  ) {
    return response(
      request,
      { error: "limit must be an integer from 1 to 25.", requestId },
      400,
      requestId,
    );
  }
  if (
    !dryRun &&
    (payload.confirmation !== EXECUTION_CONFIRMATION ||
      request.headers.get("x-operations-confirm") !== EXECUTION_CONFIRMATION)
  ) {
    return response(
      request,
      { error: "Explicit execution confirmation is required.", requestId },
      409,
      requestId,
    );
  }

  try {
    let challengeRetention:
      | {
          status: "purged";
          accountAuthChallenges: number;
          accountEmailChallenges: number;
          accountOauthChallenges: number;
          accountRecoveryChallenges: number;
          total: number;
          batches: number;
          hasMore: boolean;
        }
      | { status: "failed"; reason: "challenge_retention_failed" }
      | { status: "skipped"; reason: "dry_run" };
    if (dryRun) {
      challengeRetention = { status: "skipped", reason: "dry_run" };
    } else {
      try {
        const purge = await purgeExpiredAccountChallenges();
        challengeRetention = {
          status: "purged",
          ...purge,
        };
        logOperationalEvent(purge.hasMore ? "warn" : "info", request, {
          event: "expired_account_challenges_purged",
          component: "account_deletion",
          operation: "purge_expired_account_challenges",
          outcome: purge.hasMore ? "partial_failure" : "completed",
          status: 200,
          errorCode: purge.hasMore
            ? "challenge_retention_backlog_remaining"
            : null,
          requestId,
          correlationId,
        });
      } catch (error) {
        challengeRetention = {
          status: "failed",
          reason: "challenge_retention_failed",
        };
        logOperationalEvent("error", request, {
          event: "expired_account_challenge_purge_failed",
          component: "account_deletion",
          operation: "purge_expired_account_challenges",
          outcome: "failed",
          status: 500,
          errorCode: "challenge_retention_failed",
          error,
          requestId,
          correlationId,
        });
      }
    }
    const result = await runDueAccountDeletions({
      dryRun,
      limit,
      requestId,
    });
    logOperationalEvent(result.failed ? "warn" : "info", request, {
      event: dryRun
        ? "account_deletion_dry_run_completed"
        : "account_deletion_execution_completed",
      component: "account_deletion",
      operation: dryRun ? "inspect_due_accounts" : "execute_due_accounts",
      outcome: result.failed ? "partial_failure" : "completed",
      status: 200,
      errorCode: result.failed ? "account_deletion_partial_failure" : null,
      requestId,
      correlationId,
    });
    return response(
      request,
      { ...result, challengeRetention, requestId },
      200,
      requestId,
    );
  } catch (error) {
    logOperationalEvent("error", request, {
      event: "account_deletion_run_failed",
      component: "account_deletion",
      operation: dryRun ? "inspect_due_accounts" : "execute_due_accounts",
      outcome: "failed",
      status: 500,
      errorCode: "account_deletion_run_failed",
      error,
      requestId,
      correlationId,
    });
    return response(
      request,
      { error: "Account deletion run failed.", requestId },
      500,
      requestId,
    );
  }
}

function response(
  request: Request,
  body: Record<string, unknown>,
  status: number,
  requestId: string,
) {
  const result = Response.json(body, { status });
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("Vary", "Authorization");
  result.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return withRequestIdentifier(result, request, requestId);
}
