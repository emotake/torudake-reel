import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACCOUNT_CHALLENGE_COOKIE,
  ACCOUNT_SESSION_COOKIE,
  accountChallengeCookie,
  accountSessionCookie,
  getAccountSessionToken,
  hashAccountToken,
  randomAccountToken,
} from "../lib/account-session.ts";

test("issues opaque secure passkey cookies without exposing account data", async () => {
  const token = randomAccountToken();
  const sessionCookie = accountSessionCookie(token, true);
  const challengeCookie = accountChallengeCookie(token, true);

  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(sessionCookie, new RegExp(`^${ACCOUNT_SESSION_COOKIE}=`));
  assert.match(challengeCookie, new RegExp(`^${ACCOUNT_CHALLENGE_COOKIE}=`));
  for (const cookie of [sessionCookie, challengeCookie]) {
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, /@|trial-/);
  }
  const request = new Request("https://torudake-reel.pages.dev/account", {
    headers: { cookie: sessionCookie.split(";", 1)[0] },
  });
  assert.equal(getAccountSessionToken(request), token);
  assert.notEqual(await hashAccountToken(token), token);
  assert.match(await hashAccountToken(token), /^[0-9a-f]{64}$/);
});

test("allows passkey registration only as a recently verified account backup", async () => {
  const source = await readFile(
    new URL("../lib/account-auth.ts", import.meta.url),
    "utf8",
  );
  const registration = source.slice(
    source.indexOf("export async function registrationOptions"),
    source.indexOf("export async function authenticationOptions"),
  );
  assert.match(registration, /external_identity_authentication_required/);
  assert.match(
    registration,
    /requireRecentAccountReauthentication\(\s*request,\s*user\.id,?\s*\)/,
  );
  assert.match(registration, /requiresReauthentication: true/);
  assert.doesNotMatch(registration, /getRegisteredTrialSessionId|trialSessionPrincipalEmail/);
  assert.match(source, /residentKey: "required"/);
  assert.match(source, /userVerification: "required"/);
  assert.match(source, /attestationType: "none"/);
  assert.match(source, /consumed_at IS NULL/);
  assert.match(source, /RETURNING challenge, ceremony, user_id/);
  assert.match(source, /hashAccountToken\(sessionToken\)/);
  assert.match(source, /EXISTS \(\s*SELECT 1 FROM account_passkeys/);
  assert.match(source, /authentication_rate_limited/);
  assert.match(
    source,
    /DELETE FROM account_auth_challenges WHERE created_at < \?/,
  );
  assert.match(source, /DELETE FROM account_sessions WHERE expires_at < \?/);
});

test("never sends an opaque trial address to Stripe Checkout", async () => {
  const source = await readFile(
    new URL("../app/api/billing/checkout/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /customerParams\.set\("email", user\.email\)/);
  assert.match(source, /customerParams\.set\("email", user\.billingEmail\)/);
  assert.match(source, /\{CHECKOUT_SESSION_ID\}/);
});
