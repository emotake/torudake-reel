export const CLIENT_PRODUCT_EVENTS = [
  "demo_started",
  "video_selected",
  "preview_completed",
  "preview_failed",
  "pricing_viewed",
  "checkout_started",
  "draft_recovery_shown",
  "draft_recovered",
  "draft_cleared",
  "voice_sample_played",
  "export_started",
  "export_completed",
  "export_failed",
  "feedback_submitted",
] as const;

export const SERVER_PRODUCT_EVENTS = [
  "checkout_session_created",
  "checkout_session_failed",
  "stripe_purchase_completed",
  "stripe_purchase_failed",
  "stripe_subscription_updated",
  "stripe_refund_updated",
  "stripe_refund_failed",
  "stripe_dispute_updated",
  "ai_operation_succeeded",
  "ai_operation_failed",
] as const;

export type ClientProductEvent = (typeof CLIENT_PRODUCT_EVENTS)[number];
export type ServerProductEvent = (typeof SERVER_PRODUCT_EVENTS)[number];
export type ProductEventName = ClientProductEvent | ServerProductEvent;

const CLIENT_EVENT_SET = new Set<string>(CLIENT_PRODUCT_EVENTS);

const STRING_PROPERTY_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  mode: new Set(["spoken", "narration", "photo"]),
  duration_bucket: new Set([
    "up_to_15s",
    "16_to_30s",
    "31_to_60s",
    "61_to_90s",
    "over_90s",
    "unknown",
    "0_30s",
    "31_60s",
    "61_90s",
    "91_180s",
    "over_180s",
  ]),
  format: new Set(["mp4", "mov", "m4v", "webm", "other"]),
  plan: new Set([
    "starter",
    "standard",
    "one_time",
    "light",
    "legacy_1480",
    "unknown",
  ]),
  source: new Set(["landing", "result", "hero_video"]),
  voice: new Set(["bright", "calm", "comedy", "party"]),
  rating: new Set(["helpful", "needs_work"]),
  context: new Set(["preview", "export", "checkout", "general"]),
  outcome: new Set([
    "created",
    "failed",
    "completed",
    "synchronized",
    "paid",
    "no_payment_required",
    "high_accuracy",
    "standard",
    "silent_no_caption",
    "auto_cut",
    "no_cut",
    "result_settings",
    "setup_settings",
    "silent",
  ]),
  error_code: new Set([
    "stripe_checkout_failed",
    "upstream_rate_limited",
    "upstream_client_error",
    "upstream_server_error",
  ]),
  operation: new Set([
    "transcribe",
    "narration_initial",
    "narration_script",
    "narration_speech",
  ]),
  bucket: new Set(["free", "monthly", "one_time", "operator", "none"]),
  status: new Set([
    "unknown",
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "warning_needs_response",
    "warning_under_review",
    "warning_closed",
    "needs_response",
    "under_review",
    "won",
    "lost",
    "prevented",
  ]),
  stripe_mode: new Set(["live", "test", "unconfigured"]),
};

const INTEGER_PROPERTY_RANGES: Readonly<
  Record<string, Readonly<{ minimum: number; maximum: number }>>
> = {
  credits: { minimum: 0, maximum: 10_000 },
  count: { minimum: 0, maximum: 10_000 },
};

const FEEDBACK_TAGS = new Set([
  "easy",
  "quality",
  "captions",
  "voice",
  "cut",
  "export",
  "other",
]);

const MAX_PROPERTIES = 10;

export type SafePropertyValue = string | number | string[];
export type SafeProductProperties = Record<string, SafePropertyValue>;

export function isClientProductEvent(value: unknown): value is ClientProductEvent {
  return typeof value === "string" && CLIENT_EVENT_SET.has(value);
}

export function productDurationBucket(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds <= 15) return "up_to_15s";
  if (seconds <= 30) return "16_to_30s";
  if (seconds <= 60) return "31_to_60s";
  if (seconds <= 90) return "61_to_90s";
  return "over_90s";
}

export function productUpstreamErrorCode(status: number) {
  if (status === 429) return "upstream_rate_limited";
  if (status >= 500) return "upstream_server_error";
  return "upstream_client_error";
}

/**
 * Accepts only finite, documented analytics dimensions. String length checks
 * alone are intentionally insufficient because short filenames, names, and
 * excerpts can still be personal or media content.
 */
export function sanitizeProductProperties(value: unknown): SafeProductProperties | null {
  if (value === undefined) return {};
  if (!isPlainRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_PROPERTIES) return null;
  const safe: SafeProductProperties = {};
  for (const [key, raw] of entries) {
    const allowedStrings = STRING_PROPERTY_VALUES[key];
    if (allowedStrings) {
      if (typeof raw !== "string" || !allowedStrings.has(raw)) return null;
      safe[key] = raw;
      continue;
    }

    const integerRange = INTEGER_PROPERTY_RANGES[key];
    if (integerRange) {
      if (
        typeof raw !== "number" ||
        !Number.isSafeInteger(raw) ||
        raw < integerRange.minimum ||
        raw > integerRange.maximum
      ) {
        return null;
      }
      safe[key] = raw;
      continue;
    }

    if (
      key === "tags" &&
      Array.isArray(raw) &&
      raw.length <= 5 &&
      raw.every((item) => typeof item === "string" && FEEDBACK_TAGS.has(item))
    ) {
      safe[key] = [...new Set(raw as string[])];
      continue;
    }
    return null;
  }
  return safe;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
