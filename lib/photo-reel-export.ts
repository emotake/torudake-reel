import {
  AUDIBLE_AUDIO_PEAK_THRESHOLD,
  AUDIBLE_AUDIO_RMS_THRESHOLD,
  measureAudioSignal,
} from "./audio";
import {
  HIGH_QUALITY_VIDEO_BITRATE,
  createPortableVideoEncodingSettings,
} from "./portable-video-export";
import {
  PHOTO_REEL_FRAME_RATE,
  PHOTO_REEL_OUTPUT_HEIGHT,
  PHOTO_REEL_OUTPUT_WIDTH,
  buildPhotoReelFrameSchedule,
  createPhotoReelPlan,
  drawPhotoReelPlanFrame,
  type PhotoReelAudioFit,
  type PhotoReelFrameState,
  type PhotoReelPlan,
  type PhotoReelSettings,
  type PreparedPhotoAsset,
} from "./photo-reel";

import type { InputAudioTrack } from "mediabunny";
import {
  detectPhotoReelBeatCandidates,
  snapPhotoReelPlanToBeats,
} from "./photo-reel-beats";

const PHOTO_REEL_AUDIO_BITRATE = 192_000;
const PHOTO_REEL_AUDIO_SAMPLE_RATE = 48_000;
const PHOTO_REEL_AUDIO_CHANNELS = 2;
const PHOTO_REEL_OUTPUT_DURATION_TOLERANCE_SECONDS = 0.6;
const PHOTO_REEL_MINIMUM_PACKET_RATE = 10;
const PHOTO_REEL_MINIMUM_VIDEO_BITRATE = 1_500_000;
const PHOTO_REEL_MINIMUM_AUDIBLE_SAMPLE_RATIO = 0.002;

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
  /** Reports local BGM analysis without exposing audio or using an API. */
  onBeatSync?: (result: Readonly<{
    detectedBeatCount: number;
    transitionTimes: readonly number[];
  }>) => void;
  /** Optional convenience override for editors that keep audio outside settings. */
  audioFile?: File | null;
  audioFit?: PhotoReelAudioFit;
  audioGain?: number;
  /**
   * A context opened synchronously from the export button's user gesture.
   * Safari may otherwise block the MediaRecorder fallback after async setup.
   */
  preparedAudioContext?: AudioContext | null;
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

function getRealtimeAudioContextConstructor() {
  if (typeof AudioContext !== "undefined") return AudioContext;
  if (typeof window === "undefined") return null;
  return (
    window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }
  ).webkitAudioContext ?? null;
}

/**
 * Opens the realtime audio context while the export click is still a trusted
 * user gesture. The caller owns the returned context and must close it.
 */
export function preparePhotoReelAudioContext() {
  const AudioContextConstructor = getRealtimeAudioContextConstructor();
  if (!AudioContextConstructor) return null;
  try {
    const context = new AudioContextConstructor();
    if (context.state !== "running") {
      void context.resume().catch(() => undefined);
    }
    return context;
  } catch {
    return null;
  }
}

function getMp4RecorderMimeType() {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return null;
  }
  return (
    [
      "video/mp4;codecs=avc1.640028,mp4a.40.2",
      "video/mp4;codecs=avc1.4D4028,mp4a.40.2",
      "video/mp4;codecs=avc1.42E028,mp4a.40.2",
      "video/mp4",
    ].find((type) => MediaRecorder.isTypeSupported(type)) ?? null
  );
}

let packagedAacEncoderRegistration: Promise<void> | null = null;

async function registerPackagedAacEncoder() {
  // The extension contains a Node worker_threads fallback. Excluding it from
  // the SSR graph keeps that fallback out of the Cloudflare Pages worker while
  // still bundling it into the browser build where Web Workers are available.
  if ((import.meta as ImportMeta & { env: { SSR: boolean } }).env.SSR) {
    throw new Error("The packaged AAC encoder is browser-only.");
  }
  packagedAacEncoderRegistration ??= import("@mediabunny/aac-encoder").then(
    ({ registerAacEncoder }) => registerAacEncoder(),
  );
  return packagedAacEncoderRegistration;
}

