import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createOneTimePaymentNotification,
  createPaidInvoiceNotification,
  LinePaymentNotificationError,
  formatPaymentNotification,
  sendLinePaymentNotification,
} from "../lib/line-payment-notifications.ts";

const configuredBindings = {
  LINE_PAYMENT_NOTIFICATION_ENABLED: "true",
  LINE_PAYMENT_NOTIFICATION_ACCESS_TOKEN: "a".repeat(64),
  LINE_PAYMENT_NOTIFICATION_TO: `U${"b".repeat(32)}`,
};

const notification = {
  amount: 200,
  billingReason: "one_time",
  currency: "jpy",
  occurredAt: 1_787_670_000,
  plan: "one_time",
};

test("keeps LINE payment notifications off unless explicitly enabled", async () => {
  let calls = 0;
  const result = await sendLinePaymentNotification(
    notification,
    "evt_test_payment_disabled",
    {
      bindings: {},
      fetcher: async () => {
        calls += 1;
        return new Response();
      },
    },
  );
  assert.deepEqual(result, {
    outcome: "disabled",
    requestId: null,
    status: null,
  });
  assert.equal(calls, 0);
});

test("sends one privacy-minimal operator message with a stable retry key", async () => {
  const requests = [];
  const fetcher = async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response("{}", {
      status: 200,
      headers: { "x-line-request-id": "line-request-0001" },
    });
  };
  const eventId = "evt_test_payment_0001";
  const first = await sendLinePaymentNotification(notification, eventId, {
    bindings: configuredBindings,
    fetcher,
  });
  const second = await sendLinePaymentNotification(notification, eventId, {
    bindings: configuredBindings,
    fetcher,
  });

  assert.equal(first.outcome, "sent");
  assert.equal(first.requestId, "line-request-0001");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].input, "https://api.line.me/v2/bot/message/push");
  assert.equal(
    requests[0].init.headers["X-Line-Retry-Key"],
    requests[1].init.headers["X-Line-Retry-Key"],
  );
  assert.match(
    requests[0].init.headers["X-Line-Retry-Key"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.to, configuredBindings.LINE_PAYMENT_NOTIFICATION_TO);
  assert.equal(body.messages.length, 1);
  assert.match(body.messages[0].text, /1動画作成/);
  assert.match(body.messages[0].text, /￥200/);
  assert.doesNotMatch(body.messages[0].text, /@|cus_|pi_|姓名|カード/);
  assert.equal(second.status, 200);
});

test("retries a transient LINE failure with the same idempotency key", async () => {
  const retryKeys = [];
  const result = await sendLinePaymentNotification(
    {
      ...notification,
      amount: 1_000,
      billingReason: "subscription_cycle",
      plan: "standard",
    },
    "evt_test_payment_retry",
    {
      bindings: configuredBindings,
      fetcher: async (_input, init) => {
        retryKeys.push(init.headers["X-Line-Retry-Key"]);
        return retryKeys.length === 1
          ? new Response(null, { status: 503 })
          : new Response("{}", {
              status: 409,
              headers: { "x-line-request-id": "line-request-0002" },
            });
      },
    },
  );
  assert.equal(result.outcome, "duplicate");
  assert.equal(result.status, 409);
  assert.equal(retryKeys.length, 2);
  assert.equal(retryKeys[0], retryKeys[1]);
});

test("fails safely when enabled notification credentials are incomplete", async () => {
  await assert.rejects(
    sendLinePaymentNotification(notification, "evt_test_payment_invalid", {
      bindings: { LINE_PAYMENT_NOTIFICATION_ENABLED: "true" },
    }),
    (error) =>
      error instanceof LinePaymentNotificationError &&
      error.code === "line_payment_notification_not_configured",
  );
});

test("formats a subscription renewal without customer or payment identifiers", () => {
  const text = formatPaymentNotification(
    {
      ...notification,
      amount: 500,
      billingReason: "subscription_cycle",
      plan: "starter",
    },
    "evt_test_payment_display_123456789012",
  );
  assert.match(text, /月3動画プラン/);
  assert.match(text, /月額プラン更新/);
  assert.match(text, /123456789012/);
  assert.doesNotMatch(text, /evt_test_payment_display/);
});

test("describes only positive JPY payments from verified Stripe event shapes", () => {
  assert.deepEqual(
    createOneTimePaymentNotification(
      { amount_total: 200, currency: "jpy", payment_status: "paid" },
      notification.occurredAt,
    ),
    notification,
  );
  assert.equal(
    createOneTimePaymentNotification(
      { amount_total: 0, currency: "jpy", payment_status: "paid" },
      notification.occurredAt,
    ),
    null,
  );
  assert.equal(
    createOneTimePaymentNotification(
      { amount_total: 200, currency: "jpy", payment_status: "unpaid" },
      notification.occurredAt,
    ),
    null,
  );
  assert.deepEqual(
    createPaidInvoiceNotification(
      {
        amount_paid: 500,
        currency: "JPY",
        billing_reason: "subscription_cycle",
      },
      "starter",
      notification.occurredAt,
    ),
    {
      amount: 500,
      billingReason: "subscription_cycle",
      currency: "jpy",
      occurredAt: notification.occurredAt,
      plan: "starter",
    },
  );
  assert.equal(
    createPaidInvoiceNotification(
      { amount_paid: 500, currency: "usd" },
      "starter",
      notification.occurredAt,
    ),
    null,
  );
});

test("Stripe finishes billing state even when LINE delivery is best effort", async () => {
  const [webhook, exampleEnv, billingDoc] = await Promise.all([
    readFile(new URL("../app/api/billing/webhook/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../docs/billing/stripe.md", import.meta.url), "utf8"),
  ]);
  assert.ok(
    webhook.indexOf("await deliverPaymentNotification(") <
      webhook.indexOf("await finishStripeEvent(event.id)"),
  );
  assert.match(webhook, /catch \(error\)[\s\S]*line_payment_notification_failed/);
  for (const name of [
    "LINE_PAYMENT_NOTIFICATION_ENABLED",
    "LINE_PAYMENT_NOTIFICATION_ACCESS_TOKEN",
    "LINE_PAYMENT_NOTIFICATION_TO",
  ]) {
    assert.match(exampleEnv, new RegExp(`^${name}=`, "m"));
    assert.match(billingDoc, new RegExp(name));
  }
});
