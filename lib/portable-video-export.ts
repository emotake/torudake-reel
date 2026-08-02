import type { InputAudioTrack } from "mediabunny";

const DEFAULT_FRAME_RATE = 30;
const MAX_FRAME_RATE = 30;
const DEFAULT_MAX_WIDTH = 1080;
const DEFAULT_MAX_HEIGHT = 1920;
const DEFAULT_VIDEO_BITRATE = 5_000_000;
const DEFAULT_AUDIO_BITRATE = 192_000;
const OUTPUT_SAMPLE_RATE = 48_000;
const OUTPUT_CHANNELS = 2;
const RANGE_EPSILON = 1e-7;

export type PortableVideoRange = Readonly<{
  start: number;
  end: number;
}>;

export type PortableFrameScheduleEntry = Readonly<{
  frameIndex: number;
  editedTime: number;
  sourceTime: number;
  duration: number;
}>;

export type PortableCaptionDrawContext = Readonly<{
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  frameIndex: number;
  sourceTime: number;
  editedTime: number;
  duration: number;
}>;

export type PortableCaptionDrawCallback = (
  frame: PortableCaptionDrawContext,
) => void | Promise<void>;

export type PortableAudioSlicePlacement = Readonly<{
  when: number;
  offset: number;
  duration: number;
}>;

export type PortableVideoExportOptions = Readonly<{
  file: File;
  ranges: readonly PortableVideoRange[];
  drawCaption?: PortableCaptionDrawCallback;
  /**
   * A ready-to-use narration buffer on the edited timeline. It is placed at
   * timestamp zero and is never stretched to fill the video.
   */
  narrationBuffer?: AudioBuffer | null;
  /** Defaults to 1. AI narration callers should keep this at 1. */
  narrationGain?: number;
  /** Gain for the source video's audio, such as 0, 0.08, or 0.12. */
  originalGain?: number;
  frameRate?: number;
  maxWidth?: number;
  maxHeight?: number;
  videoBitrate?: number;
  audioBitrate?: number;
  signal?: AbortSignal;
  /** Receives a monotonically increasing value from 0 through 1. */
  onProgress?: (progress: number) => void;
}>;

export type PortableVideoExportUnsupportedReason =
  | "browser"
  | "input"
  | "video-decode"
  | "video-encode"
  | "audio-decode"
  | "audio-encode";

export class PortableVideoExportUnsupportedError extends Error {
  readonly code = "portable-video-export-unsupported";
  readonly reason: PortableVideoExportUnsupportedReason;

  constructor(
    reason: PortableVideoExportUnsupportedReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PortableVideoExportUnsupportedError";
    this.reason = reason;
  }
}

export class PortableVideoExportAbortedError extends Error {
  readonly code = "portable-video-export-aborted";

  constructor() {
    super("動画の書き出しを中止しました。");
    this.name = "PortableVideoExportAbortedError";
  }
}

export function normalizePortableVideoRanges(
  ranges: readonly PortableVideoRange[],
  sourceDuration: number,
): PortableVideoRange[] {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new RangeError("sourceDuration must be a finite positive number.");
  }

  const normalized = ranges
    .map((range) => {
      if (
        !range ||
        !Number.isFinite(range.start) ||
        !Number.isFinite(range.end)
      ) {
        throw new TypeError("Each video range must have finite start and end values.");
      }

      return {
        start: Math.max(0, Math.min(sourceDuration, range.start)),
        end: Math.max(0, Math.min(sourceDuration, range.end)),
      };
    })
    .filter((range) => range.end - range.start > RANGE_EPSILON)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: PortableVideoRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + RANGE_EPSILON) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      merged.push(range);
    }
  }

  return merged;
}

export function getPortableEditedDuration(
  ranges: readonly PortableVideoRange[],
) {
  return ranges.reduce(
    (total, range) => total + Math.max(0, range.end - range.start),
    0,
  );
}

