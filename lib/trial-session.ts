export const TRIAL_SESSION_COOKIE = "torudake_trial_id";
export const TRIAL_DEVICE_COOKIE = "torudake_trial_device";

const TRIAL_SESSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIAL_DEVICE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

export function getOrCreateTrialDeviceId(request: Request) {
  const existing = getCookieValue(request, TRIAL_DEVICE_COOKIE);
  if (existing && TRIAL_DEVICE_PATTERN.test(existing)) {
    return { deviceId: existing, created: false } as const;
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    deviceId: btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, ""),
    created: true,
  } as const;
}

export function trialDeviceCookie(deviceId: string, secure: boolean) {
  const attributes = [
    `${TRIAL_DEVICE_COOKIE}=${encodeURIComponent(deviceId)}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearTrialSessionCookie(secure: boolean) {
  const attributes = [
    `${TRIAL_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function getCookieValue(request: Request, name: string) {
  const encodedValue = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encodedValue) return null;
  try {
    return decodeURIComponent(encodedValue);
  } catch {
    return null;
  }
}
