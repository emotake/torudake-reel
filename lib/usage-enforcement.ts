import { env } from "cloudflare:workers";

type UsageEnvironment = {
  USAGE_ENFORCEMENT_TEST_MODE?: string;
};

export function isUsageEnforcementEnabled() {
  const usageEnv = env as typeof env & UsageEnvironment;
  if (usageEnv.USAGE_ENFORCEMENT_TEST_MODE === "codex-test-only") {
    return false;
  }
  return true;
}

export function isManagedUploadEnforcementEnabled() {
  const usageEnv = env as typeof env & UsageEnvironment;
  return usageEnv.USAGE_ENFORCEMENT_TEST_MODE !== "codex-test-only";
}
