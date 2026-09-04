import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CLIENT_PRODUCT_EVENTS,
  getProductActorHash,
  isClientProductEvent,
  productDurationBucket,
  sanitizeProductProperties,
} from "../lib/product-analytics.ts";
import { POST as postProductEvent } from "../app/api/events/route.ts";
import { POST as postProductFeedback } from "../app/api/feedback/route.ts";
import { describeStripeProductTelemetry } from "../lib/stripe-product-analytics.ts";

test("accepts only the bounded product funnel vocabulary", () => {
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("acquisition_landing"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("video_selected"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("checkout_started"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("purchase_options_shown"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("one_time_rescue_revealed"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("export_completed"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("video_mix_narration_started"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("video_mix_paywall_shown"));
  assert.ok(CLIENT_PRODUCT_EVENTS.includes("video_mix_add_failed"));
  assert.equal(isClientProductEvent("video_selected"), true);
  assert.equal(isClientProductEvent("arbitrary_event"), false);
});

test("groups durations without recording exact media length", () => {
  assert.equal(productDurationBucket(15), "up_to_15s");
  assert.equal(productDurationBucket(30), "16_to_30s");
  assert.equal(productDurationBucket(61), "61_to_90s");
  assert.equal(productDurationBucket(Number.NaN), "unknown");
});

test("keeps product properties content-free and bounded", () => {
  assert.deepEqual(
    sanitizeProductProperties({
      mode: "narration",
      duration_bucket: "31_to_60s",
      format: "mov",
      count: 2,
      tags: ["voice", "quality"],
    }),
    {
      mode: "narration",
      duration_bucket: "31_to_60s",
      format: "mov",
      count: 2,
      tags: ["voice", "quality"],
    },
  );
  assert.deepEqual(
    sanitizeProductProperties({
      traffic_source: "instagram",
      traffic_medium: "organic_social",
      traffic_campaign: "recognition_202609",
      traffic_content: "daily_a",
    }),
    {
      traffic_source: "instagram",
      traffic_medium: "organic_social",
      traffic_campaign: "recognition_202609",
      traffic_content: "daily_a",
    },
  );
  assert.deepEqual(
    sanitizeProductProperties({
      mode: "photo",
      plan: "one_time",
      source: "result",
      offer_version: "monthly_primary_rescue_v1",
    }),
    {
      mode: "photo",
      plan: "one_time",
      source: "result",
      offer_version: "monthly_primary_rescue_v1",
    },
  );
  assert.deepEqual(sanitizeProductProperties({ source: "pricing" }), {
    source: "pricing",
  });
  assert.deepEqual(sanitizeProductProperties({ source: "account" }), {
    source: "account",
  });

  assert.deepEqual(
    sanitizeProductProperties({
      mode: "video_mix",
      transition: "zoom-dissolve",
      narration: "enabled",
      source_count: 5,
      clip_count: 10,
      boundary_count: 9,
    }),
    {
      mode: "video_mix",
      transition: "zoom-dissolve",
      narration: "enabled",
      source_count: 5,
      clip_count: 10,
      boundary_count: 9,
    },
  );
  assert.equal(sanitizeProductProperties({ email: "person@example.com" }), null);
  assert.equal(sanitizeProductProperties({ filename: "private.mov" }), null);
  assert.equal(sanitizeProductProperties({ transcript: "spoken content" }), null);
  assert.equal(sanitizeProductProperties({ mode: "x".repeat(49) }), null);
  assert.equal(sanitizeProductProperties({ source: "山田太郎" }), null);
  assert.equal(
    sanitizeProductProperties({ offer_version: "unreviewed_experiment" }),
    null,
  );
  assert.equal(sanitizeProductProperties({ status: "private caption excerpt" }), null);
  assert.equal(sanitizeProductProperties({ count: -1 }), null);
  assert.equal(sanitizeProductProperties({ count: 10_001 }), null);
  assert.equal(sanitizeProductProperties({ tags: Array(6).fill("quality") }), null);
});

test("rejects non-object JSON before either public endpoint reaches storage", async () => {
  for (const payload of [null, [], "text", 42, true]) {
    const eventResponse = await postProductEvent(
      localJsonRequest("/api/events", payload),
    );
    assert.equal(eventResponse.status, 400);
    assert.equal((await eventResponse.json()).error, "invalid_json");

    const feedbackResponse = await postProductFeedback(
      localJsonRequest("/api/feedback", payload),
    );
    assert.equal(feedbackResponse.status, 400);
    assert.equal((await feedbackResponse.json()).error, "invalid_json");
  }
});

test("rejects content disguised as an allowed analytics dimension", async () => {
  const response = await postProductEvent(
    localJsonRequest("/api/events", {
      event: "video_selected",
      properties: { source: "private filename.mov" },
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_properties");
});

test("public collection endpoints enforce origin and byte limits before storage", async () => {
  const wrongOrigin = await postProductEvent(
    new Request("https://torudake-reel.pages.dev/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ event: "demo_started", properties: {} }),
    }),
  );
  assert.equal(wrongOrigin.status, 403);

  const oversizedEvent = await postProductEvent(
    new Request("http://localhost/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ padding: "x".repeat(4_096) }),
    }),
  );
  assert.equal(oversizedEvent.status, 413);

  const oversizedFeedback = await postProductFeedback(
    new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ padding: "x".repeat(2_048) }),
    }),
  );
  assert.equal(oversizedFeedback.status, 413);
});

test("network actor hashes cannot be changed by rotating client cookies", async () => {
  const commonHeaders = {
    "cf-connecting-ip": "203.0.113.20",
    origin: "http://localhost",
  };
  const first = await getProductActorHash(
    new Request("http://localhost/api/events", {
      headers: { ...commonHeaders, cookie: "torudake_trial_id=first" },
    }),
  );
  const rotated = await getProductActorHash(
    new Request("http://localhost/api/events", {
      headers: { ...commonHeaders, cookie: "torudake_trial_id=second" },
    }),
  );
  const otherNetwork = await getProductActorHash(
    new Request("http://localhost/api/events", {
      headers: { ...commonHeaders, "cf-connecting-ip": "203.0.113.21" },
    }),
  );
  assert.equal(first, rotated);
  assert.notEqual(first, otherNetwork);
});

test("production actor hashing fails closed without a configured secret", async () => {
  await assert.rejects(
    getProductActorHash(
      new Request("https://torudake-reel.pages.dev/api/events", {
        headers: { "cf-connecting-ip": "203.0.113.20" },
      }),
    ),
    /hashing secret is unavailable/i,
  );
});

test("Stripe telemetry counts only successful payment and separates money states", () => {
  const delayed = {
    metadata: { plan: "one_time" },
    payment_status: "unpaid",
  };
  assert.equal(
    describeStripeProductTelemetry("checkout.session.completed", delayed),
    null,
  );
  assert.deepEqual(
    describeStripeProductTelemetry("checkout.session.async_payment_succeeded", {
      ...delayed,
      payment_status: "paid",
    }),
    {
      eventName: "stripe_purchase_completed",
      properties: { plan: "one_time", outcome: "paid" },
    },
  );
  assert.deepEqual(
    describeStripeProductTelemetry("checkout.session.completed", {
      metadata: { plan: "light" },
      payment_status: "paid",
    }),
    {
      eventName: "stripe_purchase_completed",
      properties: { plan: "light", outcome: "paid" },
    },
  );
  assert.deepEqual(
    describeStripeProductTelemetry("refund.failed", { status: "failed" }),
    {
      eventName: "stripe_refund_failed",
      properties: { status: "failed", outcome: "synchronized" },
    },
  );
  assert.deepEqual(
    describeStripeProductTelemetry("charge.dispute.updated", {
      status: "under_review",
    }),
    {
      eventName: "stripe_dispute_updated",
      properties: { status: "under_review", outcome: "synchronized" },
    },
  );
});

test("telemetry and feedback endpoints cap bodies, origins, rates and retention", async () => {
  const [events, feedback, helper, migration] = await Promise.all([
    readFile(new URL("../app/api/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/feedback/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/product-analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0017_zippy_vermin.sql", import.meta.url), "utf8"),
  ]);
  assert.match(events, /MAX_EVENT_BODY_BYTES = 4 \* 1024/);
  assert.match(events, /isSameOriginProductEvent\(request\)/);
  assert.match(helper, /CLIENT_RATE_LIMIT = 60/);
  assert.match(helper, /EVENT_RETENTION_SECONDS = 90/);
  assert.match(feedback, /FEEDBACK_DAILY_LIMIT = 10/);
  assert.match(feedback, /FEEDBACK_RETENTION_SECONDS = 180/);
  assert.doesNotMatch(feedback, /comment\??:/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `product_events`/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `product_feedback`/);
  assert.match(migration, /PRAGMA optimize/);
});

test("billing and AI telemetry remains best-effort and contains no content", async () => {
  const helper = await readFile(
    new URL("../lib/product-analytics.ts", import.meta.url),
    "utf8",
  );
  assert.match(helper, /Analytics must never interrupt|return false/);
  assert.match(helper, /console\.warn\("product telemetry unavailable"/);
  assert.doesNotMatch(helper, /properties\.(?:transcript|script|filename|email)/);
});

function localJsonRequest(path, payload) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(payload),
  });
}
