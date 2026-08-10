export type ImageDataLike = {
  data: ArrayLike<number>;
  width: number;
  height: number;
};

export type NormalizedPoint = {
  x: number;
  y: number;
  confidence?: number;
};

export type NormalizedFace = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
};

export type FrameCompositionMetadata = {
  /** Face rectangles use normalized 0..1 coordinates. */
  faces?: readonly NormalizedFace[];
  /** Optional subject center, also in normalized 0..1 coordinates. */
  subject?: NormalizedPoint;
};

export type FrameVisualAnalysis = {
  brightness: number;
  contrast: number;
  exposureScore: number;
  sharpnessScore: number;
  colorfulnessScore: number;
  shadowClipRatio: number;
  highlightClipRatio: number;
  compositionScore: number;
  faceScore: number;
  qualityScore: number;
};

export type VideoFrameCandidate<T = unknown> = {
  time: number;
  image: ImageDataLike;
  metadata?: FrameCompositionMetadata;
  value?: T;
};

export type RankedVideoFrame<T = unknown> = {
  candidate: VideoFrameCandidate<T>;
  analysis: FrameVisualAnalysis;
  sceneChangeScore: number;
  representativeScore: number;
};

export type RepresentativeFrameOptions = {
  count?: number;
  duration?: number;
  minSpacingSeconds?: number;
};

export type RepresentativeSampleOptions = {
  /** Defaults to a duration-aware value between 12 and 24. */
  count?: number;
  startPaddingSeconds?: number;
  endPaddingSeconds?: number;
};

const ANALYSIS_GRID_LIMIT = 64;
const COMPARISON_GRID_LIMIT = 32;
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clampByte(value: number) {
  return Math.min(255, Math.max(0, Number.isFinite(value) ? value : 0));
}

function validateImage(image: ImageDataLike) {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    throw new RangeError("Frame dimensions must be positive integers.");
  }
  if (image.data.length < image.width * image.height * 4) {
    throw new RangeError("Frame data must contain RGBA values for every pixel.");
  }
}

