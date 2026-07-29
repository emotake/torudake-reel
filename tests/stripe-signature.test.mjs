import assert from "node:assert/strict";
import test from "node:test";

import { verifyStripeSignature } from "../lib/stripe.ts";

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
