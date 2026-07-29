export const FREE_VIDEO_LIMIT = 2;
export const FREE_SECONDS_LIMIT = 180;
export const LIGHT_MONTHLY_VIDEO_LIMIT = 5;

export type BillingUsageSnapshot = {
  freeVideosUsed: number;
  freeSecondsUsed: number;
  monthlyVideosUsed: number;
  monthlyPlanActive: boolean;
  oneTimeCreditsRemaining: number;
};

export type BillingBucket = "free" | "subscription" | "one_time";

export function chooseBillingBucket(
  usage: BillingUsageSnapshot,
  sourceDurationSeconds: number,
): BillingBucket | null {
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
