import { env } from "cloudflare:workers";

export type CurrentUser = {
  email: string;
  fullName: string | null;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";

type AuthenticationEnvironment = {
  TRUST_SITES_AUTH_HEADERS?: string;
};

/**
 * Authenticated-user headers are meaningful only behind the OpenAI Sites
 * dispatcher. Public Workers/Pages requests can set the same header names, so
 * the application must opt in only in that trusted hosting environment.
 */
export function isSitesAuthenticationTrusted() {
  const authenticationEnv = env as typeof env & AuthenticationEnvironment;
  return authenticationEnv.TRUST_SITES_AUTH_HEADERS?.trim() === "true";
}

export function getCurrentUser(request: Request): CurrentUser | null {
  if (isSitesAuthenticationTrusted()) {
    const email = request.headers
      .get(USER_EMAIL_HEADER)
      ?.trim()
      .toLowerCase();
    if (email?.includes("@")) {
      const encodedName = request.headers.get(USER_FULL_NAME_HEADER);
      const fullName =
        encodedName &&
        request.headers.get(USER_FULL_NAME_ENCODING_HEADER) ===
          "percent-encoded-utf-8"
          ? safeDecode(encodedName)
          : null;
      return { email, fullName };
    }
  }

  // Anonymous identities are accepted only through getUsagePrincipal(),
  // which verifies that the opaque cookie was issued and registered in D1.
  return null;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function authenticationRequired() {
  return Response.json(
    {
      error: "続けるにはアカウントへのログインが必要です。",
      code: "authentication_required",
    },
    { status: 401 },
  );
}

export function authenticationUnavailable() {
  return Response.json(
    {
      error:
        "安全なアカウント認証を準備中のため、現在このURLでは決済を利用できません。この操作では新しい決済は開始されていません。",
      code: "authentication_temporarily_unavailable",
    },
    { status: 503 },
  );
}
