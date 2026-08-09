import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialNarrationToken,
  verifyInitialNarrationToken,
} from "../lib/narration-initial.ts";

const secret = "test-only-initial-narration-secret";
const now = 2_000_000_000;
const expectation = {
  reservationId: "reservation-initial-1",
  actionId: "initial_action_1234",
  script: "今日の景色を、自然な声で紹介します。",
  style: "calm",
  targetDurationSeconds: 30,
};

test("signs an initial narration bundle for one exact reservation and payload", async () => {
  const token = await createInitialNarrationToken(
    secret,
    expectation,
    1,
    now,
  );
  const claims = await verifyInitialNarrationToken(
    secret,
    token,
    expectation,
    now + 899,
  );

  assert.ok(claims);
  assert.equal(claims.r, expectation.reservationId);
  assert.equal(claims.a, expectation.actionId);
  assert.equal(claims.n, 1);
  assert.equal(claims.s, expectation.style);
  assert.equal(claims.d, 30_000);
});

test("rejects tampered and expired initial narration bundle tokens", async () => {
  const token = await createInitialNarrationToken(
    secret,
    expectation,
    3,
    now,
  );
  const [claims, signature] = token.split(".");
  const tamperedSignature = `${signature.slice(0, -1)}${
    signature.endsWith("A") ? "B" : "A"
  }`;

  assert.equal(
    await verifyInitialNarrationToken(
      secret,
      `${claims}.${tamperedSignature}`,
      expectation,
      now + 1,
    ),
    null,
  );
  assert.equal(
    await verifyInitialNarrationToken(secret, token, expectation, now + 900),
    null,
    "the 15-minute token is invalid at its expiry boundary",
  );
  assert.equal(
    await verifyInitialNarrationToken(
      "different-secret",
      token,
      expectation,
      now + 1,
    ),
    null,
  );
});

test("binds the initial narration token to reservation, action, script, style, and duration", async () => {
  const token = await createInitialNarrationToken(
    secret,
    expectation,
    1,
    now,
  );
  const mismatches = [
    { reservationId: "reservation-initial-2" },
    { actionId: "initial_action_9999" },
    { script: "同じ映像を、別の台本で紹介します。" },
    { style: "bright" },
    { targetDurationSeconds: 31 },
  ];

  for (const mismatch of mismatches) {
    assert.equal(
      await verifyInitialNarrationToken(
        secret,
        token,
        { ...expectation, ...mismatch },
        now + 1,
      ),
      null,
      `must reject a mismatched ${Object.keys(mismatch)[0]}`,
    );
  }
});
