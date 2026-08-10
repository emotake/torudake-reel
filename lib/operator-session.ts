export const OPERATOR_COOKIE_NAME = "torudake_operator_session";
export const OPERATOR_ACCESS_DAYS = 180;

const OPERATOR_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeOperatorLabel(value: unknown) {
  if (typeof value !== "string") return "運営端末";
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 40);
  return normalized || "運営端末";
}

export function operatorSessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = OPERATOR_ACCESS_DAYS * 24 * 60 * 60,
) {
  const attributes = [
    `${OPERATOR_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearOperatorSessionCookie(secure: boolean) {
  return [
    `${OPERATOR_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function getOperatorSessionToken(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const encodedValue = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OPERATOR_COOKIE_NAME}=`))
    ?.slice(OPERATOR_COOKIE_NAME.length + 1);
  if (!encodedValue) return null;

  try {
    const value = decodeURIComponent(encodedValue).toLowerCase();
    return OPERATOR_TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function isSameOriginMutation(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function randomOperatorToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
