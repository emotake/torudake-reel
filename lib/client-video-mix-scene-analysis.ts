import {
  analyzeVideoFrame,
  calculateSceneDifference,
  createRepresentativeFrameSampleTimes,
  type ImageDataLike,
} from "./video-frame-analysis";
import {
  selectRecommendedVideoMixClips,
  type VideoMixSceneRecommendation,
  type VideoMixSceneSample,
} from "./video-mix-scene-selection";

export const VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES = 24;
export const VIDEO_MIX_SCENE_ANALYSIS_THUMBNAIL_COUNT = 6;

export type ClientVideoMixSceneAnalysis = Readonly<{
  recommendation: VideoMixSceneRecommendation;
  thumbnails: readonly string[];
}>;

const ANALYSIS_LONG_EDGE = 160;
const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_HEIGHT = 68;

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException("場面の自動選別を中止しました。", "AbortError");
  }
}

function waitForVideoMetadata(
  video: HTMLVideoElement,
  sourceUrl: string,
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(
      () => finish(new Error("動画の場面を読み取る準備に時間がかかっています。")),
      12_000,
    );
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onLoaded = () => {
      if (
        Number.isFinite(video.duration) &&
        video.duration > 0 &&
        video.videoWidth > 0 &&
        video.videoHeight > 0
      ) {
        finish();
      } else {
        finish(new Error("動画の場面を読み取れませんでした。"));
      }
    };
    const onError = () => finish(new Error("動画の場面を読み取れませんでした。"));
    const onAbort = () =>
      finish(new DOMException("場面の自動選別を中止しました。", "AbortError"));

    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    video.src = sourceUrl;
    video.load();
    if (signal.aborted) onAbort();
  });
}

function waitForCurrentFrameData(video: HTMLVideoElement, signal: AbortSignal) {
  throwIfAborted(signal);
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(
      () => finish(new Error("動画の場面の読み取りに時間がかかっています。")),
      6_000,
    );
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onLoaded = () => finish();
    const onError = () => finish(new Error("動画の場面を読み取れませんでした。"));
    const onAbort = () =>
      finish(new DOMException("場面の自動選別を中止しました。", "AbortError"));
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function seekVideoFrame(
  video: HTMLVideoElement,
  targetTime: number,
  duration: number,
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  const safeTime = Math.min(
    Math.max(0, targetTime),
    Math.max(0, duration - 0.04),
  );
  if (Math.abs(video.currentTime - safeTime) >= 0.001) {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(
        () => finish(new Error("動画の場面の読み取りに時間がかかっています。")),
        6_000,
      );
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onSeeked = () => finish();
      const onError = () => finish(new Error("動画の場面を読み取れませんでした。"));
      const onAbort = () =>
        finish(new DOMException("場面の自動選別を中止しました。", "AbortError"));
      video.addEventListener("seeked", onSeeked, { once: true });
      video.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      video.currentTime = safeTime;
      if (signal.aborted) onAbort();
    });
  }
  // `seeked` means the requested frame is decoded and available to Canvas.
  // Waiting for requestVideoFrameCallback after this point can cost its full
  // timeout for every frame while a video is paused (especially on iOS).
  await waitForCurrentFrameData(video, signal);
  throwIfAborted(signal);
}

function limitSampleTimes(times: readonly number[]) {
  if (times.length <= VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES) return [...times];
  return Array.from(
    { length: VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES },
    (_, index) =>
      times[
        Math.round(
          (index * (times.length - 1)) /
            (VIDEO_MIX_SCENE_ANALYSIS_MAX_FRAMES - 1),
        )
      ],
  );
}

function thumbnailSlotsBySample(sampleCount: number) {
  const slots = new Map<number, number[]>();
  for (let slot = 0; slot < VIDEO_MIX_SCENE_ANALYSIS_THUMBNAIL_COUNT; slot += 1) {
    const sampleIndex = Math.round(
      (slot * Math.max(0, sampleCount - 1)) /
        Math.max(1, VIDEO_MIX_SCENE_ANALYSIS_THUMBNAIL_COUNT - 1),
    );
    slots.set(sampleIndex, [...(slots.get(sampleIndex) ?? []), slot]);
  }
  return slots;
}

