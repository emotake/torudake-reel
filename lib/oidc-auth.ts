import { env } from "cloudflare:workers";
import {
  AccountAuthError,
  createAccountSession,
  getAccountIdentity,
  requireRecentAccountSession,
} from "./account-auth";
import {
  bytesToBase64Url,
  getAccountSessionToken,
  hashAccountToken,
} from "./account-session";
import {
  authenticateVerifiedExternalIdentity,
  ExternalAccountAuthError,
  linkVerifiedExternalIdentity,
  prepareExternalAuthTrialContext,
  reauthenticateVerifiedExternalIdentity,
  verifyExternalAuthTrialContext,
  type ExternalAccountDatabase,
  type ExternalAuthTrialContext,
} from "./external-account-auth";
import {
  buildOidcAuthorizationUrl,
  constantTimeStringEqual,
  createOidcTransactionSecrets,
  exchangeOidcAuthorizationCode,
  normalizeOidcReturnTo,
  OIDC_ENDPOINTS,
  OidcProtocolError,
  oidcCallbackPath,
  type OidcProvider,
  type OidcProviderConfig,
  verifyGoogleIdToken,
  verifyLineIdToken,
} from "./oidc-core";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "./request-safety";
import { deauthorizeLineAuthorization } from "./line-deauthorization";

const OIDC_TRANSACTION_LIFETIME_SECONDS = 10 * 60;
const OIDC_RATE_WINDOW_SECONDS = 10 * 60;
const OIDC_NETWORK_START_LIMIT = 30;
const OIDC_GLOBAL_START_LIMIT = 3_000;
const OIDC_POPUP_CHANNEL = "torudake-oidc-results";
const OIDC_LEGACY_POPUP_RETURN_TO = "/account?auth_popup=pending";
const OIDC_POPUP_RETURN_TO_PREFIX = "oidc-popup:";
const OIDC_POPUP_FLOW_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type D1Database = ExternalAccountDatabase;

type OidcBindings = Record<string, unknown> & { DB?: unknown };

type RuntimeConfig = OidcProviderConfig & {
  authSecret: string;
  database: D1Database;
};

type OidcTransaction = {
  intent: "login" | "link" | "reauthenticate";
  nonce: string;
  pkce_verifier: string | null;
  initiating_user_id: string | null;
  expected_origin: string;
  return_to: string;
};

export class OidcAuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly publicMessage: string;
  readonly callbackCode: string;

  constructor(
    code: string,
    status: number,
    publicMessage: string,
    callbackCode = "failed",
  ) {
    super(publicMessage);
    this.name = "OidcAuthError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    this.callbackCode = callbackCode;
  }
}

export function isOidcProviderConfigured(
  provider: OidcProvider,
  bindings: OidcBindings = env as unknown as OidcBindings,
) {
  return resolveRuntimeConfig(provider, bindings) !== null;
}

