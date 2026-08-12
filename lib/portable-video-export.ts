import type { InputAudioTrack } from "mediabunny";
import { getAudioCodecPriority } from "./transcription-media";
import {
  createPortableVideoColorConversionPlan,
  type PortableVideoColorConversionPlan,
} from "./video-color-space";
import {
  combineAudioLoudnessMeasurements,
  computeLoudnessNormalizationGain,
  measureAudioLoudness,
  type AudioLoudnessMeasurement,
} from "./audio-loudness";

const DEFAULT_FRAME_RATE = 30;
const MAX_FRAME_RATE = 30;
const PORTRAIT_OUTPUT_WIDTH = 1080;
const PORTRAIT_OUTPUT_HEIGHT = 1920;
const LANDSCAPE_OUTPUT_WIDTH = 1920;
const LANDSCAPE_OUTPUT_HEIGHT = 1080;
const SQUARE_OUTPUT_SIZE = 1080;
export const HIGH_QUALITY_VIDEO_BITRATE = 10_000_000;
const DEFAULT_AUDIO_BITRATE = 192_000;
const OUTPUT_SAMPLE_RATE = 48_000;
const OUTPUT_CHANNELS = 2;
const RANGE_EPSILON = 1e-7;
export const PORTABLE_AUDIO_CUT_FADE_SECONDS = 0.02;
export const PORTABLE_VIDEO_CROSSFADE_SECONDS = 0.08;
export const PORTABLE_NARRATION_DUCKING_RATIO = 0.42;
const PORTABLE_DUCK_ATTACK_SECONDS = 0.08;
const PORTABLE_DUCK_RELEASE_SECONDS = 0.18;
const PORTABLE_NARRATION_ACTIVITY_WINDOW_SECONDS = 0.02;
export const MAX_SAFE_WHOLE_FILE_AUDIO_DECODE_BYTES = 96 * 1024 * 1024;
const IOS_SAFE_EDITED_DURATION_SECONDS = 120;
const LOW_MEMORY_SAFE_EDITED_DURATION_SECONDS = 150;

export type PortableExportMemoryPreflight = Readonly<{
  ok: boolean;
  deviceClass: "ios" | "low-memory" | "standard";
  editedDurationSeconds: number;
  estimatedOutputBytes: number;
  estimatedWorkingBytes: number;
  maximumSafeDurationSeconds: number;
  message: string | null;
}>;

export function getPortableExportMemoryPreflight({
  editedDurationSeconds,
  videoBitrate = HIGH_QUALITY_VIDEO_BITRATE,
  audioBitrate = DEFAULT_AUDIO_BITRATE,
  userAgent = "",
  maximumTouchPoints = 0,
  deviceMemoryGb = null,
}: {
  editedDurationSeconds: number;
  videoBitrate?: number;
  audioBitrate?: number;
  userAgent?: string;
  maximumTouchPoints?: number;
  deviceMemoryGb?: number | null;
}): PortableExportMemoryPreflight {
  if (!Number.isFinite(editedDurationSeconds) || editedDurationSeconds <= 0) {
    throw new RangeError("Edited duration must be a finite positive number.");
  }
  const normalizedVideoBitrate = Math.max(1, videoBitrate);
  const normalizedAudioBitrate = Math.max(0, audioBitrate);
  const estimatedOutputBytes = Math.ceil(
    (editedDurationSeconds *
      (normalizedVideoBitrate + normalizedAudioBitrate)) /
      8,
  );
  const renderedAudioBytes = Math.ceil(
    editedDurationSeconds * OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS * 4,
  );
  // Includes the encoded output, offline mixed audio, active decoder frames,
  // canvases and muxing metadata. The estimate is intentionally conservative
  // because iOS may terminate a tab instead of throwing a recoverable error.
  const estimatedWorkingBytes = Math.ceil(
    estimatedOutputBytes * 1.2 + renderedAudioBytes + 64 * 1024 * 1024,
  );
  const normalizedUserAgent = userAgent.toLowerCase();
  const isIos =
    /iphone|ipad|ipod/.test(normalizedUserAgent) ||
    (/macintosh/.test(normalizedUserAgent) && maximumTouchPoints > 1);
  const isLowMemory =
    typeof deviceMemoryGb === "number" &&
    Number.isFinite(deviceMemoryGb) &&
    deviceMemoryGb > 0 &&
    deviceMemoryGb <= 4;
  const deviceClass = isIos
    ? "ios"
    : isLowMemory
      ? "low-memory"
      : "standard";
  const maximumSafeDurationSeconds = isIos
    ? IOS_SAFE_EDITED_DURATION_SECONDS
    : isLowMemory
      ? LOW_MEMORY_SAFE_EDITED_DURATION_SECONDS
      : 300;
  const ok = editedDurationSeconds <= maximumSafeDurationSeconds + 0.01;
  const deviceLabel = isIos ? "このiPhone／iPad" : "この端末";
  return {
    ok,
    deviceClass,
    editedDurationSeconds,
    estimatedOutputBytes,
    estimatedWorkingBytes,
    maximumSafeDurationSeconds,
    message: ok
      ? null
      : `${deviceLabel}では、${maximumSafeDurationSeconds}秒を超える1080p動画を安全に書き出せません。編集する長さを${maximumSafeDurationSeconds}秒以内にするか、PC版Chromeで書き出してください。`,
  };
}

