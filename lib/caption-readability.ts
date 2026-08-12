import type { CaptionSegment } from "./captions";

/**
 * Shared limits for captions that remain legible on a vertical phone video.
 * They are intentionally platform-neutral: the lower exclusion keeps text
 * clear of the controls and description used by most short-video apps.
 */
export const CAPTION_MIN_DISPLAY_SECONDS = 0.8;
export const CAPTION_MAX_JAPANESE_CHARS_PER_SECOND = 12;
export const CAPTION_VIDEO_SAFE_AREA = Object.freeze({
  leftRatio: 0.07,
  rightRatio: 0.07,
  topRatio: 0.1,
  bottomRatio: 0.2,
});

export type CaptionReadabilityOptions = Readonly<{
  minimumDisplaySeconds?: number;
  maximumCharactersPerSecond?: number;
}>;

export type CaptionReadabilityAssessment = Readonly<{
  characterCount: number;
  displayDurationSeconds: number;
  recommendedDurationSeconds: number;
  charactersPerSecond: number;
  meetsMinimumDuration: boolean;
  meetsReadingSpeed: boolean;
  readable: boolean;
}>;

export type CaptionSafeArea = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}>;

function normalizePositive(
  value: number | undefined,
  fallback: number,
  name: string,
) {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a finite positive number.`);
  }
  return normalized;
}

export function countCaptionReadableCharacters(text: string) {
  return Array.from(text.normalize("NFKC").replace(/\s+/gu, "")).length;
}

export function getRecommendedCaptionDisplayDuration(
  text: string,
  options: CaptionReadabilityOptions = {},
) {
  const minimumDisplaySeconds = normalizePositive(
    options.minimumDisplaySeconds,
    CAPTION_MIN_DISPLAY_SECONDS,
    "minimumDisplaySeconds",
  );
  const maximumCharactersPerSecond = normalizePositive(
    options.maximumCharactersPerSecond,
    CAPTION_MAX_JAPANESE_CHARS_PER_SECOND,
    "maximumCharactersPerSecond",
  );
  const characterCount = countCaptionReadableCharacters(text);
  if (characterCount === 0) return 0;
  return Math.round(
    Math.max(
      minimumDisplaySeconds,
      characterCount / maximumCharactersPerSecond,
    ) * 1_000,
  ) / 1_000;
}

export function assessCaptionReadability(
  caption: Pick<CaptionSegment, "start" | "end" | "text">,
  options: CaptionReadabilityOptions = {},
): CaptionReadabilityAssessment {
  const minimumDisplaySeconds = normalizePositive(
    options.minimumDisplaySeconds,
    CAPTION_MIN_DISPLAY_SECONDS,
    "minimumDisplaySeconds",
  );
  const maximumCharactersPerSecond = normalizePositive(
    options.maximumCharactersPerSecond,
    CAPTION_MAX_JAPANESE_CHARS_PER_SECOND,
    "maximumCharactersPerSecond",
  );
  const characterCount = countCaptionReadableCharacters(caption.text);
  const displayDurationSeconds = Math.max(0, caption.end - caption.start);
  const recommendedDurationSeconds = getRecommendedCaptionDisplayDuration(
    caption.text,
    { minimumDisplaySeconds, maximumCharactersPerSecond },
  );
  const charactersPerSecond =
    displayDurationSeconds > 0
      ? characterCount / displayDurationSeconds
      : characterCount > 0
        ? Number.POSITIVE_INFINITY
        : 0;
  const meetsMinimumDuration =
    characterCount === 0 ||
    displayDurationSeconds + 0.001 >= minimumDisplaySeconds;
  const meetsReadingSpeed =
    characterCount === 0 ||
    charactersPerSecond <= maximumCharactersPerSecond + 0.001;

  return {
    characterCount,
    displayDurationSeconds,
    recommendedDurationSeconds,
    charactersPerSecond,
    meetsMinimumDuration,
    meetsReadingSpeed,
    readable: meetsMinimumDuration && meetsReadingSpeed,
  };
}

export function getCaptionSafeArea(
  width: number,
  height: number,
  ratios = CAPTION_VIDEO_SAFE_AREA,
): CaptionSafeArea {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new RangeError("Video dimensions must be finite positive numbers.");
  }
  const values = [
    ratios.leftRatio,
    ratios.rightRatio,
    ratios.topRatio,
    ratios.bottomRatio,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0 || value >= 1) ||
    ratios.leftRatio + ratios.rightRatio >= 1 ||
    ratios.topRatio + ratios.bottomRatio >= 1
  ) {
    throw new RangeError("Safe-area ratios must leave a visible center area.");
  }
  const left = width * ratios.leftRatio;
  const right = width * ratios.rightRatio;
  const top = height * ratios.topRatio;
  const bottom = height * ratios.bottomRatio;
  return {
    x: left,
    y: top,
    width: width - left - right,
    height: height - top - bottom,
    left,
    right,
    top,
    bottom,
  };
}
