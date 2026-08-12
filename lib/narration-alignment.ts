import type { CaptionSegment, CaptionWordTiming } from "./captions";
import { CAPTION_MIN_DISPLAY_SECONDS } from "./caption-readability";

export type SpeechActivityRange = Readonly<{
  start: number;
  end: number;
}>;

export type NarrationAlignmentOptions = Readonly<{
  maximumDurationSeconds?: number;
  edgePaddingSeconds?: number;
  mergeGapSeconds?: number;
  preserveExactWordTimings?: boolean;
}>;

function roundMilliseconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function narrationTextWeight(text: string) {
  let weight = 0;
  for (const character of Array.from(text.normalize("NFKC").trim())) {
    if (/\s/u.test(character)) continue;
    weight += /[、。，,.！？!?]/u.test(character) ? 0.22 : 1;
  }
  return Math.max(1, weight);
}

export function normalizeSpeechActivityRanges(
  ranges: readonly SpeechActivityRange[],
  maximumDurationSeconds = Number.POSITIVE_INFINITY,
  mergeGapSeconds = 0.08,
) {
  if (
    (!Number.isFinite(maximumDurationSeconds) &&
      maximumDurationSeconds !== Number.POSITIVE_INFINITY) ||
    maximumDurationSeconds <= 0
  ) {
    throw new RangeError("maximumDurationSeconds must be positive.");
  }
  if (!Number.isFinite(mergeGapSeconds) || mergeGapSeconds < 0) {
    throw new RangeError("mergeGapSeconds must be finite and non-negative.");
  }
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Number(range.start)),
      end: Math.min(maximumDurationSeconds, Number(range.end)),
    }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end - range.start > 0.001,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + mergeGapSeconds) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map((range) => ({
    start: roundMilliseconds(range.start),
    end: roundMilliseconds(range.end),
  }));
}

function speechOffsetToClockTime(
  ranges: readonly SpeechActivityRange[],
  requestedOffset: number,
  boundary: "start" | "end",
) {
  let remaining = Math.max(0, requestedOffset);
  for (const [index, range] of ranges.entries()) {
    const duration = range.end - range.start;
    if (
      remaining < duration ||
      (boundary === "end" && remaining <= duration) ||
      index === ranges.length - 1
    ) {
      return Math.min(range.end, range.start + remaining);
    }
    remaining -= duration;
  }
  return ranges.at(-1)?.end ?? 0;
}

function remapApproximateWordTimings(
  wordTimings: readonly CaptionWordTiming[] | undefined,
  originalDuration: number,
  nextDuration: number,
) {
  if (!wordTimings?.length || originalDuration <= 0 || nextDuration <= 0) {
    return wordTimings;
  }
  const scale = nextDuration / originalDuration;
  return wordTimings.map((word) => ({
    ...word,
    startOffset: roundMilliseconds(
      Math.min(nextDuration, Math.max(0, word.startOffset * scale)),
    ),
    endOffset: roundMilliseconds(
      Math.min(nextDuration, Math.max(0, word.endOffset * scale)),
    ),
  }));
}

/**
 * Places generated-script captions on the actual voiced parts of locally
 * decoded narration. It uses no network call and leaves captions carrying
 * exact word timings untouched by default.
 */
export function alignNarrationCaptionsToSpeechActivity<
  T extends CaptionSegment,
