import process from "node:process";

const DEFAULT_ORIGIN = "https://torudake-reel.pages.dev";
const FORBIDDEN_PATHS = [
  "/api/billing/checkout",
  "/api/billing/portal",
  "/api/billing/webhook",
];

export function buildSmokeRequests(origin = process.env.SMOKE_ORIGIN) {
  const base = new URL(origin || DEFAULT_ORIGIN);
  if (base.protocol !== "https:" || base.pathname !== "/") {
    throw new Error("Payment smoke requires an HTTPS origin root.");
  }
  return [
    { name: "public-readiness", url: new URL("/api/health", base), expect: 200 },
    {
      name: "billing-status-contract",
      url: new URL("/api/billing/status", base),
      expect: 200,
    },
  ];
}

export function assertNonChargingPath(pathname) {
  if (FORBIDDEN_PATHS.includes(pathname)) {
    throw new Error(`Refusing billing mutation in smoke check: ${pathname}`);
  }
}

export async function runPaymentSmoke({
  origin,
  fetchImpl = fetch,
} = {}) {
  const results = [];
  for (const check of buildSmokeRequests(origin)) {
    assertNonChargingPath(check.url.pathname);
    const response = await fetchImpl(check.url, {
      headers: { "User-Agent": "torudake-payment-smoke/1" },
    });
    const body = await response.json().catch(() => null);
    if (response.status !== check.expect) {
      throw new Error(
        `${check.name} failed (${response.status}, requestId=${response.headers.get("x-request-id") ?? body?.requestId ?? "missing"}).`,
      );
    }
    if (check.name === "billing-status-contract") {
      if (
        typeof body?.configured !== "boolean" ||
        !["live", "test", "unconfigured"].includes(body?.billingMode)
      ) {
        throw new Error("Billing status response did not match its public contract.");
      }
    }
    results.push({ name: check.name, status: response.status });
  }
  return results;
}

async function main() {
  if (process.argv.includes("--charge") || process.argv.includes("--checkout")) {
    throw new Error("This command never creates Checkout sessions or charges.");
  }
  console.log(JSON.stringify(await runPaymentSmoke()));
}

if (process.argv[1]?.endsWith("payment-smoke.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