export async function beginOidcAuthorization(
  request: Request,
  provider: OidcProvider,
) {
  const config = runtimeConfigOrThrow(provider);
  assertCanonicalRequestOrigin(request, config);
  const requestUrl = new URL(request.url);
  const reauthenticate = strictStartFlag(
    requestUrl,
    "reauthenticate",
    "invalid_reauthentication_request",
  );
  const link = strictStartFlag(requestUrl, "link", "invalid_link_request");
  if (reauthenticate && link) {
    throw new OidcAuthError(
      "ambiguous_authentication_intent",
      400,
      "ログイン方法の追加と本人確認を同時に開始することはできません。",
    );
  }
  if (provider === "line" && link) {
    throw lineLinkUnavailableError();
  }
  const authenticatedAccount = await getAccountIdentity(request);
  if (authenticatedAccount && !reauthenticate && !link) {
    throw new OidcAuthError(
      "already_authenticated",
      409,
      "すでにログインしています。別のアカウントを使う場合は、先にログアウトしてください。",
      "already_authenticated",
    );
  }
  if (!authenticatedAccount && (reauthenticate || link)) {
    throw new OidcAuthError(
      "authentication_required",
      401,
      "本人確認をやり直すには、先にアカウントへログインしてください。",
    );
  }
  if (authenticatedAccount && reauthenticate) {
    await assertReauthenticationProviderLinked(
      config.database,
      authenticatedAccount.id,
      provider,
    );
  }
  if (authenticatedAccount && link) {
    const recentSession = await requireRecentAccountSession(request).catch(
      (error: unknown) => {
        const status = error && typeof error === "object" &&
            "status" in error && typeof error.status === "number"
          ? error.status
          : 401;
        const code = error && typeof error === "object" &&
            "code" in error && typeof error.code === "string"
          ? error.code
          : "reauthentication_required";
        const message = error instanceof Error
          ? error.message
          : "ログイン方法を追加する前に、本人確認をやり直してください。";
        throw new OidcAuthError(code, status, message);
      },
    );
    if (recentSession.userId !== authenticatedAccount.id) {
      throw new OidcAuthError(
        "link_session_changed",
        401,
        "ログイン方法を追加するアカウントを確認できませんでした。もう一度お試しください。",
      );
    }
  }

  const returnToValues = requestUrl.searchParams.getAll("returnTo");
  const popup = strictStartFlag(
    requestUrl,
    "popup",
    "invalid_popup_authentication_request",
  );
  const popupFlowValues = requestUrl.searchParams.getAll("popupFlow");
  if (
    popupFlowValues.length > 1 ||
    (popupFlowValues.length === 1 &&
      !OIDC_POPUP_FLOW_PATTERN.test(popupFlowValues[0])) ||
    (!popup && popupFlowValues.length > 0)
  ) {
    throw new OidcAuthError(
      "invalid_popup_authentication_request",
      400,
      "ログインを開始できませんでした。ページを再読み込みしてお試しください。",
    );
  }
  const popupFlow = popupFlowValues[0] ?? null;
  const returnTo = popup
    ? popupFlow
      ? `${OIDC_POPUP_RETURN_TO_PREFIX}${popupFlow}`
      : OIDC_LEGACY_POPUP_RETURN_TO
    : normalizeOidcReturnTo(
        returnToValues.length === 1 ? returnToValues[0] : null,
      );
  let trial: ExternalAuthTrialContext | null = null;
  if (!reauthenticate && !link) {
    try {
      trial = await prepareExternalAuthTrialContext(
        request,
        config.database,
      );
    } catch (error) {
      if (
        !(error instanceof ExternalAccountAuthError) ||
        error.code !== "trial_session_required"
      ) {
        throw externalErrorAsOidc(error);
      }
    }
  }
  const intent: OidcTransaction["intent"] = reauthenticate
    ? "reauthenticate"
    : link
      ? "link"
      : "login";
  const transaction = await createOidcTransactionSecrets();
  const now = Math.floor(Date.now() / 1_000);
  const stateHash = await hashAccountToken(transaction.state);
  const networkHash = await oidcNetworkHash(request, config.authSecret);

  await config.database
    .prepare("DELETE FROM account_oauth_challenges WHERE expires_at < ?")
    .bind(now)
    .run();
  const inserted = await config.database
    .prepare(`
      INSERT INTO account_oauth_challenges (
        state_hash, provider, nonce, pkce_verifier, intent,
        initiating_user_id, expected_origin, return_to, network_hash,
        created_at, expires_at, consumed_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
      WHERE (
        SELECT COUNT(*) FROM account_oauth_challenges
        WHERE network_hash = ? AND created_at >= ?
      ) < ?
        AND (
          SELECT COUNT(*) FROM account_oauth_challenges
          WHERE created_at >= ?
        ) < ?
    `)
    .bind(
      stateHash,
      provider,
      transaction.nonce,
      transaction.pkceVerifier,
      intent,
      authenticatedAccount?.id ?? trial?.userId ?? null,
      config.canonicalOrigin,
      returnTo,
      networkHash,
      now,
      now + OIDC_TRANSACTION_LIFETIME_SECONDS,
      networkHash,
      now - OIDC_RATE_WINDOW_SECONDS,
      OIDC_NETWORK_START_LIMIT,
      now - OIDC_RATE_WINDOW_SECONDS,
      OIDC_GLOBAL_START_LIMIT,
    )
    .run();
  if (inserted.meta?.changes !== 1) {
    throw new OidcAuthError(
      "oidc_rate_limited",
      429,
      "ログインの試行回数が多いため、少し待ってからもう一度お試しください。",
      "rate_limited",
    );
  }

  const authorizationUrl = buildOidcAuthorizationUrl(config, {
    state: transaction.state,
    nonce: transaction.nonce,
    pkceChallenge: transaction.pkceChallenge,
    forceLogin: reauthenticate,
  });
  const secure = config.canonicalOrigin.startsWith("https://");
  const response = redirectResponse(authorizationUrl.toString(), 302);
  response.headers.append(
    "Set-Cookie",
    oidcStateCookie(
      provider,
      transaction.state,
      secure,
      OIDC_TRANSACTION_LIFETIME_SECONDS,
    ),
  );
  if (intent !== "login") {
    const sessionToken = getAccountSessionToken(request);
    if (!sessionToken || !authenticatedAccount) {
      throw new OidcAuthError(
        "authentication_required",
        401,
        "ログイン方法を追加するには、もう一度ログインしてください。",
      );
    }
    response.headers.append(
      "Set-Cookie",
      oidcSessionProofCookie(
        provider,
        await oidcSessionProof(
          config.authSecret,
          provider,
          intent,
          transaction.state,
          sessionToken,
        ),
        secure,
        OIDC_TRANSACTION_LIFETIME_SECONDS,
      ),
    );
  }
  return response;
}

