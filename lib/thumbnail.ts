export type ThumbnailCaption = {
  id?: number | string;
  start: number;
  end: number;
  text: string;
  removed?: boolean;
  accent?: boolean;
};

export type ThumbnailCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MAX_THUMBNAIL_CANDIDATES = 3;
const VIDEO_END_PADDING_SECONDS = 0.05;
const MAX_FRAME_OFFSET_SECONDS = 0.8;

function normalizeCandidateText(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/**
 * Returns up to three useful cover candidates. Accented captions are placed
 * first, while the relative order within each group is kept stable.
 */
export function selectThumbnailCandidates<T extends ThumbnailCaption>(
  captions: readonly T[],
): T[] {
  const included = captions.filter(
    (caption) => !caption.removed && Boolean(caption.text.trim()),
  );
  const ordered = [
    ...included.filter((caption) => caption.accent),
    ...included.filter((caption) => !caption.accent),
  ];
  const seenTexts = new Set<string>();
  const candidates: T[] = [];

  for (const caption of ordered) {
    const key = normalizeCandidateText(caption.text);
    if (!key || seenTexts.has(key)) continue;
    seenTexts.add(key);
    candidates.push(caption);
    if (candidates.length === MAX_THUMBNAIL_CANDIDATES) break;
  }

  return candidates;
}

function finiteOrZero(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function roundMilliseconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Picks a decoded frame inside the caption interval without seeking to the
 * exact end of the source video. Long captions are sampled near their start so
 * the selected frame remains representative of the caption's opening scene.
 */
export function getThumbnailFrameTime(
  caption: Pick<ThumbnailCaption, "start" | "end">,
  videoDuration: number,
) {
  const duration = Math.max(0, finiteOrZero(videoDuration));
  if (duration === 0) return 0;

  const latestSafeTime = Math.max(0, duration - VIDEO_END_PADDING_SECONDS);
  const start = Math.min(
    latestSafeTime,
    Math.max(0, finiteOrZero(caption.start)),
  );
  const end = Math.min(
    latestSafeTime,
    Math.max(start, finiteOrZero(caption.end)),
  );
  const offset = Math.min(
    MAX_FRAME_OFFSET_SECONDS,
    Math.max(0, (end - start) / 2),
  );

  return roundMilliseconds(Math.min(latestSafeTime, start + offset));
}

function requirePositiveDimension(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}

/**
 * Calculates the source rectangle for a centered CSS-style `cover` crop.
 * Target dimensions express only the desired ratio, so both 9×16 and
 * 1080×1920 produce the same crop.
 */
export function calculateCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = 9,
  targetHeight = 16,
): ThumbnailCrop {
  requirePositiveDimension(sourceWidth, "sourceWidth");
  requirePositiveDimension(sourceHeight, "sourceHeight");
  requirePositiveDimension(targetWidth, "targetWidth");
  requirePositiveDimension(targetHeight, "targetHeight");

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  if (sourceRatio > targetRatio) {
    const width = sourceHeight * targetRatio;
    return {
      x: (sourceWidth - width) / 2,
      y: 0,
      width,
      height: sourceHeight,
    };
  }

  if (sourceRatio < targetRatio) {
    const height = sourceWidth / targetRatio;
    return {
      x: 0,
      y: (sourceHeight - height) / 2,
      width: sourceWidth,
      height,
    };
  }

  return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
}
