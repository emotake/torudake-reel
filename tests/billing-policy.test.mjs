import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseBillingBucket,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  LIGHT_MONTHLY_PRICE_JPY,
  LIGHT_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PRICE_JPY,
  OPERATOR_DAILY_VIDEO_LIMIT,
  startOfTokyoDaySeconds,
} from "../lib/billing-policy.ts";

const emptyUsage = {
  freeVideosUsed: 0,
  freeSecondsUsed: 0,
  monthlyVideosUsed: 0,
  monthlyPlanActive: false,
  oneTimeCreditsRemaining: 0,
};

test("keeps the simple launch pricing in one policy", () => {
  assert.equal(LIGHT_MONTHLY_VIDEO_LIMIT, 8);
  assert.equal(LIGHT_MONTHLY_PRICE_JPY, 1480);
  assert.equal(ONE_TIME_PRICE_JPY, 200);
  assert.equal(
    Math.floor(LIGHT_MONTHLY_PRICE_JPY / LIGHT_MONTHLY_VIDEO_LIMIT),
    185,
  );
});

test("stops the free trial at either two videos or three minutes", () => {
  assert.equal(
    chooseBillingBucket(emptyUsage, 90),
    "free",
  );
  assert.equal(
    chooseBillingBucket(
      {
        ...emptyUsage,
        freeVideosUsed: FREE_VIDEO_LIMIT,
      },
      10,
    ),
    null,
  );
  assert.equal(
    chooseBillingBucket(
      {
        ...emptyUsage,
        freeVideosUsed: 1,
        freeSecondsUsed: FREE_SECONDS_LIMIT - 10,
      },
      11,
    ),
    null,
  );
});

test("uses monthly allowance before one-time credits", () => {
  assert.equal(
    chooseBillingBucket(
      {
        ...emptyUsage,
        monthlyPlanActive: true,
        monthlyVideosUsed: LIGHT_MONTHLY_VIDEO_LIMIT - 1,
        oneTimeCreditsRemaining: 2,
      },
      90,
    ),
    "subscription",
  );
  assert.equal(
    chooseBillingBucket(
      {
        ...emptyUsage,
        monthlyPlanActive: true,
        monthlyVideosUsed: LIGHT_MONTHLY_VIDEO_LIMIT,
        oneTimeCreditsRemaining: 2,
      },
      90,
    ),
    "one_time",
  );
});

test("uses the operator allowance without consuming customer buckets", () => {
  assert.equal(
    chooseBillingBucket(
      {
        ...emptyUsage,
        freeVideosUsed: FREE_VIDEO_LIMIT,
        monthlyPlanActive: true,
        monthlyVideosUsed: LIGHT_MONTHLY_VIDEO_LIMIT,
        oneTimeCreditsRemaining: 3,
        operatorActive: true,
        operatorVideosUsedToday: OPERATOR_DAILY_VIDEO_LIMIT - 1,
      },
      600,
    ),
    "operator",
  );
});

test("stops at the operator safety limit without falling back to paid or free buckets", () => {
  assert.equal(
    chooseBillingBucket(
      {
        ...emptyUsage,
        monthlyPlanActive: true,
        oneTimeCreditsRemaining: 3,
        operatorActive: true,
        operatorVideosUsedToday: OPERATOR_DAILY_VIDEO_LIMIT,
      },
      30,
    ),
    null,
  );
});

test("starts the operator day at midnight in Japan", () => {
  const beforeMidnight = Date.parse("2026-07-31T14:59:59Z") / 1_000;
  const afterMidnight = Date.parse("2026-07-31T15:00:00Z") / 1_000;

  assert.equal(
    startOfTokyoDaySeconds(beforeMidnight),
    Date.parse("2026-07-30T15:00:00Z") / 1_000,
  );
  assert.equal(
    startOfTokyoDaySeconds(afterMidnight),
    Date.parse("2026-07-31T15:00:00Z") / 1_000,
  );
});
