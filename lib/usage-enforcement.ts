import { env } from "cloudflare:workers";

type UsageEnvironment = {
  OPENAI_API_KEY?: string;
  USAGE_ENFORCEMENT_TEST_MODE?: string;
};

export function isUsageEnforcementEnabled() {
  const usageEnv = env as typeof env & UsageEnvironment;
  if (usageEnv.USAGE_ENFORCEMENT_TEST_MODE === "codex-test-only") {
    return false;
  }
  return Boolean(usageEnv.OPENAI_API_KEY?.trim());
}

export function isManagedUploadEnforcementEnabled() {
  const usageEnv = env as typeof env & UsageEnvironment;
  return usageEnv.USAGE_ENFORCEMENT_TEST_MODE !== "codex-test-only";
}