export function normalizePortableFrameRate(frameRate = DEFAULT_FRAME_RATE) {
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new RangeError("frameRate must be a finite positive number.");
  }
  return Math.min(MAX_FRAME_RATE, frameRate);
}

export function computePortableVideoDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = DEFAULT_MAX_WIDTH,
  maxHeight = DEFAULT_MAX_HEIGHT,
) {
  if (
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0
  ) {
    throw new RangeError("Source dimensions must be finite positive numbers.");
  }
  if (
    !Number.isFinite(maxWidth) ||
    maxWidth < 2 ||
    !Number.isFinite(maxHeight) ||
    maxHeight < 2
  ) {
    throw new RangeError("Maximum dimensions must be at least two pixels.");
  }

  const evenMaximumWidth = Math.max(2, Math.floor(maxWidth / 2) * 2);
  const evenMaximumHeight = Math.max(2, Math.floor(maxHeight / 2) * 2);
  const scale = Math.min(
    1,
    evenMaximumWidth / sourceWidth,
    evenMaximumHeight / sourceHeight,
  );
  const makeEven = (value: number, maximum: number) => {
    const rounded = Math.max(2, Math.min(maximum, Math.round(value)));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  };

  return {
    width: makeEven(sourceWidth * scale, evenMaximumWidth),
    height: makeEven(sourceHeight * scale, evenMaximumHeight),
  };
}

export function mapPortableEditedTimeToSourceTime(
  ranges: readonly PortableVideoRange[],
  editedTime: number,
) {
  if (ranges.length === 0) {
    throw new RangeError("At least one playable range is required.");
  }
  if (!Number.isFinite(editedTime)) {
    throw new TypeError("editedTime must be finite.");
  }

  const totalDuration = getPortableEditedDuration(ranges);
  const clampedTime = Math.max(0, Math.min(totalDuration, editedTime));
  let elapsed = 0;

  for (const [index, range] of ranges.entries()) {
    const rangeDuration = range.end - range.start;
    const isLast = index === ranges.length - 1;
    if (clampedTime < elapsed + rangeDuration || isLast) {
      return Math.min(range.end, range.start + Math.max(0, clampedTime - elapsed));
    }
    elapsed += rangeDuration;
  }

  return ranges.at(-1)!.end;
}

export function buildPortableFrameSchedule(
  ranges: readonly PortableVideoRange[],
  requestedFrameRate = DEFAULT_FRAME_RATE,
): PortableFrameScheduleEntry[] {
  if (ranges.length === 0) {
    throw new RangeError("At least one playable range is required.");
  }
  const frameRate = normalizePortableFrameRate(requestedFrameRate);
  const totalDuration = getPortableEditedDuration(ranges);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new RangeError("The edited duration must be positive.");
  }

  const frameDuration = 1 / frameRate;
  const frameCount = Math.max(
    1,
    Math.ceil(totalDuration * frameRate - RANGE_EPSILON),
  );
  const schedule: PortableFrameScheduleEntry[] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const editedTime = frameIndex * frameDuration;
    const sourceTime = mapPortableEditedTimeToSourceTime(ranges, editedTime);
    schedule.push({
      frameIndex,
      editedTime,
      sourceTime,
      duration: Math.min(frameDuration, totalDuration - editedTime),
    });
  }

  return schedule;
}

export function getPortableAudioSlicePlacement(
  range: PortableVideoRange,
  editedRangeStart: number,
  bufferTimestamp: number,
  bufferDuration: number,
): PortableAudioSlicePlacement | null {
  if (
    !Number.isFinite(editedRangeStart) ||
    !Number.isFinite(bufferTimestamp) ||
    !Number.isFinite(bufferDuration) ||
    bufferDuration < 0
  ) {
    throw new TypeError("Audio placement values must be finite and non-negative.");
  }

  const overlapStart = Math.max(range.start, bufferTimestamp);
  const overlapEnd = Math.min(range.end, bufferTimestamp + bufferDuration);
  if (overlapEnd - overlapStart <= RANGE_EPSILON) return null;

  return {
    when: editedRangeStart + (overlapStart - range.start),
    offset: overlapStart - bufferTimestamp,
    duration: overlapEnd - overlapStart,
  };
}

