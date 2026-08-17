import {
  getRegisteredTrialSessionId,
  hashTrialSessionId,
  unboundTrialSessionPrincipalEmail,
} from "./trial-session-store";
import {
  anonymousTrialAccountTransferStatements,
  type AnonymousTrialAccountTransferContext,
} from "./anonymous-trial-account-transfer";

export type ExternalIdentityProvider = "line" | "google" | "email";

const RECENT_LINK_SESSION_SECONDS = 10 * 60;
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/;

type D1Result = { meta?: { changes?: number } };
type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<D1Result>;
};
export type ExternalAccountDatabase = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

export type ExternalAuthTrialContext = AnonymousTrialAccountTransferContext & {
  sessionId: string;
};

type StoredIdentity = {
  id: string;
  user_id: string;
  revoked_at: number | null;
  account_deleted_at: number | null;
};

export class ExternalAccountAuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ExternalAccountAuthError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Adds a verified provider subject to one already-authenticated account.
 *
 * The provider subject is authoritative; verified email is metadata only and
 * is never used to locate or merge users. Repeating a completed link for the
 * same account is idempotent. A subject owned by any other account remains a
 * hard conflict, including when that old identity is no longer usable.
 */
export async function linkVerifiedExternalIdentity(values: {
  database: ExternalAccountDatabase;
  userId: string;
  provider: ExternalIdentityProvider;
  subjectHash: string;
  verifiedEmail: string | null;
  initiatingSessionTokenHash: string;
  now?: number;
}) {
  validateSubjectHash(values.subjectHash);
  validateSessionTokenHash(values.initiatingSessionTokenHash);
  const now = values.now ?? Math.floor(Date.now() / 1_000);
  const existing = await findStoredIdentity(
    values.database,
    values.provider,
    values.subjectHash,
  );
  if (existing) {
    return await reuseLinkedIdentity({ ...values, existing, now });
  }

  const identityId = crypto.randomUUID();
  try {
    const inserted = await values.database
      .prepare(`
        INSERT INTO account_external_identities (
          id, user_id, provider, subject_hash, verified_email,
          created_at, last_used_at, revoked_at
        )
        SELECT ?, users.id, ?, ?, ?, ?, ?, NULL
        FROM users
        WHERE users.id = ?
          AND users.account_deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM account_sessions
            WHERE token_hash = ? AND user_id = users.id
              AND expires_at > ? AND created_at >= ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM account_external_identities
            WHERE provider = ? AND subject_hash = ?
          )
      `)
      .bind(
        identityId,
        values.provider,
        values.subjectHash,
        values.verifiedEmail,
        now,
        now,
        values.userId,
        values.initiatingSessionTokenHash,
        now,
        now - RECENT_LINK_SESSION_SECONDS,
        values.provider,
        values.subjectHash,
      )
      .run();
    if (inserted.meta?.changes === 1) {
      return { identityId, userId: values.userId, reused: false };
    }
  } catch (creationError) {
    const winner = await findStoredIdentity(
      values.database,
      values.provider,
      values.subjectHash,
    ).catch(() => null);
    if (!winner) throw creationError;
    return await reuseLinkedIdentity({ ...values, existing: winner, now });
  }

  const winner = await findStoredIdentity(
    values.database,
    values.provider,
    values.subjectHash,
  );
  if (winner) {
    return await reuseLinkedIdentity({ ...values, existing: winner, now });
  }
  throw new ExternalAccountAuthError(
    "link_session_changed",
    "現在のアカウントにログイン方法を追加できませんでした。もう一度ログインしてお試しください。",
    401,
  );
}
/**
 * Reuses an already-linked provider only while the exact session that began
 * reauthentication is still active. An old-but-live session is allowed here
 * because the provider ceremony itself is the step-up proof.
 */
