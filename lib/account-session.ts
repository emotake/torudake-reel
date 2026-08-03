export const ACCOUNT_SESSION_COOKIE = "__Host-torudake_account";
export const ACCOUNT_CHALLENGE_COOKIE = "__Host-torudake_challenge";
const LOCAL_SESSION_COOKIE = "torudake_account";
const LOCAL_CHALLENGE_COOKIE = "torudake_challenge";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function randomAccountToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashAccountToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return bytesToHex(new Uint8Array(digest));
}

export function getAccountSessionToken(request: Request) {
  return getCookieToken(request, [ACCOUNT_SESSION_COOKIE, LOCAL_SESSION_COOKIE]);
}

export function getAccountChallengeToken(request: Request) {
  return getCookieToken(request, [
    ACCOUNT_CHALLENGE_COOKIE,
    LOCAL_CHALLENGE_COOKIE,
  ]);
}

export function accountSessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = 30 * 24 * 60 * 60,
) {
  return cookie(
    secure ? ACCOUNT_SESSION_COOKIE : LOCAL_SESSION_COOKIE,
    token,
    secure,
    maxAgeSeconds,
  );
}

export function accountChallengeCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = 5 * 60,
) {
  return cookie(
    secure ? ACCOUNT_CHALLENGE_COOKIE : LOCAL_CHALLENGE_COOKIE,
    token,
    secure,
    maxAgeSeconds,
  );
}

export function clearAccountSessionCookie(secure: boolean) {
  return accountSessionCookie("", secure, 0);
}

export function clearAccountChallengeCookie(secure: boolean) {
  return accountChallengeCookie("", secure, 0);
}

export function bytesToBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function getCookieToken(request: Request, names: string[]) {
  const cookies = new Map(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), part.slice(separator + 1)];
      }),
  );
  for (const name of names) {
    const encoded = cookies.get(name);
    if (!encoded) continue;
    try {
      const value = decodeURIComponent(encoded);
      if (TOKEN_PATTERN.test(value)) return value;
    } catch {
      // Ignore malformed cookies.
    }
  }
  return null;
}

function cookie(
  name: string,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function bytesToHex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