async function resolvePhotoReelExportCapability(
  media: typeof import("mediabunny"),
  hasAudio: boolean,
) {
  const encodingSettings = createPortableVideoEncodingSettings(
    PHOTO_REEL_OUTPUT_WIDTH,
    PHOTO_REEL_OUTPUT_HEIGHT,
    HIGH_QUALITY_VIDEO_BITRATE,
    PHOTO_REEL_FRAME_RATE,
  );
  const canEncodeWithWebCodecs = await media.canEncodeVideo(
    "avc",
    encodingSettings,
  );
  const audioEncodingOptions = {
    numberOfChannels: PHOTO_REEL_AUDIO_CHANNELS,
    sampleRate: PHOTO_REEL_AUDIO_SAMPLE_RATE,
    bitrate: PHOTO_REEL_AUDIO_BITRATE,
  };
  let canEncodeAudio = hasAudio
    ? await media.canEncodeAudio("aac", audioEncodingOptions)
    : true;
  if (hasAudio && !canEncodeAudio) {
    try {
      await registerPackagedAacEncoder();
      canEncodeAudio = await media.canEncodeAudio("aac", audioEncodingOptions);
    } catch (error) {
      console.warn("The packaged AAC encoder could not be loaded.", error);
    }
  }
  const needsRecorderFallback =
    !canEncodeWithWebCodecs || !canEncodeAudio;
  const canUseRecorderFallback = Boolean(
    getMp4RecorderMimeType() &&
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function" &&
      (!hasAudio || getRealtimeAudioContextConstructor()),
  );
  if (needsRecorderFallback && !canUseRecorderFallback) {
    throw new PhotoReelExportUnsupportedError(
      canEncodeWithWebCodecs ? "audio-encode" : "video-encode",
      canEncodeWithWebCodecs
        ? "このブラウザでは音楽付きMP4を書き出せません。最新版のSafariまたはChromeでお試しください。"
        : "このブラウザでは高画質MP4を書き出せません。最新版のSafariまたはChromeでお試しください。",
    );
  }
  return { encodingSettings, needsRecorderFallback };
}

export async function assertPhotoReelExportSupported(hasAudio: boolean) {
  if (typeof document === "undefined") {
    throw new PhotoReelExportUnsupportedError(
      "browser",
      "写真リールの書き出しはブラウザ上でのみ利用できます。",
    );
  }
  if (hasAudio && !getOfflineAudioContextConstructor()) {
    throw new PhotoReelExportUnsupportedError(
      "audio-decode",
      "このブラウザでは選択した音楽を動画へ入れられません。最新版のSafariまたはChromeでお試しください。",
    );
  }
  const media = await import("mediabunny");
  await resolvePhotoReelExportCapability(media, hasAudio);
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

class PhotoReelOutputValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PhotoReelOutputValidationError";
  }
}

function isAvcCodec(codec: string | null, parameter: string | null) {
  const description = `${codec ?? ""} ${parameter ?? ""}`.toLowerCase();
  return /(?:^|\s)(?:avc|h264)(?:\s|$)|avc[13]/.test(description);
}

function isAacCodec(codec: string | null, parameter: string | null) {
  const description = `${codec ?? ""} ${parameter ?? ""}`.toLowerCase();
  return /(?:^|\s)aac(?:\s|$)|mp4a[.]40/.test(description);
}

