export type AuthenticationReturnResult =
  | "authenticated"
  | "reauthenticated";

export type AuthenticationMethodState = {
  authenticated: boolean;
  recentlyAuthenticated: boolean;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function normalizeAuthenticationReturnResult(
  values: readonly string[],
): AuthenticationReturnResult | null {
  if (values.length !== 1) return null;
  return values[0] === "authenticated" || values[0] === "reauthenticated"
    ? values[0]
    : null;
}

export function isAuthenticationReturnVerified(
  result: AuthenticationReturnResult | null,
  methods: AuthenticationMethodState | null | undefined,
) {
  if (!result || methods?.authenticated !== true) return false;
  return result === "authenticated" || methods.recentlyAuthenticated === true;
}

export async function verifyAuthenticationReturn(
  result: AuthenticationReturnResult | null,
  options: {
    fetcher?: FetchLike;
    signal?: AbortSignal;
  } = {},
) {
  if (!result) return false;
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher("/api/account/auth/methods", {
      cache: "no-store",
      credentials: "same-origin",
      signal: options.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as
      | Partial<AuthenticationMethodState>
      | null;
    return isAuthenticationReturnVerified(
      result,
      payload?.authenticated === true &&
          typeof payload.recentlyAuthenticated === "boolean"
        ? {
            authenticated: true,
            recentlyAuthenticated: payload.recentlyAuthenticated,
          }
        : null,
    );
  } catch {
    return false;
  }
}
