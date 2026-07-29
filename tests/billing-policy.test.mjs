import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseBillingBucket,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  LIGHT_MONTHLY_VIDEO_LIMIT,
} from "../lib/billing-policy.ts";

const emptyUsage = {
  freeVideosUsed: 0,
  freeSecondsUsed: 0,
  monthlyVideosUsed: 0,
  monthlyPlanActive: false,
  oneTimeCreditsRemaining: 0,
};

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
