import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildOidcAuthorizationUrl,
  createOidcTransactionSecrets,
  exchangeOidcAuthorizationCode,
  normalizeOidcReturnTo,
  OIDC_ENDPOINTS,
  sha256Base64Url,
  verifyGoogleIdToken,
  verifyLineIdToken,
} from "../lib/oidc-core.ts";
import {
  isOidcProviderConfigured,
  oidcRedirectUri,
  oidcStateCookie,
} from "../lib/oidc-auth.ts";

const canonicalOrigin = "https://torudake-reel.pages.dev";

test("returnTo accepts only explicitly allowlisted same-site pages", () => {
  assert.equal(normalizeOidcReturnTo("/video-mix?draft=abc#ignored"), "/video-mix?draft=abc");
  assert.equal(normalizeOidcReturnTo("/account?tab=security"), "/account?tab=security");
  assert.equal(normalizeOidcReturnTo("https://evil.example/"), "/account");
  assert.equal(normalizeOidcReturnTo("//evil.example/"), "/account");
  assert.equal(normalizeOidcReturnTo("/\\evil.example/"), "/account");
  assert.equal(normalizeOidcReturnTo("/%2f%2fevil.example"), "/account");
  assert.equal(normalizeOidcReturnTo("/internal/device-access-7k9m2p"), "/account");
});

test("authorization requests always contain state, nonce and S256 PKCE", async () => {
  const values = await createOidcTransactionSecrets();
  assert.match(values.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(values.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.match(values.pkceVerifier, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(values.pkceChallenge, await sha256Base64Url(values.pkceVerifier));

  for (const provider of ["line", "google"]) {
    const config = {
      provider,
      clientId: provider === "line" ? "1234567890" : "client.apps.googleusercontent.com",
      clientSecret: "secret-value-not-exposed",
      canonicalOrigin,
    };
    const url = buildOidcAuthorizationUrl(config, values);
    assert.equal(url.origin + url.pathname, OIDC_ENDPOINTS[provider].authorization);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), values.state);
    assert.equal(url.searchParams.get("nonce"), values.nonce);
    assert.equal(url.searchParams.get("code_challenge"), values.pkceChallenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), oidcRedirectUri(provider, canonicalOrigin));
    assert.equal(url.searchParams.has("client_secret"), false);
  }
});

