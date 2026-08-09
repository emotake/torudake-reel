export const PHOTO_REEL_MIN_PHOTOS = 2;
export const PHOTO_REEL_MAX_PHOTOS = 10;
export const PHOTO_REEL_OUTPUT_WIDTH = 1080;
export const PHOTO_REEL_OUTPUT_HEIGHT = 1920;
export const PHOTO_REEL_FRAME_RATE = 30;

export type PhotoReelDuration = 15 | 30;
export type PhotoReelTemplateId =
  | "cinematic"
  | "upbeat"
  | "editorial"
  | "memories"
  | "gallery";

export type PhotoReelTransition =
  | "crossfade"
  | "flash"
  | "wipe"
  | "slide";

export type PhotoReelAudioFit = "loop" | "trim";

export type PhotoReelTemplate = Readonly<{
  id: PhotoReelTemplateId;
  label: string;
  description: string;
  transition: PhotoReelTransition;
  transitionDuration: number;
  durationWeights: readonly number[];
}>;

export const PHOTO_REEL_TEMPLATES: readonly PhotoReelTemplate[] = [
  {
    id: "cinematic",
    label: "シネマティック",
    description: "ゆっくり寄る動きと柔らかなクロスフェードで、映画のように見せます。",
    transition: "crossfade",
    transitionDuration: 0.55,
    durationWeights: [1, 1.08, 0.96, 1.04],
  },
  {
    id: "upbeat",
    label: "リズミカル",
    description: "小気味よい切り替えと弾むような動きで、テンポよく見せます。",
    transition: "flash",
    transitionDuration: 0.16,
    durationWeights: [0.82, 1.08, 0.9, 1.2, 0.88],
  },
  {
    id: "editorial",
    label: "エディトリアル",
    description: "雑誌のページをめくるような端正な余白とワイプで見せます。",
    transition: "wipe",
    transitionDuration: 0.38,
    durationWeights: [1.12, 0.92, 1, 0.96],
  },
  {
    id: "memories",
    label: "メモリーズ",
    description: "温かい色合いと穏やかな引きの動きで、思い出を自然につなぎます。",
    transition: "crossfade",
    transitionDuration: 0.72,
    durationWeights: [1.15, 0.95, 1.08, 0.9],
  },
  {
    id: "gallery",
    label: "プレミアムギャラリー",
    description: "写真を上質なカードのように扱い、滑らかなスライドで見せます。",
    transition: "slide",
    transitionDuration: 0.46,
    durationWeights: [1, 0.94, 1.06, 1],
  },
] as const;

export type PhotoReelSettings = Readonly<{
  duration: PhotoReelDuration;
  templateId: PhotoReelTemplateId;
  title?: string;
  audioFile?: File | null;
  audioFit?: PhotoReelAudioFit;
  audioGain?: number;
}>;

export type PhotoReelAssetDescriptor = Readonly<{
  id: string;
  name: string;
  width: number;
  height: number;
}>;

export type PreparedPhotoAsset = PhotoReelAssetDescriptor &
  Readonly<{
    file: File;
    previewUrl: string;
    source: HTMLCanvasElement;
    blurredBackground: HTMLCanvasElement | null;
  }>;

export type PhotoReelSlide = Readonly<{
  assetId: string;
  assetIndex: number;
  start: number;
  end: number;
  duration: number;
  transition: PhotoReelTransition;
  transitionDuration: number;
}>;

export type PhotoReelPlan = Readonly<{
  duration: PhotoReelDuration;
  frameRate: typeof PHOTO_REEL_FRAME_RATE;
  width: typeof PHOTO_REEL_OUTPUT_WIDTH;
  height: typeof PHOTO_REEL_OUTPUT_HEIGHT;
  template: PhotoReelTemplate;
  title: string;
  slides: readonly PhotoReelSlide[];
}>;

export type PhotoReelFrameScheduleEntry = Readonly<{
  frameIndex: number;
  time: number;
  duration: number;
}>;

export type PhotoReelFrameClip = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PhotoReelFrameLayer = Readonly<{
  assetId: string;
  assetIndex: number;
  opacity: number;
  progress: number;
  scale: number;
  translateX: number;
  translateY: number;
  rotation: number;
  clip: PhotoReelFrameClip | null;
}>;

