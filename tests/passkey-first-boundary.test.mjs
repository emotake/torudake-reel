import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("single and video-mix editors open the account authentication gate on AI 401", async () => {
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
  assert.match(registration, /LINEでログインしたアカウント/);
  assert.doesNotMatch(registration, /Googleでログインしたアカウント/);
  assert.match(registration, /requireRecentAccountReauthentication/);
  assert.match(registration, /initiatingSessionHash/);
  assert.match(registration, /requiresReauthentication:\s*true/);
  assert.doesNotMatch(
    registration,
    /trialSessionPrincipalEmail|bindTrialSessionToAccount/,
  );
});

test("the public authentication chooser enables LINE and hides Google", async () => {
  const [methods, gate, start, callback, finalize, buttonCss, exampleEnv] = await Promise.all([
    readFile(new URL("lib/account-auth-methods.ts", root), "utf8"),
    readFile(new URL("app/authentication-gate.tsx", root), "utf8"),
    readFile(new URL("app/api/account/oauth/line/start/route.ts", root), "utf8"),
    readFile(new URL("app/api/account/oauth/line/callback/route.ts", root), "utf8"),
    readFile(
      new URL("app/api/account/oauth/line/callback/finalize/route.ts", root),
      "utf8",
    ),
    readFile(new URL("app/line-login-button.module.css", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  assert.match(methods, /line:\s*isOidcProviderConfigured\("line"\)/);
  assert.match(methods, /google:\s*false/);
  assert.match(methods, /email:\s*false/);
  assert.match(gate, /\/api\/account\/oauth\/line\/start/);
  assert.match(gate, /\/api\/account\/passkey\/login\/options/);
  assert.match(gate, /\/api\/account\/passkey\/reauth\/options/);
  assert.doesNotMatch(gate, /\/api\/account\/oauth\/google|\/api\/account\/email/);
  assert.match(
    gate,
    /body: passkeyAvailable\s*\? selectedReasonCopy\.passkeyBody\s*: selectedReasonCopy\.lineBody/,
  );
  const lineAuthentication = gate.slice(
    gate.indexOf("const authenticateWithLine"),
    gate.indexOf("const lineAvailable"),
  );
  assert.ok(
    lineAuthentication.indexOf("window.open(") <
      lineAuthentication.indexOf("await ensureAuthenticationContext()"),
    "the popup must open in the original click task before any awaited work",
  );
  assert.match(lineAuthentication, /popup\.opener = null/);
  assert.match(start, /beginOidcAuthorization\(request, "line"\)/);
  assert.match(callback, /oidcCallbackFinalizationPage\(request, "line"\)/);
  assert.match(finalize, /completeOidcAuthorization\(request, "line"\)/);
  assert.match(finalize, /isSameOriginMutation\(request\)/);
  assert.match(buttonCss, /#06c755/i);
  assert.match(buttonCss, /white-space:\s*nowrap/);
  assert.match(exampleEnv, /^LINE_LOGIN_ENABLED=false$/m);
  assert.match(exampleEnv, /^GOOGLE_OIDC_ENABLED=false$/m);
  assert.match(exampleEnv, /^PASSKEY_AUTH_ENABLED=false$/m);

  const embeddedPngs = Array.from(
    buttonCss.matchAll(/data:image\/png;base64,([^"\)]+)/g),
    (match) => Buffer.from(match[1], "base64"),
  );
  assert.equal(embeddedPngs.length, 4);
  assert.deepEqual(
    embeddedPngs.map((asset) =>
      createHash("sha256").update(asset).digest("hex")),
    [
      "04a40a1caf84a7bd0a9dd78ff3bd84ffecb5d855625ae7540995e67c87b3d1ba",
      "01fe150cd46fa94bdaee283a1d3c288d1f7303eea49c9553d91d8db523773430",
      "75f14205586af03ab14512b8332a047d034e289c48aeaea90bb71b345ee2154b",
      "137099cb735c8ae651924c804e3d9309f574655caf042895804fefb4ad02357c",
    ],
  );
  for (const asset of embeddedPngs) {
    assert.deepEqual(asset.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
    assert.equal(asset.readUInt32BE(16), 88);
    assert.equal(asset.readUInt32BE(20), 88);
  }
});

test("account deletion removes external identity and pending link challenges", async () => {
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

test("public policy pages describe the LINE-first behavior", async () => {
  const [privacy, terms, pricing, support] = await Promise.all(
    [
      "app/privacy/page.tsx",
      "app/terms/page.tsx",
      "app/pricing/page.tsx",
      "app/support/page.tsx",
    ].map((path) => readFile(new URL(path, root), "utf8")),
  );
  assert.match(privacy, /利用者識別子（sub）を秘密値でHMAC変換/);
  assert.match(privacy, /LINEからメールアドレス、表示名、プロフィール画像は取得しません/);
  assert.match(privacy, /本サービス内に保存したLINEの連携識別情報と処理中の認証要求/);
  assert.match(privacy, /LINE認証の完了後は直ちにLINE側の連携権限を解除/);
  assert.match(terms, /新しいアカウントはLINEで作成/);
  assert.match(pricing, /新しいアカウントはLINEで作成/);
  assert.match(support, /LINEログインで困った/);
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
