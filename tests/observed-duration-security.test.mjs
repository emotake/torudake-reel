import assert from "node:assert/strict";
import test from "node:test";

function createObservedDurationDatabase() {
  const reservations = new Map();
  const observations = new Map();

  function prepare(query) {
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async execute() {
        if (/RETURNING observed_milliseconds/i.test(query)) {
          const [reservationId, added, , , now] = this.values;
          const reservation = reservations.get(reservationId);
          const observation = observations.get(reservationId);
          const tolerance = Math.min(
            Math.max(reservation?.sourceDurationSeconds * 20, 1_000),
            3_000,
          );
          const limit =
            (reservation?.sourceDurationSeconds ?? 0) * 1_000 + tolerance;
          const next = (observation?.observedMilliseconds ?? 0) + added;
          if (
            !reservation ||
            !["reserved", "completed"].includes(reservation.status) ||
            reservation.expiresAt < now ||
            observation?.blockedAt ||
            next > limit
          ) {
            return null;
          }
          observations.set(reservationId, {
            observedMilliseconds: next,
            blockedAt: null,
          });
          return { observed_milliseconds: next };
        }
        if (
          /INSERT INTO usage_observed_durations/i.test(query) &&
          /SELECT \?, 0, \?, \?/i.test(query)
        ) {
          const [reservationId, blockedAt] = this.values;
          if (reservations.has(reservationId)) {
            const existing = observations.get(reservationId);
            observations.set(reservationId, {
              observedMilliseconds: existing?.observedMilliseconds ?? 0,
              blockedAt: existing?.blockedAt ?? blockedAt,
            });
          }
          return null;
        }
        if (
          /UPDATE usage_reservations/i.test(query) &&
          /status\s*=\s*'completed'/i.test(query)
        ) {
          const [, reservationId] = this.values;
          const reservation = reservations.get(reservationId);
          if (reservation?.status === "reserved") {
            reservation.status = "completed";
          }
          return null;
        }
        if (/SELECT blocked_at/i.test(query)) {
          const observation = observations.get(this.values[0]);
          return observation?.blockedAt
            ? { blocked_at: observation.blockedAt }
            : null;
        }
        return null;
      },
      async first() {
        return this.execute();
      },
    };
  }

  return {
    reservations,
    observations,
    prepare,
    async batch(statements) {
      for (const statement of statements) await statement.execute();
      return [];
    },
  };
}

test("enforces cumulative duration and fails closed when it is unverifiable", async () => {
  const database = createObservedDurationDatabase();
  const now = Math.floor(Date.now() / 1_000);
  database.reservations.set("video-1", {
    sourceDurationSeconds: 60,
    status: "reserved",
    expiresAt: now + 3_600,
  });
  database.reservations.set("video-2", {
    sourceDurationSeconds: 30,
    status: "reserved",
    expiresAt: now + 3_600,
  });
  globalThis.__cloudflareEnv = { DB: database };

  try {
    const moduleUrl = new URL("../lib/operator-usage.ts", import.meta.url);
    moduleUrl.searchParams.set("observed", `${process.pid}-${Date.now()}`);
    const {
      isObservedDurationBlocked,
      recordObservedTranscriptionDuration,
    } = await import(moduleUrl.href);

    assert.deepEqual(
      await recordObservedTranscriptionDuration("video-1", 30, now),
      { allowed: true, reason: null, observedSeconds: 30 },
    );
    assert.deepEqual(
      await recordObservedTranscriptionDuration("video-1", 31, now),
      { allowed: true, reason: null, observedSeconds: 61 },
    );

    const rejected = await recordObservedTranscriptionDuration(
      "video-1",
      1.3,
      now,
    );
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.reason, "duration_exceeded");
    assert.equal(database.reservations.get("video-1").status, "completed");
    assert.equal(await isObservedDurationBlocked("video-1"), true);
    assert.equal(
      database.observations.get("video-1").observedMilliseconds,
      61_000,
    );
    const unverifiable = await recordObservedTranscriptionDuration(
      "video-2",
      Number.NaN,
      now,
    );
    assert.equal(unverifiable.allowed, false);
    assert.equal(unverifiable.reason, "duration_unverifiable");
    assert.equal(database.reservations.get("video-2").status, "completed");
    assert.ok(database.observations.get("video-2").blockedAt);
  } finally {
    delete globalThis.__cloudflareEnv;
  }
});
