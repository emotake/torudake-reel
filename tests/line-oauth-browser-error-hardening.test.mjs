import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  oidcBrowserErrorResponse,
} from "../lib/oidc-auth.ts";

const root = new URL("../", import.meta.url);

test("LINE OAuth navigation failures render a private Japanese page without provider details", async () => {
  const response = oidcBrowserErrorResponse(
    new Request(
      "https://torudake-reel.pages.dev/api/account/oauth/line/start?returnTo=%2Faccount",
      { headers: { Accept: "text/html,application/xhtml+xml" } },
    ),
    new Error("BadRequest detail=provider-secret access_token=must-not-appear"),
    "start",
  );

  assert.equal(response.status, 500);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/u);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-torudake-auth-code"), "oidc_authentication_failed");
  assert.equal(response.headers.get("x-torudake-auth-trust"), "untrusted");

  const body = await response.text();
  assert.match(body, /LINEログインを開始できませんでした/u);
  assert.match(body, /href="\/account"/u);
  assert.doesNotMatch(body, /BadRequest|provider-secret|access_token|must-not-appear/u);
  assert.doesNotMatch(body, /application\/json|<pre/iu);
});

test("LINE OAuth popup start failures notify the opener without exposing provider details", async () => {
  const flowId = "123e4567-e89b-42d3-a456-426614174000";
  const response = oidcBrowserErrorResponse(
    new Request(
      `https://torudake-reel.pages.dev/api/account/oauth/line/start?popup=1&popupFlow=${flowId}`,
      { headers: { "Sec-Fetch-Mode": "navigate" } },
    ),
    new Error("Bad Request: upstream detail must-not-escape"),
    "start",
  );

  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /torudake:oidc-result/u);
  assert.match(body, /"outcome":"failed"/u);
  assert.match(body, new RegExp(flowId, "u"));
  assert.doesNotMatch(body, /Bad Request|upstream detail|must-not-escape/u);
});

test("non-navigation callers retain the existing private JSON error contract", async () => {
  const response = oidcBrowserErrorResponse(
    new Request("https://torudake-reel.pages.dev/api/account/oauth/line/start"),
    new Error("provider detail must-not-escape"),
    "start",
  );

  assert.equal(response.status, 500);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
  assert.deepEqual(await response.json(), {
    error: "ログインを開始できませんでした。時間をおいてもう一度お試しください。",
    code: "oidc_authentication_failed",
  });
});

test("all LINE OAuth browser routes use the hardened response on exceptional paths", async () => {
  const [start, callback, finalize] = await Promise.all([
    readFile(new URL("app/api/account/oauth/line/start/route.ts", root), "utf8"),
    readFile(new URL("app/api/account/oauth/line/callback/route.ts", root), "utf8"),
    readFile(
      new URL("app/api/account/oauth/line/callback/finalize/route.ts", root),
      "utf8",
    ),
  ]);

  for (const source of [start, callback, finalize]) {
    assert.match(source, /oidcBrowserErrorResponse/u);
  }
  assert.doesNotMatch(start, /oidcAuthErrorResponse/u);
  assert.doesNotMatch(callback, /oidcAuthErrorResponse/u);
  assert.doesNotMatch(finalize, /oidcAuthErrorResponse|privateJson/u);
  assert.match(finalize, /invalid_request_origin/u);
});
