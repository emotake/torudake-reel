import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  deauthorizeLineAuthorization,
  LINE_DEAUTHORIZATION_ENDPOINTS,
} from "../lib/line-deauthorization.ts";

const credentials = {
  channelId: "1234567890",
  channelSecret: "line-channel-secret-value",
  userAccessToken: "line-user-access-token-value",
};

test("LINE authorization is removed with ephemeral tokens and fixed endpoints", async () => {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input: String(input), init });
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.signal instanceof AbortSignal, true);
    if (calls.length === 1) {
      assert.equal(String(input), LINE_DEAUTHORIZATION_ENDPOINTS.channelToken);
      assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
      assert.equal(init.body.get("grant_type"), "client_credentials");
      assert.equal(init.body.get("client_id"), credentials.channelId);
      assert.equal(init.body.get("client_secret"), credentials.channelSecret);
      assert.equal(init.body.has("userAccessToken"), false);
      return Response.json({
        access_token: "stateless-channel-access-token",
        token_type: "Bearer",
        expires_in: 900,
      });
    }

    assert.equal(String(input), LINE_DEAUTHORIZATION_ENDPOINTS.deauthorize);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(
      init.headers.Authorization,
      "Bearer stateless-channel-access-token",
    );
    assert.deepEqual(JSON.parse(init.body), {
      userAccessToken: credentials.userAccessToken,
    });
    assert.equal(init.body.includes(credentials.channelSecret), false);
    return new Response(null, { status: 204 });
  };

  await deauthorizeLineAuthorization(credentials, fetcher);
  assert.equal(calls.length, 2);
});

test("LINE deauthorization fails closed without exposing credentials", async () => {
  const fetcher = async (input) => {
    if (String(input) === LINE_DEAUTHORIZATION_ENDPOINTS.channelToken) {
      return Response.json({
        access_token: "stateless-channel-access-token",
        token_type: "Bearer",
        expires_in: 900,
      });
    }
    return Response.json({ message: credentials.userAccessToken }, { status: 400 });
  };

  await assert.rejects(
    deauthorizeLineAuthorization(credentials, fetcher),
    (error) => {
      assert.equal(error?.code, "line_deauthorization_rejected");
      assert.equal(error?.message.includes(credentials.userAccessToken), false);
      assert.equal(error?.message.includes(credentials.channelSecret), false);
      return true;
    },
  );
});

test("LINE provider responses are read with a hard byte limit", async () => {
  let cancelled = false;
  const fetcher = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10 * 1024));
          controller.enqueue(new Uint8Array(7 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  await assert.rejects(
    deauthorizeLineAuthorization(credentials, fetcher),
    (error) => error?.code === "line_provider_response_too_large",
  );
  assert.equal(cancelled, true);
});

test("LINE is deauthorized after ID-token verification but before local mutation", async () => {
  const [source, accountAuthSource, deletionRoute] = await Promise.all([
    readFile(new URL("../lib/oidc-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/account-auth.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/account/deletion/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const verification = source.indexOf("const claims =");
  const deauthorization = source.indexOf("await deauthorizeLineAuthorization(");
  const subjectHash = source.indexOf("const subjectHash =", verification);
  const identityMutation = source.indexOf("const identity =", subjectHash);

  assert.ok(verification >= 0);
  assert.ok(deauthorization > verification);
  assert.ok(subjectHash > deauthorization);
  assert.ok(identityMutation > subjectHash);
  assert.match(
    source,
    /getAccountIdentity\(request, \{\s*touchLastSeen: false,?\s*\}\)/,
  );
  assert.match(
    source.slice(verification, subjectHash),
    /if \(provider === "line"\)[\s\S]*?await deauthorizeLineAuthorization/,
  );
  assert.match(accountAuthSource, /initiatingSession \? now : null/);
  assert.match(
    deletionRoute,
    /requireDeletionReauthentication\(request, session\.userId\)/,
  );
  assert.match(
    deletionRoute,
    /requireRecentAccountReauthentication\(request, userId\)/,
  );
  assert.match(deletionRoute, /"reauthentication_required"/);
});