let portableAacEncoderRegistration: Promise<void> | null = null;

export type PortableAudioActivityRange = Readonly<{
  start: number;
  end: number;
}>;

export type PortableAudioEnvelopePoint = Readonly<{
  time: number;
  gain: number;
}>;

export function getPortableEqualPowerFadeGain(
  progress: number,
  direction: "in" | "out",
) {
  const safeProgress = Math.max(0, Math.min(1, progress));
  return direction === "in"
    ? Math.sin((Math.PI / 2) * safeProgress)
    : Math.cos((Math.PI / 2) * safeProgress);
}

export function computePortableOriginalNormalizationGain(
  rms: number,
  peak: number,
) {
  if (
    !Number.isFinite(rms) ||
    !Number.isFinite(peak) ||
    rms < 0 ||
    peak < 0
  ) {
    throw new RangeError("Audio level values must be finite and non-negative.");
  }
  if (rms < 0.0001 || peak < 0.0001) return 1;

  const targetRms = 10 ** (-18 / 20);
  const rmsGain = targetRms / rms;
  const peakSafeGain = 0.9 / peak;
  const loudnessGain = Math.max(0.4, Math.min(1.8, rmsGain));
  return Math.max(0, Math.min(loudnessGain, peakSafeGain));
}

export function detectPortableNarrationActivity(
  channels: readonly Float32Array[],
  sampleRate: number,
  maximumDuration = Number.POSITIVE_INFINITY,
): PortableAudioActivityRange[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a finite positive number.");
  }
  const availableFrames = channels.reduce(
    (maximum, channel) => Math.max(maximum, channel.length),
    0,
  );
  const maximumFrames = Number.isFinite(maximumDuration)
    ? Math.max(0, Math.floor(maximumDuration * sampleRate))
    : availableFrames;
  const frameCount = Math.min(availableFrames, maximumFrames);
  if (frameCount <= 0 || channels.length === 0) return [];

  const windowFrames = Math.max(
    1,
    Math.round(PORTABLE_NARRATION_ACTIVITY_WINDOW_SECONDS * sampleRate),
  );
  const windowLevels: number[] = [];
  let maximumWindowRms = 0;
  for (let offset = 0; offset < frameCount; offset += windowFrames) {
    const end = Math.min(frameCount, offset + windowFrames);
    let sumSquares = 0;
    let sampleCount = 0;
    for (const channel of channels) {
      const channelEnd = Math.min(end, channel.length);
      for (let frame = offset; frame < channelEnd; frame += 1) {
        const sample = channel[frame];
        if (!Number.isFinite(sample)) continue;
        sumSquares += sample * sample;
        sampleCount += 1;
      }
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    windowLevels.push(rms);
    maximumWindowRms = Math.max(maximumWindowRms, rms);
  }
  if (maximumWindowRms < 0.004) return [];

  const activityThreshold = Math.max(0.008, maximumWindowRms * 0.07);
  const rawRanges: PortableAudioActivityRange[] = [];
  let activeStartWindow = -1;
  windowLevels.forEach((level, index) => {
    if (level >= activityThreshold && activeStartWindow < 0) {
      activeStartWindow = index;
    }
    const isLastWindow = index === windowLevels.length - 1;
    if (activeStartWindow >= 0 && (level < activityThreshold || isLastWindow)) {
      const endWindow = level < activityThreshold ? index : index + 1;
      rawRanges.push({
        start: (activeStartWindow * windowFrames) / sampleRate,
        end: Math.min(frameCount / sampleRate, (endWindow * windowFrames) / sampleRate),
      });
      activeStartWindow = -1;
    }
  });

  const padded = rawRanges.map((range) => ({
    start: Math.max(0, range.start - 0.04),
    end: Math.min(frameCount / sampleRate, range.end + 0.06),
  }));
  const merged: PortableAudioActivityRange[] = [];
  for (const range of padded) {
    const previous = merged.at(-1);
    if (
      previous &&
      range.start <=
        previous.end + PORTABLE_DUCK_ATTACK_SECONDS + PORTABLE_DUCK_RELEASE_SECONDS
    ) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else if (range.end - range.start >= 0.04) {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * Clips activity measured on the narration buffer to the portion currently
 * being played, then maps buffer time onto playback time. For example, at 2x
 * playback an activity interval lasting 0.4 seconds in the buffer lasts 0.2
 * seconds in the preview/export segment.
 */
export function remapPortableNarrationActivity(
  activityRanges: readonly PortableAudioActivityRange[],
  sourceOffset: number,
  playbackRate: number,
  duration: number,
): PortableAudioActivityRange[] {
  if (
    !Number.isFinite(sourceOffset) ||
    sourceOffset < 0 ||
    !Number.isFinite(playbackRate) ||
    playbackRate <= 0 ||
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    throw new RangeError(
      "Narration activity mapping values must be finite and non-negative, with a positive playbackRate.",
    );
  }
  if (duration === 0) return [];

  const sourceEnd = sourceOffset + duration * playbackRate;
  const mapped = activityRanges
    .map((range) => {
      if (
        !Number.isFinite(range.start) ||
        !Number.isFinite(range.end)
      ) {
        return null;
      }
      const clippedStart = Math.max(sourceOffset, range.start);
      const clippedEnd = Math.min(sourceEnd, range.end);
      if (clippedEnd - clippedStart <= RANGE_EPSILON) return null;
      return {
        start: Math.max(0, (clippedStart - sourceOffset) / playbackRate),
        end: Math.min(duration, (clippedEnd - sourceOffset) / playbackRate),
      };
    })
    .filter((range): range is PortableAudioActivityRange => Boolean(range))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: PortableAudioActivityRange[] = [];
  for (const range of mapped) {
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

export function buildPortableDuckingEnvelope(
  activityRanges: readonly PortableAudioActivityRange[],
  baseGain: number,
  duration: number,
): PortableAudioEnvelopePoint[] {
  if (
    !Number.isFinite(baseGain) ||
    baseGain < 0 ||
    !Number.isFinite(duration) ||
    duration < 0
  ) {
    throw new RangeError("Ducking values must be finite and non-negative.");
  }
  if (duration === 0) return [{ time: 0, gain: baseGain }];

  const duckedGain = baseGain * PORTABLE_NARRATION_DUCKING_RATIO;
  const normalized = activityRanges
    .map((range) => ({
      start: Math.max(0, Math.min(duration, range.start)),
      end: Math.max(0, Math.min(duration, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const merged: PortableAudioActivityRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (
      previous &&
      range.start <=
        previous.end + PORTABLE_DUCK_ATTACK_SECONDS + PORTABLE_DUCK_RELEASE_SECONDS
    ) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
    } else {
      merged.push(range);
    }
  }
  if (merged.length === 0 || baseGain === 0) {
    return [
      { time: 0, gain: baseGain },
      { time: duration, gain: baseGain },
    ];
  }

  const points: PortableAudioEnvelopePoint[] = [{ time: 0, gain: baseGain }];
  for (const range of merged) {
    const attackStart = Math.max(0, range.start - PORTABLE_DUCK_ATTACK_SECONDS);
    const releaseEnd = Math.min(
      duration,
      range.end + PORTABLE_DUCK_RELEASE_SECONDS,
    );
    points.push(
      { time: attackStart, gain: baseGain },
      { time: range.start, gain: duckedGain },
      { time: range.end, gain: duckedGain },
    );
    // When narration remains active through the final sample there is no
    // post-speech region in which to release. Adding a base-gain point at the
    // same timestamp would replace the ducked endpoint and create one long
    // upward ramp underneath the narration.
    if (releaseEnd > range.end + RANGE_EPSILON) {
      points.push({ time: releaseEnd, gain: baseGain });
    }
  }
  if (merged.at(-1)!.end < duration - RANGE_EPSILON) {
    points.push({ time: duration, gain: baseGain });
  }

  const coalesced: PortableAudioEnvelopePoint[] = [];
  for (const point of points.sort((left, right) => left.time - right.time)) {
    const previous = coalesced.at(-1);
    if (previous && Math.abs(previous.time - point.time) <= RANGE_EPSILON) {
      coalesced[coalesced.length - 1] = point;
    } else {
      coalesced.push(point);
    }
  }
  return coalesced;
}

export function canUseWholeFileAudioDecode(fileSize: number) {
  return (
    Number.isFinite(fileSize) &&
    fileSize >= 0 &&
    fileSize <= MAX_SAFE_WHOLE_FILE_AUDIO_DECODE_BYTES
  );
}

export type PortableVideoRange = Readonly<{
  start: number;
  end: number;
}>;

export type PortableFrameScheduleEntry = Readonly<{
  frameIndex: number;
  editedTime: number;
  sourceTime: number;
  duration: number;
  blendFromSourceTime?: number;
  blendProgress?: number;
}>;

export type PortableCaptionDrawContext = Readonly<{
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  frameIndex: number;
  sourceTime: number;
  editedTime: number;
  duration: number;
}>;

export type PortableVideoDrawRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PortableCaptionDrawCallback = (
  frame: PortableCaptionDrawContext,
) => void | Promise<void>;

export type PortableAudioSlicePlacement = Readonly<{
  when: number;
  offset: number;
  duration: number;
}>;

export type PortableAudioCrossfadePlan = Readonly<{
  outgoing: PortableAudioSlicePlacement;
  incoming: PortableAudioSlicePlacement;
  fadeDuration: number;
  overlapStart: number;
  overlapEnd: number;
}>;

/**
 * Extends only the outgoing source tail over the next cut. The incoming slice
 * keeps its original timestamp, so video/audio duration and synchronization do
 * not move. The two real source buffers then overlap under matching
 * equal-power curves instead of meeting at a zero-gain seam.
 */
export function buildPortableAudioCrossfadePlan(
  outgoing: PortableAudioSlicePlacement,
  outgoingBufferDuration: number,
  incoming: PortableAudioSlicePlacement,
  maximumFadeDuration = PORTABLE_AUDIO_CUT_FADE_SECONDS,
): PortableAudioCrossfadePlan | null {
  if (
    !Number.isFinite(outgoingBufferDuration) ||
    outgoingBufferDuration < 0 ||
    !Number.isFinite(maximumFadeDuration) ||
    maximumFadeDuration < 0
  ) {
    throw new RangeError(
      "Crossfade durations must be finite and non-negative.",
    );
  }

  const outgoingEnd = outgoing.when + outgoing.duration;
  if (Math.abs(outgoingEnd - incoming.when) > 0.001) return null;

  const availableOutgoingTail = Math.max(
    0,
    outgoingBufferDuration - outgoing.offset - outgoing.duration,
  );
  const fadeDuration = Math.min(
    maximumFadeDuration,
    availableOutgoingTail,
    outgoing.duration / 2,
    incoming.duration / 2,
  );
  if (fadeDuration <= RANGE_EPSILON) return null;

  return {
    outgoing: {
      ...outgoing,
      duration: outgoing.duration + fadeDuration,
    },
    incoming,
    fadeDuration,
    overlapStart: incoming.when,
    overlapEnd: incoming.when + fadeDuration,
  };
}

export type PortableAudioTrackCandidate<T> = Readonly<{
  track: T;
  codec: string | null;
  decodable: boolean;
  primary: boolean;
}>;

export function selectPreferredPortableAudioTrack<T>(
  candidates: readonly PortableAudioTrackCandidate<T>[],
) {
  const preferredDecodable = candidates
    .filter((candidate) => candidate.decodable)
    .sort(
      (left, right) =>
        getAudioCodecPriority(left.codec) -
        getAudioCodecPriority(right.codec),
    )[0];

  return (
    preferredDecodable?.track ??
    candidates.find((candidate) => candidate.primary)?.track ??
    candidates[0]?.track ??
    null
  );
}

type PortableAudioTrackSource<T> = Readonly<{
  getAudioTracks: () => Promise<T[]>;
  getPrimaryAudioTrack: () => Promise<T | null>;
}>;

/**
 * Uses one compatibility choice for preview loudness measurement and final
 * export. Some iPhone files expose an undecodable spatial-audio track as the
 * primary track while also carrying a compatible secondary AAC track.
 */
export async function getPreferredPortableInputAudioTrack<
  T extends Readonly<{
    getCodec: () => Promise<string | null>;
    canDecode: () => Promise<boolean>;
  }>,
>(input: PortableAudioTrackSource<T>) {
  const [audioTracks, primaryAudioTrack] = await Promise.all([
    input.getAudioTracks(),
    input.getPrimaryAudioTrack(),
  ]);
  const candidates = await Promise.all(
    audioTracks.map(async (track) => ({
      track,
      codec: await track.getCodec().catch(() => null),
      decodable: await track.canDecode().catch(() => false),
      primary: track === primaryAudioTrack,
    })),
  );
  return selectPreferredPortableAudioTrack(candidates);
}

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
  /** Reports whether the browser will color-convert a wide-gamut/HDR source. */
  onColorConversionPlan?: (plan: PortableVideoColorConversionPlan) => void;
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

/**
 * Builds the shared AVC settings used by both capability detection and the
 * actual encoder. Mediabunny 1.51 forwards `framerate` to WebCodecs during
 * canEncodeVideo(), even though that field is not yet exposed by its public
 * TypeScript options. Keeping it here prevents a device from passing a
 * generic AVC check and then failing only after the full render has started.
 */
export function createPortableVideoEncodingSettings(
  width: number,
  height: number,
  bitrate: number,
  frameRate: number,
) {
  return {
    width,
    height,
    bitrate,
    framerate: frameRate,
    bitrateMode: "variable" as const,
    latencyMode: "quality" as const,
    contentHint: "detail",
  };
}

export function computePortableVideoDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth?: number,
  maxHeight?: number,
) {
  if (
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0
  ) {
    throw new RangeError("Source dimensions must be finite positive numbers.");
  }
  const defaultDimensions =
    sourceWidth > sourceHeight
      ? { width: LANDSCAPE_OUTPUT_WIDTH, height: LANDSCAPE_OUTPUT_HEIGHT }
      : sourceHeight > sourceWidth
        ? { width: PORTRAIT_OUTPUT_WIDTH, height: PORTRAIT_OUTPUT_HEIGHT }
        : { width: SQUARE_OUTPUT_SIZE, height: SQUARE_OUTPUT_SIZE };
  const outputWidth = maxWidth ?? defaultDimensions.width;
  const outputHeight = maxHeight ?? defaultDimensions.height;
  if (
    !Number.isFinite(outputWidth) ||
    outputWidth < 2 ||
    !Number.isFinite(outputHeight) ||
    outputHeight < 2
  ) {
    throw new RangeError("Maximum dimensions must be at least two pixels.");
  }

  return {
    width: Math.max(2, Math.floor(outputWidth / 2) * 2),
    height: Math.max(2, Math.floor(outputHeight / 2) * 2),
  };
}

export function computePortableVideoDrawRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
): PortableVideoDrawRect {
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
    throw new RangeError("Video dimensions must be finite positive numbers.");
  }

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
    let elapsed = 0;
    let rangeIndex = 0;
    for (; rangeIndex < ranges.length; rangeIndex += 1) {
      const rangeDuration = ranges[rangeIndex].end - ranges[rangeIndex].start;
      if (
        editedTime < elapsed + rangeDuration - RANGE_EPSILON ||
        rangeIndex === ranges.length - 1
      ) {
        break;
      }
      elapsed += rangeDuration;
    }
    const withinRange = Math.max(0, editedTime - elapsed);
    const previousRange = ranges[rangeIndex - 1];
    const currentRange = ranges[rangeIndex];
    const crossfadeDuration = previousRange && currentRange
      ? Math.min(
          PORTABLE_VIDEO_CROSSFADE_SECONDS,
          previousRange.end - previousRange.start,
          currentRange.end - currentRange.start,
        )
      : 0;
    const isCrossfadeFrame =
      crossfadeDuration > RANGE_EPSILON &&
      withinRange < crossfadeDuration - RANGE_EPSILON;
    const blendProgress = isCrossfadeFrame
      ? Math.min(1, (withinRange + frameDuration) / crossfadeDuration)
      : 1;
    schedule.push({
      frameIndex,
      editedTime,
      sourceTime,
      duration: Math.min(frameDuration, totalDuration - editedTime),
      ...(isCrossfadeFrame && blendProgress < 1 - RANGE_EPSILON
        ? {
            blendFromSourceTime: Math.max(
              previousRange.start,
              previousRange.end - frameDuration / 2,
            ),
            blendProgress,
          }
        : {}),
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

export async function ensurePortableAacEncoding(
  media: typeof import("mediabunny"),
  settings: {
    numberOfChannels: number;
    sampleRate: number;
    bitrate: number;
  },
) {
  if (await media.canEncodeAudio("aac", settings)) return true;
  // This extension is a browser-only WebAssembly fallback. Keeping its
  // dynamic import out of the SSR graph prevents Node's worker_threads shim
  // from being evaluated by the Cloudflare Pages worker at startup.
  if (
    (import.meta as ImportMeta & { env: { SSR: boolean } }).env.SSR
  ) {
    return false;
  }

  try {
    portableAacEncoderRegistration ??= import("@mediabunny/aac-encoder").then(
      ({ registerAacEncoder }) => {
        registerAacEncoder();
      },
    );
    await portableAacEncoderRegistration;
  } catch {
    portableAacEncoderRegistration = null;
    return false;
  }

  return media.canEncodeAudio("aac", settings);
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
  fadeIn: boolean;
  fadeOut: boolean;
  fadeInDuration?: number;
  fadeOutDuration?: number;
};

export function applyPortableAudioCrossfades(
  ranges: ScheduledAudioBuffer[][],
) {
  ranges.forEach((rangeBuffers) => {
    if (rangeBuffers.length === 0) return;
    rangeBuffers[0].fadeIn = true;
    rangeBuffers[rangeBuffers.length - 1].fadeOut = true;
  });

  for (let index = 0; index < ranges.length - 1; index += 1) {
    const outgoing = ranges[index].at(-1);
    const incoming = ranges[index + 1][0];
    if (!outgoing || !incoming) continue;
    const plan = buildPortableAudioCrossfadePlan(
      outgoing.placement,
      outgoing.buffer.duration,
      incoming.placement,
    );
    if (!plan) continue;

    outgoing.placement = plan.outgoing;
    outgoing.fadeOutDuration = plan.fadeDuration;
    incoming.fadeInDuration = plan.fadeDuration;
  }
}

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
  const decodedRanges: ScheduledAudioBuffer[][] = [];
  let editedRangeStart = 0;

  for (const range of ranges) {
    const rangeBuffers: ScheduledAudioBuffer[] = [];
    for await (const wrapped of sink.buffers(range.start, range.end)) {
      throwIfAborted(signal);
      const placement = getPortableAudioSlicePlacement(
        range,
        editedRangeStart,
        wrapped.timestamp,
        wrapped.duration,
      );
      if (placement) {
        rangeBuffers.push({
          buffer: wrapped.buffer,
          placement,
          fadeIn: false,
          fadeOut: false,
        });
      }
    }
    if (rangeBuffers.length > 0) decodedRanges.push(rangeBuffers);
    editedRangeStart += range.end - range.start;
  }

  applyPortableAudioCrossfades(decodedRanges);
  return decodedRanges.flat();
}

function buildDecodedFileAudioSchedule(
  decodedAudio: AudioBuffer,
  ranges: readonly PortableVideoRange[],
) {
  const scheduledRanges: ScheduledAudioBuffer[][] = [];
  let editedRangeStart = 0;

  for (const range of ranges) {
    const placement = getPortableAudioSlicePlacement(
      range,
      editedRangeStart,
      0,
      decodedAudio.duration,
    );
    if (placement) {
      scheduledRanges.push([{
        buffer: decodedAudio,
        placement,
        fadeIn: true,
        fadeOut: true,
      }]);
    }
    editedRangeStart += range.end - range.start;
  }

  applyPortableAudioCrossfades(scheduledRanges);
  return scheduledRanges.flat();
}

function scheduleAudioBuffer(
  context: OfflineAudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  placement: PortableAudioSlicePlacement,
  fades: {
    fadeIn?: boolean;
    fadeOut?: boolean;
    fadeInDuration?: number;
    fadeOutDuration?: number;
  } = {},
) {
  const duration = Math.min(
    placement.duration,
    Math.max(0, buffer.duration - placement.offset),
  );
  if (duration <= RANGE_EPSILON) return;

  const source = context.createBufferSource();
  source.buffer = buffer;
  if (!fades.fadeIn && !fades.fadeOut) {
    source.connect(destination);
    source.start(placement.when, placement.offset, duration);
    return;
  }

  const sliceGain = context.createGain();
  source.connect(sliceGain);
  sliceGain.connect(destination);

  const maximumSingleFadeDuration = duration / (
    fades.fadeIn && fades.fadeOut ? 2 : 1
  );
  const fadeInDuration = Math.min(
    fades.fadeInDuration ?? PORTABLE_AUDIO_CUT_FADE_SECONDS,
    maximumSingleFadeDuration,
  );
  const fadeOutDuration = Math.min(
    fades.fadeOutDuration ?? PORTABLE_AUDIO_CUT_FADE_SECONDS,
    maximumSingleFadeDuration,
  );
  const curveSteps = 32;
  if (fades.fadeIn && fadeInDuration > RANGE_EPSILON) {
    const fadeInCurve = Float32Array.from(
      { length: curveSteps },
      (_, index) =>
        getPortableEqualPowerFadeGain(index / (curveSteps - 1), "in"),
    );
    sliceGain.gain.setValueCurveAtTime(
      fadeInCurve,
      placement.when,
      fadeInDuration,
    );
  } else {
    sliceGain.gain.setValueAtTime(1, placement.when);
  }
  if (fades.fadeOut && fadeOutDuration > RANGE_EPSILON) {
    const fadeOutCurve = Float32Array.from(
      { length: curveSteps },
      (_, index) =>
        getPortableEqualPowerFadeGain(index / (curveSteps - 1), "out"),
    );
    sliceGain.gain.setValueCurveAtTime(
      fadeOutCurve,
      placement.when + duration - fadeOutDuration,
      fadeOutDuration,
    );
  }
  source.start(placement.when, placement.offset, duration);
}

function measureScheduledOriginalAudio(items: ScheduledAudioBuffer[]) {
  const maximumSamples = 120_000;
  const availableSamples = items.reduce(
    (total, item) =>
      total +
      Math.ceil(item.placement.duration * item.buffer.sampleRate) *
        item.buffer.numberOfChannels,
    0,
  );
  const stride = Math.max(1, Math.ceil(availableSamples / maximumSamples));
  let sumSquares = 0;
  let peak = 0;
  let sampleCount = 0;

  for (const item of items) {
    const startFrame = Math.max(
      0,
      Math.floor(item.placement.offset * item.buffer.sampleRate),
    );
    const endFrame = Math.min(
      item.buffer.length,
      Math.ceil(
        (item.placement.offset + item.placement.duration) *
          item.buffer.sampleRate,
      ),
    );
    for (let channel = 0; channel < item.buffer.numberOfChannels; channel += 1) {
      const samples = item.buffer.getChannelData(channel);
      for (let frame = startFrame; frame < endFrame; frame += stride) {
        const sample = samples[frame];
        if (!Number.isFinite(sample)) continue;
        sumSquares += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
        sampleCount += 1;
      }
    }
  }

  const rmsMeasurement = {
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    peak,
  };
  const loudnessMeasurements: AudioLoudnessMeasurement[] = [];
  for (const item of items) {
    const startFrame = Math.max(
      0,
      Math.floor(item.placement.offset * item.buffer.sampleRate),
    );
    const endFrame = Math.min(
      item.buffer.length,
      Math.ceil(
        (item.placement.offset + item.placement.duration) *
          item.buffer.sampleRate,
      ),
    );
    if (endFrame <= startFrame) continue;
    loudnessMeasurements.push(
      measureAudioLoudness(
        Array.from(
          { length: item.buffer.numberOfChannels },
          (_, channel) => item.buffer.getChannelData(channel),
        ),
        item.buffer.sampleRate,
        { startFrame, endFrame },
      ),
    );
  }
  return {
    ...rmsMeasurement,
    loudness: combineAudioLoudnessMeasurements(loudnessMeasurements),
  };
}

/**
 * Pre-computes the same local source-audio normalization used by the final
 * MP4 mixer so preview and fallback paths can share its gain. Unsupported
 * decoders fail open at unity gain; playback must never be blocked merely
 * because a loudness preview could not be measured.
 */
export async function measurePortableOriginalAudioNormalization(
  file: File,
  ranges: readonly PortableVideoRange[],
  signal?: AbortSignal,
) {
  let input: InstanceType<(typeof import("mediabunny"))["Input"]> | null =
    null;
  try {
    throwIfAborted(signal);
    const media = await import("mediabunny");
    input = new media.Input({
      source: new media.BlobSource(file),
      formats: media.ALL_FORMATS,
    });
    if (!(await input.canRead())) return 1;
    const audioTrack = await getPreferredPortableInputAudioTrack(input);
    if (!audioTrack || !(await audioTrack.canDecode())) return 1;
    const sourceDuration = await audioTrack.computeDuration();
    const normalizedRanges = normalizePortableVideoRanges(
      ranges,
      sourceDuration,
    );
    if (normalizedRanges.length === 0) return 1;
    const decoded = await collectDecodedOriginalAudio(
      media,
      audioTrack,
      normalizedRanges,
      signal,
    );
    if (decoded.length === 0) return 1;
    const level = measureScheduledOriginalAudio(decoded);
    return level.loudness.integratedLufs === null
      ? computePortableOriginalNormalizationGain(level.rms, level.peak)
      : computeLoudnessNormalizationGain(level.loudness);
  } catch (error) {
    if (error instanceof PortableVideoExportAbortedError) throw error;
    return 1;
  } finally {
    input?.dispose();
  }
}

function narrationActivityFromBuffer(
  buffer: AudioBuffer,
  maximumDuration: number,
) {
  return detectPortableNarrationActivity(
    Array.from(
      { length: buffer.numberOfChannels },
      (_, channel) => buffer.getChannelData(channel),
    ),
    buffer.sampleRate,
    maximumDuration,
  );
}

function automateOriginalAudioGain(
  gain: AudioParam,
  baseGain: number,
  duration: number,
  narrationActivity: readonly PortableAudioActivityRange[],
) {
  const envelope = buildPortableDuckingEnvelope(
    narrationActivity,
    baseGain,
    duration,
  );
  gain.cancelScheduledValues(0);
  envelope.forEach((point, index) => {
    if (index === 0) gain.setValueAtTime(point.gain, point.time);
    else gain.linearRampToValueAtTime(point.gain, point.time);
  });
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
  let audioTrack: InputAudioTrack | null = null;
  if (options.originalGain > 0) {
    audioTrack = await getPreferredPortableInputAudioTrack(input);
  }
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
  const narrationActivity = options.narrationBuffer
    ? narrationActivityFromBuffer(
        options.narrationBuffer,
        options.editedDuration,
      )
    : [];

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
      if (!canUseWholeFileAudioDecode(options.file.size)) {
        throw new PortableVideoExportUnsupportedError(
          "audio-decode",
          "この端末では大容量動画の元音声を安全に処理できません。動画を100MB以下に圧縮するか、PC版Chromeで書き出してください。",
          { cause: webCodecsError },
        );
      }
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
    const originalLevel = measureScheduledOriginalAudio(originalAudio);
    const normalizationGain =
      originalLevel.loudness.integratedLufs === null
        ? computePortableOriginalNormalizationGain(
            originalLevel.rms,
            originalLevel.peak,
          )
        : computeLoudnessNormalizationGain(originalLevel.loudness);
    // The user's 8% / 12% choice remains the base proportion. Local
    // normalization makes source loudness consistent, and narration activity
    // temporarily ducks that base without changing the selected setting.
    const normalizedOriginalGain = Math.min(
      2,
      options.originalGain * normalizationGain,
    );
    automateOriginalAudioGain(
      originalGainNode.gain,
      normalizedOriginalGain,
      options.editedDuration,
      narrationActivity,
    );
    originalGainNode.connect(limiter);
    for (const item of originalAudio) {
      scheduleAudioBuffer(
        context,
        originalGainNode,
        item.buffer,
        item.placement,
        item,
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
        { fadeIn: true, fadeOut: true },
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
    HIGH_QUALITY_VIDEO_BITRATE,
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
    const memoryPreflight = getPortableExportMemoryPreflight({
      editedDurationSeconds: editedDuration,
      videoBitrate,
      audioBitrate,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      maximumTouchPoints:
        typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
      deviceMemoryGb:
        typeof navigator === "undefined"
          ? null
          : ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
            null),
    });
    if (!memoryPreflight.ok) {
      throw new PortableVideoExportUnsupportedError(
        "browser",
        memoryPreflight.message ??
          "この端末では動画を安全に書き出せません。PC版Chromeでお試しください。",
      );
    }
    const [sourceWidth, sourceHeight, sourceColorSpace, sourceHasHdr] =
      await Promise.all([
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getColorSpace().catch(() => ({})),
        videoTrack.hasHighDynamicRange().catch(() => false),
      ]);
    const colorConversionPlan = createPortableVideoColorConversionPlan({
      colorSpace: sourceColorSpace,
      hasHighDynamicRange: sourceHasHdr,
    });
    options.onColorConversionPlan?.(colorConversionPlan);
    const dimensions = computePortableVideoDimensions(
      sourceWidth,
      sourceHeight,
      options.maxWidth,
      options.maxHeight,
    );
    const drawRect = computePortableVideoDrawRect(
      sourceWidth,
      sourceHeight,
      dimensions.width,
      dimensions.height,
    );
    const videoEncodingSettings = createPortableVideoEncodingSettings(
      dimensions.width,
      dimensions.height,
      videoBitrate,
      frameRate,
    );

    if (
      !(await media.canEncodeVideo("avc", videoEncodingSettings))
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
      !(await ensurePortableAacEncoding(media, {
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
    // A fixed sRGB backing canvas gives Canvas2D/WebCodecs one explicit SDR
    // destination. Wide-gamut and HDR samples are color-managed before the
    // portable H.264 encode instead of inheriting ambiguous source metadata.
    const context = canvas.getContext("2d", {
      alpha: false,
      colorSpace: colorConversionPlan.outputCanvasColorSpace,
    });
    if (!context) {
      throw new PortableVideoExportUnsupportedError(
        "browser",
        "動画フレームを描画できません。",
      );
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    const target = new media.BufferTarget();
    output = new media.Output({
      // Metadata-at-end avoids keeping a second copy of every encoded packet
      // until finalization. The resulting ordinary MP4 remains uploadable to
      // iPhone Photos and social platforms while using substantially less RAM.
      format: new media.Mp4OutputFormat({ fastStart: false }),
      target,
    });
    const videoSource = new media.CanvasSource(canvas, {
      codec: "avc",
      bitrate: videoBitrate,
      bitrateMode: videoEncodingSettings.bitrateMode,
      latencyMode: videoEncodingSettings.latencyMode,
      contentHint: videoEncodingSettings.contentHint,
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
    const crossfadeFrameSink = new media.VideoSampleSink(videoTrack);

    try {
      const timestamps = schedule.map((frame) => frame.sourceTime);
      let emittedFrames = 0;
      for await (const sample of frameSink.samplesAtTimestamps(timestamps)) {
        throwIfAborted(options.signal);
        const frame = schedule[emittedFrames];
        if (!frame) break;

        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        let blendSample: Awaited<ReturnType<typeof crossfadeFrameSink.getSample>> =
          null;
        try {
          if (frame.blendFromSourceTime !== undefined) {
            blendSample = await crossfadeFrameSink.getSample(
              frame.blendFromSourceTime,
            );
          }
          if (blendSample && sample) {
            blendSample.draw(
              context,
              drawRect.x,
              drawRect.y,
              drawRect.width,
              drawRect.height,
            );
            context.save();
            context.globalAlpha = frame.blendProgress ?? 1;
            sample.draw(
              context,
              drawRect.x,
              drawRect.y,
              drawRect.width,
              drawRect.height,
            );
            context.restore();
          } else {
            sample?.draw(
              context,
              drawRect.x,
              drawRect.y,
              drawRect.width,
              drawRect.height,
            );
          }
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
          blendSample?.close();
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
