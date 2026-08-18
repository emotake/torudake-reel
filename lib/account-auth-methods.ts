import { env } from "cloudflare:workers";
import { isPasskeyAuthenticationConfigured } from "./account-auth";
import { isSitesAuthenticationTrusted } from "./current-user";
import { isOidcProviderConfigured } from "./oidc-auth";

export type AccountAuthenticationMethodAvailability = {
  passkey: boolean;
  line: boolean;
  google: boolean;
  email: boolean;
};

export type PublicAuthenticationFlags = {
  OIDC_AUTH_ENABLED: boolean;
  LINE_LOGIN_ENABLED: boolean;
  GOOGLE_OIDC_ENABLED: boolean;
  EMAIL_AUTH_ENABLED: boolean;
  PASSKEY_AUTH_ENABLED: boolean;
};

export function publicAuthenticationFlags(): PublicAuthenticationFlags {
  return {
    OIDC_AUTH_ENABLED: env.OIDC_AUTH_ENABLED === "true",
    LINE_LOGIN_ENABLED: env.LINE_LOGIN_ENABLED === "true",
    GOOGLE_OIDC_ENABLED: env.GOOGLE_OIDC_ENABLED === "true",
    EMAIL_AUTH_ENABLED: env.EMAIL_AUTH_ENABLED === "true",
    PASSKEY_AUTH_ENABLED: env.PASSKEY_AUTH_ENABLED === "true",
  };
}

export function configuredAccountAuthenticationMethods(): AccountAuthenticationMethodAvailability {
  return {
    passkey: isPasskeyAuthenticationConfigured(),
    line: isOidcProviderConfigured("line"),
    // Google routes remain available for a controlled rollback, but the
    // public account chooser is deliberately LINE-first.
    google: false,
    email: false,
  };
}

export function isAccountAuthenticationAvailable() {
  if (isSitesAuthenticationTrusted()) return true;
  return Object.values(configuredAccountAuthenticationMethods()).some(Boolean);
}
