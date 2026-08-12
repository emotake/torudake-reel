import {
  PHOTO_REEL_MAX_PHOTOS,
  PHOTO_REEL_MAX_MOTION_SCALE,
  PHOTO_REEL_MIN_PHOTOS,
  PHOTO_REEL_OUTPUT_HEIGHT,
  PHOTO_REEL_OUTPUT_WIDTH,
  computePhotoReelImageLayout,
  type PreparedPhotoAsset,
} from "./photo-reel";

let photoAssetSequence = 0;
export const PHOTO_REEL_THUMBNAIL_MAX_EDGE = 192;

export type PhotoReelPrepareProgress = (
  progress: number,
  preparedCount: number,
  total: number,
) => void;

export class PhotoReelPhotoDecodeError extends Error {
  readonly code = "photo-reel-photo-decode";
  readonly fileName: string;

  constructor(fileName: string, options?: ErrorOptions) {
    super(
      `「${fileName}」を読み込めませんでした。JPEG・PNG・WebP・HEIC・HEIF形式の写真でお試しください。`,
      options,
    );
    this.name = "PhotoReelPhotoDecodeError";
    this.fileName = fileName;
  }
}

function createCanvas(width: number, height: number) {
  if (typeof document === "undefined") {
    throw new Error("Photo preparation is available only in a browser.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function getCanvasContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not prepare a photo canvas.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

async function loadImageElement(url: string) {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("The image element could not decode the photo.")),
      { once: true },
    );
    image.src = url;
  });
  await image.decode().catch(() => undefined);
  return image;
}

async function decodePhoto(file: File, previewUrl: string) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap as CanvasImageSource,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Safari and some HEIF/JPEG combinations need an HTMLImageElement.
    }
  }

  const image = await loadImageElement(previewUrl);
  return {
    source: image as CanvasImageSource,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => image.removeAttribute("src"),
  };
}

export function computePhotoReelThumbnailDimensions(
  width: number,
  height: number,
  maxEdge = PHOTO_REEL_THUMBNAIL_MAX_EDGE,
) {
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(maxEdge) ||
    maxEdge <= 0
  ) {
    throw new RangeError("Photo thumbnail dimensions must be positive.");
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function createThumbnailUrl(source: HTMLCanvasElement) {
  const dimensions = computePhotoReelThumbnailDimensions(
    source.width,
    source.height,
  );
  const thumbnail = createCanvas(dimensions.width, dimensions.height);
  try {
    const context = getCanvasContext(thumbnail);
    context.drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      thumbnail.toBlob(
        (result) => {
          if (result) resolve(result);
          else reject(new Error("The browser could not create a photo thumbnail."));
        },
        "image/jpeg",
        0.82,
      );
    });
    return URL.createObjectURL(blob);
  } finally {
    thumbnail.width = 1;
    thumbnail.height = 1;
  }
}

