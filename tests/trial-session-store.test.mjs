import assert from "node:assert/strict";
import test from "node:test";

function createTrialSessionDatabase() {
  const sessions = new Map();
  const issuances = new Map();

  function prepare(query) {
    const statement = {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async first() {
        if (/SUM\(CASE WHEN network_hash/i.test(query)) {
          const [
            networkHash,
            burstStart,
            ,
            dailyStart,
            globalStart,
          ] = this.values;
          const values = Array.from(issuances.values());
          return {
            network_burst: values.filter(
              (item) =>
                item.networkHash === networkHash &&
                item.createdAt >= burstStart,
            ).length,
            network_daily: values.filter(
              (item) =>
                item.networkHash === networkHash &&
                item.createdAt >= dailyStart,
            ).length,
            global_daily: values.filter(
              (item) => item.createdAt >= globalStart,
            ).length,
          };
        }
        if (/FROM trial_issuance_fingerprints/i.test(query)) {
          const [fingerprintHash] = this.values;
          const issuance = issuances.get(fingerprintHash);
          return issuance ? { session_hash: issuance.sessionHash } : null;
        }
        if (/SELECT session_hash\s+FROM trial_sessions/i.test(query)) {
          const [hash, now] = this.values;
          const session = sessions.get(hash);
          return session && session.expiresAt >= now
            ? { session_hash: hash }
            : null;
        }
        return null;
      },
      async run() {
        if (/INSERT INTO trial_issuance_fingerprints/i.test(query)) {
          const [
            fingerprintHash,
            networkHash,
            sessionHash,
            createdAt,
            lastSeenAt,
            ,
            networkBurstStart,
            networkBurstLimit,
            ,
            networkDailyStart,
            networkDailyLimit,
            globalWindowStart,
            globalLimit,
          ] = this.values;
          const existing = issuances.get(fingerprintHash);
          const recentNetworkBurst = Array.from(issuances.values()).filter(
            (issuance) =>
              issuance.networkHash === networkHash &&
              issuance.createdAt >= networkBurstStart,
          ).length;
          const recentNetworkDaily = Array.from(issuances.values()).filter(
            (issuance) =>
              issuance.networkHash === networkHash &&
              issuance.createdAt >= networkDailyStart,
          ).length;
          const recentGlobalIssuances = Array.from(issuances.values()).filter(
            (issuance) => issuance.createdAt >= globalWindowStart,
          ).length;
          if (
            !existing &&
            (recentNetworkBurst >= networkBurstLimit ||
              recentNetworkDaily >= networkDailyLimit ||
              recentGlobalIssuances >= globalLimit)
          ) {
            return { meta: { changes: 0 } };
          }
          issuances.set(fingerprintHash, {
            sessionHash: existing?.sessionHash ?? sessionHash,
            networkHash: existing?.networkHash ?? networkHash,
            createdAt: existing?.createdAt ?? createdAt,
            lastSeenAt,
          });
        } else if (/INSERT INTO trial_sessions/i.test(query)) {
          const [hash, createdAt, lastSeenAt, expiresAt] = this.values;
          if (/WHERE EXISTS/i.test(query)) {
            const [, , , , fingerprintHash, expectedSessionHash] = this.values;
            if (
              issuances.get(fingerprintHash)?.sessionHash !==
              expectedSessionHash
            ) {
              return { meta: { changes: 0 } };
            }
          }
          const existing = sessions.get(hash);
          sessions.set(hash, {
            createdAt: existing?.createdAt ?? createdAt,
            lastSeenAt,
            expiresAt,
          });
        } else if (/DELETE FROM trial_sessions/i.test(query)) {
          const [now] = this.values;
          for (const [hash, session] of sessions) {
            if (session.expiresAt < now) sessions.delete(hash);
          }
        }
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  }

  return {
    sessions,
    issuances,
    prepare,
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
}

test("rejects a client-forged trial UUID until the server issues a session", async () => {
  const database = createTrialSessionDatabase();
  globalThis.__cloudflareEnv = {
    DB: database,
    TRIAL_ISSUANCE_SECRET: "test-secret-with-at-least-thirty-two-characters",
  };
  try {
    const moduleUrl = new URL("../lib/trial-session-store.ts", import.meta.url);
    moduleUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    const {
      getRegisteredTrialSessionId,
      issueOrRefreshTrialSession,
      trialIssuanceLimitError,
      trialSessionPrincipalEmail,
    } = await import(moduleUrl.href);
    const sharedNetworkLimit = trialIssuanceLimitError({
      networkBurst: 12,
      networkDaily: 12,
      globalDaily: 12,
    });
    assert.equal(sharedNetworkLimit.code, "trial_network_temporarily_limited");
    assert.equal(sharedNetworkLimit.status, 429);
    assert.match(sharedNetworkLimit.publicMessage, /10分/);
    const capacityLimit = trialIssuanceLimitError({
      networkBurst: 0,
      networkDaily: 0,
      globalDaily: 5_000,
    });
    assert.equal(capacityLimit.code, "trial_capacity_temporarily_limited");
    assert.equal(capacityLimit.status, 429);
    assert.match(capacityLimit.publicMessage, /一時的/);
    const forged = "11111111-1111-4111-8111-111111111111";
    const forgedRequest = new Request("https://torudake-reel.pages.dev/", {
      headers: {
        cookie: `torudake_trial_id=${forged}`,
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "Trial test browser",
        "accept-language": "ja-JP",
      },
    });

    assert.equal(await getRegisteredTrialSessionId(forgedRequest), null);
    const now = Math.floor(Date.now() / 1_000);
    const issued = await issueOrRefreshTrialSession(forgedRequest, now);
    assert.notEqual(issued, forged);

    const issuedRequest = new Request("https://torudake-reel.pages.dev/", {
      headers: { cookie: `torudake_trial_id=${issued}` },
    });
    assert.equal(await getRegisteredTrialSessionId(issuedRequest), issued);
    assert.equal(
      await issueOrRefreshTrialSession(issuedRequest, now + 1),
      issued,
    );

    await assert.rejects(
      issueOrRefreshTrialSession(
        new Request("https://torudake-reel.pages.dev/", {
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            "user-agent": "Trial test browser",
            "accept-language": "ja-JP",
          },
        }),
        now + 2,
      ),
      (error) =>
        error?.code === "trial_already_issued" && error?.status === 409,
    );
    assert.equal(database.issuances.size, 1);
    const [storedFingerprint] = database.issuances.keys();
    assert.match(storedFingerprint, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(storedFingerprint, /203\.0\.113\.10/);
    const [{ networkHash: storedNetworkHash }] = database.issuances.values();
    assert.match(storedNetworkHash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(storedNetworkHash, /203\.0\.113\.10/);

    for (let index = 1; index < 12; index += 1) {
      await issueOrRefreshTrialSession(
        new Request("https://torudake-reel.pages.dev/", {
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            "user-agent": `Trial test browser variant ${index}`,
            "accept-language": "ja-JP",
          },
        }),
        now + 2 + index,
      );
    }
    await assert.rejects(
      issueOrRefreshTrialSession(
        new Request("https://torudake-reel.pages.dev/", {
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            "user-agent": "Trial test browser variant over the limit",
            "accept-language": "ja-JP",
          },
        }),
        now + 11,
      ),
      (error) =>
        error?.code === "trial_network_temporarily_limited" &&
        error?.status === 429 &&
        /10分/.test(error?.publicMessage ?? ""),
    );

    const secondNetworkSession = await issueOrRefreshTrialSession(
      new Request("https://torudake-reel.pages.dev/", {
        headers: {
          "cf-connecting-ip": "203.0.113.11",
          "user-agent": "Trial test browser",
          "accept-language": "ja-JP",
        },
      }),
      now + 12,
    );
    assert.notEqual(secondNetworkSession, issued);

    const storeSource = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../lib/trial-session-store.ts", import.meta.url), "utf8"),
    );
    assert.match(storeSource, /TRIAL_GLOBAL_ISSUANCE_LIMIT = 5_000/);
    assert.match(storeSource, /TRIAL_NETWORK_DAILY_LIMIT = 50/);
    assert.doesNotMatch(storeSource, /30 \* 24 \* 60 \* 60/);

    delete globalThis.__cloudflareEnv.TRIAL_ISSUANCE_SECRET;
    assert.equal(
      await issueOrRefreshTrialSession(issuedRequest, now + 13),
      issued,
      "a registered cookie remains refreshable without issuance context",
    );
    await assert.rejects(
      issueOrRefreshTrialSession(
        new Request("https://torudake-reel.pages.dev/"),
        now + 14,
      ),
      (error) =>
        error?.code === "trial_issuance_not_configured" &&
        error?.status === 503,
    );

    globalThis.__cloudflareEnv.TRIAL_ISSUANCE_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    await assert.rejects(
      issueOrRefreshTrialSession(
        new Request("https://torudake-reel.pages.dev/"),
        now + 15,
      ),
      (error) =>
        error?.code === "trial_request_context_unavailable" &&
        error?.status === 503,
    );

    const principalEmail = await trialSessionPrincipalEmail(issued);
    assert.match(
      principalEmail,
      /^trial-[0-9a-f]{48}@anonymous\.torudake\.invalid$/,
    );
    assert.doesNotMatch(principalEmail, new RegExp(issued, "i"));

    globalThis.__cloudflareEnv.DB = createTrialSessionDatabase();
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("trial-session", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const endpointResponse = await worker.fetch(
      new Request("https://torudake-reel.pages.dev/api/session/trial", {
        method: "POST",
        headers: {
          origin: "https://torudake-reel.pages.dev",
          "cf-connecting-ip": "198.51.100.24",
          "user-agent": "Route test browser",
          "accept-language": "ja-JP",
        },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    assert.equal(endpointResponse.status, 200);
    assert.deepEqual(await endpointResponse.json(), { ready: true });
    assert.match(
      endpointResponse.headers.get("set-cookie") ?? "",
      /^torudake_trial_id=/,
    );
    const endpointCookies = endpointResponse.headers.getSetCookie();
    const deviceCookie = endpointCookies
      .find((cookie) => cookie.startsWith("torudake_trial_device="))
      ?.split(";", 1)[0];
    assert.ok(deviceCookie);

    const repeatedEndpointResponse = await worker.fetch(
      new Request("https://torudake-reel.pages.dev/api/session/trial", {
        method: "POST",
        headers: {
          origin: "https://torudake-reel.pages.dev",
          "cf-connecting-ip": "198.51.100.24",
          "user-agent": "Route test browser",
          "accept-language": "ja-JP",
          cookie: deviceCookie,
        },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    assert.equal(repeatedEndpointResponse.status, 409);
    assert.equal(repeatedEndpointResponse.headers.get("set-cookie"), null);
    assert.equal(
      (await repeatedEndpointResponse.json()).code,
      "trial_already_issued",
    );

    delete globalThis.__cloudflareEnv.TRIAL_ISSUANCE_SECRET;
    const unconfiguredEndpointResponse = await worker.fetch(
      new Request("https://torudake-reel.pages.dev/api/session/trial", {
        method: "POST",
        headers: {
          origin: "https://torudake-reel.pages.dev",
          "cf-connecting-ip": "198.51.100.25",
        },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    assert.equal(unconfiguredEndpointResponse.status, 503);
    const unconfiguredPayload = await unconfiguredEndpointResponse.json();
    assert.equal(unconfiguredPayload.code, "trial_issuance_not_configured");
    assert.match(unconfiguredPayload.error, /設定/);
    assert.equal(
      unconfiguredEndpointResponse.headers.get("cache-control"),
      "no-store",
    );
    assert.equal(unconfiguredEndpointResponse.headers.get("set-cookie"), null);
    globalThis.__cloudflareEnv.TRIAL_ISSUANCE_SECRET =
      "test-secret-with-at-least-thirty-two-characters";

    const crossOriginResponse = await worker.fetch(
      new Request("https://torudake-reel.pages.dev/api/session/trial", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
    assert.equal(crossOriginResponse.status, 403);
    assert.equal(crossOriginResponse.headers.get("set-cookie"), null);
  } finally {
    delete globalThis.__cloudflareEnv;
  }
});