async function measureDecodedAudioTrack(
  media: typeof import("mediabunny"),
  audioTrack: InputAudioTrack,
) {
  if (!(await audioTrack.canDecode())) {
    throw new PhotoReelOutputValidationError(
      "完成動画のBGM音量を確認できませんでした。最新版のSafariまたはChromeで、もう一度お試しください。",
    );
  }

  const sink = new media.AudioSampleSink(audioTrack);
  let squaredTotal = 0;
  let peak = 0;
  let audibleSamples = 0;
  let sampleCount = 0;
  for await (const sample of sink.samples()) {
    try {
      // Measuring at up to 12 kHz is sufficient to detect an accidentally
      // silent AAC track without adding noticeable export verification time.
      const stride = Math.max(1, Math.floor(sample.sampleRate / 12_000));
      const channels = Array.from(
        { length: sample.numberOfChannels },
        (_, channel) => {
          const plane = new Float32Array(sample.numberOfFrames);
          sample.copyTo(plane, {
            planeIndex: channel,
            format: "f32-planar",
          });
          return plane;
        },
      );
      const mono = new Float32Array(Math.ceil(sample.numberOfFrames / stride));
      for (
        let frame = 0, outputIndex = 0;
        frame < sample.numberOfFrames;
        frame += stride, outputIndex += 1
      ) {
        let value = 0;
        for (const channel of channels) value += channel[frame] ?? 0;
        mono[outputIndex] = value / channels.length;
      }
      const metrics = measureAudioSignal(mono);
      squaredTotal += metrics.rms * metrics.rms * metrics.sampleCount;
      peak = Math.max(peak, metrics.peak);
      audibleSamples += metrics.audibleSampleRatio * metrics.sampleCount;
      sampleCount += metrics.sampleCount;
    } finally {
      sample.close();
    }
  }

  return {
    rms: sampleCount > 0 ? Math.sqrt(squaredTotal / sampleCount) : 0,
    peak,
    audibleSampleRatio: sampleCount > 0 ? audibleSamples / sampleCount : 0,
    sampleCount,
  };
}

