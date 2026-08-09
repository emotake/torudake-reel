import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const disclosureStoreSource = await readFile(
  new URL("../lib/narration-disclosure-store.ts", import.meta.url),
  "utf8",
);
const disclosureRouteSource = await readFile(
  new URL("../app/api/narration/disclosure/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("creates the disclosure schema with the production-compatible D1 batch API", () => {
  assert.match(disclosureStoreSource, /database\.prepare\(/);
  assert.match(disclosureStoreSource, /await database\.batch\(\[/);
  assert.doesNotMatch(disclosureStoreSource, /database\.exec\(/);
  assert.match(
    disclosureStoreSource,
    /CREATE TABLE IF NOT EXISTS ai_disclosure_confirmations/,
  );
});

test("binds disclosure writes to a same-origin owned usage reservation", () => {
  assert.match(disclosureRouteSource, /isSameOriginMutation\(request\)/);
  assert.match(disclosureRouteSource, /getUsagePrincipal\(request/);
  assert.match(
    disclosureRouteSource,
    /authorizeUsageOperation\([\s\S]*"narration_disclosure"/,
  );
  assert.match(
    disclosureRouteSource,
    /markOperatorUsageOperationSucceeded\([\s\S]*"narration_disclosure"/,
  );
  assert.match(
    pageSource,
    /usageReservationId=\{usageReservationId\}/,
  );
  assert.match(
    pageSource,
    /rememberUsageReservation\(newlyReservedUsage, reservation\.bucket\)/,
  );
});
