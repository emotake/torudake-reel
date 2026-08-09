import {
  HIGH_QUALITY_VIDEO_BITRATE,
  createPortableVideoEncodingSettings,
} from "./portable-video-export";
import {
  PHOTO_REEL_FRAME_RATE,
  buildPhotoReelFrameSchedule,
  createPhotoReelPlan,
  drawPhotoReelPlanFrame,
  type PhotoReelAudioFit,
  type PhotoReelFrameState,
  type PhotoReelPlan,
  type PhotoReelSettings,
  type PreparedPhotoAsset,
} from "./photo-reel";

const PHOTO_REEL_AUDIO_BITRATE = 192_000;
const PHOTO_REEL_AUDIO_SAMPLE_RATE = 48_000;
const PHOTO_REEL_AUDIO_CHANNELS = 2;

export type PhotoReelExportFrameContext = Readonly<{
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  plan: PhotoReelPlan;
  state: PhotoReelFrameState;
  frameIndex: number;
  time: number;
  duration: number;
}>;

export type PhotoReelExportCallbacks = Readonly<{
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Optional convenience override for editors that keep audio outside settings. */
  audioFile?: File | null;
  audioFit?: PhotoReelAudioFit;
  audioGain?: number;
  drawOverlay?: (
    frame: PhotoReelExportFrameContext,
  ) => void | Promise<void>;
}>;

export type PhotoReelAudioPlacement = Readonly<{
  playDuration: number;
  loop: boolean;
}>;

export type PhotoReelExportUnsupportedReason =
  | "browser"
  | "video-encode"
  | "audio-decode"
  | "audio-encode";

export class PhotoReelExportUnsupportedError extends Error {
  readonly code = "photo-reel-export-unsupported";
  readonly reason: PhotoReelExportUnsupportedReason;

  constructor(
    reason: PhotoReelExportUnsupportedReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PhotoReelExportUnsupportedError";
    this.reason = reason;
  }
}

export class PhotoReelExportAbortedError extends Error {
  readonly code = "photo-reel-export-aborted";

  constructor() {
    super("写真リールの書き出しを中止しました。");
    this.name = "PhotoReelExportAbortedError";
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new PhotoReelExportAbortedError();
}

export function normalizePhotoReelAudioGain(value = 0.82) {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new RangeError("Photo reel audio gain must be between 0 and 2.");
  }
  return value;
}

export function resolvePhotoReelAudioPlacement(
  sourceDuration: number,
  targetDuration: number,
  fit: PhotoReelAudioFit = "loop",
): PhotoReelAudioPlacement {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new RangeError("Audio duration must be a finite positive number.");
  }
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new RangeError("Photo reel duration must be a finite positive number.");
  }
  if (fit !== "loop" && fit !== "trim") {
    throw new RangeError("Audio fit must be loop or trim.");
  }
  return {
    playDuration: fit === "loop" ? targetDuration : Math.min(sourceDuration, targetDuration),
    loop: fit === "loop" && sourceDuration < targetDuration,
  };
}

function getOfflineAudioContextConstructor() {
  if (typeof OfflineAudioContext !== "undefined") return OfflineAudioContext;
  if (typeof window === "undefined") return null;
  return (
    window as typeof window & {
      webkitOfflineAudioContext?: typeof OfflineAudioContext;
    }
  ).webkitOfflineAudioContext ?? null;
}

async function renderPhotoReelAudio(
  file: File,
  targetDuration: number,
  fit: PhotoReelAudioFit,
  gainValue: number,
  signal?: AbortSignal,
) {
  const OfflineAudioContextConstructor = getOfflineAudioContextConstructor();
  if (!OfflineAudioContextConstructor) {
    throw new PhotoReelExportUnsupportedError(
      "browser",
      "このブラウザでは音楽付きの写真リールを書き出せません。",
    );
  }
  const context = new OfflineAudioContextConstructor(
    PHOTO_REEL_AUDIO_CHANNELS,
    Math.max(1, Math.ceil(targetDuration * PHOTO_REEL_AUDIO_SAMPLE_RATE)),
    PHOTO_REEL_AUDIO_SAMPLE_RATE,
  );
  let decoded: AudioBuffer;
  try {
    const bytes = await file.arrayBuffer();
    throwIfAborted(signal);
    decoded = await context.decodeAudioData(bytes);
  } catch (error) {
    if (error instanceof PhotoReelExportAbortedError) throw error;
    throw new PhotoReelExportUnsupportedError(
      "audio-decode",
      "選択した音楽を読み込めませんでした。MP3・M4A・WAV形式でお試しください。",
      { cause: error },
    );
  }

  const placement = resolvePhotoReelAudioPlacement(
    decoded.duration,
    targetDuration,
    fit,
  );
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.loop = placement.loop;
  const gain = context.createGain();
  const fadeDuration = Math.min(0.28, placement.playDuration / 4);
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(gainValue, fadeDuration);
  gain.gain.setValueAtTime(
    gainValue,
    Math.max(fadeDuration, placement.playDuration - fadeDuration),
  );
  gain.gain.linearRampToValueAtTime(0, placement.playDuration);
  source.connect(gain).connect(context.destination);
  source.start(0, 0, placement.playDuration);
  throwIfAborted(signal);
  const rendered = await context.startRendering();
  throwIfAborted(signal);
  return rendered;
}

