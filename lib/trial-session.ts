export const TRIAL_SESSION_COOKIE = "torudake_trial_id";

const TRIAL_SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getTrialSessionId(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const encodedValue = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${TRIAL_SESSION_COOKIE}=`))
    ?.slice(TRIAL_SESSION_COOKIE.length + 1);
  if (!encodedValue) return null;

  try {
    const value = decodeURIComponent(encodedValue);
    return TRIAL_SESSION_PATTERN.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function trialSessionCookie(
  sessionId: string,
  secure: boolean,
) {
  const attributes = [
    `${TRIAL_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
