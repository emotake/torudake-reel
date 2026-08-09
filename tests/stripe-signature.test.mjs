import assert from "node:assert/strict";
import test from "node:test";

import {
  isCanonicalBillingRequest,
  publicOrigin,
  verifyStripeSignature,
} from "../lib/stripe.ts";

async function signatureFor(payload, timestamp, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

test("verifies the unmodified Stripe webhook body", async () => {
  const payload = '{"id":"evt_test","type":"checkout.session.completed"}';
  const timestamp = 1_800_000_000;
  const secret = "whsec_test";
  const signature = await signatureFor(payload, timestamp, secret);

  assert.equal(
    await verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${signature}`,
      secret,
      timestamp,
    ),
    true,
  );
  assert.equal(
    await verifyStripeSignature(
      `${payload} `,
      `t=${timestamp},v1=${signature}`,
      secret,
      timestamp,
    ),
    false,
  );
});

test("rejects Stripe webhook signatures outside the tolerance", async () => {
  const payload = "{}";
  const timestamp = 1_800_000_000;
  const secret = "whsec_test";
  const signature = await signatureFor(payload, timestamp, secret);

  assert.equal(
    await verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${signature}`,
      secret,
      timestamp + 301,
    ),
    false,
  );
});

test("rejects malformed timestamps and non-hex v1 signatures", async () => {
  const payload = "{}";
  const timestamp = 1_800_000_000;
  const secret = "whsec_test";
  const signature = await signatureFor(payload, timestamp, secret);

  assert.equal(
    await verifyStripeSignature(
      payload,
      `t=${timestamp}.5,v1=${signature}`,
      secret,
      timestamp,
    ),
    false,
  );
  assert.equal(
    await verifyStripeSignature(
      payload,
      `t=${timestamp},v1=${"z".repeat(64)}`,
      secret,
      timestamp,
    ),
    false,
  );
});

test("does not build Stripe return URLs from client-supplied proxy headers", () => {
  const request = new Request("https://torudake-reel.pages.dev/api/billing/checkout", {
    headers: {
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
  });

  assert.equal(publicOrigin(request), "https://torudake-reel.pages.dev");
});

test("allows billing only from the canonical public host or local development", () => {
  assert.equal(
    isCanonicalBillingRequest(
      new Request("https://torudake-reel.pages.dev/api/billing/checkout"),
    ),
    true,
  );
  assert.equal(
    isCanonicalBillingRequest(
      new Request("https://old-deployment.torudake-reel.pages.dev/api/billing/checkout"),
    ),
    false,
  );
  assert.equal(
    isCanonicalBillingRequest(
      new Request("http://localhost:3000/api/billing/checkout"),
    ),
    true,
  );
});
