import assert from "node:assert/strict";
import test from "node:test";

function createUsageDatabase() {
  const reservations = new Map();
  const operations = new Map();

  function prepare(query) {
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        if (/SELECT count, successful_count/i.test(query)) {
          const [id, reservationId, operation] = this.values;
          const existing = operations.get(id);
          return existing?.reservationId === reservationId &&
            existing.operation === operation
            ? {
                count: existing.count,
                successful_count: existing.successfulCount,
              }
            : null;
        }
        if (/INSERT INTO operator_usage_operations/i.test(query)) {
          const [id, reservationId, operation, now, , , limit] = this.values;
          const reservation = reservations.get(reservationId);
          if (
            !reservation ||
            !["reserved", "completed"].includes(reservation.status) ||
            reservation.expiresAt < now
          ) {
            return null;
          }
          const existing = operations.get(id);
          if (existing && existing.count >= limit) return null;
          const count = (existing?.count ?? 0) + 1;
          operations.set(id, {
            reservationId,
            operation,
            count,
            successfulCount: existing?.successfulCount ?? 0,
          });
          return { count };
        }
        if (/UPDATE operator_usage_operations/i.test(query)) {
          const [, id, reservationId, operation] = this.values;
          const existing = operations.get(id);
          if (
            !existing ||
            existing.reservationId !== reservationId ||
            existing.operation !== operation
          ) {
            return null;
          }
          existing.successfulCount += 1;
          return { successful_count: existing.successfulCount };
        }
        if (/SET status = 'released'/i.test(query)) {
          const [reservationId, userId] = this.values;
          const reservation = reservations.get(reservationId);
          const claimed = [...operations.values()].some(
            (item) =>
              item.reservationId === reservationId &&
              item.successfulCount > 0,
          );
          if (
            reservation?.userId === userId &&
            reservation.status === "reserved" &&
            !claimed
          ) {
            reservation.status = "released";
            return { id: reservationId };
          }
          return null;
        }
        if (/SET status = 'completed'/i.test(query)) {
          const [, reservationId, userId] = this.values;
          const reservation = reservations.get(reservationId);
          const claimed = [...operations.values()].some(
            (item) =>
              item.reservationId === reservationId &&
              item.successfulCount > 0,
          );
          if (
            reservation?.userId === userId &&
            reservation.status === "reserved" &&
            claimed
          ) {
            reservation.status = "completed";
            return { id: reservationId };
          }
          return null;
        }
        return null;
      },
      async run() {
        return { meta: { changes: 0 } };
      },
    };
  }

  return {
    reservations,
    operations,
    prepare,
    async batch() {
      return [];
    },
  };
}

test("limits operations for a free reservation and refuses a post-use refund", async () => {
  const database = createUsageDatabase();
  const now = Math.floor(Date.now() / 1_000);
  database.reservations.set("free-reservation", {
    userId: "user-1",
    bucket: "free",
    status: "reserved",
    expiresAt: now + 3_600,
  });
  database.reservations.set("unused-reservation", {
    userId: "user-1",
    bucket: "free",
    status: "reserved",
    expiresAt: now + 3_600,
  });
  database.reservations.set("failed-reservation", {
    userId: "user-1",
    bucket: "free",
    status: "reserved",
    expiresAt: now + 3_600,
  });
  globalThis.__cloudflareEnv = { DB: database };

  try {
    const moduleUrl = new URL("../lib/operator-usage.ts", import.meta.url);
    moduleUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    const {
      consumeOperatorUsageOperation,
      getOperatorUsageOperationCounts,
      markOperatorUsageOperationSucceeded,
      releaseOrCompleteUsageReservation,
    } = await import(moduleUrl.href);

    for (let count = 0; count < 24; count += 1) {
      assert.equal(
        await consumeOperatorUsageOperation(
          "free-reservation",
          "transcribe",
          now,
        ),
        true,
      );
    }
    assert.equal(
      await consumeOperatorUsageOperation(
        "free-reservation",
        "transcribe",
        now,
      ),
      false,
    );
    assert.equal(
      await markOperatorUsageOperationSucceeded(
        "free-reservation",
        "transcribe",
        now,
      ),
      true,
    );
    assert.deepEqual(
      await getOperatorUsageOperationCounts(
        "free-reservation",
        "transcribe",
      ),
      { count: 24, successfulCount: 1 },
    );
    assert.equal(
      await releaseOrCompleteUsageReservation(
        "free-reservation",
        "user-1",
        now,
      ),
      "completed",
    );
    assert.equal(database.reservations.get("free-reservation").status, "completed");

    assert.equal(
      await releaseOrCompleteUsageReservation(
        "unused-reservation",
        "user-1",
        now,
      ),
      "released",
    );

    assert.equal(
      await consumeOperatorUsageOperation(
        "failed-reservation",
        "transcribe",
        now,
      ),
      true,
    );
    assert.equal(
      await releaseOrCompleteUsageReservation(
        "failed-reservation",
        "user-1",
        now,
      ),
      "released",
      "a failed upstream attempt does not consume the video allowance",
    );
  } finally {
    delete globalThis.__cloudflareEnv;
  }
});
