import type { ImageDataLike, NormalizedFace } from "./video-frame-analysis";

export type PhotoReelFocusPoint = Readonly<{
  x: number;
  y: number;
  confidence: number;
  source: "face" | "saliency" | "manual" | "center";
}>;

const DEFAULT_FOCUS: PhotoReelFocusPoint = Object.freeze({
  x: 0.5,
  y: 0.45,
  confidence: 0,
  source: "center",
});

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizePhotoReelFocusPoint(
  point: Partial<PhotoReelFocusPoint> | null | undefined,
  fallback = DEFAULT_FOCUS,
): PhotoReelFocusPoint {
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    return fallback;
  }
  return {
    x: clamp(point.x ?? fallback.x, 0.05, 0.95),
    y: clamp(point.y ?? fallback.y, 0.05, 0.95),
    confidence: clamp(point.confidence ?? 1),
    source: point.source ?? "manual",
  };
}

function estimateFromFaces(faces: readonly NormalizedFace[]) {
  const valid = faces.filter(
    (face) =>
      Number.isFinite(face.x) &&
      Number.isFinite(face.y) &&
      Number.isFinite(face.width) &&
      Number.isFinite(face.height) &&
      face.width > 0 &&
      face.height > 0,
  );
  if (valid.length === 0) return null;

  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  let totalArea = 0;
  for (const face of valid) {
    const width = clamp(face.width);
    const height = clamp(face.height);
    const area = width * height;
    const confidence = clamp(face.confidence ?? 1);
    const weight = Math.max(0.0025, Math.sqrt(area)) * confidence;
    weightedX += clamp(face.x + width / 2) * weight;
    // A small downward bias keeps some shoulders/body in a vertical crop.
    weightedY += clamp(face.y + height * 0.68) * weight;
    totalWeight += weight;
    totalArea += area;
  }
  if (totalWeight <= 0) return null;
  return normalizePhotoReelFocusPoint({
    x: weightedX / totalWeight,
    y: weightedY / totalWeight,
    confidence: clamp(0.62 + Math.min(0.34, totalArea * 1.8)),
    source: "face",
  });
}

function validateImage(image: ImageDataLike) {
  return (
    Number.isInteger(image.width) &&
    image.width > 0 &&
    Number.isInteger(image.height) &&
    image.height > 0 &&
    image.data.length >= image.width * image.height * 4
  );
}

/**
 * Finds a local visual subject from faces or edge/color saliency. It is small
 * enough for a thumbnail-sized canvas and never sends pixels off the device.
 */
export function estimatePhotoReelSubject(
  image: ImageDataLike,
  faces: readonly NormalizedFace[] = [],
): PhotoReelFocusPoint {
  const faceFocus = estimateFromFaces(faces);
  if (faceFocus) return faceFocus;
  if (!validateImage(image) || image.width < 3 || image.height < 3) {
    return DEFAULT_FOCUS;
  }

  const luminance = (x: number, y: number) => {
    const index = (y * image.width + x) * 4;
    return (
      Number(image.data[index]) * 0.2126 +
      Number(image.data[index + 1]) * 0.7152 +
      Number(image.data[index + 2]) * 0.0722
    ) / 255;
  };
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  let sampleCount = 0;

  for (let y = 1; y < image.height - 1; y += 1) {
    for (let x = 1; x < image.width - 1; x += 1) {
      const index = (y * image.width + x) * 4;
      const horizontal = Math.abs(luminance(x + 1, y) - luminance(x - 1, y));
      const vertical = Math.abs(luminance(x, y + 1) - luminance(x, y - 1));
      const red = Number(image.data[index]) / 255;
      const green = Number(image.data[index + 1]) / 255;
      const blue = Number(image.data[index + 2]) / 255;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const normalizedX = x / (image.width - 1);
      const normalizedY = y / (image.height - 1);
      const centerPrior = clamp(
        1 - Math.hypot(normalizedX - 0.5, normalizedY - 0.46) / 0.72,
      );
      const weight =
        (horizontal + vertical + chroma * 0.09) *
        (0.62 + centerPrior * 0.38);
      totalWeight += weight;
      weightedX += normalizedX * weight;
      weightedY += normalizedY * weight;
      sampleCount += 1;
    }
  }

  const averageSignal = sampleCount > 0 ? totalWeight / sampleCount : 0;
  if (totalWeight <= 0.0001 || averageSignal < 0.006) return DEFAULT_FOCUS;
  return normalizePhotoReelFocusPoint({
    x: weightedX / totalWeight,
    y: weightedY / totalWeight,
    confidence: clamp((averageSignal - 0.006) / 0.12, 0.08, 0.72),
    source: "saliency",
  });
}

export function getDefaultPhotoReelFocusPoint() {
  return DEFAULT_FOCUS;
}
