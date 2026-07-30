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

test("uses the trial session only when an editing route allows it", () => {
  const request = new Request("https://torudake-reel.pages.dev/", {
    headers: {
      cookie: `another=value; torudake_trial_id=${sessionId}`,
    },
  });

  assert.equal(getTrialSessionId(request), sessionId);
  assert.equal(getCurrentUser(request), null);
  assert.deepEqual(getCurrentUser(request, { allowTrial: true }), {
    email: `trial-${sessionId}@anonymous.torudake.invalid`,
    fullName: null,
  });
});

test("rejects malformed trial session cookies", () => {
  const request = new Request("https://torudake-reel.pages.dev/", {
    headers: { cookie: "torudake_trial_id=not-a-session" },
  });
  assert.equal(getTrialSessionId(request), null);
  assert.equal(getCurrentUser(request, { allowTrial: true }), null);
});

test("serves the trial session endpoint instead of a Not Found response", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("trial-session", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("https://torudake-reel.pages.dev/api/session/trial", {
      method: "POST",
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
  assert.match(
    response.headers.get("set-cookie") ?? "",
    /^torudake_trial_id=/,
  );
});
