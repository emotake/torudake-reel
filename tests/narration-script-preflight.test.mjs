import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/narration/script/route.ts", import.meta.url),
  "utf8",
);
const mainEditor = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("preflights owned reservation and entitlement before reading image JSON", () => {
  const preflightStart = route.indexOf("let usageHeaderPreflight");
  const ownedReservation = route.indexOf("findOwnedUsageReservation", preflightStart);
  const entitlement = route.indexOf(
    "getAiEntitlementBudgetForReservation",
    ownedReservation,
  );
  const bodyParse = route.indexOf("parseJsonBodyWithLimit", entitlement);

  assert.ok(preflightStart >= 0);
  assert.ok(ownedReservation > preflightStart);
  assert.ok(entitlement > ownedReservation);
  assert.ok(bodyParse > entitlement);
});

test("uses bounded header identifiers and never trusts them as authorization", () => {
  assert.match(route, /X-Usage-Reservation-Id/);
  assert.match(route, /X-AI-Operation-Id/);
  assert.match(route, /isValidMeteredAiActionId\(actionId\)/);
  assert.match(route, /reservationId !== usageHeaderPreflight\.reservationId/);
  assert.match(route, /aiOperationId !== usageHeaderPreflight\.actionId/);

  const bodyParse = route.indexOf("parseJsonBodyWithLimit");
  const mismatchCheck = route.indexOf("reservationId !== usageHeaderPreflight.reservationId");
  const authorization = route.indexOf("await authorizeMeteredAiOperation", mismatchCheck);
  assert.ok(bodyParse >= 0 && mismatchCheck > bodyParse && authorization > mismatchCheck);
});

test("requires both preflight headers before parsing when usage enforcement is active", () => {
  const enforcement = route.indexOf("if (usageEnforcementEnabled)");
  const reservationHeader = route.indexOf("request.headers.get(NARRATION_RESERVATION_HEADER)", enforcement);
  const actionHeader = route.indexOf("request.headers.get(NARRATION_ACTION_HEADER)", reservationHeader);
  const validation = route.indexOf("!isValidMeteredAiActionId(actionId)", actionHeader);
  const rejection = route.indexOf("status: 400", validation);
  const bodyParse = route.indexOf("parseJsonBodyWithLimit", rejection);

  assert.ok(enforcement >= 0);
  assert.ok(reservationHeader > enforcement);
  assert.ok(actionHeader > reservationHeader);
  assert.ok(validation > actionHeader && rejection > validation);
  assert.ok(bodyParse > rejection);
  assert.doesNotMatch(
    route.slice(actionHeader, validation),
    /if \(reservationId \|\| actionId\)/,
  );
  assert.match(route, /Local\/test bypasses still skip[\s\S]*?isUsageEnforcementEnabled/);
});

test("rejects either missing production preflight header before reading the body", async () => {
  globalThis.__cloudflareEnv = {
    OPENAI_API_KEY: "test-key",
    TRUST_SITES_AUTH_HEADERS: "true",
  };
  const routeUrl = new URL(
    "../app/api/narration/script/route.ts",
    import.meta.url,
  );
  routeUrl.searchParams.set("mandatory-header-runtime", `${process.pid}-${Date.now()}`);
  const { POST } = await import(routeUrl.href);
  const authenticatedHeaders = {
    "Content-Type": "application/json",
    "Content-Length": "7000000",
    "oai-authenticated-user-email": "preflight@example.com",
  };
  const cases = [
    {},
    { "X-Usage-Reservation-Id": "reservation_123" },
    { "X-AI-Operation-Id": "11111111-1111-4111-8111-111111111111" },
  ];

  try {
    for (const headers of cases) {
      const request = new Request(
        "https://torudake-reel.pages.dev/api/narration/script",
        {
          method: "POST",
          headers: { ...authenticatedHeaders, ...headers },
          body: "{}",
        },
      );
      const response = await POST(request);
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.match(payload.error, /AI処理の利用情報/);
      assert.equal(request.bodyUsed, false);
    }
  } finally {
    delete globalThis.__cloudflareEnv;
  }
});

test("sends the mandatory preflight identifiers from the main editor", () => {
  const request = mainEditor.slice(
    mainEditor.indexOf('fetch("/api/narration/script"'),
    mainEditor.indexOf("const quota = readAiOperationQuota", mainEditor.indexOf('fetch("/api/narration/script"')),
  );
  assert.match(request, /"X-Usage-Reservation-Id": usageReservationId \?\? ""/);
  assert.match(request, /"X-AI-Operation-Id": aiOperationId/);
  assert.match(request, /usageReservationId,/);
  assert.match(request, /aiOperationId,/);
});

test("read-only preflight cannot create a duplicate lease", () => {
  const preflight = route.slice(
    route.indexOf("let usageHeaderPreflight"),
    route.indexOf("let payload:"),
  );
  assert.match(preflight, /findOwnedUsageReservation/);
  assert.match(preflight, /getAiEntitlementBudgetForReservation/);
  assert.doesNotMatch(preflight, /authorizeMeteredAiOperation/);
  assert.doesNotMatch(preflight, /acquireUsageOperationLease/);
  assert.equal((route.match(/await authorizeMeteredAiOperation/g) ?? []).length, 1);
});

test("defers last-slot capacity to atomic authorization so the same action can recover or continue", async () => {
  const preflight = route.slice(
    route.indexOf("let usageHeaderPreflight"),
    route.indexOf("let payload:"),
  );
  assert.match(preflight, /await getAiEntitlementBudgetForReservation\(reservation\)/);
  assert.doesNotMatch(preflight, /entitlement\.remaining\s*<=\s*0/);
  assert.doesNotMatch(preflight, /status:\s*429/);

  const bodyParse = route.indexOf("parseJsonBodyWithLimit");
  const continuation = route.indexOf('continuationMode: "narration_bundle_phase"');
  const authorization = route.indexOf("await authorizeMeteredAiOperation", bodyParse);
  assert.ok(bodyParse >= 0 && authorization > bodyParse && continuation > authorization);

  const billingStore = await readFile(
    new URL("../lib/billing-store.ts", import.meta.url),
    "utf8",
  );
  const existingAction = billingStore.indexOf("if (existingAction)");
  const newActionCapacity = billingStore.indexOf(
    "usageBefore.successfulCount >= successfulLimit",
    existingAction,
  );
  assert.ok(
    existingAction >= 0 && newActionCapacity > existingAction,
    "same-action continuation must be handled before new-action capacity rejection",
  );
});
