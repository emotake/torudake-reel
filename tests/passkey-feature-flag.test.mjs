import assert from "node:assert/strict";
import test from "node:test";

let databaseAccesses = 0;
const runtimeEnv = {
  DB: {
    prepare() {
      databaseAccesses += 1;
      throw new Error("disabled passkey routes must not access D1");
    },
  },
  TRIAL_ISSUANCE_SECRET: "test-secret-with-at-least-thirty-two-characters",
};
globalThis.__cloudflareEnv = runtimeEnv;

const {
  authenticationOptions,
  deleteAccountPasskey,
  getAccountPasskeys,
  isPasskeyAuthenticationConfigured,
  renameAccountPasskey,
  reauthenticationOptions,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} = await import("../lib/account-auth.ts");
const { GET: authenticationMethods } = await import(
  "../app/api/account/auth/methods/route.ts"
);
const { POST: registrationOptionsRoute } = await import(
  "../app/api/account/passkey/register/options/route.ts"
);
const { POST: registrationVerifyRoute } = await import(
  "../app/api/account/passkey/register/verify/route.ts"
);
const { POST: loginOptionsRoute } = await import(
  "../app/api/account/passkey/login/options/route.ts"
);
const { POST: loginVerifyRoute } = await import(
  "../app/api/account/passkey/login/verify/route.ts"
);
const { POST: reauthenticationOptionsRoute } = await import(
  "../app/api/account/passkey/reauth/options/route.ts"
);
const {
  DELETE: deletePasskeyRoute,
  GET: listPasskeysRoute,
  PATCH: renamePasskeyRoute,
} = await import("../app/api/account/passkeys/route.ts");

const origin = "https://torudake-reel.pages.dev";

test("passkey authentication is disabled unless the flag is exactly true", () => {
  for (const value of [undefined, "false", "TRUE", "1", " true "]) {
    if (value === undefined) delete runtimeEnv.PASSKEY_AUTH_ENABLED;
    else runtimeEnv.PASSKEY_AUTH_ENABLED = value;
    assert.equal(isPasskeyAuthenticationConfigured(), false, String(value));
  }

  runtimeEnv.PASSKEY_AUTH_ENABLED = "true";
  assert.equal(isPasskeyAuthenticationConfigured(), true);
  delete runtimeEnv.PASSKEY_AUTH_ENABLED;
});

test("disabled passkey operations fail closed before reading D1 or challenges", async () => {
  delete runtimeEnv.PASSKEY_AUTH_ENABLED;
  databaseAccesses = 0;
  const request = new Request(`${origin}/api/account/passkey`);
  const operations = [
    () => registrationOptions(request),
    () => authenticationOptions(request),
    () => reauthenticationOptions(request),
    () => verifyRegistration(request, {}),
    () => verifyAuthentication(request, {}),
    () => getAccountPasskeys(request),
    () => renameAccountPasskey(request, undefined, undefined),
    () => deleteAccountPasskey(request, undefined),
  ];

  for (const operation of operations) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error?.code, "passkey_authentication_disabled");
      assert.equal(error?.status, 503);
      return true;
    });
  }
  assert.equal(databaseAccesses, 0);
});

test("the authentication-method response hides passkey while disabled", async () => {
  delete runtimeEnv.PASSKEY_AUTH_ENABLED;
  const response = await authenticationMethods(
    new Request(`${origin}/api/account/auth/methods`),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).passkey, false);
});

test("every public passkey endpoint returns a private 503 while disabled", async () => {
  delete runtimeEnv.PASSKEY_AUTH_ENABLED;
  const routes = [
    [registrationOptionsRoute, "/api/account/passkey/register/options", undefined],
    [registrationVerifyRoute, "/api/account/passkey/register/verify", { credential: {} }],
    [loginOptionsRoute, "/api/account/passkey/login/options", undefined],
    [loginVerifyRoute, "/api/account/passkey/login/verify", {}],
    [reauthenticationOptionsRoute, "/api/account/passkey/reauth/options", undefined],
  ];

  for (const [route, path, body] of routes) {
    const response = await route(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: {
          origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("cache-control"), "private, no-store", path);
    assert.equal((await response.json()).code, "passkey_authentication_disabled", path);
  }
});

test("disabled verification endpoints reject before parsing request JSON", async () => {
  delete runtimeEnv.PASSKEY_AUTH_ENABLED;
  const routes = [
    [registrationVerifyRoute, "/api/account/passkey/register/verify"],
    [loginVerifyRoute, "/api/account/passkey/login/verify"],
  ];

  for (const [route, path] of routes) {
    const response = await route(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{malformed",
      }),
    );
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).code, "passkey_authentication_disabled", path);
  }
});

test("disabled passkey management methods return 503 before body or D1 access", async () => {
  delete runtimeEnv.PASSKEY_AUTH_ENABLED;
  databaseAccesses = 0;
  const routes = [
    [listPasskeysRoute, "GET"],
    [renamePasskeyRoute, "PATCH"],
    [deletePasskeyRoute, "DELETE"],
  ];

  for (const [route, method] of routes) {
    const response = await route(
      new Request(`${origin}/api/account/passkeys`, {
        method,
        headers: {
          origin,
          ...(method === "GET" ? {} : { "content-type": "application/json" }),
        },
        body: method === "GET" ? undefined : "{malformed",
      }),
    );
    assert.equal(response.status, 503, method);
    assert.equal(response.headers.get("cache-control"), "private, no-store", method);
    assert.equal((await response.json()).code, "passkey_authentication_disabled", method);
  }
  assert.equal(databaseAccesses, 0);
});

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
