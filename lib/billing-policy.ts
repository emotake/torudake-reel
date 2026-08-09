export const FREE_VIDEO_LIMIT = 2;
export const FREE_SECONDS_LIMIT = 180;
export const LIGHT_MONTHLY_VIDEO_LIMIT = 8;
export const LIGHT_MONTHLY_PRICE_JPY = 1480;
export const ONE_TIME_PRICE_JPY = 200;
export const OPERATOR_DAILY_VIDEO_LIMIT = 20;

export type BillingUsageSnapshot = {
  freeVideosUsed: number;
  freeSecondsUsed: number;
  monthlyVideosUsed: number;
  monthlyPlanActive: boolean;
  oneTimeCreditsRemaining: number;
  operatorActive?: boolean;
  operatorVideosUsedToday?: number;
};

export type BillingBucket =
  | "free"
  | "subscription"
  | "one_time"
  | "operator";

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
    usage.monthlyVideosUsed < LIGHT_MONTHLY_VIDEO_LIMIT
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
