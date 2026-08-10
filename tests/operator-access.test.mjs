import assert from "node:assert/strict";
import test from "node:test";

import {
  clearOperatorSessionCookie,
  getOperatorSessionToken,
  isSameOriginMutation,
  normalizeOperatorLabel,
  OPERATOR_COOKIE_NAME,
  operatorSessionCookie,
} from "../lib/operator-session.ts";

const operatorToken = "ab".repeat(32);

test("creates a private secure operator session cookie", () => {
  const cookie = operatorSessionCookie(operatorToken, true);
  assert.match(cookie, new RegExp(`^${OPERATOR_COOKIE_NAME}=`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /operator-device@/);
});

test("reads only a valid operator token from cookies", () => {
  const request = new Request("https://torudake-reel.pages.dev/", {
    headers: {
      cookie: `other=value; ${OPERATOR_COOKIE_NAME}=${operatorToken}`,
    },
  });
  assert.equal(getOperatorSessionToken(request), operatorToken);

  const malformed = new Request("https://torudake-reel.pages.dev/", {
    headers: { cookie: `${OPERATOR_COOKIE_NAME}=short` },
  });
  assert.equal(getOperatorSessionToken(malformed), null);
});

test("clears the same secure operator cookie", () => {
  const cookie = clearOperatorSessionCookie(true);
  assert.match(cookie, new RegExp(`^${OPERATOR_COOKIE_NAME}=`));
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
});

test("accepts mutations only from the exact page origin", () => {
  const accepted = new Request(
    "https://torudake-reel.pages.dev/api/operator/enroll",
    { headers: { origin: "https://torudake-reel.pages.dev" } },
  );
  const rejected = new Request(
    "https://torudake-reel.pages.dev/api/operator/enroll",
    { headers: { origin: "https://example.com" } },
  );
  const missing = new Request(
    "https://torudake-reel.pages.dev/api/operator/enroll",
  );

  assert.equal(isSameOriginMutation(accepted), true);
  assert.equal(isSameOriginMutation(rejected), false);
  assert.equal(isSameOriginMutation(missing), false);
});

test("normalizes a short human-readable device label", () => {
  assert.equal(
    normalizeOperatorLabel("  iPhone   Safari  "),
    "iPhone Safari",
  );
  assert.equal(normalizeOperatorLabel(""), "運営端末");
  assert.equal(normalizeOperatorLabel("a".repeat(80)).length, 40);
});
