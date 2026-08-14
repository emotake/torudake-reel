import { getCaptionDisplayRange, type CaptionSegment } from "./captions";
import { buildNarrationTimeline, type NarrationPlan } from "./narration";
import { attachNarrationCaptionDisplayTiming } from "./narration-alignment";
import {
  computePortableOriginalNormalizationGain,
  detectPortableNarrationActivity,
} from "./portable-video-export";
import {
  computeLoudnessNormalizationGain,
  measureAudioLoudness,
} from "./audio-loudness";
import {
  VIDEO_COMPOSITION_MAX_SOURCES,
  type VideoCompositionClip,
} from "./video-composition";
import {
  buildVideoMixSceneNarrationTimeline,
  type VideoMixNarrationScene,
} from "./video-mix-scene-timeline";

const FRAME_LONG_EDGE = 512;
const FRAME_JPEG_QUALITY = 0.66;

export const VIDEO_MIX_CAPTION_STYLE_OPTIONS = [
  {
    id: "panel",
    label: "読みやすい帯",
    note: "半透明の帯で、どんな映像でも読みやすく",
  },
  {
    id: "outline",
    label: "くっきり文字",
    note: "太いふち取りで、映像を広く見せる",
  },
  {
    id: "minimal",
    label: "シンプル",
    note: "細めの白文字で、映像を主役に",
  },
] as const;

export type VideoMixCaptionStyle =
  (typeof VIDEO_MIX_CAPTION_STYLE_OPTIONS)[number]["id"];

/** Retains the original video-mix caption appearance for existing drafts. */
export const DEFAULT_VIDEO_MIX_CAPTION_STYLE: VideoMixCaptionStyle = "panel";

export type VideoMixNarrationFrameSource = Readonly<{
  file: File;
  clips: readonly VideoCompositionClip[];
}>;

export type PreparedVideoMixNarration = Readonly<{
  decodedDuration: number;
  audioDuration: number;
  activity: ReturnType<typeof detectPortableNarrationActivity>;
  normalizationGain: number;
  captions: CaptionSegment[];
}>;

export type VideoMixNarrationFrameRequest = Readonly<{
  sourceIndex: number;
  sourceTime: number;
}>;

export type VideoMixNarrationContactSheetRequest = Readonly<{
  sourceIndex: number;
  frames: readonly VideoMixNarrationFrameRequest[];
}>;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("AIナレーションの作成を中止しました。", "AbortError");
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("AIナレーションの作成を中止しました。", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function computeVideoMixNarrationNormalizationGain(
  channels: readonly Float32Array[],
  sampleRate: number,
  duration: number,
) {
  const endFrame = Math.max(0, Math.ceil(duration * sampleRate));
  const measurement = measureAudioLoudness(channels, sampleRate, {
    startFrame: 0,
    endFrame,
  });
  const measured = measurement.integratedLufs === null
    ? computePortableOriginalNormalizationGain(
        Math.sqrt(Math.max(0, measurement.ungatedMeanSquare)),
        measurement.samplePeak,
      )
    : computeLoudnessNormalizationGain(measurement, {
        targetLufs: -18,
        truePeakLimitDbtp: -2,
        minimumGain: 0.65,
        maximumGain: 1.35,
      });
  return Math.max(0.65, Math.min(1.35, measured));
}

function releaseFrameVideo(video: HTMLVideoElement, url: string) {
  try {
    video.pause();
  } catch {
    // Cleanup must continue even if the media element is already unusable.
  }
  try {
    video.removeAttribute("src");
    video.load();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitForMetadata(video: HTMLVideoElement, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error("動画の場面を読み取れませんでした。")),
      12_000,
    );
    const onAbort = () =>
      finish(new DOMException("AIナレーションの作成を中止しました。", "AbortError"));
    const finish = (error?: Error | DOMException) => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      video.onloadedmetadata = null;
      video.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    video.onloadedmetadata = () => finish();
    video.onerror = () => finish(new Error("動画の場面を読み取れませんでした。"));
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, time: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error("動画の場面の読み取りに時間がかかっています。")),
      8_000,
    );
    const onAbort = () =>
      finish(new DOMException("AIナレーションの作成を中止しました。", "AbortError"));
    const finish = (error?: Error | DOMException) => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      video.onseeked = null;
      video.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    video.onseeked = () => finish();
    video.onerror = () => finish(new Error("動画の場面を読み取れませんでした。"));
    video.currentTime = Math.max(0, time);
  });
}

