import { isPasskeyAuthenticationConfigured } from "./account-auth";
import { isSitesAuthenticationTrusted } from "./current-user";
import { isOidcProviderConfigured } from "./oidc-auth";

export type AccountAuthenticationMethodAvailability = {
  passkey: boolean;
  line: boolean;
  google: boolean;
  email: boolean;
};

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
