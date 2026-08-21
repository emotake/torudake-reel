import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AuthenticationApiError,
  authenticationErrorMessage,
  isTrialAlreadyIssuedAuthenticationError,
} from "../lib/client-authentication-error.ts";
import { prepareLineAuthenticationContext } from "../lib/client-line-auth-lifecycle.ts";

const root = new URL("../", import.meta.url);
const authenticationGateSource = await readFile(
  new URL("app/authentication-gate.tsx", root),
  "utf8",
);

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source section: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source section boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("LINE login attempts trial preparation but does not depend on its success", async () => {
  const lineAuthentication = sourceSection(
    authenticationGateSource,
    "const authenticateWithLine",
    "const lineAvailable",
  );

  assert.doesNotMatch(lineAuthentication, /api\/session\/trial/);
  assert.match(
    lineAuthentication,
    /await prepareLineAuthenticationContext\(\s*ensureAuthenticationContext,\s*isTrialAlreadyIssuedAuthenticationError,\s*\)/,
  );
  assert.match(
    lineAuthentication,
    /catch \(cause\)[\s\S]*authenticationErrorMessage\([\s\S]*setBusy\(null\)/,
  );
  assert.match(lineAuthentication, /api\/account\/oauth\/line\/start/);
  assert.match(lineAuthentication, /window\.location\.assign\(startUrl\.toString\(\)\)/);
  assert.match(lineAuthentication, /popup\.location\.replace\(startUrl\.toString\(\)\)/);

  let attempts = 0;
  const ready = await prepareLineAuthenticationContext(
    async () => {
      attempts += 1;
    },
    isTrialAlreadyIssuedAuthenticationError,
  );
  assert.equal(ready, true);
  assert.equal(attempts, 1);

  const unavailable = await prepareLineAuthenticationContext(
    async () => {
      attempts += 1;
      throw new AuthenticationApiError("無料体験を開始済みです。", {
        status: 409,
        code: "trial_already_issued",
      });
    },
    isTrialAlreadyIssuedAuthenticationError,
  );
  assert.equal(unavailable, false);
  assert.equal(attempts, 2, "a rejected trial request must still be attempted once");

  for (const failure of [
    new TypeError("Failed to fetch"),
    new AuthenticationApiError("利用できません。", {
      status: 403,
      code: "trial_already_issued",
    }),
    new AuthenticationApiError("利用できません。", {
      status: 409,
      code: "different_conflict",
    }),
    new AuthenticationApiError("利用できません。", {
      status: 500,
      code: "trial_already_issued",
    }),
  ]) {
    await assert.rejects(
      prepareLineAuthenticationContext(
        async () => {
          throw failure;
        },
        isTrialAlreadyIssuedAuthenticationError,
      ),
      (cause) => cause === failure,
    );
  }
});

test("trial preparation remains available for app authentication that needs it", () => {
  const trialPreparation = sourceSection(
    authenticationGateSource,
    "const ensureAuthenticationContext",
    "const refreshAuthentication",
  );
  const passkeyAuthentication = sourceSection(
    authenticationGateSource,
    "const authenticateWithPasskey",
    "const authenticateWithLine",
  );

  assert.match(trialPreparation, /api\/session\/trial/);
  assert.match(passkeyAuthentication, /ensureAuthenticationContext/);
});

test("raw authentication errors are replaced with a safe Japanese message", () => {
  const fallback = "LINEログインを開始できませんでした。もう一度お試しください。";

  for (const raw of [
    "BadRequest",
    "Detail: BadRequest",
    "invalid_request",
    "Unexpected token 'P', Payload Too Large is not valid JSON",
    "<html>Internal Server Error</html>",
    new Error("BadRequest"),
    { detail: "BadRequest" },
  ]) {
    assert.equal(authenticationErrorMessage(raw, fallback), fallback);
  }

  assert.equal(
    authenticationErrorMessage(
      "通信状態を確認して、もう一度お試しください。",
      fallback,
    ),
    "通信状態を確認して、もう一度お試しください。",
  );
  assert.equal(
    authenticationErrorMessage("BadRequest：もう一度お試しください。", fallback),
    fallback,
  );
});

test("the authentication modal sanitizes API and caught errors", () => {
  assert.match(
    authenticationGateSource,
    /authenticationErrorMessage\(payload\?\.error, fallback\)/,
  );
  assert.match(authenticationGateSource, /status: response\.status/);
  assert.match(
    authenticationGateSource,
    /code: typeof payload\?\.code === "string" \? payload\.code : undefined/,
  );
  assert.doesNotMatch(
    authenticationGateSource,
    /cause instanceof Error\s*\?\s*cause\.message/,
  );
});
