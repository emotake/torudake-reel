import type { CaptionSegment } from "./captions";

const MINIMUM_CAPTION_SECONDS = 0.02;

function roundSeconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

/** Keeps server transcription output inside the exact edited-video clock. */
export function normalizeVideoMixOriginalCaptions(
  segments: readonly CaptionSegment[],
  durationSeconds: number,
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  return segments.flatMap((segment) => {
    const text = segment.text.trim();
    if (!text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      return [];
    }
    const start = Math.max(0, Math.min(durationSeconds, segment.start));
    const end = Math.max(start, Math.min(durationSeconds, segment.end));
    if (end - start < MINIMUM_CAPTION_SECONDS) return [];
    const displayStart = Number.isFinite(segment.displayStart)
      ? Math.max(start, Math.min(end, segment.displayStart!))
      : undefined;
    const displayEnd = Number.isFinite(segment.displayEnd)
      ? Math.max(displayStart ?? start, Math.min(end, segment.displayEnd!))
      : undefined;
    return [{
      ...segment,
      start: roundSeconds(start),
      end: roundSeconds(end),
      text,
      displayStart:
        displayStart === undefined ? undefined : roundSeconds(displayStart),
      displayEnd:
        displayEnd === undefined ? undefined : roundSeconds(displayEnd),
    }];
  }).map((segment, index) => ({ ...segment, id: index + 1 }));
}

export function updateVideoMixOriginalCaption(
  captions: readonly CaptionSegment[],
  id: number,
  patch: Readonly<Partial<Pick<CaptionSegment, "text" | "removed">>>,
) {
  return captions.map((caption) =>
    caption.id === id
      ? {
          ...caption,
          ...(patch.text === undefined ? {} : { text: patch.text.slice(0, 160) }),
          ...(patch.removed === undefined ? {} : { removed: patch.removed }),
        }
      : caption,
  );
}

export function getEnabledVideoMixOriginalCaptions(
  captions: readonly CaptionSegment[],
) {
  return captions.filter(
    (caption) => !caption.removed && Boolean(caption.text.trim()),
  );
}
