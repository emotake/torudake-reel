import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeAuthenticationReturnResult,
  verifyAuthenticationReturn,
} from "../lib/client-authentication-return.ts";
import {
  claimAuthenticationBusy,
  createLineSameTabNavigationEpoch,
  isActiveAbortableAuthenticationAttempt,
  isActiveLineAuthenticationAttempt,
  isPendingLineSameTabNavigation,
  markLineSameTabNavigationCommitted,
  runAbortableAuthenticationRequest,
  runGuardedAuthenticationSequence,
  scheduleLineAuthenticationRecovery,
  shouldInitializeAuthenticationGate,
} from "../lib/client-line-auth-lifecycle.ts";
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
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const startIndex = normalizedSource.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source section: ${start}`);
  const endIndex = normalizedSource.indexOf(end, startIndex + start.length);
  return normalizedSource.slice(
    startIndex,
    endIndex === -1 ? undefined : endIndex,
  );
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
  const returnToHelper = sourceSection(
    authenticationGateSource,
    "function currentAuthenticationReturnTo",
    "function isPopupClosed",
  );
  assert.match(returnToHelper, /searchParams\.delete\(["']auth_error["']\)/);
  assert.match(returnToHelper, /searchParams\.delete\(["']auth_result["']\)/);
  assert.doesNotMatch(
    returnToHelper,
    /searchParams\.set\([\s\S]*?["']auth_result["']|searchParams\.append\([\s\S]*?["']auth_result["']/,
    "only the verified server callback may add auth_result",
  );
  assert.match(
    lineAuthentication,
    /window\.location\.(?:assign|replace)\([^)]*startUrl/,
    "the mobile fallback must navigate the current tab",
  );
  assert.match(
    lineAuthentication,
    /armSameTabRecovery\([\s\S]{0,700}window\.location\.assign/,
    "same-tab navigation must arm recovery before attempting to leave",
  );
  const sameTabNavigation = sourceSection(
    lineAuthentication,
    "const navigateLineSameTab",
    "if (sameTabOnly)",
  );
  assert.ok(
    sameTabNavigation.indexOf("armSameTabRecovery(") <
      sameTabNavigation.indexOf("await prepareLineContext("),
    "same-tab recovery must cover the best-effort trial preparation",
  );
  assert.match(authenticationGateSource, /scheduleLineAuthenticationRecovery\(/);
  assert.match(
    authenticationGateSource,
    /recoverSameTabAttempt[\s\S]{0,500}setBusy\(null\)/,
    "a cancelled same-tab navigation must restore usable controls",
  );
  assert.match(authenticationGateSource, /addEventListener\("pagehide"/);
  assert.match(authenticationGateSource, /addEventListener\("pageshow"/);
  assert.match(authenticationGateSource, /addEventListener\("beforeunload"/);
  assert.match(authenticationGateSource, /if \(!event\.persisted\) return/);

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

test("same-tab recovery fires only for the still-current attempt", () => {
  let callback = null;
  let cancelledHandle = null;
  let current = true;
  let recoveries = 0;
  const cancelRecovery = scheduleLineAuthenticationRecovery({
    delayMs: 1_000,
    isCurrent: () => current,
    recover: () => {
      recoveries += 1;
    },
    schedule(next) {
      callback = next;
      return 41;
    },
    cancel(handle) {
      cancelledHandle = handle;
    },
  });

  assert.equal(recoveries, 0);
  callback();
  assert.equal(recoveries, 1, "a document that remains must recover once");
  cancelRecovery();
  assert.equal(cancelledHandle, 41);

  callback = null;
  current = false;
  recoveries = 0;
  scheduleLineAuthenticationRecovery({
    delayMs: 1_000,
    isCurrent: () => current,
    recover: () => {
      recoveries += 1;
    },
    schedule(next) {
      callback = next;
      return 42;
    },
    cancel() {},
  });
  callback();
  assert.equal(recoveries, 0, "a stale attempt must not alter current UI");

  const navigation = createLineSameTabNavigationEpoch(9, 7);
  callback = null;
  recoveries = 0;
  scheduleLineAuthenticationRecovery({
    delayMs: 1_000,
    isCurrent: () =>
      isPendingLineSameTabNavigation(navigation, 9, 7),
    recover: () => {
      recoveries += 1;
    },
    schedule(next) {
      callback = next;
      return 43;
    },
    cancel() {},
  });
  assert.equal(markLineSameTabNavigationCommitted(navigation, 9), true);
  callback();
  assert.equal(
    recoveries,
    0,
    "pagehide-committed navigation must not be reset by the watchdog",
  );
  assert.equal(navigation.committed, true);
  assert.equal(
    isPendingLineSameTabNavigation(navigation, 9, 7),
    false,
    "a BFCache-restored document must be handled as a committed return",
  );
});

test("authentication requests abort on a deadline or parent cancellation", async () => {
  let timeoutCallback = null;
  let cancelledHandle = null;
  let timeoutSignal = null;
  const timedRequest = runAbortableAuthenticationRequest({
    timeoutMs: 12_000,
    timeoutMessage: "authentication request timed out",
    run(signal) {
      timeoutSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    schedule(callback) {
      timeoutCallback = callback;
      return 51;
    },
    cancel(handle) {
      cancelledHandle = handle;
    },
  });
  timeoutCallback();
  await assert.rejects(timedRequest, /authentication request timed out/);
  assert.equal(timeoutSignal.aborted, true);
  assert.equal(cancelledHandle, 51);

  const parent = new AbortController();
  cancelledHandle = null;
  let forwardedSignal = null;
  const cancelledRequest = runAbortableAuthenticationRequest({
    timeoutMs: 12_000,
    timeoutMessage: "authentication request timed out",
    signal: parent.signal,
    run(signal) {
      forwardedSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    schedule() {
      return 52;
    },
    cancel(handle) {
      cancelledHandle = handle;
    },
  });
  parent.abort(new Error("authentication gate closed"));
  await assert.rejects(cancelledRequest, /authentication gate closed/);
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(cancelledHandle, 52);

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(new Error("authentication gate already closed"));
  let alreadyCancelledRun = false;
  await assert.rejects(
    runAbortableAuthenticationRequest({
      timeoutMs: 12_000,
      timeoutMessage: "authentication request timed out",
      signal: alreadyCancelled.signal,
      async run() {
        alreadyCancelledRun = true;
      },
    }),
    /authentication gate already closed/,
  );
  assert.equal(alreadyCancelledRun, false);
});

test("passkey flow stops dynamically after close or unmount boundaries", async () => {
  const busyState = { current: null };
  assert.equal(claimAuthenticationBusy(busyState, "passkey"), true);
  assert.equal(claimAuthenticationBusy(busyState, "passkey"), false);
  assert.equal(busyState.current, "passkey");

  const controller = new AbortController();
  const activeState = { mounted: true, open: true, generation: 12 };
  assert.equal(
    isActiveAbortableAuthenticationAttempt(
      activeState,
      12,
      controller.signal,
    ),
    true,
  );
  controller.abort();
  assert.equal(
    isActiveAbortableAuthenticationAttempt(
      activeState,
      12,
      controller.signal,
    ),
    false,
  );

  let current = true;
  let releaseOptions;
  const calls = [];
  const optionsPending = new Promise((resolve) => {
    releaseOptions = resolve;
  });
  const duringOptions = runGuardedAuthenticationSequence({
    isCurrent: () => current,
    ensureContext: async () => {
      calls.push("context");
    },
    loadOptions: async () => {
      calls.push("options");
      return optionsPending;
    },
    requestCredential: async () => {
      calls.push("prompt");
      return "credential";
    },
    verifyCredential: async () => {
      calls.push("verify");
    },
    refreshAuthentication: async () => {
      calls.push("refresh");
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  current = false;
  releaseOptions("options");
  assert.equal(await duringOptions, "stale");
  assert.deepEqual(calls, ["context", "options"]);

  current = true;
  calls.length = 0;
  let releaseCredential;
  const credentialPending = new Promise((resolve) => {
    releaseCredential = resolve;
  });
  const duringPrompt = runGuardedAuthenticationSequence({
    isCurrent: () => current,
    ensureContext: async () => {
      calls.push("context");
    },
    loadOptions: async () => {
      calls.push("options");
      return "options";
    },
    requestCredential: async () => {
      calls.push("prompt");
      return credentialPending;
    },
    verifyCredential: async () => {
      calls.push("verify");
    },
    refreshAuthentication: async () => {
      calls.push("refresh");
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  current = false;
  releaseCredential("credential");
  assert.equal(await duringPrompt, "stale");
  assert.deepEqual(calls, ["context", "options", "prompt"]);

  current = true;
  calls.length = 0;
  let releaseVerification;
  const verificationPending = new Promise((resolve) => {
    releaseVerification = resolve;
  });
  const duringVerification = runGuardedAuthenticationSequence({
    isCurrent: () => current,
    ensureContext: async () => {
      calls.push("context");
    },
    loadOptions: async () => {
      calls.push("options");
      return "options";
    },
    requestCredential: async () => {
      calls.push("prompt");
      return "credential";
    },
    verifyCredential: async () => {
      calls.push("verify");
      await verificationPending;
    },
    refreshAuthentication: async () => {
      calls.push("refresh");
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  current = false;
  releaseVerification();
  assert.equal(await duringVerification, "stale");
  assert.deepEqual(calls, ["context", "options", "prompt", "verify"]);

  const passkeyAuthentication = sourceSection(
    authenticationGateSource,
    "const authenticateWithPasskey",
    "const authenticateWithLine",
  );
  assert.match(
    passkeyAuthentication,
    /claimAuthenticationBusy\(busyRef,\s*["']passkey["']\)/,
  );
  assert.match(passkeyAuthentication, /controller\.signal/);
  assert.match(authenticationGateSource, /WebAuthnAbortService\.cancelCeremony/);
  assert.match(authenticationGateSource, /invalidatePasskeyAttempt\(\)/);
  assert.match(authenticationGateSource, /PASSKEY_CEREMONY_TIMEOUT_MS/);
  assert.match(authenticationGateSource, /passkeyAttemptTimeoutRef/);
  assert.match(authenticationGateSource, /cancelPasskeyAttempt/);
  assert.match(authenticationGateSource, /パスキーによる本人確認を中止/);
  assert.match(authenticationGateSource, /runAbortableAuthenticationRequest\(/);
  assert.match(authenticationGateSource, /AUTHENTICATION_REQUEST_TIMEOUT_MS/);
});

test("popup best-effort preflight is registered before awaiting and stops after close or unmount", () => {
  const lineAuthentication = sourceSection(
    authenticationGateSource,
    "const authenticateWithLine",
    "const lineAvailable",
  );
  const openIndex = lineAuthentication.indexOf("window.open(");
  const registerIndex = lineAuthentication.indexOf("beginLineAttempt(popup)");
  const awaitIndex = lineAuthentication.indexOf(
    "await prepareLineContext(",
    registerIndex,
  );
  const navigationIndex = lineAuthentication.indexOf(
    "popup.location.replace(startUrl.toString())",
    awaitIndex,
  );
  assert.ok(openIndex >= 0 && registerIndex > openIndex);
  assert.ok(
    awaitIndex > registerIndex &&
      navigationIndex > awaitIndex,
    "the blank popup must be registered before guarded preflight and LINE navigation",
  );
  const lineContextPreparation = sourceSection(
    lineAuthentication,
    "const prepareLineContext",
    "const navigateLineSameTab",
  );
  assert.match(
    lineContextPreparation,
    /return isCurrentLineAttempt\(generation\)/,
    "the preflight guard must stop navigation after close or unmount",
  );
  assert.match(authenticationGateSource, /mountedRef\.current\s*=\s*false/);
  assert.match(authenticationGateSource, /invalidateLineAttempt\(true\)/);

  assert.equal(
    isActiveLineAuthenticationAttempt(
      { mounted: true, open: true, generation: 7 },
      7,
    ),
    true,
  );
  for (const state of [
    { mounted: false, open: true, generation: 7 },
    { mounted: true, open: false, generation: 7 },
    { mounted: true, open: true, generation: 8 },
  ]) {
    assert.equal(isActiveLineAuthenticationAttempt(state, 7), false);
  }
});

test("parent rerenders preserve an in-flight authentication attempt", () => {
  assert.equal(
    shouldInitializeAuthenticationGate(null, true, "authenticate"),
    true,
    "opening the gate must initialize it",
  );
  assert.equal(
    shouldInitializeAuthenticationGate(
      "authenticate",
      true,
      "authenticate",
    ),
    false,
    "a parent rerender in the same open mode must not reinitialize the gate",
  );
  assert.equal(
    shouldInitializeAuthenticationGate(
      "authenticate",
      true,
      "reauthenticate",
    ),
    true,
    "a genuine mode transition must reinitialize the gate",
  );
  assert.equal(
    shouldInitializeAuthenticationGate("authenticate", false, "authenticate"),
    false,
    "a closed gate must not initialize",
  );

  const pendingBusy = { current: "line" };
  let attemptGeneration = 14;
  if (
    shouldInitializeAuthenticationGate(
      "authenticate",
      true,
      "authenticate",
    )
  ) {
    attemptGeneration += 1;
    pendingBusy.current = null;
  }
  assert.equal(
    attemptGeneration,
    14,
    "a parent rerender must preserve the active attempt generation",
  );
  assert.equal(pendingBusy.current, "line", "busy must remain claimed");
  assert.equal(
    claimAuthenticationBusy(pendingBusy, "passkey"),
    false,
    "a second authentication flow must remain blocked while the first is pending",
  );

  const refreshAuthentication = sourceSection(
    authenticationGateSource,
    "const refreshAuthentication",
    "const resetLinePopup",
  );
  assert.match(
    authenticationGateSource,
    /onAuthenticatedRef\.current\s*=\s*onAuthenticated/,
    "the latest parent callback must be read through a ref",
  );
  assert.match(refreshAuthentication, /onAuthenticatedRef\.current\(\)/);
  assert.doesNotMatch(refreshAuthentication, /await onAuthenticated\(\)/);
  assert.match(
    refreshAuthentication,
    /\},\s*\[mode\]\s*\);/,
    "inline parent callback identity must not recreate refreshAuthentication",
  );

  const initialization = sourceSection(
    authenticationGateSource,
    "shouldInitializeAuthenticationGate(",
    "useEffect(() => {\n    if (!open) return;",
  );
  assert.match(initialization, /invalidateLineAttempt\(true\)/);
  assert.match(initialization, /invalidatePasskeyAttempt\(\)/);
  assert.ok(
    initialization.indexOf("invalidateLineAttempt(true)") <
      initialization.indexOf("busyRef.current = null"),
    "a genuine reinitialization must invalidate active attempts before clearing busy",
  );
  assert.doesNotMatch(initialization, /onAuthenticated/);
  assert.doesNotMatch(initialization, /handleLinePopupResult/);
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
  assert.match(
    authenticationGateSource,
    /refreshFailed[\s\S]{0,900}invalidateLineAttempt\(true\)[\s\S]{0,400}setBusy\(null\)/,
    "a stalled or failed post-popup session refresh must restore usable controls",
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
  assert.match(authReturnNoticeSource, /getAll\(["']auth_result["']\)/);
  assert.match(authReturnNoticeSource, /delete\(["']auth_error["']\)/);
  assert.match(authReturnNoticeSource, /delete\(["']auth_result["']\)/);
  assert.match(
    authReturnNoticeSource,
    /window\.location\.pathname\s*===\s*["']\/account["']/,
    "the global notice must leave /account feedback to AccountClient",
  );
  assert.match(authReturnNoticeSource, /verifyAuthenticationReturn\(/);
  assert.match(accountClientSource, /isAuthenticationReturnVerified\(/);
});

test("auth_result is only trusted after the no-store account-method check", async () => {
  assert.equal(normalizeAuthenticationReturnResult(["authenticated"]), "authenticated");
  assert.equal(
    normalizeAuthenticationReturnResult(["reauthenticated"]),
    "reauthenticated",
  );
  assert.equal(normalizeAuthenticationReturnResult([]), null);
  assert.equal(
    normalizeAuthenticationReturnResult(["authenticated", "authenticated"]),
    null,
  );
  assert.equal(normalizeAuthenticationReturnResult(["forged"]), null);

  let capturedInit;
  const verified = await verifyAuthenticationReturn("authenticated", {
    fetcher: async (_input, init) => {
      capturedInit = init;
      return Response.json({
        authenticated: true,
        recentlyAuthenticated: false,
      });
    },
  });
  assert.equal(verified, true);
  assert.equal(capturedInit.cache, "no-store");
  assert.equal(capturedInit.credentials, "same-origin");

  assert.equal(
    await verifyAuthenticationReturn("authenticated", {
      fetcher: async () => Response.json({
        authenticated: false,
        recentlyAuthenticated: false,
      }),
    }),
    false,
    "a URL alone must not claim a completed login",
  );
  assert.equal(
    await verifyAuthenticationReturn("reauthenticated", {
      fetcher: async () => Response.json({
        authenticated: true,
        recentlyAuthenticated: false,
      }),
    }),
    false,
    "reauthentication needs the authoritative recent-session flag",
  );
  assert.equal(
    await verifyAuthenticationReturn("reauthenticated", {
      fetcher: async () => Response.json({
        authenticated: true,
        recentlyAuthenticated: true,
      }),
    }),
    true,
  );
  assert.equal(
    await verifyAuthenticationReturn("authenticated", {
      fetcher: async () => Response.json({}, { status: 503 }),
    }),
    false,
    "an unavailable authority must fail closed",
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
