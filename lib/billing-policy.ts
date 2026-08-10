export const FREE_VIDEO_LIMIT = 2;
export const FREE_SECONDS_LIMIT = 180;
export const STARTER_MONTHLY_VIDEO_LIMIT = 3;
export const STARTER_MONTHLY_PRICE_JPY = 500;
export const STANDARD_MONTHLY_VIDEO_LIMIT = 7;
export const STANDARD_MONTHLY_PRICE_JPY = 1000;
export const LEGACY_MONTHLY_VIDEO_LIMIT = 8;
export const LEGACY_MONTHLY_PRICE_JPY = 1480;
// Temporary source compatibility while the UI migrates from the former
// single "light" plan. New billing code must use a concrete plan key.
export const LIGHT_MONTHLY_VIDEO_LIMIT = STANDARD_MONTHLY_VIDEO_LIMIT;
export const LIGHT_MONTHLY_PRICE_JPY = STANDARD_MONTHLY_PRICE_JPY;
export const ONE_TIME_PRICE_JPY = 200;
export const OPERATOR_DAILY_VIDEO_LIMIT = 20;
export const FREE_AI_OPERATION_SUCCESS_LIMIT = 3;
export const SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT = 6;
export const ONE_TIME_AI_OPERATION_SUCCESS_LIMIT = 5;
export const OPERATOR_AI_OPERATION_SUCCESS_LIMIT = 10;

export type MonthlyPlanKey = "starter" | "standard" | "legacy_1480";

export const MONTHLY_PLANS = {
  starter: {
    key: "starter",
    priceJpy: STARTER_MONTHLY_PRICE_JPY,
    videoLimit: STARTER_MONTHLY_VIDEO_LIMIT,
    purchasable: true,
  },
  standard: {
    key: "standard",
    priceJpy: STANDARD_MONTHLY_PRICE_JPY,
    videoLimit: STANDARD_MONTHLY_VIDEO_LIMIT,
    purchasable: true,
  },
  legacy_1480: {
    key: "legacy_1480",
    priceJpy: LEGACY_MONTHLY_PRICE_JPY,
    videoLimit: LEGACY_MONTHLY_VIDEO_LIMIT,
    purchasable: false,
  },
} as const satisfies Record<
  MonthlyPlanKey,
  {
    key: MonthlyPlanKey;
    priceJpy: number;
    videoLimit: number;
    purchasable: boolean;
  }
>;

export function isMonthlyPlanKey(value: unknown): value is MonthlyPlanKey {
  return (
    value === "starter" ||
    value === "standard" ||
    value === "legacy_1480"
  );
}

export function monthlyPlanVideoLimit(planKey: MonthlyPlanKey) {
  return MONTHLY_PLANS[planKey].videoLimit;
}

export type BillingUsageSnapshot = {
  freeVideosUsed: number;
  freeSecondsUsed: number;
  monthlyVideosUsed: number;
  monthlyPlanActive: boolean;
  monthlyVideoLimit: number;
  oneTimeCreditsRemaining: number;
  operatorActive?: boolean;
  operatorVideosUsedToday?: number;
};

export type BillingBucket =
  | "free"
  | "subscription"
  | "one_time"
  | "operator";

export function getAiOperationSuccessLimit(bucket: BillingBucket) {
  switch (bucket) {
    case "free":
      return FREE_AI_OPERATION_SUCCESS_LIMIT;
    case "subscription":
      return SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT;
    case "one_time":
      return ONE_TIME_AI_OPERATION_SUCCESS_LIMIT;
    case "operator":
      return OPERATOR_AI_OPERATION_SUCCESS_LIMIT;
  }
}

export function isBillingBucket(value: unknown): value is BillingBucket {
  return (
    value === "free" ||
    value === "subscription" ||
    value === "one_time" ||
    value === "operator"
  );
}

export function canSaveCompletedVideo(
  bucket: BillingBucket | null,
): boolean {
  return bucket !== null && bucket !== "free";
}

export function chooseBillingBucket(
  usage: BillingUsageSnapshot,
  sourceDurationSeconds: number,
): BillingBucket | null {
  if (usage.operatorActive) {
    return (usage.operatorVideosUsedToday ?? 0) <
      OPERATOR_DAILY_VIDEO_LIMIT
      ? "operator"
      : null;
  }

  if (
    usage.monthlyPlanActive &&
    usage.monthlyVideosUsed < usage.monthlyVideoLimit
  ) {
    return "subscription";
  }

  if (usage.oneTimeCreditsRemaining > 0) {
    return "one_time";
  }

  const roundedDuration = Math.max(1, Math.ceil(sourceDurationSeconds));
  if (
    usage.freeVideosUsed < FREE_VIDEO_LIMIT &&
    usage.freeSecondsUsed + roundedDuration <= FREE_SECONDS_LIMIT
  ) {
    return "free";
  }

  return null;
}

export function startOfTokyoDaySeconds(nowSeconds: number) {
  const secondsPerDay = 24 * 60 * 60;
  const tokyoOffsetSeconds = 9 * 60 * 60;
  return (
    Math.floor((nowSeconds + tokyoOffsetSeconds) / secondsPerDay) *
      secondsPerDay -
    tokyoOffsetSeconds
  );
}
