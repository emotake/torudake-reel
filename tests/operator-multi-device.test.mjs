import assert from "node:assert/strict";
import test from "node:test";

const legacyToken = "cd".repeat(32);
const legacySessionHash = await sha256(legacyToken);
const nowSeconds = 2_000_000_000;

class FakeStatement {
  constructor(database, query) {
    this.database = database;
    this.query = query.replace(/\s+/g, " ").trim().toLowerCase();
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    if (this.query.startsWith("insert into operator_devices")) {
      const [
        slot,
        sessionHash,
        label,
        activatedAt,
        expiresAt,
        activeAfter,
        limit,
      ] = this.values;
      const activeCount = this.database.rows.filter(
        (row) => row.revokedAt === null && row.expiresAt > activeAfter,
      ).length;
      if (activeCount >= limit) return { meta: { changes: 0 } };
      this.database.rows.push({
        slot,
        sessionHash,
        label,
        activatedAt,
        expiresAt,
        revokedAt: null,
      });
      return { meta: { changes: 1 } };
    }

    if (this.query.startsWith("update operator_devices")) {
      const [revokedAt, sessionHash] = this.values;
      let changes = 0;
      for (const row of this.database.rows) {
        if (row.sessionHash === sessionHash && row.revokedAt === null) {
          row.revokedAt = revokedAt;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    return { meta: { changes: 0 } };
  }

  async first() {
    const [sessionHash, activeAfter] = this.values;
    const row = this.database.rows.find(
      (candidate) =>
        candidate.sessionHash === sessionHash &&
        candidate.revokedAt === null &&
        candidate.expiresAt > activeAfter,
    );
    return row
      ? {
          label: row.label,
          activatedAt: row.activatedAt,
          expiresAt: row.expiresAt,
        }
      : null;
  }
}

const database = {
  rows: [
    {
      slot: "primary",
      sessionHash: legacySessionHash,
      label: "運営スマホ",
      activatedAt: nowSeconds - 100,
      expiresAt: nowSeconds + 10_000,
      revokedAt: null,
    },
  ],
  prepare(query) {
    return new FakeStatement(this, query);
  },
  async batch() {
    return [];
  },
};

globalThis.__cloudflareEnv = {
  DB: database,
  OPERATOR_ENROLLMENT_CODE: "operator-enrollment-code-for-tests",
};

const {
  activateOperatorDevice,
  getOperatorDevice,
  OPERATOR_DEVICE_LIMIT,
  OperatorDeviceLimitError,
  revokeOperatorDevice,
} = await import("../lib/operator-access.ts");

test("keeps the legacy smartphone active while adding independent devices", async () => {
  assert.equal(OPERATOR_DEVICE_LIMIT, 5);
  const legacyRequest = operatorRequest(legacyToken);
  assert.equal(
    (await getOperatorDevice(legacyRequest, nowSeconds))?.label,
    "運営スマホ",
  );

  const addedDevices = [];
  for (let index = 1; index < OPERATOR_DEVICE_LIMIT; index += 1) {
    addedDevices.push(
      await activateOperatorDevice(`運営端末${index}`, nowSeconds),
    );
  }

  assert.equal(database.rows.length, OPERATOR_DEVICE_LIMIT);
  assert.equal(
    (await getOperatorDevice(legacyRequest, nowSeconds))?.label,
    "運営スマホ",
  );
  assert.equal(
    (
      await getOperatorDevice(
        operatorRequest(addedDevices[0].token),
        nowSeconds,
      )
    )?.label,
    "運営端末1",
  );

  await assert.rejects(
    () => activateOperatorDevice("上限超過", nowSeconds),
    OperatorDeviceLimitError,
  );
});

test("revokes only the current browser and frees one device slot", async () => {
  const legacyRequest = operatorRequest(legacyToken);
  assert.equal(await revokeOperatorDevice(legacyRequest, nowSeconds + 1), true);
  assert.equal(await getOperatorDevice(legacyRequest, nowSeconds + 1), null);

  const replacement = await activateOperatorDevice(
    "メインPC",
    nowSeconds + 1,
  );
  assert.equal(
    (
      await getOperatorDevice(
        operatorRequest(replacement.token),
        nowSeconds + 1,
      )
    )?.label,
    "メインPC",
  );
  assert.equal(
    database.rows.filter(
      (row) => row.revokedAt === null && row.expiresAt > nowSeconds + 1,
    ).length,
    OPERATOR_DEVICE_LIMIT,
  );
});

function operatorRequest(token) {
  return new Request("https://torudake-reel.pages.dev/", {
    headers: { cookie: `torudake_operator_session=${token}` },
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

test.after(() => {
  delete globalThis.__cloudflareEnv;
});
