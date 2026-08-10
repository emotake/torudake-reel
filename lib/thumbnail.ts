import {
  analyzeVideoFrame,
  calculateSceneDifference,
  type FrameCompositionMetadata,
  type FrameVisualAnalysis,
  type ImageDataLike,
} from "./video-frame-analysis";

export type ThumbnailCaption = {
  id?: number | string;
  start: number;
  end: number;
  text: string;
  removed?: boolean;
  accent?: boolean;
};

export type ThumbnailFrameCandidate<T = unknown> = {
  id: number | string;
  time: number;
  image: ImageDataLike;
  metadata?: FrameCompositionMetadata;
  caption?: ThumbnailCaption;
  value?: T;
};

export type RankedThumbnailFrame<T = unknown> = {
  candidate: ThumbnailFrameCandidate<T>;
  analysis: FrameVisualAnalysis;
  score: number;
};

export type ThumbnailFrameSelectionOptions = {
  limit?: number;
  minSpacingSeconds?: number;
  minSceneDifference?: number;
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

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function scoreCaptionForCover(caption?: ThumbnailCaption) {
  if (!caption || caption.removed) return 0;
  const length = Array.from(caption.text.trim()).length;
  if (length === 0) return 0;
  const readableLengthScore =
    length <= 22 ? clamp01(length / 9) : clamp01(1 - (length - 22) / 30);
  return clamp01(readableLengthScore * 0.75 + (caption.accent ? 0.25 : 0));
}

/**
 * Ranks decoded cover frames by visual quality and composition. Caption order
 * is intentionally not part of the score; text contributes only a small
 * readability signal after the image has been assessed locally.
 */
export function rankThumbnailFrames<T>(
  candidates: readonly ThumbnailFrameCandidate<T>[],
): RankedThumbnailFrame<T>[] {
  return candidates
    .map((candidate, index) => {
      const analysis = analyzeVideoFrame(candidate.image, candidate.metadata);
      const captionScore = scoreCaptionForCover(candidate.caption);
      const score = clamp01(
        analysis.qualityScore * 0.69 +
          analysis.compositionScore * 0.18 +
          analysis.faceScore * 0.09 +
          captionScore * 0.04,
      );
      return { candidate, analysis, score, index };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.time - right.candidate.time ||
        left.index - right.index,
    )
    .map((entry) => ({
      candidate: entry.candidate,
      analysis: entry.analysis,
      score: entry.score,
    }));
}

/**
 * Returns visually distinct cover choices, preventing three nearly identical
 * frames from occupying every thumbnail slot.
 */
export function selectThumbnailFrames<T>(
  candidates: readonly ThumbnailFrameCandidate<T>[],
  options: ThumbnailFrameSelectionOptions = {},
): RankedThumbnailFrame<T>[] {
  const limit = Math.max(
    1,
    Math.min(candidates.length, Math.round(options.limit ?? MAX_THUMBNAIL_CANDIDATES)),
  );
  const minSpacing = Math.max(0, options.minSpacingSeconds ?? 0.45);
  const minSceneDifference = clamp01(options.minSceneDifference ?? 0.08);
  const ranked = rankThumbnailFrames(candidates);
  const selected: RankedThumbnailFrame<T>[] = [];

  for (const entry of ranked) {
    const isTooSimilar = selected.some(
      (existing) =>
        Math.abs(existing.candidate.time - entry.candidate.time) < minSpacing &&
        calculateSceneDifference(
          existing.candidate.image,
          entry.candidate.image,
        ) < minSceneDifference,
    );
    if (isTooSimilar) continue;
    selected.push(entry);
    if (selected.length === limit) break;
  }

  if (selected.length < limit) {
    for (const entry of ranked) {
      if (selected.includes(entry)) continue;
      selected.push(entry);
      if (selected.length === limit) break;
    }
  }

  return selected;
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