/**
 * Extracts representative frames from the selected clips in finished-video
 * order. The source videos stay on the device; only the returned JPEGs are
 * later sent to the narration endpoint.
 */
export async function extractVideoMixNarrationFrames(
  sources: readonly VideoMixNarrationFrameSource[],
  count = VIDEO_COMPOSITION_MAX_SOURCES,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  // `count` remains accepted for existing callers. Contact sheets are always
  // bounded by source count so no selected clip can be dropped.
  if (!Number.isFinite(count) || count <= 0) return [];
  if (sources.length > VIDEO_COMPOSITION_MAX_SOURCES) {
    throw new RangeError(`動画は最大${VIDEO_COMPOSITION_MAX_SOURCES}本までです。`);
  }
  const requested = createVideoMixNarrationContactSheetRequests(sources, signal);
  if (requested.length === 0) return [];

  const frames: string[] = [];
  for (const sheet of requested) {
    throwIfAborted(signal);
    const sourceIndex = sheet.sourceIndex;
    const url = URL.createObjectURL(sources[sourceIndex].file);
    let video: HTMLVideoElement | null = null;
    try {
      video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = url;
      await waitForMetadata(video, signal);
      throwIfAborted(signal);
      const canvas = document.createElement("canvas");
      if (sheet.frames.length === 1) {
        const scale = Math.min(
          1,
          FRAME_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight),
        );
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      } else {
        canvas.width = FRAME_LONG_EDGE;
        canvas.height = FRAME_LONG_EDGE;
      }
      const context = canvas.getContext("2d");
      if (!context) throw new Error("動画の場面を読み取れませんでした。");
      for (const [cellIndex, request] of sheet.frames.entries()) {
        throwIfAborted(signal);
        await seekVideo(video, request.sourceTime, signal);
        throwIfAborted(signal);
        const cellWidth = canvas.width / sheet.frames.length;
        const scale = Math.min(
          cellWidth / video.videoWidth,
          canvas.height / video.videoHeight,
        );
        const drawWidth = video.videoWidth * scale;
        const drawHeight = video.videoHeight * scale;
        context.drawImage(
          video,
          cellIndex * cellWidth + (cellWidth - drawWidth) / 2,
          (canvas.height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        throwIfAborted(signal);
      }
      const frame = canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY);
      throwIfAborted(signal);
      frames.push(frame);
    } finally {
      if (video) releaseFrameVideo(video, url);
      else URL.revokeObjectURL(url);
    }
  }
  throwIfAborted(signal);
  return frames;
}

/**
 * One image is sent for each source. When a source contributes two clips, the
 * image is a two-cell contact sheet, so five sources / ten cuts still fit the
 * endpoint's five-image contract without omitting any selected scene.
 */
export function createVideoMixNarrationContactSheetRequests(
  sources: readonly Pick<VideoMixNarrationFrameSource, "clips">[],
  signal?: AbortSignal,
): VideoMixNarrationContactSheetRequest[] {
  throwIfAborted(signal);
  if (sources.length > VIDEO_COMPOSITION_MAX_SOURCES) {
    throw new RangeError(`動画は最大${VIDEO_COMPOSITION_MAX_SOURCES}本までです。`);
  }
  return sources.flatMap((source, sourceIndex) => {
    throwIfAborted(signal);
    const frames = source.clips
      .filter((clip) => clip.end > clip.start)
      .slice(0, 2)
      .map((clip) => ({
        sourceIndex,
        sourceTime: Math.max(
          clip.start,
          Math.min(clip.end - 0.001, clip.start + (clip.end - clip.start) / 2),
        ),
      }));
    return frames.length > 0 ? [{ sourceIndex, frames }] : [];
  });
}

