const INITIAL_NARRATION_TOKEN_VERSION = 1;
const INITIAL_NARRATION_TOKEN_TTL_SECONDS = 15 * 60;

export type InitialNarrationScriptAttempt = 1 | 3;

type InitialNarrationTokenClaims = {
  v: number;
  r: string;
  a: string;
  n: InitialNarrationScriptAttempt;
  h: string;
  s: string;
  d: number;
  e: number;
};

export type InitialNarrationTokenExpectation = {
  reservationId: string;
  actionId: string;
  script: string;
  style: string;
  targetDurationSeconds: number;
};

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value) || value.length > 4_096) return null;
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hashScript(script: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(script),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export function initialNarrationTargetDurationMilliseconds(
  targetDurationSeconds: number,
) {
  if (!Number.isFinite(targetDurationSeconds)) return 0;
  return Math.max(
    1_000,
    Math.min(90_000, Math.round(targetDurationSeconds * 1_000)),
  );
}

export async function createInitialNarrationToken(
  secret: string,
  expectation: InitialNarrationTokenExpectation,
  scriptAttempt: InitialNarrationScriptAttempt,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  if (!secret || !expectation.reservationId || !expectation.actionId) {
    throw new Error("initial narration token configuration is incomplete");
  }
  const claims: InitialNarrationTokenClaims = {
    v: INITIAL_NARRATION_TOKEN_VERSION,
    r: expectation.reservationId,
    a: expectation.actionId,
    n: scriptAttempt,
    h: await hashScript(expectation.script),
    s: expectation.style,
    d: initialNarrationTargetDurationMilliseconds(
      expectation.targetDurationSeconds,
    ),
    e: nowSeconds + INITIAL_NARRATION_TOKEN_TTL_SECONDS,
  };
  const encodedClaims = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedClaims),
  );
  return `${encodedClaims}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyInitialNarrationToken(
  secret: string,
  token: string,
  expectation: InitialNarrationTokenExpectation,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<InitialNarrationTokenClaims | null> {
  if (!secret || !token || token.length > 4_096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const encodedClaims = parts[0];
  const claimsBytes = decodeBase64Url(encodedClaims);
  const signature = decodeBase64Url(parts[1]);
  if (!claimsBytes || !signature) return null;

  const key = await importSigningKey(secret);
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(encodedClaims),
  );
  if (!validSignature) return null;

  let claims: InitialNarrationTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(claimsBytes)) as InitialNarrationTokenClaims;
  } catch {
    return null;
  }
  const expectedScriptHash = await hashScript(expectation.script);
  const expectedDuration = initialNarrationTargetDurationMilliseconds(
    expectation.targetDurationSeconds,
  );
  if (
    claims.v !== INITIAL_NARRATION_TOKEN_VERSION ||
    claims.r !== expectation.reservationId ||
    claims.a !== expectation.actionId ||
    (claims.n !== 1 && claims.n !== 3) ||
    claims.h !== expectedScriptHash ||
    claims.s !== expectation.style ||
    claims.d !== expectedDuration ||
    !Number.isInteger(claims.e) ||
    claims.e <= nowSeconds
  ) {
    return null;
  }
  return claims;
}