function getGridDimensions(image: ImageDataLike, limit: number) {
  const scale = Math.min(1, limit / Math.max(image.width, image.height));
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

type SampledGrid = {
  width: number;
  height: number;
  luminance: Float32Array;
  red: Float32Array;
  green: Float32Array;
  blue: Float32Array;
};

function sampleGrid(image: ImageDataLike, limit: number): SampledGrid {
  validateImage(image);
  const dimensions = getGridDimensions(image, limit);
  const sampleCount = dimensions.width * dimensions.height;
  const luminance = new Float32Array(sampleCount);
  const red = new Float32Array(sampleCount);
  const green = new Float32Array(sampleCount);
  const blue = new Float32Array(sampleCount);

  for (let gridY = 0; gridY < dimensions.height; gridY += 1) {
    const sourceY = Math.min(
      image.height - 1,
      Math.floor(((gridY + 0.5) * image.height) / dimensions.height),
    );
    for (let gridX = 0; gridX < dimensions.width; gridX += 1) {
      const sourceX = Math.min(
        image.width - 1,
        Math.floor(((gridX + 0.5) * image.width) / dimensions.width),
      );
      const sourceIndex = (sourceY * image.width + sourceX) * 4;
      const targetIndex = gridY * dimensions.width + gridX;
      const r = clampByte(image.data[sourceIndex]) / 255;
      const g = clampByte(image.data[sourceIndex + 1]) / 255;
      const b = clampByte(image.data[sourceIndex + 2]) / 255;
      red[targetIndex] = r;
      green[targetIndex] = g;
      blue[targetIndex] = b;
      luminance[targetIndex] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }

  return { ...dimensions, luminance, red, green, blue };
}

function distanceToNearestCompositionPoint(x: number, y: number) {
  const points = [
    [1 / 3, 1 / 3],
    [2 / 3, 1 / 3],
    [1 / 2, 0.42],
  ] as const;
  return Math.min(
    ...points.map(([pointX, pointY]) => Math.hypot(x - pointX, y - pointY)),
  );
}

function scoreSubjectPoint(subject: NormalizedPoint) {
  const x = clamp01(subject.x);
  const y = clamp01(subject.y);
  const positionScore = clamp01(
    1 - distanceToNearestCompositionPoint(x, y) / 0.52,
  );
  const edgeDistance = Math.min(x, 1 - x, y, 1 - y);
  const edgeScore = clamp01(edgeDistance / 0.12);
  return (
    (positionScore * 0.78 + edgeScore * 0.22) *
    clamp01(subject.confidence ?? 1)
  );
}

function scoreFaces(faces: readonly NormalizedFace[]) {
  const validFaces = faces.filter(
    (face) =>
      Number.isFinite(face.x) &&
      Number.isFinite(face.y) &&
      Number.isFinite(face.width) &&
      Number.isFinite(face.height) &&
      face.width > 0 &&
      face.height > 0,
  );
  if (validFaces.length === 0) return 0;

  const scores = validFaces.map((face) => {
    const width = clamp01(face.width);
    const height = clamp01(face.height);
    const centerX = clamp01(face.x + width / 2);
    const centerY = clamp01(face.y + height / 2);
    const area = width * height;
    const sizeScore =
      area <= 0.14
        ? clamp01(area / 0.055)
        : clamp01(1 - (area - 0.14) / 0.42);
    const positionScore = scoreSubjectPoint({ x: centerX, y: centerY });
    const inset = Math.min(
      clamp01(face.x),
      clamp01(face.y),
      clamp01(1 - face.x - width),
      clamp01(1 - face.y - height),
    );
    const cropSafetyScore = clamp01(inset / 0.035);
    return (
      (sizeScore * 0.4 + positionScore * 0.38 + cropSafetyScore * 0.22) *
      clamp01(face.confidence ?? 1)
    );
  });

  const best = Math.max(...scores);
  const groupBonus = Math.min(0.08, Math.max(0, validFaces.length - 1) * 0.025);
  return clamp01(best + groupBonus);
}

function estimateSaliencyComposition(grid: SampledGrid) {
  if (grid.width < 3 || grid.height < 3) return 0.5;
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (let y = 1; y < grid.height - 1; y += 1) {
    for (let x = 1; x < grid.width - 1; x += 1) {
      const index = y * grid.width + x;
      const horizontal = Math.abs(
        grid.luminance[index + 1] - grid.luminance[index - 1],
      );
      const vertical = Math.abs(
        grid.luminance[index + grid.width] -
          grid.luminance[index - grid.width],
      );
      const weight = horizontal + vertical;
      totalWeight += weight;
      weightedX += (x / (grid.width - 1)) * weight;
      weightedY += (y / (grid.height - 1)) * weight;
    }
  }

  if (totalWeight < 0.0001) return 0.5;
  const x = weightedX / totalWeight;
  const y = weightedY / totalWeight;
  return 0.35 + scoreSubjectPoint({ x, y }) * 0.45;
}

/**
 * Scores a decoded frame entirely in the browser. Values are normalized to
 * 0..1 so callers can compare frames from different source resolutions.
 */
export function analyzeVideoFrame(
  image: ImageDataLike,
  metadata: FrameCompositionMetadata = {},
): FrameVisualAnalysis {
  const grid = sampleGrid(image, ANALYSIS_GRID_LIMIT);
  const count = grid.luminance.length;
  let sum = 0;
  let sumSquared = 0;
  let shadowCount = 0;
  let highlightCount = 0;
  let chromaTotal = 0;

  for (let index = 0; index < count; index += 1) {
    const luminance = grid.luminance[index];
    sum += luminance;
    sumSquared += luminance * luminance;
    if (luminance <= 0.04) shadowCount += 1;
    if (luminance >= 0.96) highlightCount += 1;
    const maxChannel = Math.max(
      grid.red[index],
      grid.green[index],
      grid.blue[index],
    );
    const minChannel = Math.min(
      grid.red[index],
      grid.green[index],
      grid.blue[index],
    );
    chromaTotal += maxChannel - minChannel;
  }

  const brightness = sum / count;
  const variance = Math.max(0, sumSquared / count - brightness * brightness);
  const contrast = Math.sqrt(variance);
  const shadowClipRatio = shadowCount / count;
  const highlightClipRatio = highlightCount / count;
  const brightnessScore = clamp01(1 - Math.abs(brightness - 0.52) / 0.52);
  const clippingPenalty = clamp01(
    1 - (shadowClipRatio + highlightClipRatio) * 1.35,
  );
  const exposureScore = brightnessScore * clippingPenalty;
  const contrastScore =
    clamp01(contrast / 0.16) *
    (contrast > 0.42 ? clamp01(1 - (contrast - 0.42) / 0.32) : 1);

  let laplacianTotal = 0;
  let laplacianCount = 0;
  if (grid.width >= 3 && grid.height >= 3) {
    for (let y = 1; y < grid.height - 1; y += 1) {
      for (let x = 1; x < grid.width - 1; x += 1) {
        const index = y * grid.width + x;
        const center = grid.luminance[index];
        laplacianTotal += Math.abs(
          center * 4 -
            grid.luminance[index - 1] -
            grid.luminance[index + 1] -
            grid.luminance[index - grid.width] -
            grid.luminance[index + grid.width],
        );
        laplacianCount += 1;
      }
    }
  }
  const laplacianMean =
    laplacianCount > 0 ? laplacianTotal / laplacianCount : 0;
  const sharpnessScore = clamp01(laplacianMean / 0.22);
  const colorfulnessScore = clamp01(chromaTotal / count / 0.32);
  const faceScore = scoreFaces(metadata.faces ?? []);
  const metadataComposition = metadata.subject
    ? scoreSubjectPoint(metadata.subject)
    : 0;
  const inferredComposition = estimateSaliencyComposition(grid);
  const compositionScore =
    faceScore > 0
      ? clamp01(faceScore * 0.82 + (metadataComposition || inferredComposition) * 0.18)
      : metadataComposition > 0
        ? metadataComposition
        : inferredComposition;
  const qualityScore = clamp01(
    exposureScore * 0.34 +
      sharpnessScore * 0.27 +
      contrastScore * 0.14 +
      compositionScore * 0.19 +
      colorfulnessScore * 0.06,
  );

  return {
    brightness,
    contrast,
    exposureScore,
    sharpnessScore,
    colorfulnessScore,
    shadowClipRatio,
    highlightClipRatio,
    compositionScore,
    faceScore,
    qualityScore,
  };
}

/** Returns 0 for the same scene and approaches 1 for a major visual change. */
export function calculateSceneDifference(
  first: ImageDataLike,
  second: ImageDataLike,
) {
  const left = sampleGrid(first, COMPARISON_GRID_LIMIT);
  const right = sampleGrid(second, COMPARISON_GRID_LIMIT);
  const comparisonWidth = Math.min(left.width, right.width);
  const comparisonHeight = Math.min(left.height, right.height);
  let difference = 0;
  let count = 0;

  for (let y = 0; y < comparisonHeight; y += 1) {
    const leftY = Math.min(
      left.height - 1,
      Math.floor(((y + 0.5) * left.height) / comparisonHeight),
    );
    const rightY = Math.min(
      right.height - 1,
      Math.floor(((y + 0.5) * right.height) / comparisonHeight),
    );
    for (let x = 0; x < comparisonWidth; x += 1) {
      const leftX = Math.min(
        left.width - 1,
        Math.floor(((x + 0.5) * left.width) / comparisonWidth),
      );
      const rightX = Math.min(
        right.width - 1,
        Math.floor(((x + 0.5) * right.width) / comparisonWidth),
      );
      const leftIndex = leftY * left.width + leftX;
      const rightIndex = rightY * right.width + rightX;
      const rgbDifference =
        (Math.abs(left.red[leftIndex] - right.red[rightIndex]) +
          Math.abs(left.green[leftIndex] - right.green[rightIndex]) +
          Math.abs(left.blue[leftIndex] - right.blue[rightIndex])) /
        3;
      const luminanceDifference = Math.abs(
        left.luminance[leftIndex] - right.luminance[rightIndex],
      );
      difference += rgbDifference * 0.64 + luminanceDifference * 0.36;
      count += 1;
    }
  }

  return clamp01((count > 0 ? difference / count : 0) / 0.48);
}

function roundMilliseconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Creates a low-discrepancy sampling plan that covers the whole source while
 * avoiding the blind spots produced by six fixed, uniformly spaced seeks.
 */
export function createRepresentativeFrameSampleTimes(
  duration: number,
  options: RepresentativeSampleOptions = {},
) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const requestedCount = options.count ?? Math.round(12 + duration / 12);
  const count = Math.max(3, Math.min(24, Math.round(requestedCount)));
  const startPadding = Math.min(
    duration * 0.08,
    Math.max(0, options.startPaddingSeconds ?? Math.min(0.18, duration * 0.02)),
  );
  const endPadding = Math.min(
    duration * 0.08,
    Math.max(0, options.endPaddingSeconds ?? Math.min(0.18, duration * 0.02)),
  );
  const usableDuration = Math.max(0, duration - startPadding - endPadding);
  if (usableDuration === 0) return [roundMilliseconds(duration / 2)];

  const ratios: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const jitter =
      0.22 +
      0.56 * (((index + 1) * GOLDEN_RATIO_CONJUGATE) % 1);
    ratios.push((index + jitter) / count);
  }
  ratios[0] = 0.01;
  ratios[ratios.length - 1] = 0.99;
  ratios[Math.floor(ratios.length / 2)] = 0.5;

  return [...new Set(
    ratios
      .map((ratio) => roundMilliseconds(startPadding + usableDuration * ratio))
      .sort((left, right) => left - right),
  )];
}

