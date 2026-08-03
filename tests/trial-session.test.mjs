import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentUser } from "../lib/current-user.ts";
import {
  getTrialSessionId,
  trialSessionCookie,
} from "../lib/trial-session.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("creates a secure first-party trial session cookie", () => {
  const cookie = trialSessionCookie(sessionId, true);
  assert.match(cookie, /^torudake_trial_id=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
});

test("does not turn an unverified trial cookie into a current user", async () => {
  const request = new Request("https://torudake-reel.pages.dev/", {
    headers: {
      cookie: `another=value; torudake_trial_id=${sessionId}`,
    },
  });

  assert.equal(getTrialSessionId(request), sessionId);
  assert.equal(await getCurrentUser(request), null);
  assert.equal(await getCurrentUser(request), null);
});

test("rejects malformed trial session cookies", async () => {
  const request = new Request("https://torudake-reel.pages.dev/", {
    headers: { cookie: "torudake_trial_id=not-a-session" },
  });
  assert.equal(getTrialSessionId(request), null);
  assert.equal(await getCurrentUser(request), null);
});

test("does not trust public client-supplied Sites identity headers", async () => {
  const request = new Request("https://torudake-reel.pages.dev/account", {
    headers: {
      "oai-authenticated-user-email": "victim@example.com",
      "oai-authenticated-user-full-name": "Victim%20User",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });

  assert.equal(await getCurrentUser(request), null);
});