test("authorization code exchange sends PKCE verifier only to the fixed token endpoint", async () => {
  const config = {
    provider: "google",
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "google-client-secret",
    canonicalOrigin,
  };
  const verifier = "a".repeat(64);
  let captured;
  const fetcher = async (input, init) => {
    captured = { input: String(input), init };
    return Response.json({
      access_token: "access-token-value",
      id_token: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`,
      token_type: "Bearer",
    });
  };
  const result = await exchangeOidcAuthorizationCode(
    config,
    { code: "authorization-code-value", pkceVerifier: verifier },
    fetcher,
  );
  assert.equal(captured.input, OIDC_ENDPOINTS.google.token);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "error");
  const body = captured.init.body;
  assert.equal(body.get("code_verifier"), verifier);
  assert.equal(body.get("redirect_uri"), oidcRedirectUri("google", canonicalOrigin));
  assert.equal(body.get("client_secret"), config.clientSecret);
  assert.equal(result.accessToken, "access-token-value");
});

test("LINE identity is accepted only after server-side verify response claim checks", async () => {
  const now = 2_000_000_000;
  const nonce = "n".repeat(43);
  let postedBody;
  const fetcher = async (input, init) => {
    assert.equal(String(input), OIDC_ENDPOINTS.line.verification);
    postedBody = init.body;
    return Response.json({
      iss: "https://access.line.me",
      sub: "U1234567890abcdef1234567890abcdef",
      aud: "1234567890",
      exp: now + 3_600,
      iat: now,
      nonce,
    });
  };
  const identity = await verifyLineIdToken(
    {
      idToken: "aaa.bbb.ccc",
      nonce,
      clientId: "1234567890",
      nowSeconds: now,
    },
    fetcher,
  );
  assert.equal(identity.subject, "U1234567890abcdef1234567890abcdef");
  assert.equal(identity.verifiedEmail, null);
  assert.equal(postedBody.get("client_id"), "1234567890");
  assert.equal(postedBody.get("nonce"), nonce);

  await assert.rejects(
    verifyLineIdToken(
      {
        idToken: "aaa.bbb.ccc",
        nonce: "x".repeat(43),
        clientId: "1234567890",
        nowSeconds: now,
      },
      fetcher,
    ),
    (error) => error?.code === "invalid_id_token_nonce",
  );
});

test("Google ID token signature, claims, nonce and at_hash are verified locally", async () => {
  const now = 2_000_000_000;
  const nonce = "g".repeat(43);
  const clientId = "client.apps.googleusercontent.com";
  const accessToken = "google-access-token";
  const authorizationCode = "google-authorization-code";
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  Object.assign(publicJwk, { kid: "test-key", use: "sig", alg: "RS256" });
  const idToken = await signedGoogleIdToken(keyPair.privateKey, {
    iss: "https://accounts.google.com",
    sub: "10769150350006150715113082367",
    aud: clientId,
    azp: clientId,
    exp: now + 3_600,
    iat: now,
    nonce,
    at_hash: await oidcHalfHash(accessToken),
    email: "user@example.com",
    email_verified: true,
  });
  let jwksRequests = 0;
  const fetcher = async (input) => {
    assert.equal(String(input), "https://keys.test/jwks");
    jwksRequests += 1;
    return Response.json(
      { keys: [publicJwk] },
      { headers: { "Cache-Control": "public, max-age=300" } },
    );
  };
  const identity = await verifyGoogleIdToken(
    {
      idToken,
      accessToken,
      authorizationCode,
      nonce,
      clientId,
      nowSeconds: now,
      jwksUri: "https://keys.test/jwks",
    },
    fetcher,
  );
  assert.equal(jwksRequests, 1);
  assert.equal(identity.subject, "10769150350006150715113082367");
  assert.equal(identity.verifiedEmail, "user@example.com");

  await assert.rejects(
    verifyGoogleIdToken(
      {
        idToken,
        accessToken,
        authorizationCode,
        nonce: "z".repeat(43),
        clientId,
        nowSeconds: now,
        jwksUri: "https://keys.test/jwks",
      },
      fetcher,
    ),
    (error) => error?.code === "invalid_id_token_nonce",
  );
  await assert.rejects(
    verifyGoogleIdToken(
      {
        idToken,
        accessToken: "substituted-access-token",
        authorizationCode,
        nonce,
        clientId,
        nowSeconds: now,
        jwksUri: "https://keys.test/jwks",
      },
      fetcher,
    ),
    (error) => error?.code === "id_token_hash_mismatch",
  );
});

test("OIDC remains disabled until every feature gate and credential exists", () => {
  const database = {
    prepare() {},
    batch() {},
  };
  const complete = {
    DB: database,
    OIDC_AUTH_ENABLED: "true",
    OIDC_CANONICAL_ORIGIN: canonicalOrigin,
    OIDC_AUTH_SECRET: "s".repeat(32),
    LINE_LOGIN_ENABLED: "true",
    LINE_LOGIN_CHANNEL_ID: "1234567890",
    LINE_LOGIN_CHANNEL_SECRET: "l".repeat(32),
    GOOGLE_OIDC_ENABLED: "true",
    GOOGLE_OIDC_CLIENT_ID: "client.apps.googleusercontent.com",
    GOOGLE_OIDC_CLIENT_SECRET: "google-client-secret",
  };
  assert.equal(isOidcProviderConfigured("line", complete), true);
  assert.equal(isOidcProviderConfigured("google", complete), true);
  assert.equal(
    isOidcProviderConfigured("line", { ...complete, LINE_LOGIN_CHANNEL_SECRET: undefined }),
    false,
  );
  assert.equal(
    isOidcProviderConfigured("google", { ...complete, OIDC_AUTH_ENABLED: "false" }),
    false,
  );
  assert.equal(
    isOidcProviderConfigured("google", { ...complete, OIDC_CANONICAL_ORIGIN: "https://evil.test/path" }),
    false,
  );
});

test("state cookie is HttpOnly, host-only on HTTPS and usable on top-level callback", () => {
  const cookie = oidcStateCookie("line", "a".repeat(43), true, 600);
  assert.match(cookie, /^__Host-torudake_oidc_line=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=600/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/);
});

test("source keeps state one-time and provider subject authoritative", async () => {
  const source = await readFile(new URL("../lib/oidc-auth.ts", import.meta.url), "utf8");
  const callbackRoute = await readFile(
    new URL("../app/api/account/oauth/google/callback/route.ts", import.meta.url),
    "utf8",
  );
  const finalizeRoute = await readFile(
    new URL(
      "../app/api/account/oauth/google/callback/finalize/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const externalSource = await readFile(
    new URL("../lib/external-account-auth.ts", import.meta.url),
    "utf8",
  );
  const transferSource = await readFile(
    new URL("../lib/anonymous-trial-account-transfer.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /SET consumed_at = \?/);
  assert.match(source, /consumed_at IS NULL/);
  assert.match(externalSource, /subject_hash = \?/);
  assert.match(externalSource, /without consulting email/i);
  assert.doesNotMatch(externalSource, /WHERE\s+verified_email\s*=\s*\?/i);
  assert.match(externalSource, /anonymousTrialAccountTransferStatements/);
  assert.match(transferSource, /UPDATE usage_reservations\s+SET user_id = \?/i);
  assert.match(transferSource, /bucket != 'free'/);
  assert.match(source, /createAccountSession\(/);
  assert.match(source, /trial\?\.userId \?\? null/);
  assert.match(source, /transaction\.initiating_user_id\s*\?/);
  assert.match(source, /auth_popup=pending/);
  assert.match(source, /window\.close\(\)/);
  assert.match(source, /request\.method !== "POST"/);
  assert.match(source, /oidcCallbackUrlFromForm\(request\)/);
  assert.match(source, /hashAccountToken\(currentSessionToken\)/);
  assert.match(callbackRoute, /oidcCallbackFinalizationPage/);
  assert.doesNotMatch(callbackRoute, /completeOidcAuthorization/);
  assert.match(finalizeRoute, /isSameOriginMutation\(request\)/);
  assert.match(finalizeRoute, /completeOidcAuthorization/);
});

async function signedGoogleIdToken(privateKey, payload) {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

async function oidcHalfHash(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return base64Url(digest.slice(0, digest.length / 2));
}

function base64UrlJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
