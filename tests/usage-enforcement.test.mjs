import assert from "node:assert/strict";
import test from "node:test";

const runtimeEnv = {};
globalThis.__cloudflareEnv = runtimeEnv;
const {
  isManagedUploadEnforcementEnabled,
  isUsageEnforcementEnabled,
} = await import(
  "../lib/usage-enforcement.ts"
);

test("enforces usage whenever a paid OpenAI key is live", () => {
  assert.equal(isUsageEnforcementEnabled(), false);
  assert.equal(isManagedUploadEnforcementEnabled(), true);

  runtimeEnv.OPENAI_API_KEY = "test-key";
  assert.equal(isUsageEnforcementEnabled(), true);

  runtimeEnv.USAGE_ENFORCEMENT_TEST_MODE = "codex-test-only";
  assert.equal(isUsageEnforcementEnabled(), false);
  assert.equal(isManagedUploadEnforcementEnabled(), false);
});
