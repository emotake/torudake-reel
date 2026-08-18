import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeOidcReturnTo } from "../lib/oidc-core.ts";

const root = new URL("../", import.meta.url);

const [
  authenticationGateSource,
  accountClientSource,
  authReturnNoticeSource,
  layoutSource,
  oidcAuthSource,
] =
  await Promise.all([
    readFile(new URL("app/authentication-gate.tsx", root), "utf8"),
    readFile(new URL("app/account/account-client.tsx", root), "utf8"),
    readFile(new URL("app/authentication-return-notice.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("lib/oidc-auth.ts", root), "utf8"),
  ]);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return source.slice(startIndex, endIndex === -1 ? undefined : endIndex);
}

test("blocked or unusable LINE popups fall back to the same tab and retain the checkout return target", () => {
  const lineAuthentication = sourceSection(
    authenticationGateSource,
    "const authenticateWithLine",
    "const lineAvailable",
  );

  assert.match(
    authenticationGateSource,
    /(?:window\.location|target)\.pathname[\s\S]{0,160}(?:window\.location|target)\.search/,
    "the return target must retain both the current path and query string",
  );
  assert.match(
    lineAuthentication,
    /searchParams\.set\(\s*["']returnTo["']/,
    "the OIDC start request must carry the current page as returnTo",
  );
  assert.match(
    lineAuthentication,
    /window\.location\.(?:assign|replace)\([^)]*startUrl/,
    "the mobile fallback must navigate the current tab",
  );

  const popupBlockedBranch = sourceSection(
    lineAuthentication,
    "if (!popup)",
    "popup.location",
  );
  assert.match(
    popupBlockedBranch,
    /(?:sameTab|navigate|window\.location\.(?:assign|replace))/i,
    "a blocked popup must fall back to the same-tab flow",
  );
  assert.doesNotMatch(
    popupBlockedBranch,
    /ポップアップを許可/,
    "a blocked popup must not strand the user behind browser instructions",
  );

  const popupNavigationBranch = sourceSection(
    lineAuthentication,
    "popup.location",
    "const lineAvailable",
  );
  assert.match(
    popupNavigationBranch,
    /catch[\s\S]{0,700}(?:sameTab|navigate|window\.location\.(?:assign|replace))/i,
    "a popup that cannot navigate must fall back to the same-tab flow",
  );

  for (const plan of ["starter", "standard", "one_time"]) {
    const returnTo = `/account?checkout=${plan}`;
    assert.equal(
      normalizeOidcReturnTo(returnTo),
      returnTo,
      `checkout=${plan} must survive the same-tab OIDC round trip`,
    );
  }
});

test("popup LINE login remains pending until success, cancellation, failure, or close is observed", () => {
  const lineAuthentication = sourceSection(
    authenticationGateSource,
    "const authenticateWithLine",
    "const lineAvailable",
  );

  const usesBroadcastChannel = /BroadcastChannel\(/.test(
    authenticationGateSource,
  );
  if (usesBroadcastChannel) {
    assert.match(
      authenticationGateSource,
      /result\.(?:popupId|flowId|attemptId)\s*!==\s*[A-Za-z0-9_.]*(?:popup|flow|attempt)[A-Za-z0-9_.]*Ref\.current/i,
      "stale or unrelated BroadcastChannel results must be rejected by attempt id",
    );
  } else {
    assert.match(
      authenticationGateSource,
      /event\.origin\s*===\s*window\.location\.origin/,
      "postMessage results must be accepted only from the application origin",
    );
  }
  assert.match(
    authenticationGateSource,
    /(?:event\.data|\.data|result)[\s\S]{0,500}(?:success|succeeded|cancelled|failed|error)/i,
    "the opener must distinguish successful and unsuccessful popup results",
  );
  assert.match(
    authenticationGateSource,
    /popup\.closed/,
    "manual popup closure must terminate the pending state",
  );
  assert.doesNotMatch(
    lineAuthentication,
    /setTimeout\(\s*\(\)\s*=>\s*setBusy\(null\)\s*,\s*1_?000\s*\)/,
    "busy state must not be cleared on a blind one-second timer",
  );
  assert.match(
    authenticationGateSource,
    /refreshAuthentication\(\)/,
    "a successful popup result must refresh the authenticated state",
  );
  assert.match(
    oidcAuthSource,
    /(?:postMessage\(|BroadcastChannel\()/,
    "the callback page must send an explicit completion result to the initiating page",
  );
  assert.match(
    oidcAuthSource,
    /(?:errorCode|cancelled|result)[\s\S]{0,800}(?:postMessage|BroadcastChannel)|(?:postMessage|BroadcastChannel)[\s\S]{0,800}(?:errorCode|cancelled|result)/,
    "the completion signal must distinguish cancellation/failure from success",
  );
  assert.doesNotMatch(
    oidcAuthSource,
    /(?:postMessage|\.post\s*\()[\s\S]{0,300}(?:accessToken|idToken|sessionToken|userId)/,
    "popup completion messages must never expose identity or credential data",
  );
});

test("account auth_error is allow-listed, displayed, and removed without deleting unrelated query state", () => {
  assert.match(accountClientSource, /searchParams|get\(["']auth_error["']\)/);
  assert.match(accountClientSource, /get\(["']auth_error["']\)/);

  for (const code of [
    "cancelled",
    "expired",
    "failed",
    "identity_already_linked",
    "account_unavailable",
    "account_changed",
  ]) {
    assert.match(
      accountClientSource,
      new RegExp(`["']${code}["']\\s*:`),
      `auth_error=${code} needs an approved Japanese message`,
    );
  }

  assert.match(
    accountClientSource,
    /(?:AUTH[^\n]*ERROR[^\n]*MESSAGES|auth[^\n]*Error[^\n]*Message)[\s\S]{0,700}(?:setError|setNotice)/i,
    "only a message selected from the allow-list may reach the account UI",
  );
  assert.doesNotMatch(
    accountClientSource,
    /(?:setError|setNotice)\(\s*(?:rawAuthError|authError)\s*\)/,
    "the URL value itself must never be rendered",
  );
  assert.match(
    accountClientSource,
    /delete\(["']auth_error["']\)/,
    "auth_error must be consumed after it is displayed",
  );
  assert.match(
    accountClientSource,
    /window\.location\.pathname[\s\S]{0,240}(?:toString\(\)|window\.location\.hash)/,
    "URL cleanup must rebuild the URL from the remaining parameters",
  );
  assert.match(layoutSource, /<AuthenticationReturnNotice\s*\/>/);
  assert.match(authReturnNoticeSource, /getAll\(["']auth_error["']\)/);
  assert.match(authReturnNoticeSource, /get\(["']auth_result["']\)/);
  assert.match(authReturnNoticeSource, /delete\(["']auth_error["']\)/);
  assert.match(authReturnNoticeSource, /delete\(["']auth_result["']\)/);
  assert.match(
    authReturnNoticeSource,
    /window\.location\.pathname\s*===\s*["']\/account["']/,
    "the global notice must leave /account feedback to AccountClient",
  );
});

test("the authentication modal traps focus, makes the background inert, and restores focus", () => {
  assert.match(authenticationGateSource, /aria-modal=["']true["']/);
  const usesNativeModalDialog = /<dialog\b/.test(authenticationGateSource);
  if (usesNativeModalDialog) {
    assert.match(authenticationGateSource, /showModal\(\)/);
    assert.match(authenticationGateSource, /\.close\(\)/);
    assert.match(authenticationGateSource, /onCancel=/);
    assert.match(
      authenticationGateSource,
      /onCancel[\s\S]{0,500}preventDefault\(\)/,
      "Escape must not dismiss the native dialog while authentication is busy",
    );
  } else {
    assert.match(authenticationGateSource, /event\.key\s*(?:===|!==)\s*["']Tab["']/);
    assert.match(authenticationGateSource, /event\.shiftKey/);
    assert.match(authenticationGateSource, /preventDefault\(\)/);
    assert.match(
      authenticationGateSource,
      /button:not\(\[disabled\]\)/,
      "the focus loop must include the close and enabled provider buttons",
    );
    assert.match(authenticationGateSource, /querySelectorAll/);
    assert.match(
      authenticationGateSource,
      /(?:\.inert\s*=\s*true|setAttribute\(\s*["']inert["'])/,
      "content behind the modal must be inert while it is open",
    );
    assert.match(
      authenticationGateSource,
      /(?:\.inert\s*=\s*false|removeAttribute\(\s*["']inert["']|inert:\s*element\.inert)/,
      "the prior inert state must be restored when the modal closes",
    );
    if (/inert:\s*element\.inert/.test(authenticationGateSource)) {
      assert.match(authenticationGateSource, /element\.inert\s*=\s*inert/);
    }
    assert.match(authenticationGateSource, /event\.key\s*===\s*["']Escape["']/);
  }
  assert.match(
    authenticationGateSource,
    /\b(?:previous|previousFocusRef\.current)\?\.focus(?:\?\.)?\(\)/,
  );
});
