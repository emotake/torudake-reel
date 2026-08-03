import assert from "node:assert/strict";
import test from "node:test";

import {
  isDurationWithinReservation,
  narrationScriptCharacterLimit,
  usageDurationToleranceSeconds,
} from "../lib/usage-duration.ts";

test("applies one small bounded duration tolerance", () => {
  assert.equal(usageDurationToleranceSeconds(1), 1);
  assert.equal(usageDurationToleranceSeconds(60), 1.2);
  assert.equal(usageDurationToleranceSeconds(600), 3);
  assert.equal(isDurationWithinReservation(2, 1), true);
  assert.equal(isDurationWithinReservation(2.001, 1), false);
  assert.equal(isDurationWithinReservation(63.001, 60), false);
});

test("bounds narration text by the reserved video duration", () => {
  assert.equal(narrationScriptCharacterLimit(1), 30);
  assert.equal(narrationScriptCharacterLimit(30), 189);
  assert.equal(narrationScriptCharacterLimit(60), 354);
  assert.equal(narrationScriptCharacterLimit(3_600), 2_000);
});
