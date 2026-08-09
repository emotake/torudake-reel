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

test("keeps billing enforcement independent from the OpenAI key", () => {
  assert.equal(isUsageEnforcementEnabled(), true);
  assert.equal(isManagedUploadEnforcementEnabled(), true);

  runtimeEnv.OPENAI_API_KEY = "test-key";
  assert.equal(isUsageEnforcementEnabled(), true);

  runtimeEnv.USAGE_ENFORCEMENT_TEST_MODE = "codex-test-only";
  assert.equal(isUsageEnforcementEnabled(), false);
  assert.equal(isManagedUploadEnforcementEnabled(), false);
});