async function validatePhotoReelOutput(
  output: Blob,
  plan: PhotoReelPlan,
  expectsAudio: boolean,
) {
  if (output.size < 1_024) {
    throw new PhotoReelOutputValidationError(
      "完成動画のデータが空でした。もう一度書き出してください。",
    );
  }

  const media = await import("mediabunny");
  const input = new media.Input({
    source: new media.BlobSource(output),
    formats: media.ALL_FORMATS,
  });
  try {
    if (!(await input.canRead())) {
      throw new PhotoReelOutputValidationError(
        "完成動画を読み取れませんでした。もう一度書き出してください。",
      );
    }
    const mimeType = await input.getMimeType();
    if (!mimeType.toLowerCase().startsWith("video/mp4")) {
      throw new PhotoReelOutputValidationError(
        "完成動画がMP4形式になりませんでした。最新版のSafariまたはChromeで、もう一度お試しください。",
      );
    }

    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    if (!videoTrack) {
      throw new PhotoReelOutputValidationError(
        "完成動画に映像が入りませんでした。もう一度書き出してください。",
      );
    }

    const [width, height, codec, parameter, videoDuration, videoStats] =
      await Promise.all([
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getCodec(),
        videoTrack.getCodecParameterString(),
        videoTrack.computeDuration(),
        videoTrack.computePacketStats(),
      ]);
    if (Math.round(width) !== plan.width || Math.round(height) !== plan.height) {
      throw new PhotoReelOutputValidationError(
        `完成動画が${plan.width}×${plan.height}になりませんでした。もう一度書き出してください。`,
      );
    }
    if (!isAvcCodec(codec, parameter)) {
      throw new PhotoReelOutputValidationError(
        "完成動画がiPhone向けのH.264形式になりませんでした。最新版のSafariまたはChromeで、もう一度お試しください。",
      );
    }
    if (
      !Number.isFinite(videoDuration) ||
      Math.abs(videoDuration - plan.duration) >
        PHOTO_REEL_OUTPUT_DURATION_TOLERANCE_SECONDS
    ) {
      throw new PhotoReelOutputValidationError(
        "完成動画の長さを正しく確認できませんでした。画面を開いたまま、もう一度書き出してください。",
      );
    }
    if (
      !Number.isFinite(videoStats.averagePacketRate) ||
      videoStats.averagePacketRate < PHOTO_REEL_MINIMUM_PACKET_RATE
    ) {
      throw new PhotoReelOutputValidationError(
        "完成動画の動きが正しく記録されませんでした。画面を開いたまま、もう一度書き出してください。",
      );
    }
    if (
      !Number.isFinite(videoStats.averageBitrate) ||
      videoStats.averageBitrate < PHOTO_REEL_MINIMUM_VIDEO_BITRATE
    ) {
      throw new PhotoReelOutputValidationError(
        "完成動画の画質が1080pの保存基準に届きませんでした。画面を開いたまま、もう一度書き出してください。",
      );
    }

    if (expectsAudio) {
      if (!audioTrack) {
        throw new PhotoReelOutputValidationError(
          "完成動画にBGMが入りませんでした。もう一度書き出してください。",
        );
      }
      const [audioCodec, audioParameter, audioDuration] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getCodecParameterString(),
        audioTrack.computeDuration(),
      ]);
      if (!isAacCodec(audioCodec, audioParameter)) {
        throw new PhotoReelOutputValidationError(
          "完成動画のBGMがiPhone向けの形式になりませんでした。最新版のSafariまたはChromeで、もう一度お試しください。",
        );
      }
      if (
        !Number.isFinite(audioDuration) ||
        Math.abs(audioDuration - plan.duration) >
          PHOTO_REEL_OUTPUT_DURATION_TOLERANCE_SECONDS
      ) {
        throw new PhotoReelOutputValidationError(
          "完成動画のBGMと映像の長さが一致しませんでした。もう一度書き出してください。",
        );
      }
      const signal = await measureDecodedAudioTrack(media, audioTrack);
      if (
        signal.sampleCount === 0 ||
        signal.rms < AUDIBLE_AUDIO_RMS_THRESHOLD ||
        signal.peak < AUDIBLE_AUDIO_PEAK_THRESHOLD ||
        signal.audibleSampleRatio < PHOTO_REEL_MINIMUM_AUDIBLE_SAMPLE_RATIO
      ) {
        throw new PhotoReelOutputValidationError(
          "完成動画のBGMが聞こえる音量で入りませんでした。音量を確認して、もう一度書き出してください。",
        );
      }
    }
  } catch (error) {
    if (error instanceof PhotoReelOutputValidationError) throw error;
    throw new PhotoReelOutputValidationError(
      "完成動画の内容を確認できませんでした。画面を開いたまま、もう一度書き出してください。",
      { cause: error },
    );
  } finally {
    input.dispose();
  }
}