function finiteTime(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Selects visually strong and scene-diverse frames while guaranteeing broad
 * early/middle/late coverage. The returned array is chronological.
 */
export function selectRepresentativeVideoFrames<T>(
  candidates: readonly VideoFrameCandidate<T>[],
  options: RepresentativeFrameOptions = {},
): RankedVideoFrame<T>[] {
  if (candidates.length === 0) return [];
  const desiredCount = Math.max(
    1,
    Math.min(candidates.length, Math.round(options.count ?? 6)),
  );
  const chronological = candidates
    .map((candidate, originalIndex) => ({
      candidate,
      originalIndex,
      time: finiteTime(candidate.time),
      analysis: analyzeVideoFrame(candidate.image, candidate.metadata),
      sceneChangeScore: 0,
    }))
    .sort(
      (left, right) => left.time - right.time || left.originalIndex - right.originalIndex,
    );
  chronological.forEach((entry, index) => {
    if (index === 0) return;
    entry.sceneChangeScore = calculateSceneDifference(
      chronological[index - 1].candidate.image,
      entry.candidate.image,
    );
  });

  const inferredDuration = Math.max(
    chronological.at(-1)?.time ?? 0,
    Number.isFinite(options.duration) ? Math.max(0, options.duration ?? 0) : 0,
  );
  const duration = Math.max(0.001, inferredDuration);
  const minSpacing = Math.max(
    0,
    options.minSpacingSeconds ?? Math.min(1.25, duration / (desiredCount * 8)),
  );
  const selected = new Set<(typeof chronological)[number]>();
  const coverageRegionCount = Math.min(3, desiredCount);

  for (let region = 0; region < coverageRegionCount; region += 1) {
    const regionStart = (duration * region) / coverageRegionCount;
    const regionEnd = (duration * (region + 1)) / coverageRegionCount;
    const regionEntries = chronological.filter(
      (entry) =>
        entry.time >= regionStart &&
        (region === coverageRegionCount - 1
          ? entry.time <= regionEnd
          : entry.time < regionEnd),
    );
    const best = regionEntries.sort(
      (left, right) =>
        right.analysis.qualityScore + right.sceneChangeScore * 0.12 -
          (left.analysis.qualityScore + left.sceneChangeScore * 0.12) ||
        left.time - right.time,
    )[0];
    if (best) selected.add(best);
  }

  while (selected.size < desiredCount) {
    let bestEntry: (typeof chronological)[number] | undefined;
    let bestScore = -1;
    for (const entry of chronological) {
      if (selected.has(entry)) continue;
      const selectedEntries = [...selected];
      const nearestSeconds =
        selectedEntries.length > 0
          ? Math.min(...selectedEntries.map((item) => Math.abs(item.time - entry.time)))
          : duration;
      if (nearestSeconds < minSpacing) continue;
      const nearestSceneDifference =
        selectedEntries.length > 0
          ? Math.min(
              ...selectedEntries.map((item) =>
                calculateSceneDifference(item.candidate.image, entry.candidate.image),
              ),
            )
          : 1;
      const temporalDiversity = clamp01(nearestSeconds / (duration / desiredCount));
      const representativeScore =
        entry.analysis.qualityScore * 0.62 +
        nearestSceneDifference * 0.22 +
        temporalDiversity * 0.11 +
        entry.sceneChangeScore * 0.05;
      if (
        representativeScore > bestScore ||
        (representativeScore === bestScore &&
          (!bestEntry || entry.time < bestEntry.time))
      ) {
        bestEntry = entry;
        bestScore = representativeScore;
      }
    }

    if (!bestEntry) {
      bestEntry = chronological.find((entry) => !selected.has(entry));
      if (!bestEntry) break;
      bestScore = bestEntry.analysis.qualityScore;
    }
    selected.add(bestEntry);
  }

  return [...selected]
    .map((entry) => ({
      candidate: entry.candidate,
      analysis: entry.analysis,
      sceneChangeScore: entry.sceneChangeScore,
      representativeScore:
        entry.analysis.qualityScore * 0.82 + entry.sceneChangeScore * 0.18,
    }))
    .sort(
      (left, right) =>
        finiteTime(left.candidate.time) - finiteTime(right.candidate.time),
    );
}