/**
 * Creates a deterministic, 1080x1920 H.264/AAC MP4 entirely in the browser.
 * No photo, title, or user-provided audio is uploaded to an API.
 */
export async function exportPhotoReel(
  assets: readonly PreparedPhotoAsset[],
  settings: PhotoReelSettings,
  callbacks: PhotoReelExportCallbacks = {},
): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new PhotoReelExportUnsupportedError(
      "browser",
      "写真リールの書き出しはブラウザ上でのみ利用できます。",
    );
  }
  const plan = createPhotoReelPlan(assets, settings);
  const schedule = buildPhotoReelFrameSchedule(plan);
  const media = await import("mediabunny");
  const encodingSettings = createPortableVideoEncodingSettings(
    plan.width,
    plan.height,
    HIGH_QUALITY_VIDEO_BITRATE,
    PHOTO_REEL_FRAME_RATE,
  );
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.(0);

  if (!(await media.canEncodeVideo("avc", encodingSettings))) {
    throw new PhotoReelExportUnsupportedError(
      "video-encode",
      "このブラウザでは高画質MP4を書き出せません。最新版のSafariまたはChromeでお試しください。",
    );
  }

  const audioFile = callbacks.audioFile ?? settings.audioFile;
  const audioGain = normalizePhotoReelAudioGain(
    callbacks.audioGain ?? settings.audioGain,
  );
  const audio = audioFile
    ? await renderPhotoReelAudio(
        audioFile,
        plan.duration,
        callbacks.audioFit ?? settings.audioFit ?? "loop",
        audioGain,
        callbacks.signal,
      )
    : null;
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.(audio ? 0.09 : 0.05);

  if (
    audio &&
    !(await media.canEncodeAudio("aac", {
      numberOfChannels: PHOTO_REEL_AUDIO_CHANNELS,
      sampleRate: PHOTO_REEL_AUDIO_SAMPLE_RATE,
      bitrate: PHOTO_REEL_AUDIO_BITRATE,
    }))
  ) {
    throw new PhotoReelExportUnsupportedError(
      "audio-encode",
      "このブラウザでは音楽付きMP4を書き出せません。最新版のSafariまたはChromeでお試しください。",
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new PhotoReelExportUnsupportedError(
      "browser",
      "このブラウザでは写真リールの映像を描画できません。",
    );
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const target = new media.BufferTarget();
  const output = new media.Output({
    format: new media.Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const videoSource = new media.CanvasSource(canvas, {
    codec: "avc",
    bitrate: HIGH_QUALITY_VIDEO_BITRATE,
    bitrateMode: encodingSettings.bitrateMode,
    latencyMode: encodingSettings.latencyMode,
    contentHint: encodingSettings.contentHint,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: PHOTO_REEL_FRAME_RATE });
  const audioSource = audio
    ? new media.AudioBufferSource({
        codec: "aac",
        bitrate: PHOTO_REEL_AUDIO_BITRATE,
        transform: {
          numberOfChannels: PHOTO_REEL_AUDIO_CHANNELS,
          sampleRate: PHOTO_REEL_AUDIO_SAMPLE_RATE,
        },
      })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  let audioWrite: Promise<void> = Promise.resolve();
  try {
    await output.start();
    audioWrite = audioSource && audio
      ? audioSource.add(audio).then(() => audioSource.close())
      : Promise.resolve();

    for (const frame of schedule) {
      throwIfAborted(callbacks.signal);
      const state = drawPhotoReelPlanFrame(
        context,
        assets,
        plan,
        frame.time,
      );
      await callbacks.drawOverlay?.({
        canvas,
        context,
        plan,
        state,
        frameIndex: frame.frameIndex,
        time: frame.time,
        duration: frame.duration,
      });
      await videoSource.add(frame.time, frame.duration);
      callbacks.onProgress?.(0.1 + ((frame.frameIndex + 1) / schedule.length) * 0.84);
    }
    videoSource.close();
    await audioWrite;
    throwIfAborted(callbacks.signal);
    callbacks.onProgress?.(0.97);
    await output.finalize();
  } catch (error) {
    await Promise.allSettled([audioWrite]);
    await output.cancel().catch(() => undefined);
    throw error;
  }

  if (!target.buffer || target.buffer.byteLength === 0) {
    throw new Error("書き出した写真リールが空でした。");
  }
  callbacks.onProgress?.(1);
  return new Blob([target.buffer], { type: "video/mp4" });
}
