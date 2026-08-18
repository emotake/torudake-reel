import { bytesToBase64Url, randomAccountToken } from "./account-session";

export type OidcProvider = "line" | "google";

export type OidcProviderConfig = {
  provider: OidcProvider;
  clientId: string;
  clientSecret: string;
  canonicalOrigin: string;
};

export type OidcIdentityClaims = {
  subject: string;
  verifiedEmail: string | null;
};

export type OidcTokenSet = {
  accessToken: string;
  idToken: string;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type JsonObject = Record<string, unknown>;
type GoogleJsonWebKey = JsonWebKey & { kid?: string };

const RETURN_TO_BASE = "https://return-to.invalid";
const DEFAULT_RETURN_TO = "/account";
const ALLOWED_RETURN_PATHS = new Set([
  "/",
  "/account",
  "/pricing",
  "/video-edit",
  "/video-mix",
  "/photo-reel",
]);
const TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024;
const JWKS_RESPONSE_LIMIT_BYTES = 128 * 1024;
const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;
const CLOCK_SKEW_SECONDS = 60;

export const OIDC_ENDPOINTS = {
  line: {
    authorization: "https://access.line.me/oauth2/v2.1/authorize",
    token: "https://api.line.me/oauth2/v2.1/token",
    verification: "https://api.line.me/oauth2/v2.1/verify",
    issuer: "https://access.line.me",
  },
  google: {
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    jwks: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
  },
} as const;

export class OidcProtocolError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OidcProtocolError";
    this.code = code;
  }
}

export function oidcCallbackPath(provider: OidcProvider) {
  return `/api/account/oauth/${provider}/callback`;
}

/**
 * Only application-owned pages can be restored after login. Absolute URLs,
 * protocol-relative URLs, backslashes, fragments and unknown paths are never
 * carried through the authorization server.
 */
