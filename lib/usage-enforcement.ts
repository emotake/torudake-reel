import { env } from "cloudflare:workers";

type UsageEnvironment = {
  USAGE_ENFORCEMENT_TEST_MODE?: string;
};

function isNodeTestRuntime() {
  const runtimeProcess = (
    globalThis as typeof globalThis & {
      process?: {
        argv?: string[];
        env?: Record<string, string | undefined>;
      };
    }
  ).process;
  return (
    runtimeProcess?.env?.NODE_ENV === "test" ||
    runtimeProcess?.env?.NODE_TEST_CONTEXT !== undefined ||
    runtimeProcess?.argv?.includes("--test") === true
  );
}

function isLocalTestRequest(request?: Request) {
  if (!request) return false;
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".test") ||
      hostname.endsWith(".invalid")
    );
  } catch {
    return false;
  }
}

function testBypassIsSafe(request?: Request) {
  return isNodeTestRuntime() || isLocalTestRequest(request);
}

export function isUsageEnforcementEnabled(request?: Request) {
  const usageEnv = env as typeof env & UsageEnvironment;
  if (
    usageEnv.USAGE_ENFORCEMENT_TEST_MODE === "codex-test-only" &&
    testBypassIsSafe(request)
  ) {
    return false;
  }
  return true;
}

export function isManagedUploadEnforcementEnabled(request?: Request) {
  const usageEnv = env as typeof env & UsageEnvironment;
  return !(
    usageEnv.USAGE_ENFORCEMENT_TEST_MODE === "codex-test-only" &&
    testBypassIsSafe(request)
  );
}
