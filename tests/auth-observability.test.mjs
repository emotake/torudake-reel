import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLineAuthenticationCompletion,
  lineAuthenticationError,
  logLineAuthenticationEvent,
  safeAuthenticationErrorCode,
} from "../lib/auth-observability.ts";

test("LINE authentication events are structured, correlated and privacy safe", () => {
  const consoleEvents = [];
  const analyticsEvents = [];
  const originalInfo = console.info;
  console.info = (event) => consoleEvents.push(event);
  try {
    const request = new Request(
      "https://torudake-reel.pages.dev/api/account/oauth/line/callback/finalize?code=secret-code&state=secret-state&email=secret%40example.test",
      {
        method: "POST",
        headers: {
          "x-request-id": "eyJhbGciOiJIUzI1NiJ9.attacker-controlled",
          "x-correlation-id": "attacker-correlation-12345678",
          "cf-ray": "ray-12345678",
          cookie: "secret-cookie",
          "user-agent": "secret-user-agent",
        },
      },
    );
    logLineAuthenticationEvent(
      request,
      {
        event: "line_oidc_completion_failed",
        operation: "finalize",
        severity: "info",
        outcome: "failed",
        status: 400,
        errorCode: "oidc_state_mismatch",
      },
      { writeDataPoint: (event) => analyticsEvents.push(event) },
    );
  } finally {
    console.info = originalInfo;
  }

  assert.equal(consoleEvents.length, 1);
  assert.match(consoleEvents[0].requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(consoleEvents[0].correlationId, consoleEvents[0].requestId);
  assert.deepEqual(
    {
      component: consoleEvents[0].component,
      event: consoleEvents[0].event,
      operation: consoleEvents[0].operation,
      outcome: consoleEvents[0].outcome,
      status: consoleEvents[0].status,
      errorCode: consoleEvents[0].errorCode,
      requestId: consoleEvents[0].requestId,
      correlationId: consoleEvents[0].correlationId,
      path: consoleEvents[0].path,
    },
    {
      component: "authentication",
      event: "line_oidc_completion_failed",
      operation: "finalize",
      outcome: "failed",
      status: 400,
      errorCode: "oidc_state_mismatch",
      requestId: consoleEvents[0].requestId,
      correlationId: consoleEvents[0].requestId,
      path: "/api/account/oauth/line/callback/finalize",
    },
  );
  assert.deepEqual(analyticsEvents, [
    {
      indexes: ["line"],
      blobs: [
        "1",
        "line_oidc_completion_failed",
        "info",
        "finalize",
        "failed",
        "oidc_state_mismatch",
        "POST",
        "/api/account/oauth/line/callback/finalize",
        consoleEvents[0].requestId,
        consoleEvents[0].requestId,
      ],
      doubles: [400],
    },
  ]);

  const serialized = JSON.stringify({ consoleEvents, analyticsEvents });
  for (const secret of [
    "secret-code",
    "secret-state",
    "secret@example.test",
    "secret-cookie",
    "secret-user-agent",
    "eyJhbGciOiJIUzI1NiJ9.attacker-controlled",
    "attacker-correlation-12345678",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("LINE callback completion classification never copies arbitrary locations", () => {
  const cancelled = classifyLineAuthenticationCompletion(
    new Response(null, {
      status: 303,
      headers: {
        location: "/account?auth_error=cancelled&code=must-not-appear",
      },
    }),
  );
  assert.deepEqual(cancelled, {
    event: "line_oidc_completion_cancelled",
    severity: "info",
    outcome: "cancelled",
    errorCode: "cancelled",
  });

  assert.deepEqual(
    classifyLineAuthenticationCompletion(
      new Response(null, {
        status: 400,
        headers: { "x-torudake-auth-outcome": "cancelled" },
      }),
    ),
    {
      event: "line_oidc_completion_cancelled",
      severity: "info",
      outcome: "cancelled",
      errorCode: "cancelled",
    },
  );

  assert.deepEqual(
    classifyLineAuthenticationCompletion(new Response(null, { status: 502 })),
    {
      event: "line_oidc_completion_failed",
      severity: "error",
      outcome: "failed",
      errorCode: "oidc_callback_failed",
    },
  );
  assert.deepEqual(
    classifyLineAuthenticationCompletion(new Response(null, { status: 200 })),
    {
      event: "line_oidc_completion_succeeded",
      severity: "info",
      outcome: "succeeded",
      errorCode: undefined,
    },
  );
  assert.deepEqual(
    classifyLineAuthenticationCompletion(
      new Response(null, {
        status: 200,
        headers: { "x-torudake-auth-outcome": "state=must-not-appear" },
      }),
    ),
    {
      event: "line_oidc_completion_succeeded",
      severity: "info",
      outcome: "succeeded",
      errorCode: undefined,
    },
  );
});

test("authentication error normalization accepts only bounded machine codes", () => {
  assert.equal(safeAuthenticationErrorCode("oidc_state_mismatch"), "oidc_state_mismatch");
  assert.equal(safeAuthenticationErrorCode("TOKEN=secret"), undefined);
  assert.deepEqual(lineAuthenticationError({ code: "known_failure", status: 429 }), {
    errorCode: "known_failure",
    status: 429,
  });
  assert.deepEqual(
    lineAuthenticationError({ code: "TOKEN=secret", status: 200 }),
    { errorCode: "oidc_unexpected_error", status: 500 },
  );
});

test("Analytics Engine write failure degrades to a safe warning", () => {
  const warnings = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (event) => warnings.push(event);
  console.info = () => undefined;
  try {
    logLineAuthenticationEvent(
      new Request("https://example.test/api/account/oauth/line/start"),
      {
        event: "line_oidc_start_succeeded",
        operation: "start",
        severity: "info",
        outcome: "succeeded",
        status: 302,
      },
      {
        writeDataPoint() {
          throw new Error("provider token must-not-appear");
        },
      },
    );
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "line_auth_analytics_write_failed");
  assert.doesNotMatch(JSON.stringify(warnings), /must-not-appear/u);
});

test("a missing Analytics Engine binding is visible without failing authentication", () => {
  const warnings = [];
  const originalWarn = console.warn;
  const originalInfo = console.info;
  console.warn = (event) => warnings.push(event);
  console.info = () => undefined;
  try {
    assert.doesNotThrow(() =>
      logLineAuthenticationEvent(
        new Request("https://example.test/api/account/oauth/line/start"),
        {
          event: "line_oidc_start_succeeded",
          operation: "start",
          severity: "info",
          outcome: "succeeded",
          status: 302,
        },
        undefined,
      ),
    );
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "line_auth_analytics_binding_missing");
  assert.doesNotMatch(JSON.stringify(warnings), /authorization|cookie|email|subject/u);
});