/**
 * Provider redirects land on a cross-site GET, where the Strict account
 * session cookie is intentionally absent. This page performs no token
 * exchange or account mutation; it posts the response from our now same-site
 * document to the finalize route so the exact current session can be checked.
 */
export function oidcCallbackFinalizationPage(
  request: Request,
  provider: OidcProvider,
) {
  const config = runtimeConfigOrThrow(provider);
  assertCanonicalRequestOrigin(request, config);
  if (request.method !== "GET") {
    throw new OidcAuthError(
      "invalid_oidc_callback_method",
      405,
      "ログインを確認できませんでした。もう一度お試しください。",
    );
  }
  const callbackUrl = new URL(request.url);
  const fields = ["state", "code", "error", "iss"] as const;
  const values = fields.map((name) => {
    const matches = callbackUrl.searchParams.getAll(name);
    if (matches.length > 1) {
      throw new OidcAuthError(
        "ambiguous_authorization_response",
        400,
        "ログインを確認できませんでした。もう一度お試しください。",
      );
    }
    const value = matches[0] ?? "";
    if (value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new OidcAuthError(
        "invalid_authorization_response",
        400,
        "ログインを確認できませんでした。もう一度お試しください。",
      );
    }
    return [name, value] as const;
  });
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = bytesToBase64Url(nonceBytes);
  const inputs = values
    .map(([name, value]) =>
      `<input type="hidden" name="${name}" value="${escapeHtmlAttribute(value)}">`
    )
    .join("");
  const action = `${oidcCallbackPath(provider)}/finalize`;
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログインを確認しています</title><style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#faf8f3;color:#17231c}.panel{max-width:28rem;padding:2rem;text-align:center}button{border:0;border-radius:999px;padding:.8rem 1.5rem;background:#173f2b;color:#fff;font:inherit;cursor:pointer}</style></head>
<body><main class="panel"><h1>ログインを確認しています</h1><p>この画面を閉じずに、そのままお待ちください。</p><form id="finalize" method="post" action="${action}">${inputs}<noscript><button type="submit">確認を続ける</button></noscript></form></main>
<script nonce="${nonce}">document.getElementById("finalize").submit();</script></body></html>`;
  const response = new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  applyPrivateResponseHeaders(response.headers);
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export async function completeOidcAuthorization(
  request: Request,
  provider: OidcProvider,
) {
  const config = runtimeConfigOrThrow(provider);
  assertCanonicalRequestOrigin(request, config);
  if (request.method !== "POST") {
    throw new OidcAuthError(
      "oidc_finalize_method_required",
      405,
      "ログインを完了できませんでした。もう一度お試しください。",
    );
  }
  const secure = config.canonicalOrigin.startsWith("https://");
  const clearStateCookie = oidcStateCookie(provider, "", secure, 0);
  const clearSessionProofCookie = oidcSessionProofCookie(
    provider,
    "",
    secure,
    0,
  );
  let transaction: OidcTransaction | null = null;

  try {
    const callbackUrl = await oidcCallbackUrlFromForm(request);
    const returnedState = singleQueryParameter(callbackUrl, "state");
    const cookieState = getOidcStateCookie(request, provider, secure);
    if (
      !returnedState ||
      !cookieState ||
      !isStateToken(returnedState) ||
      !(await constantTimeStringEqual(returnedState, cookieState))
    ) {
      throw callbackError(
        "oidc_state_mismatch",
        "ログインの有効時間が切れました。もう一度お試しください。",
        "expired",
      );
    }

    const now = Math.floor(Date.now() / 1_000);
    transaction = await config.database
      .prepare(`
        UPDATE account_oauth_challenges
        SET consumed_at = ?
        WHERE state_hash = ?
          AND provider = ?
        AND intent IN ('login', 'link', 'reauthenticate')
          AND consumed_at IS NULL
          AND expires_at >= ?
        RETURNING intent, nonce, pkce_verifier, initiating_user_id,
          expected_origin, return_to
      `)
      .bind(now, await hashAccountToken(returnedState), provider, now)
      .first<OidcTransaction>();
    if (!transaction) {
      throw callbackError(
        "oidc_transaction_expired",
        "ログインの有効時間が切れました。もう一度お試しください。",
        "expired",
      );
    }
    validateStoredTransaction(transaction, config);
    if (provider === "line" && transaction.intent === "link") {
      throw lineLinkUnavailableError();
    }

    const providerError = optionalSingleQueryParameter(callbackUrl, "error");
    if (providerError) {
      const cancelled = providerError.toLowerCase() === "access_denied";
      throw callbackError(
        cancelled ? "oidc_authorization_cancelled" : "oidc_provider_error",
        cancelled
          ? "ログインをキャンセルしました。"
          : "ログインを完了できませんでした。もう一度お試しください。",
        cancelled ? "cancelled" : "failed",
      );
    }

    const currentAccount = await getAccountIdentity(request, {
      touchLastSeen: false,
    });
    let trial: ExternalAuthTrialContext | null = null;
    let initiatingSessionTokenHash: string | null = null;
    if (
      transaction.intent === "reauthenticate" ||
      transaction.intent === "link"
    ) {
      const verifiedSessionTokenHash =
        transaction.initiating_user_id
          ? await verifyOidcSessionProof(
              request,
              config.authSecret,
              provider,
              transaction.intent,
              returnedState,
              secure,
              config.database,
              transaction.initiating_user_id,
              now,
            )
          : null;
      if (
        !transaction.initiating_user_id ||
        (currentAccount &&
          currentAccount.id !== transaction.initiating_user_id) ||
        !verifiedSessionTokenHash
      ) {
        throw callbackError(
          "reauthentication_identity_changed",
          "本人確認を始めたアカウントと現在のアカウントが異なります。もう一度お試しください。",
          "account_changed",
          401,
        );
      }
      initiatingSessionTokenHash = verifiedSessionTokenHash;
    } else {
      if (currentAccount) {
        throw callbackError(
          "account_changed_during_login",
          "別の方法ですでにログインしています。別のアカウントを使う場合は、先にログアウトしてください。",
          "already_authenticated",
        );
      }
      trial = transaction.initiating_user_id
        ? await verifyExternalAuthTrialContext(
            request,
            config.database,
            transaction.initiating_user_id,
            now,
          )
        : null;
    }
    if (provider === "google") {
      const responseIssuer = singleQueryParameter(callbackUrl, "iss");
      if (responseIssuer !== "https://accounts.google.com") {
        throw callbackError(
          "invalid_authorization_response_issuer",
          "ログインを確認できませんでした。もう一度お試しください。",
          "failed",
        );
      }
    }
    const authorizationCode = singleQueryParameter(callbackUrl, "code");
    if (!authorizationCode) {
      throw callbackError(
        "authorization_code_missing",
        "ログインを確認できませんでした。もう一度お試しください。",
        "failed",
      );
    }

    const tokenSet = await exchangeOidcAuthorizationCode(config, {
      code: authorizationCode,
      pkceVerifier: transaction.pkce_verifier as string,
    });
    const completionNow = Math.floor(Date.now() / 1_000);
    const claims =
      provider === "line"
        ? await verifyLineIdToken({
            idToken: tokenSet.idToken,
            nonce: transaction.nonce,
            clientId: config.clientId,
            nowSeconds: completionNow,
          })
        : await verifyGoogleIdToken({
            idToken: tokenSet.idToken,
            accessToken: tokenSet.accessToken,
            authorizationCode,
            nonce: transaction.nonce,
            clientId: config.clientId,
            nowSeconds: completionNow,
          });

    if (provider === "line") {
      // LINE requires an app grant to be removed when its service account is
      // deleted, but its deauthorization endpoint needs the short-lived user
      // access token. Remove the grant before any local identity/session
      // mutation so we never persist tokens and a provider failure fails
      // closed. LINE documents that the stable provider user ID remains usable
      // after deauthorization; a later login simply asks for consent again.
      await deauthorizeLineAuthorization({
        channelId: config.clientId,
        channelSecret: config.clientSecret,
        userAccessToken: tokenSet.accessToken,
      });
    }

    const subjectHash = await oidcSubjectHash(
      config.authSecret,
      provider,
      config.clientId,
      claims.subject,
    );
    const identity = transaction.intent === "link"
      ? await linkVerifiedExternalIdentity({
          database: config.database,
          userId: transaction.initiating_user_id as string,
          provider,
          subjectHash,
          verifiedEmail: claims.verifiedEmail,
          initiatingSessionTokenHash: initiatingSessionTokenHash as string,
          now: completionNow,
        })
      : transaction.intent === "reauthenticate"
        ? await reauthenticateVerifiedExternalIdentity({
            database: config.database,
            userId: transaction.initiating_user_id as string,
            provider,
            subjectHash,
            verifiedEmail: claims.verifiedEmail,
            initiatingSessionTokenHash: initiatingSessionTokenHash as string,
            now: completionNow,
          })
      : await authenticateVerifiedExternalIdentity({
          database: config.database,
          trial,
          provider,
          subjectHash,
          verifiedEmail: claims.verifiedEmail,
          now: completionNow,
        });
    if (
      transaction.intent === "reauthenticate" &&
      identity.userId !== transaction.initiating_user_id
    ) {
      throw callbackError(
        "reauthentication_identity_changed",
        "現在のアカウントに登録されたログイン方法で本人確認してください。",
        "account_changed",
      );
    }
    const response = callbackResponse(
      config.canonicalOrigin,
      transaction.return_to,
      undefined,
      undefined,
      transaction.intent === "link",
    );
    if (transaction.intent !== "link") {
      const session = await createAccountSession(
        request,
        identity.userId,
        provider,
        identity.identityId,
        transaction.intent === "reauthenticate"
          ? {
              initiatingSessionTokenHash:
                initiatingSessionTokenHash as string,
              initiatingUserId: transaction.initiating_user_id as string,
            }
          : undefined,
        completionNow,
      );
      response.headers.append("Set-Cookie", session.sessionCookie);
      response.headers.append("Set-Cookie", session.challengeCookie);
    }
    response.headers.append("Set-Cookie", clearStateCookie);
    response.headers.append("Set-Cookie", clearSessionProofCookie);
    return response;
  } catch (error) {
    const normalizedError = normalizeCallbackError(error);
    if (normalizedError.callbackCode !== "cancelled") {
      console.error("OIDC callback failed", {
        provider,
        code: normalizedError.code,
      });
    }
    const response = callbackResponse(
      config.canonicalOrigin,
      transaction?.return_to ?? "/account",
      normalizedError.callbackCode,
      normalizedError.status,
      transaction?.intent === "link",
    );
    response.headers.append("Set-Cookie", clearStateCookie);
    response.headers.append("Set-Cookie", clearSessionProofCookie);
    return response;
  }
}

export function oidcAuthErrorResponse(error: unknown) {
  const normalized =
    error instanceof OidcAuthError
      ? error
      : new OidcAuthError(
          "oidc_authentication_failed",
          500,
          "ログインを開始できませんでした。時間をおいてもう一度お試しください。",
        );
  if (!(error instanceof OidcAuthError)) {
    console.error("OIDC authorization failed", { code: normalized.code });
  }
  const response = Response.json(
    { error: normalized.publicMessage, code: normalized.code },
    { status: normalized.status },
  );
  applyPrivateResponseHeaders(response.headers);
  return response;
}

export function oidcStateCookie(
  provider: OidcProvider,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
) {
  const name = oidcStateCookieName(provider, secure);
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    ...(maxAge === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function oidcSessionProofCookie(
  provider: OidcProvider,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
) {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return [
    `${oidcSessionProofCookieName(provider, secure)}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    ...(maxAge === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function runtimeConfigOrThrow(provider: OidcProvider) {
  const config = resolveRuntimeConfig(
    provider,
    env as unknown as OidcBindings,
  );
  if (!config) {
    throw new OidcAuthError(
      "oidc_not_available",
      404,
      "このログイン方法は現在利用できません。",
      "unavailable",
    );
  }
  return config;
}

async function assertReauthenticationProviderLinked(
  database: D1Database,
  userId: string,
  provider: OidcProvider,
) {
  const identity = await database
    .prepare(`
      SELECT id
      FROM account_external_identities
      WHERE user_id = ? AND provider = ? AND revoked_at IS NULL
      LIMIT 1
    `)
    .bind(userId, provider)
    .first<{ id: string }>();
  if (!identity) {
    throw new OidcAuthError(
      "reauthentication_method_not_linked",
      409,
      "このアカウントには選択したログイン方法が登録されていません。登録済みの方法を選んでください。",
    );
  }
}

function resolveRuntimeConfig(
  provider: OidcProvider,
  bindings: OidcBindings,
): RuntimeConfig | null {
  if (bindings.OIDC_AUTH_ENABLED !== "true") return null;
  const providerFlag =
    provider === "line" ? bindings.LINE_LOGIN_ENABLED : bindings.GOOGLE_OIDC_ENABLED;
  if (providerFlag !== "true") return null;

  const canonicalOrigin = parseCanonicalOrigin(bindings.OIDC_CANONICAL_ORIGIN);
  const authSecret = configurationString(bindings.OIDC_AUTH_SECRET, 32, 4_096);
  const clientId = configurationString(
    provider === "line"
      ? bindings.LINE_LOGIN_CHANNEL_ID
      : bindings.GOOGLE_OIDC_CLIENT_ID,
    4,
    512,
  );
  const clientSecret = configurationString(
    provider === "line"
      ? bindings.LINE_LOGIN_CHANNEL_SECRET
      : bindings.GOOGLE_OIDC_CLIENT_SECRET,
    8,
    2_048,
  );
  const database = bindings.DB as D1Database | undefined;
  if (
    !canonicalOrigin ||
    !authSecret ||
    !clientId ||
    !clientSecret ||
    !database?.prepare ||
    !database.batch
  ) {
    return null;
  }
  return {
    provider,
    canonicalOrigin,
    authSecret,
    clientId,
    clientSecret,
    database,
  };
}

function parseCanonicalOrigin(value: unknown) {
  const raw = configurationString(value, 1, 1_024);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (
      (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function configurationString(
  value: unknown,
  minLength: number,
  maxLength: number,
) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length < minLength ||
    trimmed.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function assertCanonicalRequestOrigin(
  request: Request,
  config: RuntimeConfig,
) {
  if (new URL(request.url).origin !== config.canonicalOrigin) {
    throw new OidcAuthError(
      "oidc_origin_mismatch",
      400,
      "正しいサイトURLからログインをやり直してください。",
      "failed",
    );
  }
}

function validateStoredTransaction(
  transaction: OidcTransaction,
  config: RuntimeConfig,
) {
  if (
    (transaction.intent !== "login" &&
      transaction.intent !== "link" &&
      transaction.intent !== "reauthenticate") ||
    ((transaction.intent === "reauthenticate" ||
      transaction.intent === "link") &&
      transaction.initiating_user_id === null) ||
    transaction.expected_origin !== config.canonicalOrigin ||
    (transaction.initiating_user_id !== null &&
      (typeof transaction.initiating_user_id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(transaction.initiating_user_id))) ||
    !isStateToken(transaction.nonce) ||
    typeof transaction.pkce_verifier !== "string" ||
    transaction.pkce_verifier.length < 43 ||
    transaction.pkce_verifier.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(transaction.pkce_verifier)
  ) {
    throw callbackError(
      "invalid_oidc_transaction",
      "ログインを確認できませんでした。もう一度お試しください。",
      "failed",
    );
  }
}

function getOidcStateCookie(
  request: Request,
  provider: OidcProvider,
  secure: boolean,
) {
  const name = oidcStateCookieName(provider, secure);
  const matches: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0 || trimmed.slice(0, separator) !== name) continue;
    try {
      matches.push(decodeURIComponent(trimmed.slice(separator + 1)));
    } catch {
      return null;
    }
  }
  return matches.length === 1 && isStateToken(matches[0]) ? matches[0] : null;
}

function getOidcSessionProofCookie(
  request: Request,
  provider: OidcProvider,
  secure: boolean,
) {
  const name = oidcSessionProofCookieName(provider, secure);
  const matches: string[] = [];
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0 || trimmed.slice(0, separator) !== name) continue;
    try {
      matches.push(decodeURIComponent(trimmed.slice(separator + 1)));
    } catch {
      return null;
    }
  }
  return matches.length === 1 && isLinkSessionProof(matches[0])
    ? matches[0]
    : null;
}

function oidcStateCookieName(provider: OidcProvider, secure: boolean) {
  return secure
    ? `__Host-torudake_oidc_${provider}`
    : `torudake_oidc_${provider}`;
}

function oidcSessionProofCookieName(
  provider: OidcProvider,
  secure: boolean,
) {
  return secure
    ? `__Host-torudake_oidc_${provider}_session_proof`
    : `torudake_oidc_${provider}_session_proof`;
}

function isStateToken(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isLinkSessionProof(value: string) {
  return /^[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/.test(value);
}

function singleQueryParameter(url: URL, name: string) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function optionalSingleQueryParameter(url: URL, name: string) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw callbackError(
      "ambiguous_authorization_response",
      "ログインを確認できませんでした。もう一度お試しください。",
      "failed",
    );
  }
  return values[0] || null;
}

async function oidcCallbackUrlFromForm(request: Request) {
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw callbackError(
      "invalid_oidc_finalize_payload",
      "ログインを確認できませんでした。もう一度お試しください。",
      "failed",
    );
  }
  let body: Uint8Array;
  try {
    body = await readRequestBodyWithLimit(request, 16 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw callbackError(
        "oidc_finalize_payload_too_large",
        "ログインを確認できませんでした。もう一度お試しください。",
        "failed",
        413,
      );
    }
    throw error;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw callbackError(
      "invalid_oidc_finalize_payload",
      "ログインを確認できませんでした。もう一度お試しください。",
      "failed",
    );
  }
  const parameters = new URLSearchParams(text);
  const callbackUrl = new URL(request.url);
  callbackUrl.search = "";
  for (const name of ["state", "code", "error", "iss"] as const) {
    const values = parameters.getAll(name);
    if (values.length !== 1 || values[0].length > 4_096) {
      throw callbackError(
        "invalid_oidc_finalize_payload",
        "ログインを確認できませんでした。もう一度お試しください。",
        "failed",
      );
    }
    if (values[0]) callbackUrl.searchParams.set(name, values[0]);
  }
  return callbackUrl;
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function strictStartFlag(url: URL, name: string, errorCode: string) {
  const values = url.searchParams.getAll(name);
  if (
    values.length > 1 ||
    (values.length === 1 && values[0] !== "1")
  ) {
    throw new OidcAuthError(
      errorCode,
      400,
      "認証を開始できませんでした。ページを再読み込みしてお試しください。",
    );
  }
  return values[0] === "1";
}

function lineLinkUnavailableError() {
  return new OidcAuthError(
    "authentication_method_unavailable",
    409,
    "このログイン操作は現在利用できません。",
    "failed",
  );
}

function callbackError(
  code: string,
  publicMessage: string,
  callbackCode: string,
  status = 400,
) {
  return new OidcAuthError(code, status, publicMessage, callbackCode);
}

function normalizeCallbackError(error: unknown) {
  if (error instanceof OidcAuthError) return error;
  if (error instanceof AccountAuthError) {
    return callbackError(
      error.code,
      error.publicMessage,
      "account_changed",
      error.status,
    );
  }
  if (error instanceof ExternalAccountAuthError) {
    let callbackCode = "failed";
    if (error.code === "external_identity_already_linked") {
      callbackCode = "identity_already_linked";
    } else if (error.code === "external_identity_unavailable") {
      callbackCode = "account_unavailable";
    } else if (error.code === "reauthentication_identity_changed") {
      callbackCode = "account_changed";
    } else if (
      error.code === "trial_session_required" ||
      error.code === "trial_identity_changed"
    ) {
      callbackCode = "expired";
    }
    return callbackError(
      error.code,
      error.message,
      callbackCode,
      error.status,
    );
  }
  if (error instanceof OidcProtocolError) {
    return callbackError(
      error.code,
      "ログインを確認できませんでした。もう一度お試しください。",
      "failed",
    );
  }
  return callbackError(
    "oidc_callback_failed",
    "ログインを完了できませんでした。時間をおいてもう一度お試しください。",
    "failed",
  );
}

function externalErrorAsOidc(error: unknown) {
  if (error instanceof ExternalAccountAuthError) {
    return new OidcAuthError(error.code, error.status, error.message, "failed");
  }
  return new OidcAuthError(
    "trial_context_unavailable",
    500,
    "無料体験の確認を準備できませんでした。時間をおいてもう一度お試しください。",
  );
}

function callbackResponse(
  canonicalOrigin: string,
  returnTo: string,
  errorCode?: string,
  errorStatus?: number,
  linked = false,
) {
  const popupFlow = popupFlowFromReturnTo(returnTo);
  if (popupFlow !== undefined) {
    return popupCallbackResponse(errorCode, errorStatus, linked, popupFlow);
  }
  const location = new URL(normalizeOidcReturnTo(returnTo), canonicalOrigin);
  if (errorCode) location.searchParams.set("auth_error", errorCode);
  return redirectResponse(location.toString(), 303);
}

function popupCallbackResponse(
  errorCode?: string,
  errorStatus?: number,
  linked = false,
  flowId: string | null = null,
) {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = bytesToBase64Url(nonceBytes);
  const succeeded = !errorCode;
  const title = succeeded
    ? linked
      ? "ログイン方法を追加しました"
      : "ログインしました"
    : linked
      ? "ログイン方法を追加できませんでした"
      : "ログインできませんでした";
  const message = succeeded
    ? linked
      ? "ログイン方法の追加が完了しました。この画面は閉じてかまいません。"
      : "ログインが完了しました。この画面は閉じてかまいません。"
    : errorCode === "cancelled"
      ? "ログインをキャンセルしました。この画面を閉じて、もう一度お試しください。"
      : "ログインを完了できませんでした。この画面を閉じて、もう一度お試しください。";
  const outcome = succeeded
    ? "succeeded"
    : errorCode === "cancelled"
      ? "cancelled"
      : "failed";
  const popupResult = JSON.stringify({
    type: "torudake:oidc-result",
    flowId: flowId ?? "",
    outcome,
  }).replaceAll("<", "\\u003c");
  const autoClose = succeeded ? "window.close();" : "";
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#faf8f3;color:#17231c}.panel{max-width:28rem;padding:2rem;text-align:center}button{border:0;border-radius:999px;padding:.8rem 1.5rem;background:#173f2b;color:#fff;font:inherit;cursor:pointer}</style></head>
<body><main class="panel"><h1>${title}</h1><p>${message}</p><button id="close" type="button">この画面を閉じる</button></main>
<script nonce="${nonce}">const result=${popupResult};try{const channel=new BroadcastChannel("${OIDC_POPUP_CHANNEL}");channel.postMessage(result);channel.close()}catch{}if(window.opener){window.opener.postMessage(result,window.location.origin)}document.getElementById("close").addEventListener("click",()=>window.close());${autoClose}</script></body></html>`;
  const response = new Response(html, {
    status: succeeded ? 200 : (errorStatus ?? 400),
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  applyPrivateResponseHeaders(response.headers);
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Torudake-Auth-Outcome", outcome);
  return response;
}

function popupFlowFromReturnTo(returnTo: string) {
  if (returnTo === OIDC_LEGACY_POPUP_RETURN_TO) return null;
  if (!returnTo.startsWith(OIDC_POPUP_RETURN_TO_PREFIX)) return undefined;
  const flowId = returnTo.slice(OIDC_POPUP_RETURN_TO_PREFIX.length);
  return OIDC_POPUP_FLOW_PATTERN.test(flowId) ? flowId : undefined;
}

function redirectResponse(location: string, status: 302 | 303) {
  const response = new Response(null, {
    status,
    headers: { Location: location },
  });
  applyPrivateResponseHeaders(response.headers);
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function applyPrivateResponseHeaders(headers: Headers) {
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Cookie");
}

async function oidcNetworkHash(request: Request, secret: string) {
  const url = new URL(request.url);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const connectingIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!local && !/^[0-9a-f:.]{3,64}$/i.test(connectingIp)) {
    throw new OidcAuthError(
      "oidc_context_unavailable",
      503,
      "接続情報を確認できませんでした。通常のブラウザで開き直してください。",
    );
  }
  return await hmacBase64Url(
    secret,
    `torudake-oidc-network-v1\n${connectingIp || "local"}`,
  );
}

async function oidcSubjectHash(
  secret: string,
  provider: OidcProvider,
  clientId: string,
  subject: string,
) {
  return await hmacBase64Url(
    secret,
    `torudake-oidc-subject-v1\n${provider}\n${clientId}\n${subject}`,
  );
}

async function oidcSessionProof(
  secret: string,
  provider: OidcProvider,
  intent: "link" | "reauthenticate",
  state: string,
  sessionToken: string,
) {
  const sessionHash = await hashAccountToken(sessionToken);
  const signature = await hmacBase64Url(
    secret,
    `torudake-oidc-session-proof-v1\n${provider}\n${intent}\n${state}\n${sessionHash}`,
  );
  return `${sessionHash}.${signature}`;
}

async function verifyOidcSessionProof(
  request: Request,
  secret: string,
  provider: OidcProvider,
  intent: "link" | "reauthenticate",
  state: string,
  secure: boolean,
  database: D1Database,
  expectedUserId: string,
  now: number,
) {
  const proof = getOidcSessionProofCookie(request, provider, secure);
  const currentSessionToken = getAccountSessionToken(request);
  if (!proof || !currentSessionToken) return null;
  const [sessionHash, signature] = proof.split(".");
  if (
    !(await constantTimeStringEqual(
      sessionHash,
      await hashAccountToken(currentSessionToken),
    ))
  ) {
    return null;
  }
  const expectedSignature = await hmacBase64Url(
    secret,
    `torudake-oidc-session-proof-v1\n${provider}\n${intent}\n${state}\n${sessionHash}`,
  );
  if (!(await constantTimeStringEqual(signature, expectedSignature))) {
    return null;
  }
  const session = await database
    .prepare(`
      SELECT account_sessions.user_id, account_sessions.created_at
      FROM account_sessions
      INNER JOIN users ON users.id = account_sessions.user_id
      WHERE account_sessions.token_hash = ?
        AND account_sessions.user_id = ?
        AND account_sessions.expires_at > ?
        AND users.account_deleted_at IS NULL
      LIMIT 1
    `)
    .bind(sessionHash, expectedUserId, now)
    .first<{ user_id: string; created_at: number }>();
  return session?.user_id === expectedUserId &&
      (intent !== "link" || session.created_at >= now - 10 * 60)
    ? sessionHash
    : null;
}

async function hmacBase64Url(secret: string, value: string) {
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
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

// Keep callback path construction referenced here so configuration reviews can
// find the exact registered redirect URIs without following the core module.
export function oidcRedirectUri(provider: OidcProvider, canonicalOrigin: string) {
  return `${canonicalOrigin}${oidcCallbackPath(provider)}`;
}

export const OIDC_OFFICIAL_ENDPOINTS = OIDC_ENDPOINTS;