export async function reauthenticateVerifiedExternalIdentity(values: {
  database: ExternalAccountDatabase;
  userId: string;
  provider: ExternalIdentityProvider;
  subjectHash: string;
  verifiedEmail: string | null;
  initiatingSessionTokenHash: string;
  now?: number;
}) {
  validateSubjectHash(values.subjectHash);
  validateSessionTokenHash(values.initiatingSessionTokenHash);
  const now = values.now ?? Math.floor(Date.now() / 1_000);
  const existing = await findStoredIdentity(
    values.database,
    values.provider,
    values.subjectHash,
  );
  if (!existing || existing.user_id !== values.userId) {
    throw new ExternalAccountAuthError(
      "reauthentication_identity_changed",
      "現在のアカウントに登録されたログイン方法で本人確認してください。",
      401,
    );
  }
  assertActiveIdentity(existing);
  const touched = await values.database
    .prepare(`
      UPDATE account_external_identities
      SET last_used_at = ?,
        verified_email = CASE
          WHEN ? IS NOT NULL THEN ?
          ELSE verified_email
        END
      WHERE id = ? AND user_id = ? AND provider = ? AND subject_hash = ?
        AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM account_sessions
          INNER JOIN users ON users.id = account_sessions.user_id
          WHERE account_sessions.token_hash = ?
            AND account_sessions.user_id = ?
            AND account_sessions.expires_at > ?
            AND users.account_deleted_at IS NULL
        )
    `)
    .bind(
      now,
      values.verifiedEmail,
      values.verifiedEmail,
      existing.id,
      values.userId,
      values.provider,
      values.subjectHash,
      values.initiatingSessionTokenHash,
      values.userId,
      now,
    )
    .run();
  if (touched.meta?.changes !== 1) {
    throw new ExternalAccountAuthError(
      "reauthentication_identity_changed",
      "本人確認中にログイン状態が変わりました。もう一度ログインしてお試しください。",
      401,
    );
  }
  return {
    identityId: existing.id,
    userId: values.userId,
  };
}

/**
 * OAuth and email verification both start from the same registered, unbound
 * trial principal. Creating this internal user before redirect preserves the
 * exact owner used by usage reservations made in the editor.
 */
export async function prepareExternalAuthTrialContext(
  request: Request,
  database: ExternalAccountDatabase,
  now = Math.floor(Date.now() / 1_000),
): Promise<ExternalAuthTrialContext> {
  const sessionId = await getRegisteredTrialSessionId(request);
  if (!sessionId) throw trialContextError();
  const principalEmail = await unboundTrialSessionPrincipalEmail(
    sessionId,
    now,
  );
  if (!principalEmail) throw trialContextError();

  let user = await database
    .prepare(`
      SELECT id, account_deleted_at
      FROM users
      WHERE email = ?
      LIMIT 1
    `)
    .bind(principalEmail)
    .first<{ id: string; account_deleted_at: number | null }>();
  if (!user) {
    const userId = crypto.randomUUID();
    await database
      .prepare(`
        INSERT INTO users (
          id, email, billing_email, full_name, stripe_customer_id,
          account_deleted_at, created_at, updated_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(email) DO NOTHING
      `)
      .bind(userId, principalEmail, now, now)
      .run();
    user = await database
      .prepare(`
        SELECT id, account_deleted_at
        FROM users
        WHERE email = ?
        LIMIT 1
      `)
      .bind(principalEmail)
      .first<{ id: string; account_deleted_at: number | null }>();
  }
  if (!user || user.account_deleted_at !== null) throw trialContextError();
  return {
    sessionId,
    sessionHash: await hashTrialSessionId(sessionId),
    principalEmail,
    userId: user.id,
  };
}