export function normalizeOidcReturnTo(value: unknown) {
  if (typeof value !== "string") return DEFAULT_RETURN_TO;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > 1_024 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return DEFAULT_RETURN_TO;
  }
  try {
    const parsed = new URL(candidate, RETURN_TO_BASE);
    if (
      parsed.origin !== RETURN_TO_BASE ||
      parsed.username ||
      parsed.password ||
      !ALLOWED_RETURN_PATHS.has(parsed.pathname)
    ) {
      return DEFAULT_RETURN_TO;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

export async function createOidcTransactionSecrets() {
  const state = randomAccountToken();
  const nonce = randomAccountToken();
  // 64 random bytes encode to 86 RFC 7636 unreserved characters (43-128).
  const verifierBytes = new Uint8Array(64);
  crypto.getRandomValues(verifierBytes);
  const pkceVerifier = bytesToBase64Url(verifierBytes);
  const pkceChallenge = await sha256Base64Url(pkceVerifier);
  return { state, nonce, pkceVerifier, pkceChallenge };
}

export function buildOidcAuthorizationUrl(
  config: OidcProviderConfig,
  values: {
    state: string;
    nonce: string;
    pkceChallenge: string;
    forceLogin?: boolean;
  },
) {
  const endpoint =
    config.provider === "line"
      ? OIDC_ENDPOINTS.line.authorization
      : OIDC_ENDPOINTS.google.authorization;
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set(
    "redirect_uri",
    `${config.canonicalOrigin}${oidcCallbackPath(config.provider)}`,
  );
  url.searchParams.set(
    "scope",
    config.provider === "line" ? "openid" : "openid email",
  );
  url.searchParams.set("state", values.state);
  url.searchParams.set("nonce", values.nonce);
  url.searchParams.set("code_challenge", values.pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.provider === "line" && values.forceLogin === true) {
    url.searchParams.set("prompt", "login");
  } else if (config.provider === "google") {
    url.searchParams.set("prompt", "select_account");
  }
  return url;
}

export async function exchangeOidcAuthorizationCode(
  config: OidcProviderConfig,
  values: { code: string; pkceVerifier: string },
  fetcher: FetchLike = fetch,
): Promise<OidcTokenSet> {
  assertAuthorizationCode(values.code);
  assertPkceVerifier(values.pkceVerifier);
  const tokenEndpoint =
    config.provider === "line"
      ? OIDC_ENDPOINTS.line.token
      : OIDC_ENDPOINTS.google.token;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: values.code,
    redirect_uri: `${config.canonicalOrigin}${oidcCallbackPath(config.provider)}`,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: values.pkceVerifier,
  });

  let response: Response;
  try {
    response = await fetcher(tokenEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      // Cloudflare Workers does not implement Request.redirect="error".
      // "manual" preserves the same fail-closed contract because provider
      // redirects are returned to us and rejected by the status/body checks.
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OidcProtocolError("token_endpoint_unavailable");
  }
  const payload = await readBoundedJsonObject(
    response,
    TOKEN_RESPONSE_LIMIT_BYTES,
  );
  if (!response.ok) {
    throw new OidcProtocolError("authorization_code_rejected");
  }

  const accessToken = boundedString(payload.access_token, 8, 8_192);
  const idToken = boundedString(payload.id_token, 64, 32_768);
  const tokenType = boundedString(payload.token_type, 1, 32);
  if (
    !accessToken ||
    !idToken ||
    !tokenType ||
    tokenType.toLowerCase() !== "bearer" ||
    !isCompactJwt(idToken)
  ) {
    throw new OidcProtocolError("invalid_token_response");
  }
  return { accessToken, idToken };
}

/**
 * LINE's documented verification endpoint performs signature verification on
 * the server side. We still validate every security-relevant returned claim so
 * that a successful HTTP response alone is never treated as an identity.
 */
export async function verifyLineIdToken(
  values: {
    idToken: string;
    nonce: string;
    clientId: string;
    nowSeconds?: number;
  },
  fetcher: FetchLike = fetch,
): Promise<OidcIdentityClaims> {
  if (!isCompactJwt(values.idToken) || !isOpaqueToken(values.nonce, 43, 43)) {
    throw new OidcProtocolError("invalid_line_id_token");
  }
  const body = new URLSearchParams({
    id_token: values.idToken,
    client_id: values.clientId,
    nonce: values.nonce,
  });
  let response: Response;
  try {
    response = await fetcher(OIDC_ENDPOINTS.line.verification, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OidcProtocolError("line_verification_unavailable");
  }
  const claims = await readBoundedJsonObject(
    response,
    TOKEN_RESPONSE_LIMIT_BYTES,
  );
  if (!response.ok) {
    throw new OidcProtocolError("line_id_token_rejected");
  }
  return await validateIdentityClaims(claims, {
    issuers: [OIDC_ENDPOINTS.line.issuer],
    audience: values.clientId,
    nonce: values.nonce,
    nowSeconds: values.nowSeconds,
    allowVerifiedEmail: false,
  });
}

export async function verifyGoogleIdToken(
  values: {
    idToken: string;
    accessToken: string;
    authorizationCode: string;
    nonce: string;
    clientId: string;
    nowSeconds?: number;
    jwksUri?: string;
  },
  fetcher: FetchLike = fetch,
): Promise<OidcIdentityClaims> {
  const parsed = parseCompactJwt(values.idToken);
  if (
    parsed.header.alg !== "RS256" ||
    (parsed.header.typ !== undefined && parsed.header.typ !== "JWT") ||
    parsed.header.crit !== undefined
  ) {
    throw new OidcProtocolError("unsupported_google_id_token");
  }
  const kid = boundedString(parsed.header.kid, 1, 256);
  if (!kid || !/^[A-Za-z0-9._-]+$/.test(kid)) {
    throw new OidcProtocolError("invalid_google_key_id");
  }
  const jwksUri = values.jwksUri ?? OIDC_ENDPOINTS.google.jwks;
  const key = await findGoogleVerificationKey(jwksUri, kid, fetcher);
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new OidcProtocolError("invalid_google_verification_key");
  }
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      parsed.signature,
      new TextEncoder().encode(parsed.signingInput),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new OidcProtocolError("invalid_google_id_token_signature");
  }

  const identity = await validateIdentityClaims(parsed.payload, {
    issuers: [...OIDC_ENDPOINTS.google.issuers],
    audience: values.clientId,
    nonce: values.nonce,
    nowSeconds: values.nowSeconds,
    allowVerifiedEmail: true,
  });
  validateAuthorizedParty(parsed.payload, values.clientId);

  // Google documents at_hash as present when an access token is returned in
  // the server flow. Requiring and checking it binds the two token values.
  const atHash = boundedString(parsed.payload.at_hash, 1, 128);
  if (!atHash) throw new OidcProtocolError("missing_google_access_token_hash");
  await verifyOidcHalfHash(atHash, values.accessToken);

  const codeHash = parsed.payload.c_hash;
  if (codeHash !== undefined) {
    const cHash = boundedString(codeHash, 1, 128);
    if (!cHash) throw new OidcProtocolError("invalid_google_code_hash");
    await verifyOidcHalfHash(cHash, values.authorizationCode);
  }
  return identity;
}

