import { getCaptionDisplayRange, type CaptionSegment } from "./captions";

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

export type CaptionDisplayTimelineOptions = CaptionReadabilityOptions &
  Readonly<{
    /** Inclusive lower bound on the finished, continuous video clock. */
    timelineStartSeconds?: number;
    /** Exclusive upper bound on the finished, continuous video clock. */
    timelineEndSeconds?: number;
  }>;

export type CaptionSourceEditRange = Readonly<{
  start: number;
  end: number;
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

function roundDisplaySeconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

/**
 * Fits caption visibility windows onto one continuous finished-video clock.
 *
 * The edit ranges (`start` / `end`) are intentionally left untouched. When
 * enough program time exists, every non-empty caption receives at least the
 * shared 0.8 second / 12 characters-per-second recommendation. If the program
 * is shorter than the combined recommendation, the available time is shared
 * deterministically without overlaps or extending the finished duration.
 */
export function fitCaptionDisplayTimeline<T extends CaptionSegment>(
  captions: readonly T[],
  options: CaptionDisplayTimelineOptions = {},
): T[] {
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
  const candidates = captions
    .map((caption, originalIndex) => {
      const display = getCaptionDisplayRange(caption);
      return {
        caption,
        originalIndex,
        anchorStart: display.start,
        anchorEnd: display.end,
        desiredDuration: Math.max(
          display.end - display.start,
          getRecommendedCaptionDisplayDuration(caption.text, {
            minimumDisplaySeconds,
            maximumCharactersPerSecond,
          }),
        ),
      };
    })
    .filter(
      (item) =>
        !item.caption.removed &&
        Boolean(item.caption.text.trim()) &&
        Number.isFinite(item.anchorStart) &&
        Number.isFinite(item.anchorEnd) &&
        item.anchorEnd > item.anchorStart &&
        item.desiredDuration > 0,
    )
    .sort(
      (left, right) =>
        left.anchorStart - right.anchorStart ||
        left.anchorEnd - right.anchorEnd ||
        left.originalIndex - right.originalIndex,
    );
  if (candidates.length === 0) return captions.map((caption) => ({ ...caption }));

  const inferredStart = Math.min(...candidates.map((item) => item.anchorStart));
  const inferredEnd = Math.max(...candidates.map((item) => item.anchorEnd));
  const timelineStart = options.timelineStartSeconds ?? inferredStart;
  const timelineEnd = options.timelineEndSeconds ?? inferredEnd;
  if (
    !Number.isFinite(timelineStart) ||
    !Number.isFinite(timelineEnd) ||
    timelineEnd <= timelineStart
  ) {
    throw new RangeError("Caption timeline bounds must be finite and increasing.");
  }

  const availableDuration = timelineEnd - timelineStart;
  const desiredDurations = candidates.map((item) => item.desiredDuration);
  const desiredTotal = desiredDurations.reduce(
    (total, duration) => total + duration,
    0,
  );
  let allocatedDurations: number[];
  if (desiredTotal <= availableDuration + 0.000_001) {
    allocatedDurations = desiredDurations;
  } else {
    const minimumDurations = desiredDurations.map((duration) =>
      Math.min(duration, minimumDisplaySeconds),
    );
    const minimumTotal = minimumDurations.reduce(
      (total, duration) => total + duration,
      0,
    );
    if (minimumTotal <= availableDuration + 0.000_001) {
      const remaining = Math.max(0, availableDuration - minimumTotal);
      const deficits = desiredDurations.map(
        (duration, index) => duration - minimumDurations[index],
      );
      const deficitTotal = deficits.reduce(
        (total, duration) => total + duration,
        0,
      );
      allocatedDurations = minimumDurations.map((duration, index) =>
        duration +
        (deficitTotal > 0 ? remaining * (deficits[index] / deficitTotal) : 0),
      );
    } else {
      allocatedDurations = desiredDurations.map(
        (duration) => availableDuration * (duration / desiredTotal),
      );
    }
  }

  const suffixDurations = new Array<number>(allocatedDurations.length + 1).fill(
    0,
  );
  for (let index = allocatedDurations.length - 1; index >= 0; index -= 1) {
    suffixDurations[index] =
      suffixDurations[index + 1] + allocatedDurations[index];
  }

  const fitted = new Map<number, { start: number; end: number }>();
  let cursor = timelineStart;
  candidates.forEach((item, index) => {
    const duration = allocatedDurations[index];
    const preferredStart = (item.anchorStart + item.anchorEnd - duration) / 2;
    const latestStart = timelineEnd - suffixDurations[index];
    const start = Math.max(cursor, Math.min(preferredStart, latestStart));
    const end = Math.min(timelineEnd, start + duration);
    fitted.set(item.originalIndex, { start, end });
    cursor = end;
  });

  const rounded = new Map<number, { start: number; end: number }>();
  let previousRoundedEnd = roundDisplaySeconds(timelineStart);
  for (const item of candidates) {
    const timing = fitted.get(item.originalIndex)!;
    const displayStart = Math.max(
      previousRoundedEnd,
      roundDisplaySeconds(timing.start),
    );
    const displayEnd = Math.min(
      roundDisplaySeconds(timelineEnd),
      Math.max(displayStart, roundDisplaySeconds(timing.end)),
    );
    previousRoundedEnd = displayEnd;
    rounded.set(item.originalIndex, { start: displayStart, end: displayEnd });
  }
  return captions.map((caption, index) => {
    const timing = rounded.get(index);
    return timing
      ? { ...caption, displayStart: timing.start, displayEnd: timing.end }
      : { ...caption };
  });
}

/**
 * Fits caption visibility independently inside each retained source range.
 *
 * A finished-video clock is continuous across cuts, while the source clock is
 * not. Mapping a visibility window that straddles a cut back with a single
 * start/end pair would therefore include the deleted source gap. Keeping each
 * fit inside one retained range preserves both the cut and the entrance time.
 */
export function fitCaptionDisplayTimelineWithinEditRanges<
  T extends CaptionSegment,
>(captions: readonly T[], ranges: readonly CaptionSourceEditRange[]): T[] {
  const normalizedRanges = ranges
    .map((range) => ({ start: Number(range.start), end: Number(range.end) }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end > range.start,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (normalizedRanges.length === 0) {
    return captions.map((caption) => ({ ...caption }));
  }

  const clockRanges = normalizedRanges.map((range, index) => {
    const editedStart = normalizedRanges
      .slice(0, index)
      .reduce((total, item) => total + item.end - item.start, 0);
    return {
      ...range,
      editedStart,
      editedEnd: editedStart + range.end - range.start,
    };
  });
  const groups = clockRanges.map(() => [] as Array<{
    caption: T;
    originalIndex: number;
  }>);

  captions.forEach((caption, originalIndex) => {
    if (caption.removed || !caption.text.trim()) return;
    const display = getCaptionDisplayRange(caption);
    let selectedRangeIndex = -1;
    let selectedOverlap = 0;
    clockRanges.forEach((range, rangeIndex) => {
      const overlap = Math.max(
        0,
        Math.min(display.end, range.end) - Math.max(display.start, range.start),
      );
      if (overlap > selectedOverlap) {
        selectedOverlap = overlap;
        selectedRangeIndex = rangeIndex;
      }
    });
    if (selectedRangeIndex < 0) return;
    groups[selectedRangeIndex].push({ caption, originalIndex });
  });

  const fittedByIndex = new Map<number, { start: number; end: number }>();
  groups.forEach((group, rangeIndex) => {
    if (group.length === 0) return;
    const range = clockRanges[rangeIndex];
    const rangeDuration = range.end - range.start;
    const onEditedClock = group.map(({ caption }) => {
      const display = getCaptionDisplayRange(caption);
      const startOffset = Math.max(
        0,
        Math.min(rangeDuration, display.start - range.start),
      );
      const endOffset = Math.max(
        startOffset,
        Math.min(rangeDuration, display.end - range.start),
      );
      return {
        ...caption,
        start: range.editedStart + startOffset,
        end: range.editedStart + endOffset,
        displayStart: undefined,
        displayEnd: undefined,
      };
    });
    const fitted = fitCaptionDisplayTimeline(onEditedClock, {
      timelineStartSeconds: range.editedStart,
      timelineEndSeconds: range.editedEnd,
    });
    fitted.forEach((caption, groupIndex) => {
      const display = getCaptionDisplayRange(caption);
      fittedByIndex.set(group[groupIndex].originalIndex, {
        start: roundDisplaySeconds(
          range.start + display.start - range.editedStart,
        ),
        end: roundDisplaySeconds(
          range.start + display.end - range.editedStart,
        ),
      });
    });
  });

  return captions.map((caption, index) => {
    const display = fittedByIndex.get(index);
    return display
      ? { ...caption, displayStart: display.start, displayEnd: display.end }
      : { ...caption };
  });
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