export type PhotoReelFrameState = Readonly<{
  time: number;
  slideIndex: number;
  slideProgress: number;
  transitionProgress: number;
  layers: readonly PhotoReelFrameLayer[];
  flashOpacity: number;
  titleOpacity: number;
}>;

export type PhotoReelImageLayout = Readonly<{
  mode: "cover" | "blur-fit";
  foreground: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  background: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}>;

const TIME_EPSILON = 1e-7;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function easeInOut(value: number) {
  const progress = clamp(value);
  return progress < 0.5
    ? 2 * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
}

function easeOut(value: number) {
  return 1 - Math.pow(1 - clamp(value), 3);
}

function normalizeTitle(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function getPhotoReelTemplate(templateId: PhotoReelTemplateId) {
  const template = PHOTO_REEL_TEMPLATES.find((item) => item.id === templateId);
  if (!template) throw new RangeError(`Unknown photo reel template: ${templateId}`);
  return template;
}

function validatePhotoReelAssetsWithMinimum(
  assets: readonly PhotoReelAssetDescriptor[],
  minimum: number,
) {
  if (
    assets.length < minimum ||
    assets.length > PHOTO_REEL_MAX_PHOTOS
  ) {
    throw new RangeError(
      `Photo reels require ${minimum}-${PHOTO_REEL_MAX_PHOTOS} photos.`,
    );
  }

  const ids = new Set<string>();
  for (const asset of assets) {
    if (!asset.id || ids.has(asset.id)) {
      throw new TypeError("Each photo must have a unique, non-empty id.");
    }
    ids.add(asset.id);
    if (
      !Number.isFinite(asset.width) ||
      asset.width <= 0 ||
      !Number.isFinite(asset.height) ||
      asset.height <= 0
    ) {
      throw new RangeError("Photo dimensions must be finite positive numbers.");
    }
  }
}

export function validatePhotoReelAssets(
  assets: readonly PhotoReelAssetDescriptor[],
) {
  validatePhotoReelAssetsWithMinimum(assets, PHOTO_REEL_MIN_PHOTOS);
}

function createPhotoReelPlanWithMinimum(
  assets: readonly PhotoReelAssetDescriptor[],
  settings: PhotoReelSettings,
  minimumPhotoCount: number,
): PhotoReelPlan {
  validatePhotoReelAssetsWithMinimum(assets, minimumPhotoCount);
  if (settings.duration !== 15 && settings.duration !== 30) {
    throw new RangeError("Photo reel duration must be 15 or 30 seconds.");
  }

  const template = getPhotoReelTemplate(settings.templateId);
  const weights = assets.map(
    (_, index) =>
      template.durationWeights[index % template.durationWeights.length] ?? 1,
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  const slides = assets.map((asset, index): PhotoReelSlide => {
    const isLast = index === assets.length - 1;
    const duration = isLast
      ? settings.duration - cursor
      : (settings.duration * weights[index]) / totalWeight;
    const start = cursor;
    const end = isLast ? settings.duration : start + duration;
    cursor = end;
    return {
      assetId: asset.id,
      assetIndex: index,
      start,
      end,
      duration: end - start,
      transition: template.transition,
      transitionDuration:
        index === 0
          ? 0
          : Math.min(template.transitionDuration, (end - start) * 0.28),
    };
  });

  return {
    duration: settings.duration,
    frameRate: PHOTO_REEL_FRAME_RATE,
    width: PHOTO_REEL_OUTPUT_WIDTH,
    height: PHOTO_REEL_OUTPUT_HEIGHT,
    template,
    title: normalizeTitle(settings.title),
    slides,
  };
}

export function createPhotoReelPlan(
  assets: readonly PhotoReelAssetDescriptor[],
  settings: PhotoReelSettings,
) {
  return createPhotoReelPlanWithMinimum(
    assets,
    settings,
    PHOTO_REEL_MIN_PHOTOS,
  );
}

export function buildPhotoReelFrameSchedule(
  plan: PhotoReelPlan,
): PhotoReelFrameScheduleEntry[] {
  const frameDuration = 1 / plan.frameRate;
  const frameCount = Math.max(
    1,
    Math.ceil(plan.duration * plan.frameRate - TIME_EPSILON),
  );

  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const time = frameIndex * frameDuration;
    return {
      frameIndex,
      time,
      duration: Math.min(frameDuration, plan.duration - time),
    };
  });
}

