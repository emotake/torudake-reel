import {
  getAccountAuthenticationState,
} from "../../../../../lib/account-auth";
import {
  configuredAccountAuthenticationMethods,
  publicAuthenticationFlags,
} from "../../../../../lib/account-auth-methods";
import { privateJson } from "../../../../../lib/account-auth-http";

export async function GET(request: Request) {
  const state = await getAccountAuthenticationState(request);
  return privateJson({
    ...state,
    ...configuredAccountAuthenticationMethods(),
    authenticationFlags: publicAuthenticationFlags(),
  });
}