/** Re-checks that the callback has the same unbound trial cookie as start. */
export async function verifyExternalAuthTrialContext(
  request: Request,
  database: ExternalAccountDatabase,
  expectedUserId: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<ExternalAuthTrialContext> {
  const sessionId = await getRegisteredTrialSessionId(request);
  if (!sessionId) throw trialContextChangedError();
  const principalEmail = await unboundTrialSessionPrincipalEmail(
    sessionId,
    now,
  );
  if (!principalEmail) throw trialContextChangedError();
  const user = await database
    .prepare(`
      SELECT id, account_deleted_at
      FROM users
      WHERE email = ?
      LIMIT 1
    `)
    .bind(principalEmail)
    .first<{ id: string; account_deleted_at: number | null }>();
  if (
    !user ||
    user.id !== expectedUserId ||
    user.account_deleted_at !== null
  ) {
    throw trialContextChangedError();
  }
  return {
    sessionId,
    sessionHash: await hashTrialSessionId(sessionId),
    principalEmail,
    userId: user.id,
  };
}

/**
 * Makes a verified provider subject authoritative without consulting email.
 * A first-time identity is attached to the current trial owner. An existing
 * identity atomically receives only a strictly anonymous/free trial owner's
 * reservations before the trial is bound, preventing a second free bucket.
 */
export async function authenticateVerifiedExternalIdentity(values: {
  database: ExternalAccountDatabase;
  trial: ExternalAuthTrialContext | null;
  provider: ExternalIdentityProvider;
  subjectHash: string;
  verifiedEmail: string | null;
  now?: number;
}) {
  validateSubjectHash(values.subjectHash);
  const now = values.now ?? Math.floor(Date.now() / 1_000);
  const existing = await findStoredIdentity(
    values.database,
    values.provider,
    values.subjectHash,
  );
  if (!values.trial) {
    if (!existing) {
      throw new ExternalAccountAuthError(
        "external_identity_not_registered",
        "このログイン方法はまだ登録されていません。無料体験の画面から登録を始めてください。",
      );
    }
    return await authenticateExistingIdentityWithoutTrial({
      database: values.database,
      existing,
      verifiedEmail: values.verifiedEmail,
      now,
    });
  }
  const trial = values.trial;
  if (existing) {
    return await authenticateExistingIdentity({
      ...values,
      trial,
      now,
      existing,
    });
  }

  const identityId = crypto.randomUUID();
  try {
    const results = await values.database.batch([
      values.database
        .prepare(`
          INSERT INTO account_external_identities (
            id, user_id, provider, subject_hash, verified_email,
            created_at, last_used_at, revoked_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, NULL
          FROM trial_sessions
          WHERE session_hash = ?
            AND account_user_id IS NULL
            AND expires_at >= ?
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
                AND (bucket != 'free' OR billing_purchase_id IS NOT NULL)
            )
        `)
        .bind(
          identityId,
          trial.userId,
          values.provider,
          values.subjectHash,
          values.verifiedEmail,
          now,
          now,
          trial.sessionHash,
          now,
          trial.userId,
          trial.principalEmail,
          trial.userId,
          trial.userId,
          trial.userId,
          trial.userId,
          trial.userId,
          trial.userId,
        ),
      values.database
        .prepare(`
          UPDATE trial_sessions
          SET account_user_id = ?
          WHERE session_hash = ?
            AND account_user_id IS NULL
            AND expires_at >= ?
            AND EXISTS (
              SELECT 1 FROM account_external_identities
              WHERE id = ? AND user_id = ? AND provider = ?
                AND subject_hash = ? AND revoked_at IS NULL
            )
        `)
        .bind(
          trial.userId,
          trial.sessionHash,
          now,
          identityId,
          trial.userId,
          values.provider,
          values.subjectHash,
        ),
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
      throw trialContextChangedError();
    }
    return { identityId, userId: trial.userId };
  } catch (creationError) {
    // A concurrent callback for the same provider subject can win the unique
    // constraint. Only that exact verified identity is eligible for recovery.
    const winner = await findStoredIdentity(
      values.database,
      values.provider,
      values.subjectHash,
    ).catch(() => null);
    if (!winner) throw creationError;
    return await authenticateExistingIdentity({
      ...values,
      trial,
      now,
      existing: winner,
    });
  }
}

async function authenticateExistingIdentityWithoutTrial(values: {
  database: ExternalAccountDatabase;
  existing: StoredIdentity;
  verifiedEmail: string | null;
  now: number;
}) {
  assertActiveIdentity(values.existing);
  const result = await values.database
    .prepare(`
      UPDATE account_external_identities
      SET last_used_at = ?,
        verified_email = CASE
          WHEN ? IS NOT NULL THEN ?
          ELSE verified_email
        END
      WHERE id = ? AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM users
          WHERE id = ? AND account_deleted_at IS NULL
        )
    `)
    .bind(
      values.now,
      values.verifiedEmail,
      values.verifiedEmail,
      values.existing.id,
      values.existing.user_id,
    )
    .run();
  if (result.meta?.changes !== 1) {
    throw new ExternalAccountAuthError(
      "external_identity_unavailable",
      "このアカウントではログインできません。サポートへお問い合わせください。",
    );
  }
  return {
    identityId: values.existing.id,
    userId: values.existing.user_id,
  };
}

async function reuseLinkedIdentity(values: {
  database: ExternalAccountDatabase;
  userId: string;
  provider: ExternalIdentityProvider;
  subjectHash: string;
  verifiedEmail: string | null;
  initiatingSessionTokenHash: string;
  now: number;
  existing: StoredIdentity;
}) {
  if (values.existing.user_id !== values.userId) {
    throw new ExternalAccountAuthError(
      "external_identity_already_linked",
      "このログイン方法は別のアカウントに登録されています。アカウントを自動で統合することはできません。",
      409,
    );
  }
  assertActiveIdentity(values.existing);
  const touched = await values.database
    .prepare(`
      UPDATE account_external_identities
      SET last_used_at = ?,
        verified_email = CASE
          WHEN ? IS NOT NULL THEN ?
          ELSE verified_email
        END
      WHERE id = ? AND user_id = ? AND provider = ? AND subject_hash = ?
        AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM account_sessions
          INNER JOIN users ON users.id = account_sessions.user_id
          WHERE account_sessions.token_hash = ?
            AND account_sessions.user_id = ?
            AND account_sessions.expires_at > ?
            AND account_sessions.created_at >= ?
            AND users.account_deleted_at IS NULL
        )
    `)
    .bind(
      values.now,
      values.verifiedEmail,
      values.verifiedEmail,
      values.existing.id,
      values.userId,
      values.provider,
      values.subjectHash,
      values.initiatingSessionTokenHash,
      values.userId,
      values.now,
      values.now - RECENT_LINK_SESSION_SECONDS,
    )
    .run();
  if (touched.meta?.changes !== 1) {
    throw new ExternalAccountAuthError(
      "link_session_changed",
      "ログイン方法の確認中にログイン状態が変わりました。もう一度ログインしてお試しください。",
      401,
    );
  }
  return {
    identityId: values.existing.id,
    userId: values.userId,
    reused: true,
  };
}

async function authenticateExistingIdentity(values: {
  database: ExternalAccountDatabase;
  trial: ExternalAuthTrialContext;
  provider: ExternalIdentityProvider;
  subjectHash: string;
  verifiedEmail: string | null;
  now: number;
  existing: StoredIdentity;
}) {
  assertActiveIdentity(values.existing);
  if (values.existing.user_id === values.trial.userId) {
    const results = await values.database.batch([
      values.database
        .prepare(`
          UPDATE trial_sessions
          SET account_user_id = ?
          WHERE session_hash = ?
            AND account_user_id IS NULL
            AND expires_at >= ?
            AND EXISTS (
              SELECT 1 FROM account_external_identities
              WHERE id = ? AND user_id = ? AND revoked_at IS NULL
            )
        `)
        .bind(
          values.existing.user_id,
          values.trial.sessionHash,
          values.now,
          values.existing.id,
          values.existing.user_id,
        ),
      identityTouchStatement(
        values.database,
        values.existing.id,
        values.verifiedEmail,
        values.now,
        values.trial.sessionHash,
        values.existing.user_id,
      ),
    ]);
    if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
      throw trialContextChangedError();
    }
    return {
      identityId: values.existing.id,
      userId: values.existing.user_id,
    };
  }

  const transferStatements = anonymousTrialAccountTransferStatements(
    values.database,
    {
      trial: values.trial,
      targetUserId: values.existing.user_id,
      targetProof: {
        kind: "external",
        identityId: values.existing.id,
        provider: values.provider,
        subjectHash: values.subjectHash,
      },
      now: values.now,
    },
  );
  const results = await values.database.batch([
    ...transferStatements,
    identityTouchStatement(
      values.database,
      values.existing.id,
      values.verifiedEmail,
      values.now,
      values.trial.sessionHash,
      values.existing.user_id,
    ),
  ]);
  if (
    results[0]?.meta?.changes !== 1 ||
    results[transferStatements.length]?.meta?.changes !== 1
  ) {
    throw new ExternalAccountAuthError(
      "unsafe_trial_account_merge",
      "無料体験の編集データを安全に引き継げませんでした。もう一度お試しください。",
    );
  }
  return {
    identityId: values.existing.id,
    userId: values.existing.user_id,
  };
}

function identityTouchStatement(
  database: ExternalAccountDatabase,
  identityId: string,
  verifiedEmail: string | null,
  now: number,
  trialSessionHash: string,
  targetUserId: string,
) {
  return database
    .prepare(`
      UPDATE account_external_identities
      SET last_used_at = ?,
        verified_email = CASE
          WHEN ? IS NOT NULL THEN ?
          ELSE verified_email
        END
      WHERE id = ? AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM trial_sessions
          WHERE session_hash = ? AND account_user_id = ?
            AND expires_at >= ?
        )
    `)
    .bind(
      now,
      verifiedEmail,
      verifiedEmail,
      identityId,
      trialSessionHash,
      targetUserId,
      now,
    );
}

async function findStoredIdentity(
  database: ExternalAccountDatabase,
  provider: ExternalIdentityProvider,
  subjectHash: string,
) {
  return await database
    .prepare(`
      SELECT account_external_identities.id,
        account_external_identities.user_id,
        account_external_identities.revoked_at,
        users.account_deleted_at
      FROM account_external_identities
      INNER JOIN users ON users.id = account_external_identities.user_id
      WHERE account_external_identities.provider = ?
        AND account_external_identities.subject_hash = ?
      LIMIT 1
    `)
    .bind(provider, subjectHash)
    .first<StoredIdentity>();
}

function assertActiveIdentity(identity: StoredIdentity) {
  if (identity.revoked_at !== null || identity.account_deleted_at !== null) {
    throw new ExternalAccountAuthError(
      "external_identity_unavailable",
      "このアカウントではログインできません。サポートへお問い合わせください。",
    );
  }
}

function validateSubjectHash(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new ExternalAccountAuthError(
      "invalid_external_subject",
      "ログイン情報を確認できませんでした。もう一度お試しください。",
    );
  }
}

function validateSessionTokenHash(value: string) {
  if (!SESSION_HASH_PATTERN.test(value)) throw linkSessionChangedError();
}

function linkSessionChangedError() {
  return new ExternalAccountAuthError(
    "link_session_changed",
    "ログイン方法の確認中にログイン状態が変わりました。もう一度ログインしてお試しください。",
    401,
  );
}

function trialContextError() {
  return new ExternalAccountAuthError(
    "trial_session_required",
    "無料体験の確認が必要です。ページを再読み込みしてお試しください。",
  );
}

function trialContextChangedError() {
  return new ExternalAccountAuthError(
    "trial_identity_changed",
    "ログインを始めたブラウザの確認情報が変わりました。もう一度お試しください。",
  );
}
