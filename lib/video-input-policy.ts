export const MAX_VIDEO_INPUT_DURATION_SECONDS = 5 * 60;

export type VideoInputDurationResult =
  | {
      ok: true;
      durationSeconds: number;
    }
  | {
      ok: false;
      code: "invalid_video_duration" | "video_duration_too_long";
      message: string;
      maximumSeconds: number;
    };

/**
 * Applies the product-wide source-video length ceiling. Five minutes exactly
 * is valid; even a fractional amount beyond 300 seconds is rejected.
 */
export function validateVideoInputDuration(
  value: unknown,
): VideoInputDurationResult {
  const durationSeconds = Number(value);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return {
      ok: false,
      code: "invalid_video_duration",
      message:
        "動画の長さを確認できませんでした。動画を選び直して、もう一度お試しください。",
      maximumSeconds: MAX_VIDEO_INPUT_DURATION_SECONDS,
    };
  }
  if (durationSeconds > MAX_VIDEO_INPUT_DURATION_SECONDS) {
    return {
      ok: false,
      code: "video_duration_too_long",
      message:
        "動画は5分（300秒）まで利用できます。300秒を超える動画は、5分以内に短くしてお試しください。",
      maximumSeconds: MAX_VIDEO_INPUT_DURATION_SECONDS,
    };
  }
  return { ok: true, durationSeconds };
}