function normalizeGain(value: number | undefined, fallback: number) {
  const gain = value ?? fallback;
  if (!Number.isFinite(gain) || gain < 0 || gain > 2) {
    throw new RangeError("Audio gains must be between 0 and 2.");
  }
  return gain;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
) {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return normalized;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new PortableVideoExportAbortedError();
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

type ScheduledAudioBuffer = {
  buffer: AudioBuffer;
  placement: PortableAudioSlicePlacement;
};

async function collectDecodedOriginalAudio(
  media: typeof import("mediabunny"),
  audioTrack: InputAudioTrack,
  ranges: readonly PortableVideoRange[],
  signal?: AbortSignal,
) {
  if (!(await audioTrack.canDecode())) {
    throw new Error("The source audio track cannot be decoded with WebCodecs.");
  }

  const sink = new media.AudioBufferSink(audioTrack);
  const decoded: ScheduledAudioBuffer[] = [];
  let editedRangeStart = 0;

  for (const range of ranges) {
    for await (const wrapped of sink.buffers(range.start, range.end)) {
      throwIfAborted(signal);
      const placement = getPortableAudioSlicePlacement(
        range,
        editedRangeStart,
        wrapped.timestamp,
        wrapped.duration,
      );
      if (placement) decoded.push({ buffer: wrapped.buffer, placement });
    }
    editedRangeStart += range.end - range.start;
  }

  return decoded;
}

function buildDecodedFileAudioSchedule(
  decodedAudio: AudioBuffer,
  ranges: readonly PortableVideoRange[],
) {
  const scheduled: ScheduledAudioBuffer[] = [];
  let editedRangeStart = 0;

  for (const range of ranges) {
    const placement = getPortableAudioSlicePlacement(
      range,
      editedRangeStart,
      0,
      decodedAudio.duration,
    );
    if (placement) scheduled.push({ buffer: decodedAudio, placement });
    editedRangeStart += range.end - range.start;
  }

  return scheduled;
}

function scheduleAudioBuffer(
  context: OfflineAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  placement: PortableAudioSlicePlacement,
) {
  const duration = Math.min(
    placement.duration,
    Math.max(0, buffer.duration - placement.offset),
  );
  if (duration <= RANGE_EPSILON) return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(destination);
  source.start(placement.when, placement.offset, duration);
}

async function renderMixedAudio(
  media: typeof import("mediabunny"),
  input: InstanceType<(typeof import("mediabunny"))["Input"]>,
  options: {
    file: File;
    ranges: readonly PortableVideoRange[];
    editedDuration: number;
    narrationBuffer: AudioBuffer | null;
    narrationGain: number;
    originalGain: number;
    signal?: AbortSignal;
  },
): Promise<AudioBuffer | null> {
  const audioTrack =
    options.originalGain > 0 ? await input.getPrimaryAudioTrack() : null;
  if (!audioTrack && !options.narrationBuffer) return null;

  const OfflineAudioContextConstructor = getOfflineAudioContextConstructor();
  if (!OfflineAudioContextConstructor) {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      "このブラウザでは音声付き動画を書き出せません。",
    );
  }

  const context = new OfflineAudioContextConstructor(
    OUTPUT_CHANNELS,
    Math.max(1, Math.ceil(options.editedDuration * OUTPUT_SAMPLE_RATE)),
    OUTPUT_SAMPLE_RATE,
  );
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  limiter.connect(context.destination);

  if (audioTrack && options.originalGain > 0) {
    throwIfAborted(options.signal);
    let originalAudio: ScheduledAudioBuffer[];
    try {
      originalAudio = await collectDecodedOriginalAudio(
        media,
        audioTrack,
        options.ranges,
        options.signal,
      );
      if (originalAudio.length === 0) {
        throw new Error("No source audio samples were decoded.");
      }
    } catch (webCodecsError) {
      try {
        const sourceBytes = await options.file.arrayBuffer();
        throwIfAborted(options.signal);
        const decodedFile = await context.decodeAudioData(sourceBytes);
        originalAudio = buildDecodedFileAudioSchedule(
          decodedFile,
          options.ranges,
        );
      } catch (browserDecodeError) {
        throw new PortableVideoExportUnsupportedError(
          "audio-decode",
          "元動画の音声を読み取れないため、音声付きMP4を書き出せません。",
          { cause: browserDecodeError ?? webCodecsError },
        );
      }
    }

    const originalGainNode = context.createGain();
    originalGainNode.gain.value = options.originalGain;
    originalGainNode.connect(limiter);
    for (const item of originalAudio) {
      scheduleAudioBuffer(
        context,
        originalGainNode,
        item.buffer,
        item.placement,
      );
    }
  }

  if (options.narrationBuffer) {
    const narrationDuration = Math.min(
      options.editedDuration,
      options.narrationBuffer.duration,
    );
    if (narrationDuration > RANGE_EPSILON) {
      const narrationGainNode = context.createGain();
      narrationGainNode.gain.value = options.narrationGain;
      narrationGainNode.connect(limiter);
      scheduleAudioBuffer(
        context,
        narrationGainNode,
        options.narrationBuffer,
        { when: 0, offset: 0, duration: narrationDuration },
      );
    }
  }

  throwIfAborted(options.signal);
  return context.startRendering();
}