function getNormalizedPhotoDimensions(width: number, height: number) {
  const layout = computePhotoReelImageLayout(width, height);
  const target =
    layout.mode === "blur-fit" ? layout.foreground : layout.background;
  // Keep enough real source pixels for the largest Ken Burns zoom. Without
  // this cover photos were first reduced to exactly 1080x1920 and then scaled
  // up again during motion, making otherwise sharp iPhone photos look soft.
  const requiredScale =
    layout.mode === "blur-fit"
      ? Math.min(
          (target.width * PHOTO_REEL_MAX_MOTION_SCALE) / width,
          (target.height * PHOTO_REEL_MAX_MOTION_SCALE) / height,
        )
      : Math.max(
          (target.width * PHOTO_REEL_MAX_MOTION_SCALE) / width,
          (target.height * PHOTO_REEL_MAX_MOTION_SCALE) / height,
        );
  const scale = Math.min(1, requiredScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function createBlurredBackground(
  source: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
) {
  const width = PHOTO_REEL_OUTPUT_WIDTH / 4;
  const height = PHOTO_REEL_OUTPUT_HEIGHT / 4;
  const canvas = createCanvas(width, height);
  const context = getCanvasContext(canvas);
  const layout = computePhotoReelImageLayout(
    sourceWidth,
    sourceHeight,
    width,
    height,
  );
  const overscan = 20;
  context.fillStyle = "#07101f";
  context.fillRect(0, 0, width, height);
  context.save();
  context.filter = "blur(18px) saturate(0.92) brightness(0.74)";
  context.drawImage(
    source,
    layout.background.x - overscan,
    layout.background.y - overscan,
    layout.background.width + overscan * 2,
    layout.background.height + overscan * 2,
  );
  context.restore();
  context.fillStyle = "rgba(7, 16, 31, 0.1)";
  context.fillRect(0, 0, width, height);
  return canvas;
}

async function prepareSinglePhoto(
  file: File,
  index: number,
): Promise<PreparedPhotoAsset> {
  const decodeUrl = URL.createObjectURL(file);
  let source: HTMLCanvasElement | null = null;
  let blurredBackground: HTMLCanvasElement | null = null;
  let previewUrl: string | null = null;
  try {
    const decoded = await decodePhoto(file, decodeUrl);
    try {
      if (
        !Number.isFinite(decoded.width) ||
        decoded.width <= 0 ||
        !Number.isFinite(decoded.height) ||
        decoded.height <= 0
      ) {
        throw new Error("The decoded photo has invalid dimensions.");
      }
      const normalized = getNormalizedPhotoDimensions(
        decoded.width,
        decoded.height,
      );
      source = createCanvas(normalized.width, normalized.height);
      const context = getCanvasContext(source);
      context.fillStyle = "#07101f";
      context.fillRect(0, 0, source.width, source.height);
      context.drawImage(decoded.source, 0, 0, source.width, source.height);
      blurredBackground = createBlurredBackground(
        source,
        decoded.width,
        decoded.height,
      );
      previewUrl = await createThumbnailUrl(source);
      return {
        id: createPhotoAssetId(file, index),
        name: file.name,
        file,
        previewUrl,
        width: decoded.width,
        height: decoded.height,
        source,
        blurredBackground,
      };
    } finally {
      decoded.dispose();
    }
  } catch (error) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (source) {
      source.width = 1;
      source.height = 1;
    }
    if (blurredBackground) {
      blurredBackground.width = 1;
      blurredBackground.height = 1;
    }
    throw new PhotoReelPhotoDecodeError(file.name, { cause: error });
  } finally {
    URL.revokeObjectURL(decodeUrl);
  }
}

function createPhotoAssetId(file: File, index: number) {
  photoAssetSequence += 1;
  const randomId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${photoAssetSequence}`;
  return `photo-${index}-${file.lastModified}-${file.size}-${randomId}`;
}

/**
 * Decodes photos sequentially and downsizes each one before moving to the next.
 * This keeps iPhone memory use bounded even when ten high-resolution photos are
 * selected. Original decode URLs are revoked immediately; returned thumbnail
 * URLs remain valid until disposePhotoAssets().
 */
export async function preparePhotoAssets(
  files: readonly File[],
  onProgress?: PhotoReelPrepareProgress,
): Promise<PreparedPhotoAsset[]> {
  if (files.length < 1 || files.length > PHOTO_REEL_MAX_PHOTOS) {
    throw new RangeError(
      `Prepare between 1 and ${PHOTO_REEL_MAX_PHOTOS} photos at a time. A reel requires at least ${PHOTO_REEL_MIN_PHOTOS}.`,
    );
  }
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("This browser cannot prepare local photos.");
  }

  const prepared: PreparedPhotoAsset[] = [];
  onProgress?.(0, 0, files.length);
  try {
    for (const [index, file] of files.entries()) {
      if (
        !(file instanceof File) ||
        (!file.type.startsWith("image/") &&
          !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name))
      ) {
        throw new PhotoReelPhotoDecodeError(file?.name ?? `写真${index + 1}`);
      }
      prepared.push(await prepareSinglePhoto(file, index));
      onProgress?.((index + 1) / files.length, index + 1, files.length);
    }
    return prepared;
  } catch (error) {
    disposePhotoAssets(prepared);
    throw error;
  }
}

export function disposePhotoAssets(assets: readonly PreparedPhotoAsset[]) {
  for (const asset of assets) {
    URL.revokeObjectURL(asset.previewUrl);
    asset.source.width = 1;
    asset.source.height = 1;
    if (asset.blurredBackground) {
      asset.blurredBackground.width = 1;
      asset.blurredBackground.height = 1;
    }
  }
}
