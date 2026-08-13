import process from "node:process";

const DEFAULT_ORIGIN = "https://torudake-reel.pages.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

export function normalizeOrigin(value) {
  const normalized = String(value || DEFAULT_ORIGIN).replace(/\/$/u, "");
  if (!ORIGIN_PATTERN.test(normalized)) {
    throw new Error("Synthetic readiness requires an explicit HTTPS origin.");
  }
  return normalized;
}

export async function checkReadiness({
  origin = process.env.SYNTHETIC_ORIGIN,
  secret = process.env.OPS_HEALTH_SECRET,
  detailed = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const safeOrigin = normalizeOrigin(origin);
  if (detailed && (!secret || secret.length < 32)) {
    throw new Error("Detailed readiness requires OPS_HEALTH_SECRET (32+ characters).");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${safeOrigin}${detailed ? "/api/internal/health" : "/api/health"}`,
      {
        headers: detailed ? { Authorization: `Bearer ${secret}` } : {},
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== "ready") {
      throw new Error(
        `Readiness failed (${response.status}, requestId=${body?.requestId ?? response.headers.get("x-request-id") ?? "missing"}).`,
      );
    }
    return {
      ok: true,
      status: response.status,
      requestId: body.requestId ?? response.headers.get("x-request-id"),
      detailed,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const detailed = process.argv.includes("--detailed");
  const result = await checkReadiness({ detailed });
  console.log(JSON.stringify(result));
}

if (process.argv[1]?.endsWith("synthetic-readiness.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

