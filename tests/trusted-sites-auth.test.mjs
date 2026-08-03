import assert from "node:assert/strict";
import test from "node:test";

globalThis.__cloudflareEnv = {
  TRUST_SITES_AUTH_HEADERS: "true",
};

const { getCurrentUser, isSitesAuthenticationTrusted } = await import(
  "../lib/current-user.ts"
);

test("accepts dispatcher identity only after environment-side opt-in", () => {
  const request = new Request("https://workspace.example.test/account", {
    headers: {
      "oai-authenticated-user-email": " Person@Example.COM ",
      "oai-authenticated-user-full-name": "%E5%B1%B1%E7%94%B0%20%E5%A4%AA%E9%83%8E",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });

  assert.equal(isSitesAuthenticationTrusted(), true);
  assert.deepEqual(getCurrentUser(request), {
    email: "person@example.com",
    fullName: "山田 太郎",
  });
});

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
