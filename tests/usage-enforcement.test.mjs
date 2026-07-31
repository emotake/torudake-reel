import assert from "node:assert/strict";
import test from "node:test";

const runtimeEnv = {};
globalThis.__cloudflareEnv = runtimeEnv;
const { isUsageEnforcementEnabled } = await import(
  "../lib/usage-enforcement.ts"
);

test("enforces usage whenever a paid OpenAI key is live", () => {
  assert.equal(isUsageEnforcementEnabled(), false);

  runtimeEnv.OPENAI_API_KEY = "test-key";
  assert.equal(isUsageEnforcementEnabled(), true);

  runtimeEnv.USAGE_ENFORCEMENT_TEST_MODE = "codex-test-only";
  assert.equal(isUsageEnforcementEnabled(), false);
});
