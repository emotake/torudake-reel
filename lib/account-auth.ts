import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { env } from "cloudflare:workers";
import {
  accountChallengeCookie,
  accountSessionCookie,
  base64UrlToBytes,
  bytesToBase64Url,
  clearAccountChallengeCookie,
  clearAccountSessionCookie,
  getAccountChallengeToken,
  getAccountSessionToken,
  hashAccountToken,
  randomAccountToken,
} from "./account-session";
import {
  bindTrialSessionToAccount,
  getRegisteredTrialSessionId,
  trialSessionPrincipalEmail,
  unboundTrialSessionPrincipalEmail,
} from "./trial-session-store";

const CHALLENGE_LIFETIME_SECONDS = 5 * 60;
const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const AUTH_NAME = "撮るだけリール";
const AUTH_RATE_WINDOW_SECONDS = 10 * 60;
const AUTH_NETWORK_LIMIT = 30;
const AUTH_GLOBAL_LIMIT = 3_000;
const MAX_PASSKEYS_PER_ACCOUNT = 10;
const RECENT_AUTHENTICATION_SECONDS = 10 * 60;
const RECOVERY_REQUEST_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const RECOVERY_RATE_WINDOW_SECONDS = 24 * 60 * 60;
const RECOVERY_CONTACT_LIMIT = 3;
const RECOVERY_NETWORK_LIMIT = 5;
const RECOVERY_GLOBAL_LIMIT = 1_000;
const PASSKEY_DISPLAY_NAME_MAX_LENGTH = 40;

type D1Result = { meta?: { changes?: number } };
type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<D1Result>;
};
type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

type AuthChallenge = {
  challenge: string;
  ceremony: "registration" | "authentication";
  user_id: string | null;
  expected_origin: string;
  rp_id: string;
};

type StoredPasskey = {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
};

export type AccountIdentity = {
  id: string;
  email: string;
  billingEmail: string | null;
  fullName: string | null;
};

