import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createRequestLogContext,
  getRequestIdentifiers,
  withRequestIdentifier,
} from "../lib/observability.ts";
import { isConstantTimeSecretEqualForTest } from "../lib/health.ts";
import {
  assertNonChargingPath,
  buildSmokeRequests,
  runPaymentSmoke,
} from "../scripts/operations/payment-smoke.mjs";
import {
  checkReadiness,
  normalizeOrigin,
} from "../scripts/operations/synthetic-readiness.mjs";
import {
  buildExternalObservabilityPlan,
  validateAlertPolicy,
} from "../scripts/operations/configure-cloudflare-alerts.mjs";

const entrySource = readFileSync(
  new URL("../cloudflare-pages-entry.mjs", import.meta.url),
  "utf8",
);
const backupSource = readFileSync(
  new URL("../scripts/operations/backup-d1.ps1", import.meta.url),
  "utf8",
);
const restoreSource = readFileSync(
  new URL("../scripts/operations/restore-drill.ps1", import.meta.url),
  "utf8",
);
const operationsDoc = readFileSync(
  new URL("../docs/operations/production-operations.md", import.meta.url),
  "utf8",
);
const supportDoc = readFileSync(
  new URL("../docs/operations/support-playbook.md", import.meta.url),
  "utf8",
);

test("request and correlation IDs accept only bounded safe values", () => {
  const trusted = new Request("https://example.test/api/test", {
    headers: {
      "x-request-id": "req_12345678",
      "x-correlation-id": "corr-12345678",
      "cf-ray": "ray-12345678",
    },
  });
  assert.deepEqual(getRequestIdentifiers(trusted), {
    requestId: "req_12345678",
    correlationId: "corr-12345678",
  });
  const context = createRequestLogContext(trusted);
  assert.equal(context.path, "/api/test");
  assert.equal(context.cfRay, "ray-12345678");

  const untrusted = new Request("https://example.test/api/test", {
    headers: { "x-request-id": "unsafe/value", "x-correlation-id": "bad" },
  });
  const identifiers = getRequestIdentifiers(untrusted);
  assert.match(identifiers.requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(identifiers.correlationId, identifiers.requestId);

  const response = withRequestIdentifier(new Response(null), untrusted, identifiers.requestId);
  assert.equal(response.headers.get("x-request-id"), identifiers.requestId);
  assert.equal(
    createRequestLogContext(untrusted, identifiers).requestId,
    identifiers.requestId,
  );
});

test("operations secret comparison does not use plain string equality", async () => {
  assert.equal(await isConstantTimeSecretEqualForTest("a", "a"), true);
  assert.equal(await isConstantTimeSecretEqualForTest("a", "b"), false);
  assert.equal(await isConstantTimeSecretEqualForTest("short", "longer"), false);
});

test("Pages entry exposes the same safe request ID on all responses", () => {
  assert.match(entrySource, /headers\.set\("x-request-id", requestId\)/u);
  assert.match(entrySource, /headers\.set\("X-Request-Id", identifiers\.requestId\)/u);
  assert.match(entrySource, /event: "http_server_error"/u);
  assert.match(entrySource, /console\.error\(\s*runtimeLog/u);
  assert.match(entrySource, /Internal server error/u);
  assert.doesNotMatch(entrySource, /catch \(error\)[\s\S]{0,500}throw error/u);
});

test("Cloudflare alert configuration is plan-only unless explicitly applied", () => {
  const plan = buildExternalObservabilityPlan();
  assert.equal(plan.externalMutation, false);
  assert.equal(plan.deploymentAlerts.status, "not_applied");
  assert.throws(
    () =>
      validateAlertPolicy(
        {
          alert_type: "pages_event_alert",
          enabled: true,
          mechanisms: { email: [{ id: "REPLACE_WITH_EMAIL" }] },
          name: "Torudake Pages failure",
        },
        new Set(["pages_event_alert"]),
      ),
    /real email/u,
  );
});

test("readiness probe is bounded and reports an operational request ID", async () => {
  assert.equal(normalizeOrigin("https://example.test/"), "https://example.test");
  assert.throws(() => normalizeOrigin("http://example.test"), /HTTPS origin/u);
  const result = await checkReadiness({
    origin: "https://example.test",
    fetchImpl: async () =>
      Response.json(
        { status: "ready", requestId: "req-12345678" },
        { headers: { "x-request-id": "req-12345678" } },
      ),
  });
  assert.equal(result.ok, true);
  assert.equal(result.requestId, "req-12345678");
});

test("payment smoke cannot call a billing mutation", async () => {
  assert.deepEqual(
    buildSmokeRequests("https://example.test").map((check) => check.url.pathname),
    ["/api/health", "/api/billing/status"],
  );
  assert.throws(
    () => assertNonChargingPath("/api/billing/checkout"),
    /Refusing billing mutation/u,
  );
  const results = await runPaymentSmoke({
    origin: "https://example.test",
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname === "/api/health") {
        return Response.json({ status: "ready" });
      }
      return Response.json({ configured: true, billingMode: "live" });
    },
  });
  assert.equal(results.length, 2);
});

test("backup is encrypted on D and restore drill is production-read-only", () => {
  assert.match(backupSource, /BackupRoot must be an explicit directory on drive D:/u);
  assert.match(backupSource, /wrangler d1 export/u);
  assert.match(backupSource, /age -r/u);
  assert.match(backupSource, /finally/u);
  assert.match(backupSource, /Remove-Item -LiteralPath \$sqlPath/u);
  assert.match(restoreSource, /sqlite3 \$databasePath/u);
  assert.match(restoreSource, /PRAGMA quick_check/u);
  assert.match(restoreSource, /migration ledger does not exactly match/u);
  assert.doesNotMatch(restoreSource, /wrangler d1 execute/u);
});

test("operations and support runbooks cover paid-service incidents safely", () => {
  for (const phrase of [
    "Stripe Workbench",
    "payment-smoke",
    "monthly restore drill",
    "migration ledger is append-only",
  ]) {
    assert.match(operationsDoc, new RegExp(phrase, "u"));
  }
  for (const phrase of [
    "Duplicate charge",
    "Save failed after an allowance was consumed",
    "All passkeys lost",
    "Refund or dispute",
    "Outage communication",
    "No support SLA has been approved",
    "Do **not** ask users to attach their video",
  ]) {
    assert.match(supportDoc, new RegExp(phrase.replaceAll("*", "\\*"), "u"));
  }
});