export function createVideoMixNarrationFrameRequests(
  sources: readonly Pick<VideoMixNarrationFrameSource, "clips">[],
  count = 6,
  signal?: AbortSignal,
): VideoMixNarrationFrameRequest[] {
  throwIfAborted(signal);
  if (sources.length > VIDEO_COMPOSITION_MAX_SOURCES) {
    throw new RangeError(`動画は最大${VIDEO_COMPOSITION_MAX_SOURCES}本までです。`);
  }
  let editedCursor = 0;
  const orderedClips = sources.flatMap((source, sourceIndex) => {
    throwIfAborted(signal);
    return source.clips.map((clip) => {
      throwIfAborted(signal);
      const duration = Math.max(0, clip.end - clip.start);
      const item = {
        sourceIndex,
        clip,
        duration,
        editedStart: editedCursor,
        editedEnd: editedCursor + duration,
      };
      editedCursor += duration;
      return item;
    });
  });
  const totalDuration = orderedClips.reduce(
    (sum, item) => sum + item.duration,
    0,
  );
  if (orderedClips.length === 0 || totalDuration <= 0) return [];
  const sourceCount = new Set(orderedClips.map((item) => item.sourceIndex)).size;
  const frameCount = Math.max(
    Math.min(8, sourceCount),
    Math.max(1, Math.min(8, Math.round(count))),
  );
  const atEditedTime = (editedTime: number) => {
    for (const item of orderedClips) {
      if (editedTime <= item.editedEnd || item === orderedClips.at(-1)) {
        return {
          sourceIndex: item.sourceIndex,
          sourceTime: Math.min(
            item.clip.end - 0.001,
            item.clip.start + Math.max(0, editedTime - item.editedStart),
          ),
          editedTime,
        };
      }
    }
    return null;
  };

  // Give every source one frame first so a short clip is never omitted from
  // the generated narration merely because a neighboring clip is longer.
  const selected = sources.flatMap((_, sourceIndex) => {
    throwIfAborted(signal);
    const sourceClips = orderedClips.filter(
      (item) => item.sourceIndex === sourceIndex,
    );
    const sourceDuration = sourceClips.reduce(
      (sum, item) => sum + item.duration,
      0,
    );
    if (sourceDuration <= 0) return [];
    let remaining = sourceDuration / 2;
    for (const item of sourceClips) {
      throwIfAborted(signal);
      if (remaining <= item.duration || item === sourceClips.at(-1)) {
        const editedTime = item.editedStart + Math.min(item.duration, remaining);
        const request = atEditedTime(editedTime);
        return request ? [request] : [];
      }
      remaining -= item.duration;
    }
    return [];
  });

  const extraCount = Math.max(0, frameCount - selected.length);
  const extraCandidateCount = Math.max(32, frameCount * 8);
  const extraCandidates = Array.from(
    { length: extraCandidateCount },
    (_, index) =>
      atEditedTime(((index + 0.5) / extraCandidateCount) * totalDuration),
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  for (let index = 0; index < extraCount; index += 1) {
    throwIfAborted(signal);
    let bestCandidate: (typeof extraCandidates)[number] | null = null;
    let bestDistance = -1;
    for (const candidate of extraCandidates) {
      throwIfAborted(signal);
      const duplicate = selected.some(
        (item) =>
          item.sourceIndex === candidate.sourceIndex &&
          Math.abs(item.sourceTime - candidate.sourceTime) < 0.08,
      );
      if (duplicate) continue;
      const nearestSelectedDistance = Math.min(
        ...selected.map((item) => Math.abs(item.editedTime - candidate.editedTime)),
      );
      if (nearestSelectedDistance > bestDistance) {
        bestCandidate = candidate;
        bestDistance = nearestSelectedDistance;
      }
    }
    if (!bestCandidate) break;
    selected.push(bestCandidate);
  }

  return selected
    .sort((left, right) => left.editedTime - right.editedTime)
    .slice(0, frameCount)
    .map(({ sourceIndex, sourceTime }) => ({ sourceIndex, sourceTime }));
}

export async function prepareVideoMixNarration(
  audio: Blob,
  plan: NarrationPlan,
  compositionDuration: number,
  signal?: AbortSignal,
  sceneTimeline?: readonly VideoMixNarrationScene[],
): Promise<PreparedVideoMixNarration> {
  throwIfAborted(signal);
  const AudioContextConstructor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : typeof window !== "undefined"
        ? (window as typeof window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        : undefined;
  if (!AudioContextConstructor) {
    throw new Error("このブラウザではAI音声を確認できません。");
  }
  const context = new AudioContextConstructor();
  try {
    const audioBytes = await waitWithAbort(audio.arrayBuffer(), signal);
    throwIfAborted(signal);
    const decoded = await waitWithAbort(
      context.decodeAudioData(audioBytes),
      signal,
    );
    throwIfAborted(signal);
    const maximumDuration = Math.max(
      0.1,
      Math.min(decoded.duration, compositionDuration),
    );
    const channels: Float32Array[] = [];
    for (let index = 0; index < decoded.numberOfChannels; index += 1) {
      throwIfAborted(signal);
      channels.push(decoded.getChannelData(index));
    }
    throwIfAborted(signal);
    const activity = detectPortableNarrationActivity(
      channels,
      decoded.sampleRate,
      maximumDuration,
    );
    const normalizationGain = computeVideoMixNarrationNormalizationGain(
      channels,
      decoded.sampleRate,
      maximumDuration,
    );
    throwIfAborted(signal);
    const sceneAlignedTimeline = sceneTimeline?.length
      ? buildVideoMixSceneNarrationTimeline(
          plan.segments,
          sceneTimeline,
          compositionDuration,
          maximumDuration,
        )
      : [];
    const timeline = sceneAlignedTimeline.length > 0
      ? sceneAlignedTimeline
      : buildNarrationTimeline(
          plan.segments,
          compositionDuration,
          compositionDuration,
          maximumDuration,
          { autoCut: false },
        );
    throwIfAborted(signal);
    const captions = attachNarrationCaptionDisplayTiming(timeline, activity, {
      maximumDurationSeconds: maximumDuration,
    });
    throwIfAborted(signal);
    return {
      decodedDuration: decoded.duration,
      audioDuration: maximumDuration,
      activity,
      normalizationGain,
      captions,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function getActiveVideoMixCaption(
  captions: readonly CaptionSegment[],
  editedTime: number,
) {
  return captions.find((caption) => {
    if (caption.removed) return false;
    const range = getCaptionDisplayRange(caption);
    return editedTime >= range.start && editedTime < range.end;
  }) ?? null;
}

function splitCaptionLines(text: string, maximumCharacters = 14) {
  const characters = Array.from(text.replace(/\s+/gu, "").trim());
  if (characters.length <= maximumCharacters) return [characters.join("")];
  const midpoint = Math.ceil(characters.length / 2);
  return [
    characters.slice(0, midpoint).join(""),
    characters.slice(midpoint).join(""),
  ];
}

/** Shared 9:16 Canvas caption renderer for preview and export. */
export function drawVideoMixNarrationCaption(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  editedTime: number,
  captions: readonly CaptionSegment[],
  style: VideoMixCaptionStyle = DEFAULT_VIDEO_MIX_CAPTION_STYLE,
) {
  const caption = getActiveVideoMixCaption(captions, editedTime);
  if (!caption) return false;
  const display = getCaptionDisplayRange(caption);
  const entrance = Math.min(1, Math.max(0, (editedTime - display.start) / 0.18));
  const lines = splitCaptionLines(caption.text);
  const fontSize = Math.round(Math.max(32, Math.min(62, width * 0.052)));
  const lineHeight = Math.round(fontSize * 1.32);
  const paddingX = Math.round(fontSize * 0.72);
  const paddingY = Math.round(fontSize * 0.45);
  context.save();
  const fontWeight = style === "minimal" ? 600 : 700;
  context.font = `${fontWeight} ${fontSize}px "Noto Sans JP", "Hiragino Sans", sans-serif`;
  const boxWidth = Math.min(
    width * 0.86,
    Math.max(...lines.map((line) => context.measureText(line).width)) + paddingX * 2,
  );
  const boxHeight = lines.length * lineHeight + paddingY * 2;
  const x = (width - boxWidth) / 2;
  const baseY = height * 0.8 - boxHeight;
  const y = baseY + (1 - entrance) * fontSize * 0.22;

  context.globalAlpha = 0.35 + entrance * 0.65;
  context.textAlign = "center";
  context.textBaseline = "middle";
  if (style === "panel") {
    const radius = Math.min(28, fontSize * 0.42);
    context.fillStyle = "rgba(8, 14, 24, 0.78)";
    context.beginPath();
    context.roundRect(x, y, boxWidth, boxHeight, radius);
    context.fill();
    context.lineWidth = Math.max(2, width * 0.0025);
    context.strokeStyle = "rgba(255,255,255,0.24)";
    context.stroke();
  }
  context.fillStyle = "#fff";
  context.shadowColor = style === "minimal" ? "rgba(0,0,0,0.82)" : "rgba(0,0,0,0.55)";
  context.shadowBlur = style === "minimal"
    ? Math.max(2, width * 0.004)
    : Math.max(4, width * 0.008);
  context.shadowOffsetY = style === "minimal" ? Math.max(1, width * 0.002) : 0;
  if (style === "outline") {
    context.lineWidth = Math.max(5, fontSize * 0.12);
    context.lineJoin = "round";
    context.strokeStyle = "rgba(8,14,24,0.94)";
  }
  lines.forEach((line, index) => {
    const lineY = y + paddingY + lineHeight * (index + 0.5);
    if (style === "outline") {
      context.strokeText(line, width / 2, lineY, boxWidth - paddingX * 1.4);
    }
    context.fillText(
      line,
      width / 2,
      lineY,
      boxWidth - paddingX * 1.4,
    );
  });
  context.restore();
  return true;
}