async function exportPhotoReelWithMediaRecorder(
  assets: readonly PreparedPhotoAsset[],
  plan: PhotoReelPlan,
  audio: AudioBuffer | null,
  callbacks: PhotoReelExportCallbacks,
) {
  const mimeType = getMp4RecorderMimeType();
  if (!mimeType || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
    throw new PhotoReelExportUnsupportedError(
      "video-encode",
      "このブラウザでは高画質MP4を書き出せません。最新版のSafariまたはChromeでお試しください。",
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

  const drawFrame = async (time: number, frameIndex: number) => {
    const state = drawPhotoReelPlanFrame(context, assets, plan, time);
    await callbacks.drawOverlay?.({
      canvas,
      context,
      plan,
      state,
      frameIndex,
      time,
      duration: Math.min(1 / PHOTO_REEL_FRAME_RATE, plan.duration - time),
    });
  };
  await drawFrame(0, 0);
  throwIfAborted(callbacks.signal);

  const stream = canvas.captureStream(PHOTO_REEL_FRAME_RATE);
  let audioContext: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  let audioGain: GainNode | null = null;
  if (audio) {
    const AudioContextConstructor = getRealtimeAudioContextConstructor();
    if (!AudioContextConstructor) {
      stream.getTracks().forEach((track) => track.stop());
      throw new PhotoReelExportUnsupportedError(
        "audio-encode",
        "このブラウザでは音楽付きMP4を書き出せません。",
      );
    }
    try {
      audioContext =
        callbacks.preparedAudioContext ?? new AudioContextConstructor();
      if (audioContext.state !== "running") {
        await audioContext.resume().catch(() => undefined);
      }
      if (audioContext.state !== "running") {
        throw new Error("AudioContext did not enter the running state.");
      }
      const destination = audioContext.createMediaStreamDestination();
      audioSource = audioContext.createBufferSource();
      audioSource.buffer = audio;
      audioGain = audioContext.createGain();
      audioGain.gain.value = 1;
      audioSource.connect(audioGain).connect(destination);
      destination.stream
        .getAudioTracks()
        .forEach((track) => stream.addTrack(track));
    } catch (error) {
      audioSource?.disconnect();
      audioGain?.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await audioContext?.close().catch(() => undefined);
      throw new PhotoReelExportUnsupportedError(
        "audio-encode",
        "BGM付き動画の書き出しを開始できませんでした。画面を開いたまま、もう一度お試しください。",
        { cause: error },
      );
    }
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: HIGH_QUALITY_VIDEO_BITRATE,
      ...(audio ? { audioBitsPerSecond: PHOTO_REEL_AUDIO_BITRATE } : {}),
    });
  } catch (error) {
    audioSource?.disconnect();
    audioGain?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => undefined);
    throw new PhotoReelExportUnsupportedError(
      "video-encode",
      "このブラウザでは高画質MP4を書き出せません。最新版のSafariまたはChromeでお試しください。",
      { cause: error },
    );
  }
  const chunks: BlobPart[] = [];
  let recorderError: Error | null = null;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      () => {
        recorderError = new Error("写真リールの書き出しに失敗しました。");
        resolve();
      },
      { once: true },
    );
  });

  let animationFrame = 0;
  let recorderStarted = false;
  let rejectRecording: ((reason: Error) => void) | null = null;
  const pageInterruptedError = new Error(
    "書き出し中に画面が閉じられたため中止しました。画面を開いたまま、もう一度お試しください。利用枠は消費されません。",
  );
  const interruptForPageState = () => {
    rejectRecording?.(pageInterruptedError);
    if (recorderStarted && recorder.state !== "inactive") recorder.stop();
  };
  const interruptWhenHidden = () => {
    if (document.visibilityState === "hidden") interruptForPageState();
  };
  document.addEventListener("visibilitychange", interruptWhenHidden);
  window.addEventListener("pagehide", interruptForPageState);
  try {
    callbacks.onProgress?.(0.08);
    recorder.start(1_000);
    recorderStarted = true;
    audioSource?.start();
    const startedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      rejectRecording = reject;
      let lastFrameIndex = -1;
      const tick = async (now: number) => {
        if (recorderError) {
          reject(recorderError);
          return;
        }
        if (callbacks.signal?.aborted) {
          reject(new PhotoReelExportAbortedError());
          return;
        }
        const time = Math.min(plan.duration, (now - startedAt) / 1_000);
        const frameIndex = Math.min(
          Math.ceil(plan.duration * PHOTO_REEL_FRAME_RATE) - 1,
          Math.floor(time * PHOTO_REEL_FRAME_RATE),
        );
        if (frameIndex !== lastFrameIndex) {
          try {
            await drawFrame(time, frameIndex);
            lastFrameIndex = frameIndex;
          } catch (error) {
            reject(error);
            return;
          }
        }
        callbacks.onProgress?.(0.08 + (time / plan.duration) * 0.87);
        if (time >= plan.duration) {
          resolve();
          return;
        }
        animationFrame = requestAnimationFrame((next) => void tick(next));
      };
      animationFrame = requestAnimationFrame((next) => void tick(next));
    });
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    if (recorderError) throw recorderError;
    throwIfAborted(callbacks.signal);
  } catch (error) {
    if (recorderStarted) {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
    }
    if (!recorderStarted) {
      throw new PhotoReelExportUnsupportedError(
        "video-encode",
        "このブラウザでは高画質MP4の記録を開始できませんでした。最新版のSafariまたはChromeでお試しください。",
        { cause: error },
      );
    }
    throw error;
  } finally {
    rejectRecording = null;
    document.removeEventListener("visibilitychange", interruptWhenHidden);
    window.removeEventListener("pagehide", interruptForPageState);
    cancelAnimationFrame(animationFrame);
    try {
      audioSource?.stop();
    } catch {
      // The audio source normally ends with the fixed reel duration.
    }
    audioSource?.disconnect();
    audioGain?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => undefined);
  }

  const output = new Blob(chunks, { type: recorder.mimeType || mimeType });
  throwIfAborted(callbacks.signal);
  await validatePhotoReelOutput(output, plan, Boolean(audio));
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.(1);
  return output;
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
  const basePlan = createPhotoReelPlan(assets, settings);
  const media = await import("mediabunny");
  const audioFile = callbacks.audioFile ?? settings.audioFile;
  const { encodingSettings, needsRecorderFallback } =
    await resolvePhotoReelExportCapability(media, Boolean(audioFile));
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.(0);

  const audioGain = normalizePhotoReelAudioGain(
    callbacks.audioGain ?? settings.audioGain,
  );
  const audio = audioFile
    ? await renderPhotoReelAudio(
        audioFile,
        basePlan.duration,
        callbacks.audioFit ?? settings.audioFit ?? "loop",
        audioGain,
        callbacks.signal,
      )
    : null;
  const beatCandidatesWereProvided = settings.beatCandidates !== undefined;
  const beatCandidates = beatCandidatesWereProvided
    ? settings.beatCandidates ?? []
    : audio
      ? detectPhotoReelBeatCandidates(
        Array.from(
          { length: audio.numberOfChannels },
          (_, channel) => audio.getChannelData(channel),
        ),
        audio.sampleRate,
        basePlan.duration,
      )
      : [];
  const plan = beatCandidatesWereProvided
    ? basePlan
    : snapPhotoReelPlanToBeats(basePlan, beatCandidates);
  const schedule = buildPhotoReelFrameSchedule(plan);
  callbacks.onBeatSync?.({
    detectedBeatCount: beatCandidates.length,
    transitionTimes: plan.slides.slice(1).map((slide) => slide.start),
  });
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.(audio ? 0.09 : 0.05);

  if (needsRecorderFallback) {
    return exportPhotoReelWithMediaRecorder(assets, plan, audio, callbacks);
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
    format: new media.Mp4OutputFormat({ fastStart: "reserve" }),
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
  output.addVideoTrack(videoSource, {
    frameRate: PHOTO_REEL_FRAME_RATE,
    maximumPacketCount: schedule.length + 2,
  });
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
  if (audioSource) {
    output.addAudioTrack(audioSource, {
      // AAC normally emits far fewer packets; 150/s includes a wide safety margin.
      maximumPacketCount: Math.ceil(plan.duration * 150) + 2,
    });
  }

  let audioWrite: Promise<void> = Promise.resolve();
  let audioWriteError: unknown = null;
  try {
    await output.start();
    audioWrite = audioSource && audio
      ? audioSource
          .add(audio)
          .then(() => audioSource.close())
          .catch((error) => {
            // Attach the handler immediately while video frames are encoded so
            // a fast audio failure never becomes an unhandled rejection.
            audioWriteError = error;
          })
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
    if (audioWriteError) throw audioWriteError;
    throwIfAborted(callbacks.signal);
    callbacks.onProgress?.(0.97);
    await output.finalize();
    throwIfAborted(callbacks.signal);
  } catch (error) {
    await Promise.allSettled([audioWrite]);
    await output.cancel().catch(() => undefined);
    throw error;
  }

  if (!target.buffer || target.buffer.byteLength === 0) {
    throw new Error("書き出した写真リールが空でした。");
  }
  throwIfAborted(callbacks.signal);
  const completedOutput = new Blob([target.buffer], { type: "video/mp4" });
  await validatePhotoReelOutput(completedOutput, plan, Boolean(audio));
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.(1);
  return completedOutput;
}
