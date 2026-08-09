import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function createLeaseDatabase() {
  const reservations = new Map();
  const leases = new Map();

  function prepare(query) {
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        if (/INSERT INTO usage_operation_leases/i.test(query)) {
          const [
            id,
            reservationId,
            operation,
            token,
            acquiredAt,
            expiresAt,
            ,
            ,
            reservationNow,
            replacementNow,
          ] = this.values;
          const reservation = reservations.get(reservationId);
          if (
            !reservation ||
            !["reserved", "completed"].includes(reservation.status) ||
            reservation.expiresAt < reservationNow
          ) {
            return null;
          }
          const existing = leases.get(id);
          if (existing && existing.expiresAt > replacementNow) return null;
          const lease = {
            id,
            reservationId,
            operation,
            token,
            acquiredAt,
            expiresAt,
          };
          leases.set(id, lease);
          return { lease_token: token, expires_at: expiresAt };
        }
        if (/DELETE FROM usage_operation_leases/i.test(query)) {
          const [id, reservationId, operation, token] = this.values;
          const existing = leases.get(id);
          if (
            !existing ||
            existing.reservationId !== reservationId ||
            existing.operation !== operation ||
            existing.token !== token
          ) {
            return null;
          }
          leases.delete(id);
          return { id };
        }
        return null;
      },
    };
  }

  return {
    reservations,
    leases,
    prepare,
    async batch() {
      return [];
    },
  };
}

test("serializes one transcription per reservation and safely replaces stale leases", async () => {
  const database = createLeaseDatabase();
  const now = 2_000_000_000;
  database.reservations.set("video-1", {
    status: "reserved",
    expiresAt: now + 3_600,
  });
  globalThis.__cloudflareEnv = { DB: database };

  try {
    const moduleUrl = new URL("../lib/operator-usage.ts", import.meta.url);
    moduleUrl.searchParams.set("lease", `${process.pid}-${Date.now()}`);
    const {
      acquireUsageOperationLease,
      releaseUsageOperationLease,
    } = await import(moduleUrl.href);

    const first = await acquireUsageOperationLease(
      "video-1",
      "transcribe",
      999,
      now,
    );
    assert.ok(first);
    assert.equal(first.expiresAt, now + 300, "lease TTL covers all retry passes");

    const parallel = await acquireUsageOperationLease(
      "video-1",
      "transcribe",
      180,
      now + 1,
    );
    assert.equal(parallel, null, "parallel request cannot acquire the lease");

    assert.equal(
      await releaseUsageOperationLease({ ...first, token: "wrong-token" }),
      false,
      "a different Worker cannot release the lease",
    );
    assert.equal(database.leases.size, 1);

    const replacement = await acquireUsageOperationLease(
      "video-1",
      "transcribe",
      45,
      now + 300,
    );
    assert.ok(replacement, "an expired lease can be recovered");
    assert.notEqual(replacement.token, first.token);
    assert.equal(
      await releaseUsageOperationLease(first),
      false,
      "the stale token cannot delete its replacement",
    );
    assert.equal(await releaseUsageOperationLease(replacement), true);
    assert.equal(database.leases.size, 0);
  } finally {
    delete globalThis.__cloudflareEnv;
  }
});

test("the transcribe route leases before charging and always releases in finally", async () => {
  const routeSource = await readFile(
    new URL("../app/api/transcribe/route.ts", import.meta.url),
    "utf8",
  );
  const billingSource = await readFile(
    new URL("../lib/billing-store.ts", import.meta.url),
    "utf8",
  );
  const postSource = routeSource.slice(
    routeSource.indexOf("export async function POST"),
  );
  const leasedAuthorizationSource = billingSource.slice(
    billingSource.indexOf("export async function authorizeLeasedUsageOperation"),
  );

  assert.ok(
    postSource.indexOf("authorizeLeasedUsageOperation(") <
      postSource.indexOf("requestTimedTranscription(apiKey, file)"),
    "the upstream request must follow leased authorization",
  );
  assert.match(routeSource, /reason === "operation_in_progress"[\s\S]*409/);
  assert.match(
    routeSource,
    /finally\s*\{[\s\S]*releaseUsageOperationLease\(transcriptionLease\)/,
  );
  assert.ok(
    leasedAuthorizationSource.indexOf("acquireUsageOperationLease(") <
      leasedAuthorizationSource.indexOf("consumeOperatorUsageOperation("),
    "a busy request must be rejected before its operation count is charged",
  );
});

test("the narration speech route leases, caps successful output, and releases safely", async () => {
  const routeSource = await readFile(
    new URL("../app/api/narration/speech/route.ts", import.meta.url),
    "utf8",
  );
  const reserveSource = await readFile(
    new URL("../app/api/usage/reserve/route.ts", import.meta.url),
    "utf8",
  );
  const billingSource = await readFile(
    new URL("../lib/billing-store.ts", import.meta.url),
    "utf8",
  );
  const postSource = routeSource.slice(
    routeSource.indexOf("export async function POST"),
  );
  const leasedAuthorizationSource = billingSource.slice(
    billingSource.indexOf("export async function authorizeLeasedUsageOperation"),
  );

  assert.ok(
    postSource.indexOf("authorizeLeasedUsageOperation(") <
      postSource.indexOf("requestSpeech("),
  );
  assert.match(
    postSource,
    /getNarrationSpeechSuccessLimit\(\s*reservation\.bucket,?\s*\)/,
  );
  assert.match(postSource, /successfulLimit:\s*narrationGenerationLimit/);
  assert.match(
    reserveSource,
    /narrationGenerationLimit:\s*getNarrationSpeechSuccessLimit\(/,
  );
  assert.match(postSource, /reason === "operator_success_limit"/);
  assert.match(postSource, /reason === "operation_in_progress"[\s\S]*409/);
  assert.match(
    postSource,
    /Math\.min\(reservation\.sourceDurationSeconds, targetDurationSeconds, 90\)/,
  );
  assert.match(postSource, /if \(!audio\.byteLength\)/);
  assert.match(
    postSource,
    /finally\s*\{[\s\S]*releaseUsageOperationLease\(narrationLease\)/,
  );
  assert.ok(
    leasedAuthorizationSource.indexOf("acquireUsageOperationLease(") <
      leasedAuthorizationSource.indexOf("getOperatorUsageOperationCounts("),
  );
  assert.ok(
    leasedAuthorizationSource.indexOf("getOperatorUsageOperationCounts(") <
      leasedAuthorizationSource.indexOf("consumeOperatorUsageOperation("),
  );
});