>(
  captions: T[],
  activityRanges: readonly SpeechActivityRange[],
  options: NarrationAlignmentOptions = {},
): T[] {
  const edgePaddingSeconds = options.edgePaddingSeconds ?? 0.045;
  if (!Number.isFinite(edgePaddingSeconds) || edgePaddingSeconds < 0) {
    throw new RangeError("edgePaddingSeconds must be finite and non-negative.");
  }
  const ranges = normalizeSpeechActivityRanges(
    activityRanges,
    options.maximumDurationSeconds,
    options.mergeGapSeconds,
  );
  if (ranges.length === 0) return captions;

  const alignable = captions.filter(
    (caption) =>
      !caption.removed &&
      caption.text.trim() &&
      (!(options.preserveExactWordTimings ?? true) ||
        !caption.wordTimings?.length),
  );
  if (alignable.length === 0) return captions;

  const totalSpeechDuration = ranges.reduce(
    (total, range) => total + range.end - range.start,
    0,
  );
  if (totalSpeechDuration <= 0.001) return captions;
  const totalWeight = alignable.reduce(
    (total, caption) => total + narrationTextWeight(caption.text),
    0,
  );
  const speechChunksMatchCaptions = ranges.length === alignable.length;
  const mapped = new Map<number, { start: number; end: number }>();
  let speechCursor = 0;

  alignable.forEach((caption, index) => {
    if (speechChunksMatchCaptions) {
      mapped.set(caption.id, {
        start: ranges[index].start,
        end: ranges[index].end,
      });
      return;
    }
    const weight = narrationTextWeight(caption.text);
    const nextSpeechCursor =
      index === alignable.length - 1
        ? totalSpeechDuration
        : speechCursor + totalSpeechDuration * (weight / totalWeight);
    mapped.set(caption.id, {
      start: speechOffsetToClockTime(ranges, speechCursor, "start"),
      end: speechOffsetToClockTime(ranges, nextSpeechCursor, "end"),
    });
    speechCursor = nextSpeechCursor;
  });

  const firstStart = ranges[0].start;
  const lastEnd = ranges.at(-1)!.end;
  const padded = alignable.map((caption) => {
    const timing = mapped.get(caption.id)!;
    const timingRangeIndex = Math.max(
      0,
      ranges.findIndex(
        (range) =>
          timing.start >= range.start - 0.001 &&
          timing.start < range.end - 0.001,
      ),
    );
    const timingRange = ranges[timingRangeIndex];
    const nextRange = ranges[timingRangeIndex + 1];
    const endRange =
      nextRange && Math.abs(timing.end - nextRange.start) <= 0.001
        ? timingRange
        : ([...ranges]
            .reverse()
            .find(
              (range) =>
                timing.end > range.start + 0.001 &&
                timing.end <= range.end + 0.001,
            ) ?? timingRange);
    return {
      caption,
      start: Math.max(
        timingRange?.start ?? firstStart,
        timing.start - edgePaddingSeconds,
      ),
      end: Math.min(
        endRange?.end ?? lastEnd,
        timing.end + edgePaddingSeconds,
      ),
    };
  });
  for (let index = 1; index < padded.length; index += 1) {
    const previous = padded[index - 1];
    const current = padded[index];
    if (previous.end <= current.start) continue;
    if (current.start - previous.start <= CAPTION_MIN_DISPLAY_SECONDS) {
      const split = (previous.end + current.start) / 2;
      previous.end = split;
      current.start = split;
      continue;
    }
    previous.end = current.start;
  }

  const updates = new Map(
    padded.map(({ caption, start, end }) => {
      const oldDuration = caption.end - caption.start;
      const nextStart = roundMilliseconds(start);
      const nextEnd = roundMilliseconds(Math.max(start + 0.001, end));
      return [
        caption.id,
        {
          start: nextStart,
          end: nextEnd,
          wordTimings: remapApproximateWordTimings(
            caption.wordTimings,
            oldDuration,
            nextEnd - nextStart,
          ),
        },
      ] as const;
    }),
  );

  return captions.map((caption) => {
    const update = updates.get(caption.id);
    if (!update) return caption;
    return {
      ...caption,
      ...update,
      localSilenceStart: true,
      localSilenceEnd: true,
    };
  });
}

function narrationClockToSourceClock(
  timeline: readonly CaptionSegment[],
  narrationTime: number,
) {
  const playable = timeline.filter(
    (caption) => !caption.removed && caption.end > caption.start,
  );
  if (playable.length === 0) return 0;
  const totalDuration = playable.reduce(
    (total, caption) => total + caption.end - caption.start,
    0,
  );
  let remaining = Math.min(Math.max(0, narrationTime), totalDuration);
  for (const [index, caption] of playable.entries()) {
    const duration = caption.end - caption.start;
    if (remaining <= duration || index === playable.length - 1) {
      return Math.min(caption.end, caption.start + remaining);
    }
    remaining -= duration;
  }
  return playable.at(-1)!.end;
}

/**
 * Aligns caption visibility to decoded narration activity while preserving
 * every original edit range. This separation is important: narration pauses
 * are part of the audio and must remain in preview and export even when no
 * caption is visible during those pauses.
 */
export function attachNarrationCaptionDisplayTiming<
  T extends CaptionSegment,
>(
  timeline: T[],
  activityRanges: readonly SpeechActivityRange[],
  options: NarrationAlignmentOptions = {},
): T[] {
  if (timeline.length === 0 || activityRanges.length === 0) return timeline;
  const narrationClockTimeline = timeline.map((caption) => ({ ...caption }));
  let cursor = 0;
  for (const caption of narrationClockTimeline) {
    const duration = Math.max(0, caption.end - caption.start);
    caption.start = cursor;
    caption.end = cursor + duration;
    cursor += duration;
  }
  const aligned = alignNarrationCaptionsToSpeechActivity(
    narrationClockTimeline,
    activityRanges,
    { ...options, maximumDurationSeconds: options.maximumDurationSeconds ?? cursor },
  );
  const alignedById = new Map(aligned.map((caption) => [caption.id, caption]));

  return timeline.map((caption) => {
    const speechCaption = alignedById.get(caption.id);
    if (!speechCaption) return caption;
    const displayStart = narrationClockToSourceClock(
      timeline,
      speechCaption.start,
    );
    const displayEnd = narrationClockToSourceClock(timeline, speechCaption.end);
    if (displayEnd <= displayStart + 0.001) return caption;
    return {
      ...caption,
      displayStart: roundMilliseconds(displayStart),
      displayEnd: roundMilliseconds(displayEnd),
      localSilenceStart: true,
      localSilenceEnd: true,
    };
  });
}

/** Indicates when a mapped caption should be split before render. */
export function narrationCaptionNeedsReadabilitySplit(caption: CaptionSegment) {
  const characterCount = Array.from(caption.text.replace(/\s+/gu, "")).length;
  const duration = caption.end - caption.start;
  return (
    duration > 0 &&
    (duration < CAPTION_MIN_DISPLAY_SECONDS || characterCount / duration > 12)
  );
}