function getMotion(
  templateId: PhotoReelTemplateId,
  assetIndex: number,
  progress: number,
) {
  const direction = assetIndex % 2 === 0 ? 1 : -1;
  const verticalDirection = assetIndex % 3 === 0 ? -1 : 1;
  const smooth = easeInOut(progress);

  switch (templateId) {
    case "cinematic":
      return {
        scale: 1.025 + smooth * 0.075,
        translateX: direction * (0.014 - smooth * 0.028),
        translateY: verticalDirection * (0.008 - smooth * 0.016),
        rotation: 0,
      };
    case "upbeat": {
      const settle = 1 - easeOut(Math.min(1, progress * 4));
      return {
        scale: 1.035 + settle * 0.055 + Math.sin(progress * Math.PI) * 0.008,
        translateX: direction * 0.008 * (1 - smooth),
        translateY: 0,
        rotation: direction * settle * 0.004,
      };
    }
    case "editorial":
      return {
        scale: 1.018 + smooth * 0.042,
        translateX: direction * (0.025 - smooth * 0.05),
        translateY: 0,
        rotation: 0,
      };
    case "memories":
      return {
        scale: 1.075 - smooth * 0.055,
        translateX: direction * (0.01 - smooth * 0.02),
        translateY: verticalDirection * (0.012 - smooth * 0.024),
        rotation: 0,
      };
    case "gallery":
      return {
        scale: 0.975 + easeOut(progress) * 0.035,
        translateX: direction * 0.008 * (1 - smooth),
        translateY: 0.01 * (1 - easeOut(progress)),
        rotation: direction * (0.006 - smooth * 0.004),
      };
  }
}

function buildLayer(
  plan: PhotoReelPlan,
  slideIndex: number,
  progress: number,
  opacity: number,
  transitionTranslateX = 0,
  clip: PhotoReelFrameClip | null = null,
): PhotoReelFrameLayer {
  const slide = plan.slides[slideIndex];
  const motion = getMotion(
    plan.template.id,
    slide.assetIndex,
    clamp(progress),
  );
  return {
    assetId: slide.assetId,
    assetIndex: slide.assetIndex,
    opacity: clamp(opacity),
    progress: clamp(progress),
    scale: motion.scale,
    translateX: motion.translateX + transitionTranslateX,
    translateY: motion.translateY,
    rotation: motion.rotation,
    clip,
  };
}

function getTitleOpacity(plan: PhotoReelPlan, time: number) {
  if (!plan.title) return 0;
  const visibleUntil = Math.min(3.2, Math.max(1.8, plan.slides[0].duration));
  const fadeIn = clamp(time / 0.45);
  const fadeOut = clamp((visibleUntil - time) / 0.55);
  return easeOut(Math.min(fadeIn, fadeOut));
}

