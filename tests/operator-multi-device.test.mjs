import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const legacyToken = "cd".repeat(32);
const legacySessionHash = await sha256(legacyToken);
const nowSeconds = Math.floor(Date.now() / 1_000);

class D1Statement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.query, values);
  }

  async first() {
    return this.database.sqlite.prepare(this.query).get(...this.values) ?? null;
  }

  async run() {
    const result = this.database.sqlite.prepare(this.query).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }

  prepare(query) {
    return new D1Statement(this, query);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const database = new D1Database();
database.sqlite.exec(`
  CREATE TABLE operator_devices (
    slot text PRIMARY KEY NOT NULL,
    session_hash text NOT NULL,
    label text NOT NULL,
    activated_at integer NOT NULL,
    expires_at integer NOT NULL,
    revoked_at integer
  );
  CREATE UNIQUE INDEX operator_devices_session_hash_unique
  ON operator_devices (session_hash);
`);
database.sqlite
  .prepare(`
    INSERT INTO operator_devices (
      slot, session_hash, label, activated_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
  `)
  .run(
    "primary",
    legacySessionHash,
    "運営スマホ",
    nowSeconds - 100,
    nowSeconds + 10_000,
  );

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
const { POST: enrollOperatorDevice } = await import(
  "../app/api/operator/enroll/route.ts"
);

let replacementToken = "";

test("adds devices without revoking legacy sessions and enforces an atomic cap", async () => {
  assert.equal(OPERATOR_DEVICE_LIMIT, 5);
  const legacyRequest = operatorRequest(legacyToken);
  assert.equal(
    (await getOperatorDevice(legacyRequest, nowSeconds))?.label,
    "運営スマホ",
  );

  const addedDevices = [];
  for (let index = 1; index <= 3; index += 1) {
    addedDevices.push(
      await activateOperatorDevice(`運営端末${index}`, nowSeconds),
    );
  }
  assert.equal(activeDeviceCount(), 4);
  assert.equal(
    (await getOperatorDevice(legacyRequest, nowSeconds))?.label,
    "運営スマホ",
  );

  const simultaneous = await Promise.allSettled([
    activateOperatorDevice("同時登録A", nowSeconds),
    activateOperatorDevice("同時登録B", nowSeconds),
  ]);
  assert.equal(
    simultaneous.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = simultaneous.find((result) => result.status === "rejected");
  assert.ok(rejected);
  assert.ok(rejected.reason instanceof OperatorDeviceLimitError);
  assert.equal(activeDeviceCount(), OPERATOR_DEVICE_LIMIT);

  assert.equal(
    (
      await getOperatorDevice(
        operatorRequest(addedDevices[0].token),
        nowSeconds,
      )
    )?.label,
    "運営端末1",
  );
});

test("the enrollment route returns 409 at the cap without issuing a cookie", async () => {
  const response = await enrollOperatorDevice(
    enrollmentRequest({
      code: "operator-enrollment-code-for-tests",
      label: "メインPC",
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.limitReached, true);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(activeDeviceCount(), OPERATOR_DEVICE_LIMIT);
});

test("explicit recovery replaces only the oldest device and issues a cookie", async () => {
  const response = await enrollOperatorDevice(
    enrollmentRequest({
      code: "operator-enrollment-code-for-tests",
      label: "メインPC",
      replaceOldest: true,
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.replacedOldest, true);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie ?? "", /^torudake_operator_session=[0-9a-f]{64};/);
  replacementToken = cookie?.match(
    /^torudake_operator_session=([0-9a-f]{64});/,
  )?.[1] ?? "";
  assert.ok(replacementToken);
  assert.equal(activeDeviceCount(), OPERATOR_DEVICE_LIMIT);
  assert.equal(
    await getOperatorDevice(operatorRequest(legacyToken), nowSeconds + 1),
    null,
  );
  assert.equal(
    (
      await getOperatorDevice(
        operatorRequest(replacementToken),
        nowSeconds + 1,
      )
    )?.label,
    "メインPC",
  );
});

test("revokes only the current browser and frees one device slot", async () => {
  const request = operatorRequest(replacementToken);
  assert.equal(await revokeOperatorDevice(request, nowSeconds + 2), true);
  assert.equal(await getOperatorDevice(request, nowSeconds + 2), null);

  const next = await activateOperatorDevice("予備PC", nowSeconds + 2);
  assert.equal(next.replacedOldest, false);
  assert.equal(activeDeviceCount(), OPERATOR_DEVICE_LIMIT);
  assert.equal(
    (
      await getOperatorDevice(
        operatorRequest(next.token),
        nowSeconds + 2,
      )
    )?.label,
    "予備PC",
  );
});

function activeDeviceCount() {
  return Number(
    database.sqlite
      .prepare(`
        SELECT COUNT(*) AS count
        FROM operator_devices
        WHERE revoked_at IS NULL AND expires_at > ?
      `)
      .get(nowSeconds)?.count ?? 0,
  );
}

function operatorRequest(token) {
  return new Request("https://torudake-reel.pages.dev/", {
    headers: { cookie: `torudake_operator_session=${token}` },
  });
}

function enrollmentRequest(body) {
  return new Request(
    "https://torudake-reel.pages.dev/api/operator/enroll",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://torudake-reel.pages.dev",
        "user-agent": "operator-multi-device-test",
      },
      body: JSON.stringify(body),
    },
  );
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest).toString("hex");
}

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