/**
 * Samples and scores one source entirely on the device. Callers should run
 * sources serially: this function keeps only the preceding and current 160px
 * ImageData frames alive, then releases its video and canvases in `finally`.
 */
export async function analyzeClientVideoMixSourceScenes(
  sourceUrl: string,
  sourceDuration: number,
  signal: AbortSignal,
): Promise<ClientVideoMixSceneAnalysis> {
  if (!sourceUrl || !Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new TypeError("A source URL and positive video duration are required.");
  }
  throwIfAborted(signal);

  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const analysisCanvas = document.createElement("canvas");
  const thumbnailCanvas = document.createElement("canvas");

  try {
    await waitForVideoMetadata(video, sourceUrl, signal);
    throwIfAborted(signal);
    const duration = Math.min(sourceDuration, video.duration);
    const analysisScale = Math.min(
      1,
      ANALYSIS_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight),
    );
    analysisCanvas.width = Math.max(1, Math.round(video.videoWidth * analysisScale));
    analysisCanvas.height = Math.max(1, Math.round(video.videoHeight * analysisScale));
    const analysisContext = analysisCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!analysisContext) {
      throw new Error("動画の場面を端末内で解析できませんでした。");
    }
    thumbnailCanvas.width = THUMBNAIL_WIDTH;
    thumbnailCanvas.height = THUMBNAIL_HEIGHT;
    const thumbnailContext = thumbnailCanvas.getContext("2d");
    if (!thumbnailContext) {
      throw new Error("動画の場面一覧を作成できませんでした。");
    }

    const sampleTimes = limitSampleTimes(
      createRepresentativeFrameSampleTimes(duration),
    );
    if (sampleTimes.length === 0) {
      throw new Error("動画の場面を読み取れませんでした。");
    }
    const thumbnailSlots = thumbnailSlotsBySample(sampleTimes.length);
    const thumbnails = new Array<string>(
      VIDEO_MIX_SCENE_ANALYSIS_THUMBNAIL_COUNT,
    ).fill("");
    const samples: VideoMixSceneSample[] = [];
    let previousImage: ImageDataLike | null = null;

    for (let index = 0; index < sampleTimes.length; index += 1) {
      throwIfAborted(signal);
      const time = sampleTimes[index];
      await seekVideoFrame(video, time, duration, signal);
      analysisContext.drawImage(
        video,
        0,
        0,
        analysisCanvas.width,
        analysisCanvas.height,
      );
      const image = analysisContext.getImageData(
        0,
        0,
        analysisCanvas.width,
        analysisCanvas.height,
      );
      const frame = analyzeVideoFrame(image);
      samples.push({
        time,
        qualityScore: frame.qualityScore,
        sceneChangeScore: previousImage
          ? calculateSceneDifference(previousImage, image)
          : 0,
      });
      previousImage = image;

      const slots = thumbnailSlots.get(index);
      if (slots) {
        thumbnailContext.drawImage(
          video,
          0,
          0,
          thumbnailCanvas.width,
          thumbnailCanvas.height,
        );
        const dataUrl = thumbnailCanvas.toDataURL("image/jpeg", 0.64);
        for (const slot of slots) thumbnails[slot] = dataUrl;
      }
      throwIfAborted(signal);
    }

    if (thumbnails.some((thumbnail) => !thumbnail)) {
      throw new Error("動画の場面一覧を作成できませんでした。");
    }
    return {
      recommendation: selectRecommendedVideoMixClips(duration, samples),
      thumbnails,
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    analysisCanvas.width = 0;
    analysisCanvas.height = 0;
    thumbnailCanvas.width = 0;
    thumbnailCanvas.height = 0;
  }
}
