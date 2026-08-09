import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const accountClientSource = await readFile(
  new URL("../app/account/account-client.tsx", import.meta.url),
  "utf8",
);
const hookStart = pageSource.indexOf("function useCaptionProfileSync()");
const hookEnd = pageSource.indexOf("export default function Home()", hookStart);
const syncHookSource = pageSource.slice(hookStart, hookEnd);

test("keeps caption profiles local for visitors without an authentication hint", () => {
  assert.ok(hookStart >= 0 && hookEnd > hookStart);
  assert.match(
    syncHookSource,
    /localStorage\.getItem\(ACCOUNT_AUTHENTICATED_STORAGE_KEY\) === "1"/,
  );

  const localOnlyGuard = syncHookSource.indexOf("if (!hasAuthenticationHint)");
  const profileGet = syncHookSource.indexOf('fetch("/api/caption-profile"');
  assert.ok(localOnlyGuard >= 0 && localOnlyGuard < profileGet);
  assert.match(
    syncHookSource.slice(localOnlyGuard, profileGet),
    /setSyncStatus\("local-only"\);\s*return;/,
  );
});

test("does not PUT a caption profile until authentication and a user edit are confirmed", () => {
  assert.match(
    syncHookSource,
    /if \(syncStatus !== "authenticated" \|\| !hasUserEdited\) return;/,
  );
  assert.match(syncHookSource, /method: "PUT"/);
  assert.match(
    syncHookSource,
    /setHasUserEdited\(true\);\s*setCaptionProfileState\(nextProfile\);/,
  );
  assert.doesNotMatch(
    syncHookSource,
    /setCaptionProfileState\(normalizeCaptionProfile\(payload\.profile\)\);[\s\S]*setHasUserEdited\(true\)/,
  );
});

test("preserves a local edit that races with the authenticated profile load", () => {
  assert.match(
    syncHookSource,
    /hasUserEditedRef\.current = true;[\s\S]*if \(payload\.profile && !hasUserEditedRef\.current\)/,
  );
  assert.match(
    syncHookSource,
    /CAPTION_PROFILE_SAVE_DELAY_MS/,
  );
});

test("clears a stale authentication hint after an unauthorized profile request", () => {
  const unauthorizedBranches = syncHookSource.match(
    /response\.status === 401/g,
  );
  assert.equal(unauthorizedBranches?.length, 2);
  assert.match(
    syncHookSource,
    /response\.status === 401[\s\S]*removeAccountAuthenticationHint\(\);[\s\S]*setSyncStatus\("local-only"\)/,
  );
});

test("records the authentication hint from the account status response", () => {
  assert.match(
    accountClientSource,
    /const ACCOUNT_AUTH_HINT_STORAGE_KEY = "torudake-account-authenticated"/,
  );
  assert.match(
    accountClientSource,
    /if \(payload\.authenticated\) \{[\s\S]*localStorage\.setItem\(ACCOUNT_AUTH_HINT_STORAGE_KEY, "1"\)[\s\S]*\} else \{[\s\S]*localStorage\.removeItem\(ACCOUNT_AUTH_HINT_STORAGE_KEY\)/,
  );
});