export function getPhotoReelFrameState(
  plan: PhotoReelPlan,
  requestedTime: number,
): PhotoReelFrameState {
  if (!Number.isFinite(requestedTime)) {
    throw new TypeError("Photo reel time must be finite.");
  }
  const time = clamp(requestedTime, 0, plan.duration);
  const matchedSlideIndex = plan.slides.findIndex(
    (slide) => time < slide.end - TIME_EPSILON,
  );
  const slideIndex =
    time >= plan.duration || matchedSlideIndex < 0
      ? plan.slides.length - 1
      : matchedSlideIndex;
  const slide = plan.slides[slideIndex];
  const localTime = clamp(time - slide.start, 0, slide.duration);
  const slideProgress = clamp(localTime / slide.duration);
  const rawTransitionProgress =
    slideIndex === 0 || slide.transitionDuration <= TIME_EPSILON
      ? 1
      : clamp(localTime / slide.transitionDuration);
  const transitionProgress = easeInOut(rawTransitionProgress);
  let flashOpacity = 0;
  let layers: PhotoReelFrameLayer[];

  if (slideIndex === 0 || rawTransitionProgress >= 1) {
    layers = [buildLayer(plan, slideIndex, slideProgress, 1)];
  } else {
    switch (slide.transition) {
      case "crossfade":
        layers = [
          buildLayer(plan, slideIndex - 1, 1, 1 - transitionProgress),
          buildLayer(plan, slideIndex, slideProgress, transitionProgress),
        ];
        break;
      case "wipe": {
        const fromRight = slideIndex % 2 === 0;
        const width = transitionProgress;
        layers = [
          buildLayer(plan, slideIndex - 1, 1, 1),
          buildLayer(plan, slideIndex, slideProgress, 1, 0, {
            x: fromRight ? 1 - width : 0,
            y: 0,
            width,
            height: 1,
          }),
        ];
        break;
      }
      case "slide": {
        const direction = slideIndex % 2 === 0 ? 1 : -1;
        layers = [
          buildLayer(
            plan,
            slideIndex - 1,
            1,
            1 - transitionProgress * 0.18,
            -direction * transitionProgress * 0.16,
          ),
          buildLayer(
            plan,
            slideIndex,
            slideProgress,
            1,
            direction * (1 - transitionProgress),
          ),
        ];
        break;
      }
      case "flash":
        flashOpacity = Math.sin(rawTransitionProgress * Math.PI) * 0.62;
        layers = [
          rawTransitionProgress < 0.46
            ? buildLayer(plan, slideIndex - 1, 1, 1)
            : buildLayer(plan, slideIndex, slideProgress, 1),
        ];
        break;
    }
  }

  return {
    time,
    slideIndex,
    slideProgress,
    transitionProgress,
    layers,
    flashOpacity,
    titleOpacity: getTitleOpacity(plan, time),
  };
}

function computeContainRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
) {
  const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (outputWidth - width) / 2,
    y: (outputHeight - height) / 2,
    width,
    height,
  };
}

function computeCoverRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
) {
  const scale = Math.max(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (outputWidth - width) / 2,
    y: (outputHeight - height) / 2,
    width,
    height,
  };
}

export function computePhotoReelImageLayout(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth = PHOTO_REEL_OUTPUT_WIDTH,
  outputHeight = PHOTO_REEL_OUTPUT_HEIGHT,
): PhotoReelImageLayout {
  if (
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0 ||
    !Number.isFinite(outputWidth) ||
    outputWidth <= 0 ||
    !Number.isFinite(outputHeight) ||
    outputHeight <= 0
  ) {
    throw new RangeError("Photo and output dimensions must be positive.");
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const outputAspect = outputWidth / outputHeight;
  const aspectDifference = Math.abs(Math.log(sourceAspect / outputAspect));
  const mode = aspectDifference > 0.09 ? "blur-fit" : "cover";
  return {
    mode,
    foreground:
      mode === "blur-fit"
        ? computeContainRect(
            sourceWidth,
            sourceHeight,
            outputWidth,
            outputHeight,
          )
        : computeCoverRect(
            sourceWidth,
            sourceHeight,
            outputWidth,
            outputHeight,
          ),
    background: computeCoverRect(
      sourceWidth,
      sourceHeight,
      outputWidth,
      outputHeight,
    ),
  };
}

function getTemplateImageFilter(templateId: PhotoReelTemplateId) {
  switch (templateId) {
    case "cinematic":
      return "contrast(1.08) saturate(0.94) brightness(0.96)";
    case "upbeat":
      return "contrast(1.05) saturate(1.12)";
    case "editorial":
      return "contrast(1.02) saturate(0.9) brightness(1.04)";
    case "memories":
      return "sepia(0.08) saturate(0.92) brightness(1.02)";
    case "gallery":
      return "contrast(1.03) saturate(1.02)";
  }
}

function drawCoverBackground(
  context: CanvasRenderingContext2D,
  asset: PreparedPhotoAsset,
  layout: PhotoReelImageLayout,
) {
  if (asset.blurredBackground) {
    context.drawImage(
      asset.blurredBackground,
      0,
      0,
      context.canvas.width,
      context.canvas.height,
    );
  } else {
    context.save();
    context.filter = "blur(42px) saturate(0.9) brightness(0.72)";
    const overscan = 48;
    context.drawImage(
      asset.source,
      layout.background.x - overscan,
      layout.background.y - overscan,
      layout.background.width + overscan * 2,
      layout.background.height + overscan * 2,
    );
    context.restore();
  }
  context.save();
  context.globalAlpha = 0.12;
  context.fillStyle = "#07101f";
  context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const corner = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + corner, y);
  context.lineTo(x + width - corner, y);
  context.quadraticCurveTo(x + width, y, x + width, y + corner);
  context.lineTo(x + width, y + height - corner);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - corner,
    y + height,
  );
  context.lineTo(x + corner, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - corner);
  context.lineTo(x, y + corner);
  context.quadraticCurveTo(x, y, x + corner, y);
  context.closePath();
}

