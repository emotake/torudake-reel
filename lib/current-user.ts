import { env } from "cloudflare:workers";
import { getAccountIdentity } from "./account-auth";

export type CurrentUser = {
  id: string | null;
  email: string;
  billingEmail: string | null;
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

export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
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
      return { id: null, email, billingEmail: email, fullName };
    }
  }

  const account = await getAccountIdentity(request);
  if (account) return account;

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
        "アカウント認証を現在利用できません。少し待ってからお試しください。",
      code: "authentication_temporarily_unavailable",
    },
    { status: 503 },
  );
}
