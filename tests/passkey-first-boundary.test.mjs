import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("expensive AI routes reject anonymous trial principals", async () => {
  const routes = await Promise.all(
    [
      "app/api/narration/script/route.ts",
      "app/api/narration/speech/route.ts",
      "app/api/transcribe/route.ts",
    ].map((path) => readFile(new URL(path, root), "utf8")),
  );
  for (const source of routes) {
    assert.match(source, /getUsagePrincipal\(request\)/);
    assert.doesNotMatch(source, /getUsagePrincipal\(request,\s*\{\s*allowTrial:\s*true/);
    assert.match(source, /status:\s*401|authenticationRequired\(\)/);
  }
});

test("usage reservation keeps the anonymous editing and preview trial", async () => {
  const source = await readFile(
    new URL("app/api/usage/reserve/route.ts", root),
    "utf8",
  );
  assert.match(
    source,
    /getUsagePrincipal\(request,\s*\{\s*allowTrial:\s*true/,
  );
});

test("single and video-mix editors open the Google authentication gate on AI 401", async () => {
  const [single, mix, photo] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/video-mix/video-mix-client.tsx", root), "utf8"),
    readFile(new URL("app/photo-reel/photo-reel-client.tsx", root), "utf8"),
  ]);
  for (const source of [single, mix]) {
    assert.match(source, /import AuthenticationGate/);
    assert.match(source, /authentication_required/);
    assert.match(source, /reason="ai"/);
    assert.match(source, /setAuthenticationGateOpen\(true\)/);
  }
  assert.doesNotMatch(photo, /AuthenticationGate/);
});

test("passkey registration is backup-only and bound to one recent session", async () => {
  const source = await readFile(new URL("lib/account-auth.ts", root), "utf8");
  const registration = source.slice(
    source.indexOf("export async function registrationOptions"),
    source.indexOf("export async function authenticationOptions"),
  );
  assert.match(registration, /external_identity_authentication_required/);
  assert.match(registration, /requireRecentAccountReauthentication/);
  assert.match(registration, /initiatingSessionHash/);
  assert.match(registration, /requiresReauthentication:\s*true/);
  assert.doesNotMatch(
    registration,
    /trialSessionPrincipalEmail|bindTrialSessionToAccount/,
  );
});

test("the public authentication chooser enables Google and legacy passkey only", async () => {
  const [methods, gate] = await Promise.all([
    readFile(new URL("lib/account-auth-methods.ts", root), "utf8"),
    readFile(new URL("app/authentication-gate.tsx", root), "utf8"),
  ]);
  assert.match(methods, /google:\s*isOidcProviderConfigured\("google"\)/);
  assert.match(methods, /line:\s*false/);
  assert.match(methods, /email:\s*false/);
  assert.match(gate, /\/api\/account\/oauth\/google\/start/);
  assert.match(gate, /\/api\/account\/passkey\/login\/options/);
  assert.match(gate, /\/api\/account\/passkey\/reauth\/options/);
  assert.doesNotMatch(gate, /\/api\/account\/oauth\/line|\/api\/account\/email/);
});

test("account deletion removes Google identity and pending link challenges", async () => {
  const source = await readFile(
    new URL("lib/account-deletion-executor.ts", root),
    "utf8",
  );
  assert.match(source, /DELETE FROM account_oauth_challenges WHERE initiating_user_id = \?/);
  assert.match(source, /DELETE FROM account_email_challenges WHERE initiating_user_id = \?/);
  assert.match(source, /DELETE FROM account_external_identities WHERE user_id = \?/);
});

test("billing routes accept any configured account authentication method", async () => {
  const routes = await Promise.all(
    [
      "app/api/billing/status/route.ts",
      "app/api/billing/checkout/route.ts",
      "app/api/billing/portal/route.ts",
    ].map((path) => readFile(new URL(path, root), "utf8")),
  );
  for (const source of routes) {
    assert.match(source, /isAccountAuthenticationAvailable\(\)/);
    assert.doesNotMatch(source, /isPasskeyAuthenticationConfigured\(\)/);
  }
});

test("public policy pages describe the Google and legacy passkey behavior", async () => {
  const [privacy, terms, pricing, support] = await Promise.all(
    [
      "app/privacy/page.tsx",
      "app/terms/page.tsx",
      "app/pricing/page.tsx",
      "app/support/page.tsx",
    ].map((path) => readFile(new URL(path, root), "utf8")),
  );
  assert.match(privacy, /利用者識別子（sub）を秘密値でHMAC変換/);
  assert.match(privacy, /Googleから受領する確認済みメールアドレス/);
  assert.match(privacy, /Googleのログイン連携と処理中の認証要求/);
  assert.match(terms, /新しいアカウントはGoogleで作成/);
  assert.match(terms, /パスキーを予備のログイン方法として追加/);
  assert.match(pricing, /既存のパスキー利用者/);
  assert.match(support, /既存のパスキー専用アカウント/);
});

test("the release stops at migration 0026 and contains no first-free runtime", () => {
  const migrations = readdirSync(new URL("drizzle/", root))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  assert.equal(migrations.at(-1), "0026_odd_blob.sql");
  assert.equal(migrations.length, 27);
  for (const path of [
    "app/api/save-entitlement",
    "lib/first-free-save.ts",
    "lib/client-first-free-save.ts",
    "lib/business-kpi.ts",
    "lib/provider-cost.ts",
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
});