function drawPhotoAsset(
  context: CanvasRenderingContext2D,
  asset: PreparedPhotoAsset,
  templateId: PhotoReelTemplateId,
) {
  const layout = computePhotoReelImageLayout(
    asset.width,
    asset.height,
    context.canvas.width,
    context.canvas.height,
  );
  const gallery = templateId === "gallery";
  if (layout.mode === "blur-fit" || gallery) {
    drawCoverBackground(context, asset, layout);
  }

  context.save();
  context.filter = getTemplateImageFilter(templateId);
  if (gallery) {
    const padding = 54;
    const maxWidth = context.canvas.width - padding * 2;
    const maxHeight = context.canvas.height - 250;
    const galleryRect = computeContainRect(
      asset.width,
      asset.height,
      maxWidth,
      maxHeight,
    );
    const x = padding + galleryRect.x;
    const y = 125 + galleryRect.y;
    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.34)";
    context.shadowBlur = 42;
    context.shadowOffsetY = 18;
    context.fillStyle = "rgba(255, 255, 255, 0.96)";
    roundedRectPath(
      context,
      x - 22,
      y - 22,
      galleryRect.width + 44,
      galleryRect.height + 44,
      22,
    );
    context.fill();
    context.restore();
    roundedRectPath(context, x, y, galleryRect.width, galleryRect.height, 12);
    context.clip();
    context.drawImage(
      asset.source,
      x,
      y,
      galleryRect.width,
      galleryRect.height,
    );
  } else {
    context.drawImage(
      asset.source,
      layout.foreground.x,
      layout.foreground.y,
      layout.foreground.width,
      layout.foreground.height,
    );
  }
  context.restore();
}

function drawTemplateFinish(
  context: CanvasRenderingContext2D,
  plan: PhotoReelPlan,
  frame: PhotoReelFrameState,
) {
  const { width, height } = context.canvas;
  context.save();
  switch (plan.template.id) {
    case "cinematic": {
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "rgba(3, 8, 18, 0.22)");
      gradient.addColorStop(0.42, "rgba(3, 8, 18, 0)");
      gradient.addColorStop(1, "rgba(3, 8, 18, 0.42)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      break;
    }
    case "upbeat":
      if (frame.flashOpacity > 0) {
        context.globalAlpha = frame.flashOpacity;
        context.fillStyle = "#fffaf2";
        context.fillRect(0, 0, width, height);
      }
      break;
    case "editorial":
      context.globalAlpha = 0.88;
      context.fillStyle = "#f5eee2";
      context.fillRect(0, 0, 12, height);
      context.fillRect(width - 12, 0, 12, height);
      context.globalAlpha = 0.34;
      context.fillRect(38, 92, 2, height - 184);
      break;
    case "memories": {
      context.globalAlpha = 0.11;
      context.fillStyle = "#d69c62";
      context.fillRect(0, 0, width, height);
      const vignette = context.createRadialGradient(
        width / 2,
        height / 2,
        height * 0.2,
        width / 2,
        height / 2,
        height * 0.72,
      );
      vignette.addColorStop(0, "rgba(34, 18, 10, 0)");
      vignette.addColorStop(1, "rgba(34, 18, 10, 0.32)");
      context.globalAlpha = 1;
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
      break;
    }
    case "gallery": {
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "rgba(7, 16, 31, 0.2)");
      gradient.addColorStop(0.6, "rgba(7, 16, 31, 0)");
      gradient.addColorStop(1, "rgba(7, 16, 31, 0.28)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      break;
    }
  }
  context.restore();
}