export async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function constantTimeStringEqual(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return constantTimeBytesEqual(
    new Uint8Array(leftDigest),
    new Uint8Array(rightDigest),
  );
}

async function validateIdentityClaims(
  claims: JsonObject,
  expected: {
    issuers: string[];
    audience: string;
    nonce: string;
    nowSeconds?: number;
    allowVerifiedEmail: boolean;
  },
): Promise<OidcIdentityClaims> {
  const issuer = boundedString(claims.iss, 1, 512);
  if (!issuer || !expected.issuers.includes(issuer)) {
    throw new OidcProtocolError("invalid_id_token_issuer");
  }
  const audiences = normalizeAudience(claims.aud);
  if (!audiences.includes(expected.audience)) {
    throw new OidcProtocolError("invalid_id_token_audience");
  }
  const subject = boundedString(claims.sub, 1, 255);
  if (!subject || !/^[\x21-\x7e]{1,255}$/.test(subject)) {
    throw new OidcProtocolError("invalid_id_token_subject");
  }
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const expiresAt = integerClaim(claims.exp);
  const issuedAt = integerClaim(claims.iat);
  if (
    expiresAt === null ||
    issuedAt === null ||
    expiresAt <= now - CLOCK_SKEW_SECONDS ||
    issuedAt > now + CLOCK_SKEW_SECONDS ||
    expiresAt <= issuedAt
  ) {
    throw new OidcProtocolError("invalid_id_token_time");
  }
  const notBefore = claims.nbf === undefined ? null : integerClaim(claims.nbf);
  if (
    claims.nbf !== undefined &&
    (notBefore === null || notBefore > now + CLOCK_SKEW_SECONDS)
  ) {
    throw new OidcProtocolError("id_token_not_active");
  }
  const nonce = boundedString(claims.nonce, 1, 512);
  if (!nonce) throw new OidcProtocolError("missing_id_token_nonce");
  // The digest comparison keeps attacker-controlled mismatch timing uniform.
  if (!(await constantTimeStringEqual(nonce, expected.nonce))) {
    throw new OidcProtocolError("invalid_id_token_nonce");
  }

  const verifiedEmail = expected.allowVerifiedEmail
    ? verifiedEmailFromClaims(claims)
    : null;
  return { subject, verifiedEmail };
}

function validateAuthorizedParty(claims: JsonObject, clientId: string) {
  const audiences = normalizeAudience(claims.aud);
  const azp = claims.azp === undefined ? null : boundedString(claims.azp, 1, 512);
  if (audiences.length > 1 && azp !== clientId) {
    throw new OidcProtocolError("missing_google_authorized_party");
  }
  if (claims.azp !== undefined && azp !== clientId) {
    throw new OidcProtocolError("invalid_google_authorized_party");
  }
}

async function verifyOidcHalfHash(expected: string, value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const actual = bytesToBase64Url(digest.slice(0, digest.length / 2));
  if (!(await constantTimeStringEqual(actual, expected))) {
    throw new OidcProtocolError("id_token_hash_mismatch");
  }
}

type CachedJwks = { expiresAt: number; keys: GoogleJsonWebKey[] };
let googleJwksCache: CachedJwks | null = null;