export type AccountPasskeySummary = {
  id: string;
  displayName: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

export class AccountAuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly publicMessage: string;

  constructor(
    code: string,
    status: number,
    publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "AccountAuthError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export function isPasskeyAuthenticationConfigured() {
  const configuredSecret =
    typeof env.TRIAL_ISSUANCE_SECRET === "string"
      ? env.TRIAL_ISSUANCE_SECRET.trim()
      : "";
  return Boolean(databaseOrNull()?.prepare && configuredSecret.length >= 32);
}

export async function registrationOptions(request: Request) {
  const context = relyingPartyContext(request);
  const database = databaseOrThrow();
  const now = Math.floor(Date.now() / 1_000);
  const authenticatedAccount = await getAccountIdentity(request);
  let user: { id: string } | null = authenticatedAccount
    ? { id: authenticatedAccount.id }
    : null;

  if (!user) {
    const sessionId = await getRegisteredTrialSessionId(request);
    if (!sessionId) {
      throw new AccountAuthError(
        "trial_session_required",
        409,
        "無料体験の確認が必要です。ページを再読み込みしてお試しください。",
      );
    }

    const email = await trialSessionPrincipalEmail(sessionId);
    user = await database
      .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
      .bind(email)
      .first<{ id: string }>();
    if (!user) {
      const userId = crypto.randomUUID();
      await database
        .prepare(`
          INSERT INTO users (
            id, email, billing_email, full_name, stripe_customer_id,
            created_at, updated_at
          ) VALUES (?, ?, NULL, NULL, NULL, ?, ?)
          ON CONFLICT(email) DO NOTHING
        `)
        .bind(userId, email, now, now)
        .run();
      user = await database
        .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
        .bind(email)
        .first<{ id: string }>();
    }
  }
  if (!user) throw new Error("Passkey account could not be prepared.");

  const existingPasskeys = await database
    .prepare(`
      SELECT credential_id, transports
      FROM account_passkeys
      WHERE user_id = ?
      ORDER BY created_at ASC
      LIMIT 11
    `)
    .bind(user.id)
    .all<{ credential_id: string; transports: string | null }>();
  const existing = existingPasskeys.results ?? [];
  if (existing.length > 0 && !authenticatedAccount) {
    throw new AccountAuthError(
      "account_already_registered",
      409,
      "この無料体験にはアカウントが登録済みです。「ログイン」を選んでください。",
    );
  }
  if (existing.length >= MAX_PASSKEYS_PER_ACCOUNT) {
    throw new AccountAuthError(
      "passkey_limit_reached",
      409,
      "登録できるパスキーの上限に達しています。不要な端末の整理について運営へお問い合わせください。",
    );
  }

  const options = await generateRegistrationOptions({
    rpName: AUTH_NAME,
    rpID: context.rpId,
    userID: new TextEncoder().encode(user.id),
    userName: `member-${user.id.slice(-8)}`,
    userDisplayName: AUTH_NAME,
    attestationType: "none",
    timeout: CHALLENGE_LIFETIME_SECONDS * 1_000,
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    excludeCredentials: existing.map((credential) => ({
      id: credential.credential_id,
      transports: parseTransports(credential.transports),
    })),
    supportedAlgorithmIDs: [-7, -257],
  });
  const challengeToken = await saveChallenge(request, database, {
    challenge: options.challenge,
    ceremony: "registration",
    userId: user.id,
    context,
    now,
  });
  return {
    options,
    cookie: accountChallengeCookie(challengeToken, context.secure),
  };
}

export async function verifyRegistration(
  request: Request,
  response: RegistrationResponseJSON,
  requestedDisplayName?: unknown,
) {
  const challenge = await consumeChallenge(request, "registration");
  if (!challenge.user_id) throw new Error("Registration user is missing.");
  const authenticatedAccount = await getAccountIdentity(request);
  let trialSessionId: string | null = null;
  if (
    authenticatedAccount &&
    authenticatedAccount.id !== challenge.user_id
  ) {
    throw new AccountAuthError(
      "registration_identity_changed",
      401,
      "本人確認を始めたアカウントと現在のアカウントが異なります。もう一度お試しください。",
    );
  }
  if (!authenticatedAccount) {
    trialSessionId = await getRegisteredTrialSessionId(request);
    if (!trialSessionId) {
      throw new AccountAuthError(
        "registration_identity_changed",
        401,
        "登録を始めた本人確認情報を確認できませんでした。もう一度お試しください。",
      );
    }
    const expectedEmail = await unboundTrialSessionPrincipalEmail(
      trialSessionId,
    );
    if (!expectedEmail) {
      throw new AccountAuthError(
        "registration_identity_changed",
        401,
        "登録後のアカウントにはログインが必要です。ログインしてから、もう一度お試しください。",
      );
    }
    const expectedUser = await databaseOrThrow()
      .prepare("SELECT id FROM users WHERE email = ? LIMIT 1")
      .bind(expectedEmail)
      .first<{ id: string }>();
    if (expectedUser?.id !== challenge.user_id) {
      throw new AccountAuthError(
        "registration_identity_changed",
        401,
        "登録を始めた本人確認情報を確認できませんでした。もう一度お試しください。",
      );
    }
  }
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: challenge.expected_origin,
    expectedRPID: challenge.rp_id,
    requireUserPresence: true,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!verification.verified || !verification.registrationInfo.userVerified) {
    throw new AccountAuthError(
      "passkey_verification_failed",
      400,
      "本人確認を完了できませんでした。もう一度お試しください。",
    );
  }

  const database = databaseOrThrow();
  const now = Math.floor(Date.now() / 1_000);
  const { registrationInfo } = verification;
  const sessionToken = randomAccountToken();
  const sessionHash = await hashAccountToken(sessionToken);
  const transports = sanitizeTransports(response.response.transports);
  const displayName = normalizePasskeyDisplayName(requestedDisplayName);
  try {
    await database.batch([
      database
        .prepare(`
          INSERT INTO account_passkeys (
            credential_id, user_id, public_key, counter, transports,
            device_type, backed_up, display_name, created_at, updated_at,
            last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          registrationInfo.credential.id,
          challenge.user_id,
          bytesToBase64Url(registrationInfo.credential.publicKey),
          registrationInfo.credential.counter,
          transports.length ? JSON.stringify(transports) : null,
          registrationInfo.credentialDeviceType,
          registrationInfo.credentialBackedUp ? 1 : 0,
          displayName,
          now,
          now,
          now,
        ),
      sessionInsertStatement(
        database,
        sessionHash,
        challenge.user_id,
        now,
      ),
    ]);
  } catch {
    throw new AccountAuthError(
      "passkey_already_registered",
      409,
      "このパスキーは登録済みです。「ログイン」を選んでください。",
    );
  }

  if (
    trialSessionId &&
    !(await bindTrialSessionToAccount(trialSessionId, challenge.user_id))
  ) {
    await database.batch([
      database
        .prepare("DELETE FROM account_passkeys WHERE credential_id = ? AND user_id = ?")
        .bind(registrationInfo.credential.id, challenge.user_id),
      database
        .prepare("DELETE FROM account_sessions WHERE token_hash = ? AND user_id = ?")
        .bind(sessionHash, challenge.user_id),
    ]);
    throw new AccountAuthError(
      "registration_identity_changed",
      409,
      "アカウントと無料体験を安全に関連付けられませんでした。もう一度お試しください。",
    );
  }

  return authenticationResult(request, sessionToken);
}

export async function authenticationOptions(request: Request) {
  const context = relyingPartyContext(request);
  const options = await generateAuthenticationOptions({
    rpID: context.rpId,
    timeout: CHALLENGE_LIFETIME_SECONDS * 1_000,
    allowCredentials: [],
    userVerification: "required",
  });
  const now = Math.floor(Date.now() / 1_000);
  const challengeToken = await saveChallenge(request, databaseOrThrow(), {
    challenge: options.challenge,
    ceremony: "authentication",
    userId: null,
    context,
    now,
  });
  return {
    options,
    cookie: accountChallengeCookie(challengeToken, context.secure),
  };
}

export async function reauthenticationOptions(request: Request) {
  const context = relyingPartyContext(request);
  const identity = await requireAccountIdentity(request);
  const database = databaseOrThrow();
  const passkeys = await database
    .prepare(`
      SELECT credential_id, transports
      FROM account_passkeys
      WHERE user_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .bind(identity.id, MAX_PASSKEYS_PER_ACCOUNT)
    .all<{ credential_id: string; transports: string | null }>();
  const credentials = passkeys.results ?? [];
  if (!credentials.length) {
    throw new AccountAuthError(
      "passkey_not_found",
      404,
      "本人確認に使えるパスキーが見つかりませんでした。",
    );
  }
  const options = await generateAuthenticationOptions({
    rpID: context.rpId,
    timeout: CHALLENGE_LIFETIME_SECONDS * 1_000,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: parseTransports(credential.transports),
    })),
    userVerification: "required",
  });
  const now = Math.floor(Date.now() / 1_000);
  const challengeToken = await saveChallenge(request, database, {
    challenge: options.challenge,
    ceremony: "authentication",
    userId: identity.id,
    context,
    now,
  });
  return {
    options,
    cookie: accountChallengeCookie(challengeToken, context.secure),
  };
}

export async function verifyAuthentication(
  request: Request,
  response: AuthenticationResponseJSON,
) {
  const challenge = await consumeChallenge(request, "authentication");
  if (!/^[A-Za-z0-9_-]{16,1024}$/.test(response.id)) {
    throw new AccountAuthError(
      "unknown_passkey",
      400,
      "登録済みのパスキーを確認できませんでした。",
    );
  }
  const database = databaseOrThrow();
  const passkey = await database
    .prepare(`
      SELECT credential_id, user_id, public_key, counter, transports
      FROM account_passkeys
      WHERE credential_id = ?
      LIMIT 1
    `)
    .bind(response.id)
    .first<StoredPasskey>();
  if (!passkey) {
    throw new AccountAuthError(
      "unknown_passkey",
      404,
      "この端末で使えるアカウントが見つかりませんでした。",
    );
  }
  if (challenge.user_id && challenge.user_id !== passkey.user_id) {
    throw new AccountAuthError(
      "reauthentication_identity_changed",
      401,
      "現在のアカウントのパスキーで本人確認してください。",
    );
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: challenge.expected_origin,
    expectedRPID: challenge.rp_id,
    credential: {
      id: passkey.credential_id,
      publicKey: base64UrlToBytes(passkey.public_key),
      counter: passkey.counter,
      transports: parseTransports(passkey.transports),
    },
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    throw new AccountAuthError(
      "passkey_verification_failed",
      401,
      "本人確認を完了できませんでした。もう一度お試しください。",
    );
  }

  const now = Math.floor(Date.now() / 1_000);
  const sessionToken = randomAccountToken();
  const sessionHash = await hashAccountToken(sessionToken);
  await database.batch([
    database
      .prepare(`
        UPDATE account_passkeys
        SET counter = ?, updated_at = ?, last_used_at = ?
        WHERE credential_id = ?
      `)
      .bind(
        verification.authenticationInfo.newCounter,
        now,
        now,
        passkey.credential_id,
      ),
    sessionInsertStatement(database, sessionHash, passkey.user_id, now),
  ]);
  return authenticationResult(request, sessionToken);
}

export async function getAccountIdentity(request: Request) {
  const token = getAccountSessionToken(request);
  if (!token) return null;
  const database = databaseOrNull();
  if (!database) return null;
  const now = Math.floor(Date.now() / 1_000);
  const tokenHash = await hashAccountToken(token);
  const identity = await database
    .prepare(`
      SELECT users.id, users.email, users.billing_email, users.full_name
      FROM account_sessions
      INNER JOIN users ON users.id = account_sessions.user_id
      WHERE account_sessions.token_hash = ?
        AND account_sessions.expires_at > ?
        AND EXISTS (
          SELECT 1 FROM account_passkeys
          WHERE account_passkeys.user_id = users.id
        )
      LIMIT 1
    `)
    .bind(tokenHash, now)
    .first<{
      id: string;
      email: string;
      billing_email: string | null;
      full_name: string | null;
    }>();
  if (!identity) return null;
  await database
    .prepare(`
      UPDATE account_sessions
      SET last_seen_at = ?
      WHERE token_hash = ? AND last_seen_at < ?
    `)
    .bind(now, tokenHash, now - 24 * 60 * 60)
    .run()
    .catch(() => undefined);
  return {
    id: identity.id,
    email: identity.email,
    billingEmail: identity.billing_email,
    fullName: identity.full_name,
  } satisfies AccountIdentity;
}

export async function getAccountPasskeys(
  request: Request,
): Promise<AccountPasskeySummary[]> {
  const identity = await requireAccountIdentity(request);
  const rows = await databaseOrThrow()
    .prepare(`
      SELECT credential_id, display_name, device_type, backed_up,
        created_at, last_used_at
      FROM account_passkeys
      WHERE user_id = ?
      ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
      LIMIT ?
    `)
    .bind(identity.id, MAX_PASSKEYS_PER_ACCOUNT)
    .all<{
      credential_id: string;
      display_name: string;
      device_type: string;
      backed_up: number;
      created_at: number;
      last_used_at: number | null;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.credential_id,
    displayName:
      !row.display_name || row.display_name === "Device"
        ? "登録済みの端末"
        : row.display_name,
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function renameAccountPasskey(
  request: Request,
  credentialId: unknown,
  requestedDisplayName: unknown,
) {
  const identity = await requireAccountIdentity(request);
  const id = validateCredentialId(credentialId);
  const displayName = normalizePasskeyDisplayName(
    requestedDisplayName,
    false,
  );
  const now = Math.floor(Date.now() / 1_000);
  const updated = await databaseOrThrow()
    .prepare(`
      UPDATE account_passkeys
      SET display_name = ?, updated_at = ?
      WHERE credential_id = ? AND user_id = ?
    `)
    .bind(displayName, now, id, identity.id)
    .run();
  if (updated.meta?.changes !== 1) {
    throw new AccountAuthError(
      "passkey_not_found",
      404,
      "指定したパスキーが見つかりませんでした。",
    );
  }
  return { displayName };
}

export async function deleteAccountPasskey(
  request: Request,
  credentialId: unknown,
) {
  const session = await requireRecentAccountSession(request);
  const id = validateCredentialId(credentialId);
  const database = databaseOrThrow();
  const deleted = await database
    .prepare(`
      DELETE FROM account_passkeys
      WHERE credential_id = ?
        AND user_id = ?
        AND (
          SELECT COUNT(*) FROM account_passkeys WHERE user_id = ?
        ) > 1
    `)
    .bind(id, session.userId, session.userId)
    .run();
  if (deleted.meta?.changes !== 1) {
    const passkey = await database
      .prepare(`
        SELECT credential_id FROM account_passkeys
        WHERE credential_id = ? AND user_id = ?
        LIMIT 1
      `)
      .bind(id, session.userId)
      .first<{ credential_id: string }>();
    throw new AccountAuthError(
      passkey ? "last_passkey_cannot_be_deleted" : "passkey_not_found",
      passkey ? 409 : 404,
      passkey
        ? "最後のパスキーは削除できません。先に予備のパスキーを追加してください。"
        : "指定したパスキーが見つかりませんでした。",
    );
  }

  // A session is not tied to one credential in the legacy schema. Keep the
  // freshly verified current session and revoke every other session so a
  // removed or lost authenticator cannot leave an old browser signed in.
  await database
    .prepare(`
      DELETE FROM account_sessions
      WHERE user_id = ? AND token_hash <> ?
    `)
    .bind(session.userId, session.tokenHash)
    .run();
  const remaining = await database
    .prepare(`
      SELECT COUNT(*) AS count FROM account_passkeys WHERE user_id = ?
    `)
    .bind(session.userId)
    .first<{ count: number }>();
  return { remaining: Math.max(0, remaining?.count ?? 0) };
}

export async function revokeAllAccountSessions(request: Request) {
  const session = await requireRecentAccountSession(request);
  await databaseOrThrow()
    .prepare("DELETE FROM account_sessions WHERE user_id = ?")
    .bind(session.userId)
    .run();
  return clearAccountSessionCookie(new URL(request.url).protocol === "https:");
}

/**
 * Records a support-assisted recovery request without granting authentication.
 * No recovery bearer secret is issued until an operator completes the manual
 * identity-verification runbook and an audited delivery channel exists.
 */
export async function createAccountRecoveryChallenge(
  request: Request,
  billingEmail: unknown,
) {
  const normalizedEmail = normalizeRecoveryEmail(billingEmail);
  const database = databaseOrThrow();
  const now = Math.floor(Date.now() / 1_000);
  const contactHash = await recoveryValueHash(
    `contact\n${normalizedEmail}`,
  );
  const networkHash = await authenticationNetworkHash(request);
  const reference = crypto.randomUUID();
  const matchingUser = await database
    .prepare(`
      SELECT id FROM users
      WHERE lower(billing_email) = ?
        OR (
          lower(email) = ?
          AND email NOT LIKE '%@anonymous.torudake.invalid'
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .bind(normalizedEmail, normalizedEmail)
    .first<{ id: string }>();

  await database
    .prepare(`
      UPDATE account_recovery_challenges
      SET status = 'expired'
      WHERE status IN ('requested', 'reviewing', 'approved')
        AND expires_at <= ?
    `)
    .bind(now)
    .run();
  await database
    .prepare(`
      INSERT INTO account_recovery_challenges (
        id, user_id, contact_hash, network_hash, challenge_hash, status,
        created_at, expires_at, reviewed_at, consumed_at
      )
      SELECT ?, ?, ?, ?, NULL, 'requested', ?, ?, NULL, NULL
      WHERE (
        SELECT COUNT(*) FROM account_recovery_challenges
        WHERE contact_hash = ? AND created_at >= ?
      ) < ?
        AND (
          SELECT COUNT(*) FROM account_recovery_challenges
          WHERE network_hash = ? AND created_at >= ?
        ) < ?
        AND (
          SELECT COUNT(*) FROM account_recovery_challenges
          WHERE created_at >= ?
        ) < ?
    `)
    .bind(
      reference,
      matchingUser?.id ?? null,
      contactHash,
      networkHash,
      now,
      now + RECOVERY_REQUEST_LIFETIME_SECONDS,
      contactHash,
      now - RECOVERY_RATE_WINDOW_SECONDS,
      RECOVERY_CONTACT_LIMIT,
      networkHash,
      now - RECOVERY_RATE_WINDOW_SECONDS,
      RECOVERY_NETWORK_LIMIT,
      now - RECOVERY_RATE_WINDOW_SECONDS,
      RECOVERY_GLOBAL_LIMIT,
    )
    .run();

  // The same generic response is returned for unknown emails and rate-limited
  // requests to avoid exposing whether a paid account exists.
  return { reference };
}

export async function isAccountDeletionScheduled(userId: string) {
  if (!userId || userId.length > 255) return false;
  const row = await databaseOrThrow()
    .prepare(`
      SELECT 1 AS scheduled
      FROM account_deletion_requests
      WHERE user_id = ? AND status = 'scheduled'
      LIMIT 1
    `)
    .bind(userId)
    .first<{ scheduled: number }>();
  return row?.scheduled === 1;
}

export async function revokeAccountSession(request: Request) {
  const token = getAccountSessionToken(request);
  if (token) {
    const database = databaseOrNull();
    if (database) {
      await database
        .prepare("DELETE FROM account_sessions WHERE token_hash = ?")
        .bind(await hashAccountToken(token))
        .run();
    }
  }
  return clearAccountSessionCookie(new URL(request.url).protocol === "https:");
}

async function requireAccountIdentity(request: Request) {
  const identity = await getAccountIdentity(request);
  if (!identity) {
    throw new AccountAuthError(
      "authentication_required",
      401,
      "続けるにはアカウントへのログインが必要です。",
    );
  }
  return identity;
}

export async function requireRecentAccountSession(request: Request) {
  const token = getAccountSessionToken(request);
  if (!token) {
    throw new AccountAuthError(
      "authentication_required",
      401,
      "続けるにはアカウントへのログインが必要です。",
    );
  }
  const now = Math.floor(Date.now() / 1_000);
  const tokenHash = await hashAccountToken(token);
  const session = await databaseOrThrow()
    .prepare(`
      SELECT user_id, created_at
      FROM account_sessions
      WHERE token_hash = ? AND expires_at > ?
      LIMIT 1
    `)
    .bind(tokenHash, now)
    .first<{ user_id: string; created_at: number }>();
  if (!session) {
    throw new AccountAuthError(
      "authentication_required",
      401,
      "続けるにはアカウントへのログインが必要です。",
    );
  }
  if (session.created_at < now - RECENT_AUTHENTICATION_SECONDS) {
    throw new AccountAuthError(
      "reauthentication_required",
      401,
      "安全のため、パスキーで本人確認をやり直してから操作してください。",
    );
  }
  return { userId: session.user_id, tokenHash };
}

async function saveChallenge(
  request: Request,
  database: D1Database,
  values: {
    challenge: string;
    ceremony: "registration" | "authentication";
    userId: string | null;
    context: { origin: string; rpId: string; secure: boolean };
    now: number;
  },
) {
  const token = randomAccountToken();
  const tokenHash = await hashAccountToken(token);
  const networkHash = await authenticationNetworkHash(request);
  await database
    .prepare("DELETE FROM account_auth_challenges WHERE created_at < ?")
    .bind(values.now - AUTH_RATE_WINDOW_SECONDS)
    .run();
  await database
    .prepare("DELETE FROM account_sessions WHERE expires_at < ?")
    .bind(values.now)
    .run();
  const inserted = await database
    .prepare(`
        INSERT INTO account_auth_challenges (
          token_hash, challenge, ceremony, user_id, expected_origin,
          rp_id, network_hash, created_at, expires_at, consumed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
        WHERE (
          SELECT COUNT(*) FROM account_auth_challenges
          WHERE network_hash = ? AND created_at >= ?
        ) < ?
          AND (
            SELECT COUNT(*) FROM account_auth_challenges
            WHERE created_at >= ?
          ) < ?
      `)
    .bind(
      tokenHash,
      values.challenge,
      values.ceremony,
      values.userId,
      values.context.origin,
      values.context.rpId,
      networkHash,
      values.now,
      values.now + CHALLENGE_LIFETIME_SECONDS,
      networkHash,
      values.now - AUTH_RATE_WINDOW_SECONDS,
      AUTH_NETWORK_LIMIT,
      values.now - AUTH_RATE_WINDOW_SECONDS,
      AUTH_GLOBAL_LIMIT,
    )
    .run();
  if (inserted.meta?.changes !== 1) {
    throw new AccountAuthError(
      "authentication_rate_limited",
      429,
      "認証の試行回数が多いため、少し待ってからお試しください。",
    );
  }
  return token;
}

async function consumeChallenge(
  request: Request,
  ceremony: "registration" | "authentication",
) {
  const token = getAccountChallengeToken(request);
  if (!token) {
    throw new AccountAuthError(
      "challenge_missing",
      400,
      "認証の有効時間が切れました。もう一度お試しください。",
    );
  }
  const now = Math.floor(Date.now() / 1_000);
  const challenge = await databaseOrThrow()
    .prepare(`
      UPDATE account_auth_challenges
      SET consumed_at = ?
      WHERE token_hash = ?
        AND ceremony = ?
        AND consumed_at IS NULL
        AND expires_at >= ?
      RETURNING challenge, ceremony, user_id, expected_origin, rp_id
    `)
    .bind(now, await hashAccountToken(token), ceremony, now)
    .first<AuthChallenge>();
  if (!challenge) {
    throw new AccountAuthError(
      "challenge_expired",
      400,
      "認証の有効時間が切れました。もう一度お試しください。",
    );
  }
  return challenge;
}

function sessionInsertStatement(
  database: D1Database,
  tokenHash: string,
  userId: string,
  now: number,
) {
  return database
    .prepare(`
      INSERT INTO account_sessions (
        token_hash, user_id, created_at, last_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .bind(tokenHash, userId, now, now, now + SESSION_LIFETIME_SECONDS);
}

function authenticationResult(request: Request, sessionToken: string) {
  const secure = new URL(request.url).protocol === "https:";
  return {
    sessionCookie: accountSessionCookie(sessionToken, secure),
    challengeCookie: clearAccountChallengeCookie(secure),
  };
}

function relyingPartyContext(request: Request) {
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    throw new AccountAuthError(
      "secure_context_required",
      400,
      "安全な接続（HTTPS）で開き直してください。",
    );
  }
  return {
    origin: url.origin,
    rpId: url.hostname,
    secure: url.protocol === "https:",
  };
}

function databaseOrNull() {
  const database = env.DB as unknown as D1Database | undefined;
  return database?.prepare ? database : null;
}

function databaseOrThrow() {
  const database = databaseOrNull();
  if (!database) {
    throw new AccountAuthError(
      "authentication_not_configured",
      503,
      "アカウント認証を現在利用できません。少し待ってからお試しください。",
    );
  }
  return database;
}

async function authenticationNetworkHash(request: Request) {
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!local && !/^[0-9a-f:.]{3,64}$/i.test(connectingIp)) {
    throw new AccountAuthError(
      "authentication_context_unavailable",
      503,
      "接続情報を確認できませんでした。通常のブラウザで開き直してください。",
    );
  }
  const secret =
    typeof env.TRIAL_ISSUANCE_SECRET === "string"
      ? env.TRIAL_ISSUANCE_SECRET.trim()
      : "";
  if (!local && secret.length < 32) {
    throw new AccountAuthError(
      "authentication_not_configured",
      503,
      "アカウント認証を現在利用できません。少し待ってからお試しください。",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret || "torudake-local-account-auth"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`torudake-auth-v1\n${connectingIp || "local"}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function normalizePasskeyDisplayName(
  value: unknown,
  allowDefault = true,
) {
  if (value === undefined && allowDefault) return "登録済みの端末";
  if (typeof value !== "string") {
    throw new AccountAuthError(
      "invalid_passkey_name",
      400,
      "端末名を入力してください。",
    );
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    !normalized ||
    Array.from(normalized).length > PASSKEY_DISPLAY_NAME_MAX_LENGTH
  ) {
    throw new AccountAuthError(
      "invalid_passkey_name",
      400,
      `端末名は${PASSKEY_DISPLAY_NAME_MAX_LENGTH}文字以内で入力してください。`,
    );
  }
  return normalized;
}

function validateCredentialId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{16,1024}$/.test(value)
  ) {
    throw new AccountAuthError(
      "invalid_passkey_id",
      400,
      "指定したパスキーを確認できませんでした。",
    );
  }
  return value;
}

function normalizeRecoveryEmail(value: unknown) {
  if (typeof value !== "string") {
    throw new AccountAuthError(
      "invalid_recovery_contact",
      400,
      "決済時に使用したメールアドレスを入力してください。",
    );
  }
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]{1,64}@[^\s@]{1,189}$/.test(email)
  ) {
    throw new AccountAuthError(
      "invalid_recovery_contact",
      400,
      "決済時に使用したメールアドレスを入力してください。",
    );
  }
  return email;
}

async function recoveryValueHash(value: string) {
  const secret =
    typeof env.TRIAL_ISSUANCE_SECRET === "string"
      ? env.TRIAL_ISSUANCE_SECRET.trim()
      : "";
  if (secret.length < 32) {
    throw new AccountAuthError(
      "authentication_not_configured",
      503,
      "アカウント復旧の受付を現在利用できません。",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`torudake-recovery-v1\n${value}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function sanitizeTransports(value: unknown) {
  const allowed = new Set<AuthenticatorTransportFuture>([
    "ble",
    "cable",
    "hybrid",
    "internal",
    "nfc",
    "smart-card",
    "usb",
  ]);
  return Array.isArray(value)
    ? value.filter(
        (item): item is AuthenticatorTransportFuture =>
          typeof item === "string" &&
          allowed.has(item as AuthenticatorTransportFuture),
      )
    : [];
}

function parseTransports(value: string | null) {
  try {
    return sanitizeTransports(value ? JSON.parse(value) : []);
  } catch {
    return [];
  }
}