/**
 * Renders a cut, captioned H.264/AAC MP4 without MediaRecorder or
 * captureStream. This function is browser-only and intentionally leaves AAC
 * polyfill registration to the caller. When AAC is not available it throws a
 * PortableVideoExportUnsupportedError with reason `audio-encode`.
 */
export async function exportPortableVideoMp4(
  options: PortableVideoExportOptions,
): Promise<Blob> {
  if (!(options.file instanceof File)) {
    throw new TypeError("file must be a File.");
  }
  if (typeof document === "undefined") {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      "動画の書き出しはブラウザ上でのみ利用できます。",
    );
  }

  const frameRate = normalizePortableFrameRate(options.frameRate);
  const videoBitrate = normalizePositiveInteger(
    options.videoBitrate,
    DEFAULT_VIDEO_BITRATE,
    "videoBitrate",
  );
  const audioBitrate = normalizePositiveInteger(
    options.audioBitrate,
    DEFAULT_AUDIO_BITRATE,
    "audioBitrate",
  );
  const originalGain = normalizeGain(options.originalGain, 1);
  const narrationGain = normalizeGain(options.narrationGain, 1);
  const media = await import("mediabunny");
  const input = new media.Input({
    source: new media.BlobSource(options.file),
    formats: media.ALL_FORMATS,
  });

  let output: InstanceType<(typeof import("mediabunny"))["Output"]> | null =
    null;
  try {
    throwIfAborted(options.signal);
    options.onProgress?.(0);
    if (!(await input.canRead())) {
      throw new PortableVideoExportUnsupportedError(
        "input",
        "この動画形式は読み取れません。MP4またはWebMでお試しください。",
      );
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new PortableVideoExportUnsupportedError(
        "input",
        "動画トラックが見つかりません。",
      );
    }
    if (!(await videoTrack.canDecode())) {
      throw new PortableVideoExportUnsupportedError(
        "video-decode",
        "この端末では元動画を読み取れません。Safariを最新版に更新してお試しください。",
      );
    }

    const sourceDuration = await videoTrack.computeDuration();
    const ranges = normalizePortableVideoRanges(
      options.ranges,
      sourceDuration,
    );
    if (ranges.length === 0) {
      throw new RangeError("At least one playable range is required.");
    }
    const schedule = buildPortableFrameSchedule(ranges, frameRate);
    const editedDuration = getPortableEditedDuration(ranges);
    const dimensions = computePortableVideoDimensions(
      await videoTrack.getDisplayWidth(),
      await videoTrack.getDisplayHeight(),
      options.maxWidth,
      options.maxHeight,
    );

    if (
      !(await media.canEncodeVideo("avc", {
        ...dimensions,
        bitrate: videoBitrate,
      }))
    ) {
      throw new PortableVideoExportUnsupportedError(
        "video-encode",
        "この端末ではH.264動画を書き出せません。Safariを最新版に更新してお試しください。",
      );
    }

    options.onProgress?.(0.04);
    const mixedAudio = await renderMixedAudio(media, input, {
      file: options.file,
      ranges,
      editedDuration,
      narrationBuffer: options.narrationBuffer ?? null,
      narrationGain,
      originalGain,
      signal: options.signal,
    });
    throwIfAborted(options.signal);

    if (
      mixedAudio &&
      !(await media.canEncodeAudio("aac", {
        numberOfChannels: OUTPUT_CHANNELS,
        sampleRate: OUTPUT_SAMPLE_RATE,
        bitrate: audioBitrate,
      }))
    ) {
      throw new PortableVideoExportUnsupportedError(
        "audio-encode",
        "この端末では音声付きMP4を書き出せません。iPhoneとSafariを最新版に更新して、もう一度お試しください。",
      );
    }

    options.onProgress?.(0.1);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new PortableVideoExportUnsupportedError(
        "browser",
        "動画フレームを描画できません。",
      );
    }

    const target = new media.BufferTarget();
    output = new media.Output({
      format: new media.Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    const videoSource = new media.CanvasSource(canvas, {
      codec: "avc",
      bitrate: videoBitrate,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource, { frameRate });

    const audioSource = mixedAudio
      ? new media.AudioBufferSource({
          codec: "aac",
          bitrate: audioBitrate,
          transform: {
            numberOfChannels: OUTPUT_CHANNELS,
            sampleRate: OUTPUT_SAMPLE_RATE,
          },
        })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();
    const audioWrite = audioSource && mixedAudio
      ? audioSource.add(mixedAudio).then(() => audioSource.close())
      : Promise.resolve();
    const frameSink = new media.VideoSampleSink(videoTrack);

    try {
      const timestamps = schedule.map((frame) => frame.sourceTime);
      let emittedFrames = 0;
      for await (const sample of frameSink.samplesAtTimestamps(timestamps)) {
        throwIfAborted(options.signal);
        const frame = schedule[emittedFrames];
        if (!frame) break;

        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        try {
          sample?.draw(context, 0, 0, canvas.width, canvas.height);
          await options.drawCaption?.({
            canvas,
            context,
            frameIndex: frame.frameIndex,
            sourceTime: frame.sourceTime,
            editedTime: frame.editedTime,
            duration: frame.duration,
          });
          await videoSource.add(
            frame.editedTime,
            frame.duration,
          );
        } finally {
          sample?.close();
        }

        emittedFrames += 1;
        options.onProgress?.(
          0.1 + (emittedFrames / schedule.length) * 0.85,
        );
      }
      if (emittedFrames !== schedule.length) {
        throw new Error("動画フレームを最後まで読み取れませんでした。");
      }
      videoSource.close();
      await audioWrite;
      throwIfAborted(options.signal);
      options.onProgress?.(0.97);
      await output.finalize();
    } catch (error) {
      await Promise.allSettled([audioWrite]);
      throw error;
    }

    if (!target.buffer || target.buffer.byteLength === 0) {
      throw new Error("書き出した動画が空でした。");
    }
    options.onProgress?.(1);
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (error) {
    await output?.cancel().catch(() => undefined);
    throw error;
  } finally {
    input.dispose();
  }
}