function wrapTitle(context: CanvasRenderingContext2D, title: string) {
  const characters = Array.from(title);
  const lines: string[] = [];
  let line = "";
  for (const character of characters) {
    const candidate = line + character;
    if (line && context.measureText(candidate).width > 860) {
      lines.push(line);
      line = character;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function drawTitle(
  context: CanvasRenderingContext2D,
  plan: PhotoReelPlan,
  opacity: number,
) {
  if (!plan.title || opacity <= 0) return;
  context.save();
  context.globalAlpha = opacity;
  context.textBaseline = "middle";
  context.shadowColor = "rgba(0, 0, 0, 0.48)";
  context.shadowBlur = 20;
  context.shadowOffsetY = 4;
  const isEditorial = plan.template.id === "editorial";
  const isUpbeat = plan.template.id === "upbeat";
  context.font = `${isUpbeat ? 800 : 700} ${isUpbeat ? 76 : 68}px ${
    isEditorial
      ? '"Yu Mincho", "Hiragino Mincho ProN", serif'
      : '"Hiragino Sans", "Yu Gothic", sans-serif'
  }`;
  context.fillStyle = isEditorial ? "#fffaf0" : "#ffffff";
  const lines = wrapTitle(context, plan.title);
  const lineHeight = isUpbeat ? 96 : 88;
  const anchorY = isEditorial ? 250 : 1500;
  const startY = anchorY - ((lines.length - 1) * lineHeight) / 2;
  for (const [index, line] of lines.entries()) {
    context.textAlign = isEditorial ? "left" : "center";
    context.fillText(
      line,
      isEditorial ? 92 : context.canvas.width / 2,
      startY + index * lineHeight,
    );
  }
  context.restore();
}

export function drawPhotoReelPlanFrame(
  context: CanvasRenderingContext2D,
  assets: readonly PreparedPhotoAsset[],
  plan: PhotoReelPlan,
  time: number,
) {
  if (
    context.canvas.width !== plan.width ||
    context.canvas.height !== plan.height
  ) {
    throw new RangeError(
      `Photo reel canvas must be ${plan.width}x${plan.height} pixels.`,
    );
  }
  if (assets.length !== plan.slides.length) {
    throw new RangeError("Prepared photos do not match the photo reel plan.");
  }
  const frame = getPhotoReelFrameState(plan, time);
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = "none";
  context.fillStyle = "#07101f";
  context.fillRect(0, 0, plan.width, plan.height);

  for (const layer of frame.layers) {
    const asset = assets[layer.assetIndex];
    if (!asset || asset.id !== layer.assetId) {
      context.restore();
      throw new Error("Photo order changed after the reel plan was created.");
    }
    context.save();
    context.globalAlpha = layer.opacity;
    if (layer.clip) {
      context.beginPath();
      context.rect(
        layer.clip.x * plan.width,
        layer.clip.y * plan.height,
        layer.clip.width * plan.width,
        layer.clip.height * plan.height,
      );
      context.clip();
    }
    context.translate(
      plan.width / 2 + layer.translateX * plan.width,
      plan.height / 2 + layer.translateY * plan.height,
    );
    context.rotate(layer.rotation);
    context.scale(layer.scale, layer.scale);
    context.translate(-plan.width / 2, -plan.height / 2);
    drawPhotoAsset(context, asset, plan.template.id);
    context.restore();
  }

  drawTemplateFinish(context, plan, frame);
  drawTitle(context, plan, frame.titleOpacity);
  context.restore();
  return frame;
}

export function drawPhotoReelFrame(
  context: CanvasRenderingContext2D,
  assets: readonly PreparedPhotoAsset[],
  settings: PhotoReelSettings,
  time: number,
) {
  return drawPhotoReelPlanFrame(
    context,
    assets,
    createPhotoReelPlanWithMinimum(assets, settings, 1),
    time,
  );
}

export {
  disposePhotoAssets,
  preparePhotoAssets,
  PhotoReelPhotoDecodeError,
  type PhotoReelPrepareProgress,
} from "./photo-reel-assets";