async function findGoogleVerificationKey(
  jwksUri: string,
  kid: string,
  fetcher: FetchLike,
) {
  const canUseSharedCache =
    jwksUri === OIDC_ENDPOINTS.google.jwks && fetcher === fetch;
  const now = Date.now();
  let keys =
    canUseSharedCache && googleJwksCache && googleJwksCache.expiresAt > now
      ? googleJwksCache.keys
      : null;
  if (!keys || !findUsableRsaKey(keys, kid)) {
    let response: Response;
    try {
      response = await fetcher(jwksUri, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OidcProtocolError("google_jwks_unavailable");
    }
    const payload = await readBoundedJsonObject(
      response,
      JWKS_RESPONSE_LIMIT_BYTES,
    );
    if (!response.ok || !Array.isArray(payload.keys) || payload.keys.length > 20) {
      throw new OidcProtocolError("invalid_google_jwks");
    }
    keys = payload.keys.filter(isJsonWebKey);
    if (canUseSharedCache) {
      googleJwksCache = {
        keys,
        expiresAt: now + cacheLifetimeMilliseconds(response.headers),
      };
    }
  }
  const key = findUsableRsaKey(keys, kid);
  if (!key) throw new OidcProtocolError("google_signing_key_not_found");
  return key;
}

function findUsableRsaKey(keys: GoogleJsonWebKey[], kid: string) {
  return keys.find(
    (key) =>
      key.kty === "RSA" &&
      key.kid === kid &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256") &&
      (!Array.isArray(key.key_ops) || key.key_ops.includes("verify")) &&
      typeof key.n === "string" &&
      typeof key.e === "string",
  );
}

function isJsonWebKey(value: unknown): value is GoogleJsonWebKey {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseCompactJwt(value: string) {
  if (!isCompactJwt(value)) {
    throw new OidcProtocolError("invalid_compact_jwt");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = value.split(".");
  const header = decodeJwtJson(encodedHeader, 8_192);
  const payload = decodeJwtJson(encodedPayload, 24_576);
  const signature = decodeBase64Url(encodedSignature, 8_192);
  return {
    header,
    payload,
    signature,
    signingInput: `${encodedHeader}.${encodedPayload}`,
  };
}

function decodeJwtJson(value: string, maxBytes: number) {
  const bytes = decodeBase64Url(value, maxBytes);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw new OidcProtocolError("invalid_jwt_json");
  }
}

function decodeBase64Url(value: string, maxBytes: number) {
  if (
    !value ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new OidcProtocolError("invalid_base64url");
  }
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const decoded = atob(padded);
    if (decoded.length > maxBytes) throw new Error("too large");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new OidcProtocolError("invalid_base64url");
  }
}

async function readBoundedJsonObject(response: Response, limit: number) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const declaredLength = Number(rawLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > limit
    ) {
      await response.body?.cancel("provider_response_too_large").catch(
        () => undefined,
      );
      throw new OidcProtocolError("provider_response_too_large");
    }
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > limit) {
          await reader.cancel("provider_response_too_large").catch(
            () => undefined,
          );
          throw new OidcProtocolError("provider_response_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OidcProtocolError("invalid_provider_response");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as JsonObject;
  } catch {
    throw new OidcProtocolError("invalid_provider_response");
  }
}

function normalizeAudience(value: unknown) {
  const values = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > 10 ||
    !values.every(
      (item) => typeof item === "string" && item.length >= 1 && item.length <= 512,
    )
  ) {
    throw new OidcProtocolError("invalid_id_token_audience");
  }
  return values as string[];
}

function verifiedEmailFromClaims(claims: JsonObject) {
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    return null;
  }
  const email = boundedString(claims.email, 3, 254)?.trim() ?? "";
  if (!/^[^\s@]{1,64}@[^\s@]{1,189}$/.test(email)) return null;
  return email;
}

function integerClaim(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedString(value: unknown, min: number, max: number) {
  return typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function isCompactJwt(value: string) {
  return (
    value.length <= 32_768 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

function isOpaqueToken(value: string, min: number, max: number) {
  return (
    value.length >= min &&
    value.length <= max &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function assertAuthorizationCode(value: string) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 4_096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new OidcProtocolError("invalid_authorization_code");
  }
}

function assertPkceVerifier(value: string) {
  if (
    typeof value !== "string" ||
    value.length < 43 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new OidcProtocolError("invalid_pkce_verifier");
  }
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function cacheLifetimeMilliseconds(headers: Headers) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(
    headers.get("cache-control") ?? "",
  );
  const seconds = match ? Number(match[1]) : 300;
  return Math.min(3_600, Math.max(60, seconds || 300)) * 1_000;
}
