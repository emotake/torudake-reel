import type { InputAudioTrack } from "mediabunny";
import {
  HIGH_QUALITY_VIDEO_BITRATE,
  PORTABLE_AUDIO_CUT_FADE_SECONDS,
  PortableVideoExportAbortedError,
  PortableVideoExportUnsupportedError,
  buildPortableAudioCrossfadePlan,
  buildPortableDuckingEnvelope,
  computePortableOriginalNormalizationGain,
  computePortableVideoDrawRect,
  createPortableVideoEncodingSettings,
  detectPortableNarrationActivity,
  ensurePortableAacEncoding,
  getPortableAudioSlicePlacement,
  getPortableEqualPowerFadeGain,
  getPortableExportMemoryPreflight,
  getPreferredPortableInputAudioTrack,
  type PortableAudioActivityRange,
  type PortableAudioEnvelopePoint,
  type PortableVideoDrawRect,
} from "./portable-video-export";
import {
  combineAudioLoudnessMeasurements,
  computeLoudnessNormalizationGain,
  measureAudioLoudness,
  type AudioLoudnessMeasurement,
} from "./audio-loudness";
import {
  VIDEO_COMPOSITION_FRAME_RATE,
  VIDEO_COMPOSITION_MAX_SOURCES,
  VIDEO_COMPOSITION_OUTPUT_HEIGHT,
  VIDEO_COMPOSITION_OUTPUT_WIDTH,
  buildVideoCompositionFrameSchedule,
  createVideoCompositionPlan,
  videoCompositionTransitionUsesOverlap,
  type VideoCompositionClip,
  type VideoCompositionFrameScheduleEntry,
  type VideoCompositionPlan,
  type VideoCompositionBoundaryTransitionInput,
  type VideoCompositionTransition,
  type VideoCompositionTransitionType,
} from "./video-composition";
import {
  createPortableVideoColorConversionPlan,
  type PortableVideoColorConversionPlan,
} from "./video-color-space";

const OUTPUT_AUDIO_BITRATE = 192_000;
const OUTPUT_AUDIO_SAMPLE_RATE = 48_000;
const OUTPUT_AUDIO_CHANNELS = 2;
const TIME_EPSILON = 1e-7;
export const VIDEO_MIX_SOURCE_AUDIO_ANALYSIS_MAX_SECONDS = 15;
export const VIDEO_MIX_SOURCE_AUDIO_ANALYSIS_MAX_BUFFERS = 480;

export type VideoMixSourceInput = Readonly<{
  id: string;
  file: File;
  clips: readonly VideoCompositionClip[];
  framing?: VideoMixSourceFraming;
  /** Cached local loudness gain shared with preview for the selected clips. */
  audioNormalizationGain?: number;
}>;

export type VideoMixSourceFramingMode = "blur" | "cover" | "contain";

export type VideoMixSourceFraming = Readonly<{
  mode: VideoMixSourceFramingMode;
  /** Horizontal focal position, normalized from 0 (left) to 1 (right). */
  focusX: number;
  /** Vertical focal position, normalized from 0 (top) to 1 (bottom). */
  focusY: number;
}>;

export type VideoMixFrameLayout = Readonly<{
  framing: VideoMixSourceFraming;
  background:
    | Readonly<{ kind: "solid"; color: "#000" }>
    | Readonly<{
        kind: "blurred-video";
        rect: PortableVideoDrawRect;
        blurPixels: number;
      }>;
  foregroundRect: PortableVideoDrawRect;
}>;

function clampFocus(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0.5;
}

function computeCoverRect(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  focusX: number,
  focusY: number,
): PortableVideoDrawRect {
  const scale = Math.max(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const overflowX = Math.max(0, width - outputWidth);
  const overflowY = Math.max(0, height - outputHeight);
  return {
    x: overflowX > 0 ? -overflowX * focusX : 0,
    y: overflowY > 0 ? -overflowY * focusY : 0,
    width,
    height,
  };
}

/**
 * Renderer-independent framing shared by the HTML preview and Canvas export.
 * Wide footage defaults to a blurred fill, while native portrait footage uses
 * a full-bleed crop. Explicit user choices always win.
 */
export function computeVideoMixFrameLayout(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  framing?: VideoMixSourceFraming,
): VideoMixFrameLayout {
  // Reuse the established validation and contain calculation.
  const containRect = computePortableVideoDrawRect(
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
  );
  const focusX = clampFocus(framing?.focusX);
  const focusY = clampFocus(framing?.focusY);
  const sourceAspect = sourceWidth / sourceHeight;
  const outputAspect = outputWidth / outputHeight;
  const mode =
    framing?.mode ?? (sourceAspect > outputAspect * 1.15 ? "blur" : "cover");
  if (mode !== "blur" && mode !== "cover" && mode !== "contain") {
    throw new RangeError("Unsupported video framing mode.");
  }
  const normalizedFraming = { mode, focusX, focusY } as const;
  const coverRect = computeCoverRect(
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    focusX,
    focusY,
  );
  if (mode === "cover") {
    return {
      framing: normalizedFraming,
      background: { kind: "solid", color: "#000" },
      foregroundRect: coverRect,
    };
  }
  if (mode === "blur") {
    return {
      framing: normalizedFraming,
      background: {
        kind: "blurred-video",
        rect: coverRect,
        blurPixels: Math.max(18, Math.round(Math.max(outputWidth, outputHeight) * 0.024)),
      },
      foregroundRect: containRect,
    };
  }
  return {
    framing: normalizedFraming,
    background: { kind: "solid", color: "#000" },
    foregroundRect: containRect,
  };
}

export type VideoMixOverlayContext = Readonly<{
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  plan: VideoCompositionPlan;
  frame: VideoCompositionFrameScheduleEntry;
  frameIndex: number;
  editedTime: number;
  sourceTime: number;
  sourceId: string;
  sourceIndex: number;
  clipIndex: number;
  duration: number;
}>;

export type VideoMixSourceColorConversion = Readonly<{
  sourceId: string;
  sourceIndex: number;
  plan: PortableVideoColorConversionPlan;
}>;

export type VideoMixSourceAudioMetadata = Readonly<{
  sourceId: string;
  sourceIndex: number;
  /** Whether the selected input file exposes at least one audio track. */
  hasAudioTrack: boolean;
  /**
   * Whether decoded samples from this source were placed on the edited
   * timeline. `null` means decoding was intentionally skipped because the
   * caller requested a silent output with `audioGain: 0`.
   */
  hasSelectedAudioSamples: boolean | null;
  /** Whether this source actually contributed samples to the final mix. */
  contributedToMix: boolean;
}>;

export type VideoMixAudioOutputState =
  | "mixed"
  | "narration-only"
  | "intentionally-muted"
  | "no-source-audio"
  | "source-audio-unavailable-in-selection";

export type VideoMixNarrationDuckingMetadata = Readonly<{
  enabled: boolean;
  duration: number;
  baseGain: number;
  activity: readonly PortableAudioActivityRange[];
  envelope: readonly PortableAudioEnvelopePoint[];
}>;

/** Exact narration ducking recipe shared by preview playback and export. */
export function buildVideoMixNarrationDuckingMetadata(options: Readonly<{
  activity: readonly PortableAudioActivityRange[];
  baseGain: number;
  duration: number;
  enabled?: boolean;
}>): VideoMixNarrationDuckingMetadata {
  const enabled = options.enabled ?? true;
  const activity = enabled ? options.activity : [];
  return {
    enabled,
    duration: options.duration,
    baseGain: options.baseGain,
    activity: [...activity],
    envelope: buildPortableDuckingEnvelope(
      activity,
      options.baseGain,
      options.duration,
    ),
  };
}

/** Linearly samples the WebAudio automation recipe for an HTML preview. */
export function getVideoMixDuckingGainAtTime(
  metadata: VideoMixNarrationDuckingMetadata,
  editedTime: number,
) {
  const points = metadata.envelope;
  if (points.length === 0) return metadata.baseGain;
  const time = Math.max(0, Math.min(metadata.duration, editedTime));
  let previous = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    if (time <= next.time) {
      const span = next.time - previous.time;
      if (span <= TIME_EPSILON) return next.gain;
      const progress = (time - previous.time) / span;
      return previous.gain + (next.gain - previous.gain) * progress;
    }
    previous = next;
  }
  return previous.gain;
}

export type VideoMixTransitionAudioGains = Readonly<{
  boundaryIndex: number;
  outgoing: number;
  incoming: number;
}>;

/** Equal-power source gains for the true-overlap scene change at `editedTime`. */
export function getVideoMixTransitionAudioGains(
  plan: VideoCompositionPlan,
  editedTime: number,
): VideoMixTransitionAudioGains | null {
  const boundary = plan.boundaries.find(
    (candidate) =>
      candidate.transition.duration > TIME_EPSILON &&
      videoCompositionTransitionUsesOverlap(candidate.transition.type) &&
      editedTime >= candidate.editedTime - TIME_EPSILON &&
      editedTime <
        candidate.editedTime + candidate.transition.duration - TIME_EPSILON,
  );
  if (!boundary) return null;
  const progress = Math.max(
    0,
    Math.min(
      1,
      (editedTime - boundary.editedTime) / boundary.transition.duration,
    ),
  );
  return {
    boundaryIndex: boundary.index,
    outgoing: getPortableEqualPowerFadeGain(progress, "out"),
    incoming: getPortableEqualPowerFadeGain(progress, "in"),
  };
}

/**
 * Describes the audio expectation and the audio track actually written to the
 * MP4. Clients should pass `requireAudio` to their post-export quality check
 * instead of deriving the expectation from the encoded Blob.
 */
export type VideoMixAudioExportMetadata = Readonly<{
  sources: readonly VideoMixSourceAudioMetadata[];
  hasSourceAudioTrack: boolean;
  hasSelectedAudioSamples: boolean | null;
  outputHasAudioTrack: boolean;
  /** True when source audio exists and was not explicitly muted. */
  requireAudio: boolean;
  /** Safe value for an optional decoded-audio activity inspection. */
  inspectAudioActivity: boolean;
  narration: Readonly<{
    requested: boolean;
    hasDecodedSamples: boolean;
    hasActivity: boolean;
    contributedToMix: boolean;
    duckedSourceAudio: boolean;
  }>;
  state: VideoMixAudioOutputState;
}>;

export type VideoMixExportOptions = Readonly<{
  sources: readonly VideoMixSourceInput[];
  transition?:
    | VideoCompositionTransitionType
    | Partial<VideoCompositionTransition>;
  /** Overrides in finished-video boundary order; omitted entries inherit `transition`. */
  boundaryTransitions?: readonly VideoCompositionBoundaryTransitionInput[];
  /** Source-audio master gain. Defaults to 1. */
  audioGain?: number;
  /** Optional narration audio, placed at 0s and clipped to the program. */
  narrationAudio?: Blob;
  /** Narration gain after conservative loudness normalization. Defaults to 1. */
  narrationGain?: number;
  /** Cached 0.65–1.35 narration normalization shared with the live preview. */
  narrationNormalizationGain?: number;
  /** Lowers source audio only while narration is active. Defaults to true. */
  duckSourceAudioDuringNarration?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Exposes the exact deterministic plan used by both preview and export. */
  onPlan?: (plan: VideoCompositionPlan) => void;
  onColorConversionPlans?: (
    plans: readonly VideoMixSourceColorConversion[],
  ) => void;
  /**
   * Called once after a successful finalize with the exact audio expectation
   * and output state. The Promise still resolves to the established Blob.
   */
  onAudioMetadata?: (metadata: VideoMixAudioExportMetadata) => void;
  drawOverlay?: (frame: VideoMixOverlayContext) => void | Promise<void>;
}>;

type PreparedVideoMixSource = {
  source: VideoMixSourceInput;
  input: InstanceType<(typeof import("mediabunny"))["Input"]>;
  videoTrack: NonNullable<
    Awaited<
      ReturnType<
        InstanceType<(typeof import("mediabunny"))["Input"]>["getPrimaryVideoTrack"]
      >
    >
  >;
  audioTrack: InputAudioTrack | null;
  duration: number;
  frameLayout: VideoMixFrameLayout;
  colorConversionPlan: PortableVideoColorConversionPlan;
};

type ScheduledMixAudio = {
  buffer: AudioBuffer;
  sourceIndex: number;
  placement: {
    when: number;
    offset: number;
    duration: number;
  };
  fadeIn: boolean;
  fadeOut: boolean;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  /** Timeline-wide equal-power fades used by true-overlap scene changes. */
  overlapFadeIn?: Readonly<{ start: number; end: number }>;
  overlapFadeOut?: Readonly<{ start: number; end: number }>;
};

type RenderedVideoMixAudio = Readonly<{
  buffer: AudioBuffer | null;
  contributingSourceIndexes: ReadonlySet<number> | null;
  narration: Readonly<{
    hasDecodedSamples: boolean;
    hasActivity: boolean;
    contributedToMix: boolean;
    duckedSourceAudio: boolean;
  }>;
}>;

export type VideoMixFrameDecodeBatch = Readonly<{
  sourceIndex: number;
  globalClipIndex: number;
  /** Primary output frames retained for backwards-compatible inspection. */
  frames: readonly VideoCompositionFrameScheduleEntry[];
  /**
   * One monotonic decoder stream per clip, including the advancing outgoing
   * side of any blend transition. This avoids a decoder flush per frame.
   */
  requests: readonly VideoMixFrameDecodeRequest[];
}>;

export type VideoMixFrameDecodeRequest = Readonly<{
  frameIndex: number;
  role: "primary" | "transition-outgoing";
  sourceTime: number;
}>;

const VIDEO_MIX_TRANSITION_CANVAS_BYTES =
  VIDEO_COMPOSITION_OUTPUT_WIDTH * VIDEO_COMPOSITION_OUTPUT_HEIGHT * 4;

function transitionTypeUsesOutgoingFrame(
  type: VideoCompositionTransitionType,
) {
  return (
    type === "crossfade" ||
    type === "wipe-left" ||
    type === "slide-left" ||
    type === "zoom-dissolve"
  );
}

/**
 * Builds at most one monotonic decoder batch per selected clip. The previous
 * implementation called `getSample()` once per output frame, which repeatedly
 * created and flushed a decoder for long-GOP phone videos.
 */
export function buildVideoMixFrameDecodeBatches(
  plan: VideoCompositionPlan,
  schedule: readonly VideoCompositionFrameScheduleEntry[] =
    buildVideoCompositionFrameSchedule(plan),
): VideoMixFrameDecodeBatch[] {
  const framesByClip = new Map<number, VideoCompositionFrameScheduleEntry[]>();
  const requestsByClip = new Map<number, VideoMixFrameDecodeRequest[]>();
  for (const frame of schedule) {
    const frames = framesByClip.get(frame.globalClipIndex) ?? [];
    frames.push(frame);
    framesByClip.set(frame.globalClipIndex, frames);
    const primaryRequests = requestsByClip.get(frame.globalClipIndex) ?? [];
    primaryRequests.push({
      frameIndex: frame.frameIndex,
      role: "primary",
      sourceTime: frame.sourceTime,
    });
    requestsByClip.set(frame.globalClipIndex, primaryRequests);
    if (transitionUsesOutgoingFrame(frame) && frame.transition) {
      const outgoingClipIndex =
        plan.boundaries[frame.transition.boundaryIndex]?.outgoingClipIndex;
      if (outgoingClipIndex === undefined) {
        throw new Error("Unknown outgoing transition clip.");
      }
      const outgoingRequests = requestsByClip.get(outgoingClipIndex) ?? [];
      outgoingRequests.push({
        frameIndex: frame.frameIndex,
        role: "transition-outgoing",
        sourceTime: frame.transition.from.sourceTime,
      });
      requestsByClip.set(outgoingClipIndex, outgoingRequests);
    }
  }

  return plan.clips.flatMap((clip) => {
    const frames = framesByClip.get(clip.globalClipIndex) ?? [];
    const requests = requestsByClip.get(clip.globalClipIndex) ?? [];
    if (requests.length === 0) return [];
    return [{
      sourceIndex: clip.sourceIndex,
      globalClipIndex: clip.globalClipIndex,
      frames,
      requests,
    }];
  });
}

/** Two reusable 1080p canvases cover every outgoing-frame transition. */
export function getVideoMixTransitionCanvasWorkingBytes(
  plan: VideoCompositionPlan,
) {
  return plan.boundaries.some((boundary) =>
    transitionTypeUsesOutgoingFrame(boundary.transition.type),
  )
    ? VIDEO_MIX_TRANSITION_CANVAS_BYTES * 2
    : 0;
}

export type VideoMixExportMemoryPreflight = Readonly<{
  ok: boolean;
  estimatedWorkingBytes: number;
  maximumWorkingBytes: number;
  baseWorkingBytes: number;
  sourcePcmBytes: number;
  narrationPcmBytes: number;
  narrationEncodedCopyBytes: number;
  outputBlobCopyBytes: number;
  decoderSurfaceBytes: number;
  transitionCanvasBytes: number;
  message: string | null;
}>;

const VIDEO_MIX_CONSERVATIVE_SOURCE_AUDIO_CHANNELS = 6;
const VIDEO_MIX_CONSERVATIVE_DECODER_WIDTH = 3840;
const VIDEO_MIX_CONSERVATIVE_DECODER_HEIGHT = 2160;

/**
 * Estimates the peak allocations that coexist during a multi-video export.
 * The portable baseline already includes the rendered output PCM and one
 * encoded output buffer. This adds decoded source/narration PCM, the temporary
 * narration ArrayBuffer, a Blob/File output copy, decoder surfaces, and the
 * reusable transition canvases that can be live at the same time.
 */
export function getVideoMixExportMemoryPreflight(options: Readonly<{
  plan: VideoCompositionPlan;
  includeSourceAudio: boolean;
  narrationAudioBytes?: number;
  userAgent?: string;
  maximumTouchPoints?: number;
  deviceMemoryGb?: number | null;
}>): VideoMixExportMemoryPreflight {
  const narrationAudioBytes = options.narrationAudioBytes ?? 0;
  if (!Number.isFinite(narrationAudioBytes) || narrationAudioBytes < 0) {
    throw new RangeError("narrationAudioBytes must be finite and non-negative.");
  }
  const memory = getPortableExportMemoryPreflight({
    editedDurationSeconds: options.plan.duration,
    videoBitrate: HIGH_QUALITY_VIDEO_BITRATE,
    audioBitrate: OUTPUT_AUDIO_BITRATE,
    userAgent: options.userAgent,
    maximumTouchPoints: options.maximumTouchPoints,
    deviceMemoryGb: options.deviceMemoryGb,
  });
  const selectedClipSeconds = options.plan.clips.reduce(
    (total, clip) => total + clip.duration,
    0,
  );
  const sourcePcmBytes = options.includeSourceAudio
    ? Math.ceil(
        selectedClipSeconds *
          OUTPUT_AUDIO_SAMPLE_RATE *
          VIDEO_MIX_CONSERVATIVE_SOURCE_AUDIO_CHANNELS *
          4,
      )
    : 0;
  const narrationPcmBytes = narrationAudioBytes > 0
    ? Math.ceil(
        options.plan.duration *
          OUTPUT_AUDIO_SAMPLE_RATE *
          OUTPUT_AUDIO_CHANNELS *
          4,
      )
    : 0;
  const usesTwoDecodedFrames = options.plan.boundaries.some((boundary) =>
    transitionTypeUsesOutgoingFrame(boundary.transition.type),
  );
  const decoderSurfaceCount = Math.min(
    options.plan.clips.length,
    usesTwoDecodedFrames ? 2 : 1,
  );
  const decoderSurfaceBytes =
    decoderSurfaceCount *
    VIDEO_MIX_CONSERVATIVE_DECODER_WIDTH *
    VIDEO_MIX_CONSERVATIVE_DECODER_HEIGHT *
    4;
  const narrationEncodedCopyBytes = Math.ceil(narrationAudioBytes);
  const outputBlobCopyBytes = memory.estimatedOutputBytes;
  const transitionCanvasBytes =
    getVideoMixTransitionCanvasWorkingBytes(options.plan);
  const estimatedWorkingBytes = Math.ceil(
    memory.estimatedWorkingBytes +
      sourcePcmBytes +
      narrationPcmBytes +
      narrationEncodedCopyBytes +
      outputBlobCopyBytes +
      decoderSurfaceBytes +
      transitionCanvasBytes,
  );
  const deviceMemoryBytes =
    typeof options.deviceMemoryGb === "number" &&
    Number.isFinite(options.deviceMemoryGb) &&
    options.deviceMemoryGb > 0
      ? options.deviceMemoryGb * 1024 * 1024 * 1024
      : null;
  const maximumWorkingBytes =
    memory.deviceClass === "ios"
      ? 384 * 1024 * 1024
      : memory.deviceClass === "low-memory"
        ? 768 * 1024 * 1024
        : deviceMemoryBytes
          ? Math.max(
              1024 * 1024 * 1024,
              Math.min(2 * 1024 * 1024 * 1024, deviceMemoryBytes * 0.25),
            )
          : 1536 * 1024 * 1024;
  const ok = memory.ok && estimatedWorkingBytes <= maximumWorkingBytes;
  return {
    ok,
    estimatedWorkingBytes,
    maximumWorkingBytes,
    baseWorkingBytes: memory.estimatedWorkingBytes,
    sourcePcmBytes,
    narrationPcmBytes,
    narrationEncodedCopyBytes,
    outputBlobCopyBytes,
    decoderSurfaceBytes,
    transitionCanvasBytes,
    message: ok
      ? null
      : memory.message ??
        "この端末では複数動画・音声・切り替え効果を同時に安全処理できません。カットを短くするか、切り替えを「カット」にして、もう一度お試しください。",
  };
}

type VideoMixAudioMetadataSourceInput = Readonly<{
  sourceId: string;
  hasAudioTrack: boolean;
}>;

/**
 * Pure metadata builder shared by the exporter tests and browser client
 * contract. `contributingSourceIndexes: null` means audio decoding was
 * intentionally skipped, not that the selected ranges were empty.
 */
export function createVideoMixAudioExportMetadata(options: Readonly<{
  sources: readonly VideoMixAudioMetadataSourceInput[];
  audioGain: number;
  contributingSourceIndexes: ReadonlySet<number> | null;
  outputHasAudioTrack: boolean;
  narration?: Readonly<{
    requested: boolean;
    hasDecodedSamples: boolean;
    hasActivity: boolean;
    contributedToMix: boolean;
    duckedSourceAudio: boolean;
  }>;
}>): VideoMixAudioExportMetadata {
  const hasSourceAudioTrack = options.sources.some(
    (source) => source.hasAudioTrack,
  );
  const intentionallyMuted = options.audioGain <= 0;
  const hasSelectedAudioSamples = intentionallyMuted
    ? null
    : (options.contributingSourceIndexes?.size ?? 0) > 0;
  const narration = options.narration ?? {
    requested: false,
    hasDecodedSamples: false,
    hasActivity: false,
    contributedToMix: false,
    duckedSourceAudio: false,
  };
  const requireAudio =
    narration.requested || (!intentionallyMuted && hasSourceAudioTrack);
  const state: VideoMixAudioOutputState = options.outputHasAudioTrack
    ? narration.requested && !hasSelectedAudioSamples
      ? "narration-only"
      : "mixed"
    : intentionallyMuted
      ? "intentionally-muted"
      : !hasSourceAudioTrack
        ? "no-source-audio"
        : "source-audio-unavailable-in-selection";

  return {
    sources: options.sources.map((source, sourceIndex) => {
      const hasSelectedSamples = intentionallyMuted
        ? null
        : Boolean(options.contributingSourceIndexes?.has(sourceIndex));
      return {
        sourceId: source.sourceId,
        sourceIndex,
        hasAudioTrack: source.hasAudioTrack,
        hasSelectedAudioSamples: hasSelectedSamples,
        contributedToMix:
          options.outputHasAudioTrack && hasSelectedSamples === true,
      };
    }),
    hasSourceAudioTrack,
    hasSelectedAudioSamples,
    outputHasAudioTrack: options.outputHasAudioTrack,
    requireAudio,
    inspectAudioActivity:
      options.outputHasAudioTrack &&
      (hasSelectedAudioSamples === true || narration.hasActivity),
    narration,
    state,
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new PortableVideoExportAbortedError();
}

async function* abortAwareVideoMixTimestamps(
  frames: readonly Readonly<{ sourceTime: number }>[],
  signal?: AbortSignal,
) {
  for (const frame of frames) {
    // End the producer cleanly instead of throwing through Mediabunny's
    // decoder pump. The consumer checks the same signal on every yielded
    // sample and its `for await` close then releases queued VideoSamples.
    if (signal?.aborted) return;
    yield frame.sourceTime;
  }
}

function normalizeAudioGain(value = 1) {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new RangeError("Video mix audio gain must be between 0 and 2.");
  }
  return value;
}

function normalizeSourceAudioNormalizationGain(value: number | undefined) {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0.4 || value > 1.8) {
    throw new RangeError(
      "Video mix source audio normalization gain must be between 0.4 and 1.8.",
    );
  }
  return value;
}

type VideoMixLoudnessAccumulator = {
  measurements: AudioLoudnessMeasurement[];
  sumSquares: number;
  peak: number;
  sampleCount: number;
};

function createVideoMixLoudnessAccumulator(): VideoMixLoudnessAccumulator {
  return { measurements: [], sumSquares: 0, peak: 0, sampleCount: 0 };
}

function addVideoMixAudioBufferMeasurement(
  accumulator: VideoMixLoudnessAccumulator,
  buffer: AudioBuffer,
  startFrame = 0,
  endFrame = buffer.length,
) {
  const safeStart = Math.max(0, Math.min(buffer.length, startFrame));
  const safeEnd = Math.max(safeStart, Math.min(buffer.length, endFrame));
  if (safeEnd <= safeStart) return;
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel),
  );
  accumulator.measurements.push(
    measureAudioLoudness(channels, buffer.sampleRate, {
      startFrame: safeStart,
      endFrame: safeEnd,
    }),
  );
  const stride = Math.max(1, Math.ceil((safeEnd - safeStart) / 30_000));
  channels.forEach((samples) => {
    for (let frame = safeStart; frame < safeEnd; frame += stride) {
      const sample = samples[frame];
      if (!Number.isFinite(sample)) continue;
      accumulator.sumSquares += sample * sample;
      accumulator.peak = Math.max(accumulator.peak, Math.abs(sample));
      accumulator.sampleCount += 1;
    }
  });
}

function finishVideoMixAudioNormalization(
  accumulator: VideoMixLoudnessAccumulator,
) {
  const loudness = combineAudioLoudnessMeasurements(accumulator.measurements);
  if (loudness.integratedLufs !== null) {
    return Math.max(0.4, Math.min(1.8, computeLoudnessNormalizationGain(loudness)));
  }
  if (accumulator.sampleCount === 0 || accumulator.peak < 0.0001) return 1;
  const rms = Math.sqrt(accumulator.sumSquares / accumulator.sampleCount);
  const targetRms = 10 ** (-18 / 20);
  return Math.min(1.8, Math.max(0.4, targetRms / rms), 0.9 / accumulator.peak);
}

export function createVideoMixSourceAudioAnalysisWindows(
  clips: readonly VideoCompositionClip[],
  maximumSeconds = VIDEO_MIX_SOURCE_AUDIO_ANALYSIS_MAX_SECONDS,
) {
  if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0) {
    throw new RangeError("Video mix audio analysis duration must be positive.");
  }
  const valid = clips
    .map((clip) => ({ start: clip.start, end: clip.end }))
    .filter(
      (clip) =>
        Number.isFinite(clip.start) &&
        Number.isFinite(clip.end) &&
        clip.start >= 0 &&
        clip.end - clip.start > TIME_EPSILON,
    );
  const selectedSeconds = valid.reduce(
    (total, clip) => total + (clip.end - clip.start),
    0,
  );
  if (selectedSeconds <= maximumSeconds + TIME_EPSILON) return valid;
  // One centered window per selected clip keeps both cuts represented while
  // bounding phone decode work independently of the original file duration.
  return valid.map((clip) => {
    const clipDuration = clip.end - clip.start;
    const share = maximumSeconds * (clipDuration / selectedSeconds);
    const duration = Math.min(clipDuration, share);
    const start = clip.start + (clipDuration - duration) / 2;
    return { start, end: start + duration };
  });
}

/**
 * Measures only bounded windows from the currently selected clips. Decoded
 * PCM is consumed and discarded buffer-by-buffer, and callers can abort when
 * a source is removed, trimmed, or the editor unmounts.
 */
export async function measureVideoMixSourceAudioNormalization(
  file: File,
  clips: readonly VideoCompositionClip[],
  signal?: AbortSignal,
) {
  if (!(file instanceof File) || file.size <= 0) {
    throw new TypeError("A non-empty video File is required for audio analysis.");
  }
  let input: InstanceType<(typeof import("mediabunny"))["Input"]> | null = null;
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
    const duration = await audioTrack.computeDuration();
    if (!Number.isFinite(duration) || duration <= TIME_EPSILON) return 1;
    const sink = new media.AudioBufferSink(audioTrack as InputAudioTrack);
    const accumulator = createVideoMixLoudnessAccumulator();
    const windows = createVideoMixSourceAudioAnalysisWindows(clips).map((window) => ({
      start: Math.max(0, Math.min(duration, window.start)),
      end: Math.max(0, Math.min(duration, window.end)),
    }));
    let decodedBuffers = 0;
    for (const window of windows) {
      if (window.end - window.start <= TIME_EPSILON) continue;
      for await (const wrapped of sink.buffers(window.start, window.end)) {
        throwIfAborted(signal);
        addVideoMixAudioBufferMeasurement(accumulator, wrapped.buffer);
        decodedBuffers += 1;
        if (decodedBuffers >= VIDEO_MIX_SOURCE_AUDIO_ANALYSIS_MAX_BUFFERS) break;
      }
      if (decodedBuffers >= VIDEO_MIX_SOURCE_AUDIO_ANALYSIS_MAX_BUFFERS) break;
    }
    return finishVideoMixAudioNormalization(accumulator);
  } catch (error) {
    if (error instanceof PortableVideoExportAbortedError) throw error;
    // Preview loudness analysis is an enhancement. Unsupported source audio
    // remains playable at unity gain and export retains its own fallback.
    return 1;
  } finally {
    input?.dispose();
  }
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

function scheduleAudioBuffer(
  context: OfflineAudioContext,
  destination: AudioNode,
  item: ScheduledMixAudio,
) {
  const duration = Math.min(
    item.placement.duration,
    Math.max(0, item.buffer.duration - item.placement.offset),
  );
  if (duration <= TIME_EPSILON) return;

  const source = context.createBufferSource();
  source.buffer = item.buffer;
  if (
    !item.fadeIn &&
    !item.fadeOut &&
    !item.overlapFadeIn &&
    !item.overlapFadeOut
  ) {
    source.connect(destination);
    source.start(item.placement.when, item.placement.offset, duration);
    return;
  }

  const gain = context.createGain();
  source.connect(gain);
  gain.connect(destination);
  const maximumSingleFade = duration / (item.fadeIn && item.fadeOut ? 2 : 1);
  const fadeInDuration = Math.min(
    item.fadeInDuration ?? PORTABLE_AUDIO_CUT_FADE_SECONDS,
    maximumSingleFade,
  );
  const fadeOutDuration = Math.min(
    item.fadeOutDuration ?? PORTABLE_AUDIO_CUT_FADE_SECONDS,
    maximumSingleFade,
  );
  const curveSteps = 32;
  const itemStart = item.placement.when;
  const itemEnd = itemStart + duration;
  if (
    !item.overlapFadeIn ||
    item.overlapFadeIn.start > itemStart + TIME_EPSILON
  ) {
    gain.gain.setValueAtTime(1, itemStart);
  }

  const scheduleTimelineFade = (
    window: Readonly<{ start: number; end: number }>,
    direction: "in" | "out",
  ) => {
    const overlapStart = Math.max(itemStart, window.start);
    const overlapEnd = Math.min(itemEnd, window.end);
    if (overlapEnd - overlapStart <= TIME_EPSILON) return;
    const windowDuration = window.end - window.start;
    if (windowDuration <= TIME_EPSILON) return;
    gain.gain.setValueCurveAtTime(
      Float32Array.from({ length: curveSteps }, (_, index) => {
        const timelineTime =
          overlapStart +
          ((overlapEnd - overlapStart) * index) / (curveSteps - 1);
        return getPortableEqualPowerFadeGain(
          (timelineTime - window.start) / windowDuration,
          direction,
        );
      }),
      overlapStart,
      overlapEnd - overlapStart,
    );
    if (direction === "in" && overlapEnd < itemEnd - TIME_EPSILON) {
      gain.gain.setValueAtTime(1, overlapEnd);
    }
  };
  if (item.overlapFadeIn) scheduleTimelineFade(item.overlapFadeIn, "in");
  if (item.overlapFadeOut) scheduleTimelineFade(item.overlapFadeOut, "out");
  if (item.fadeIn && fadeInDuration > TIME_EPSILON) {
    gain.gain.setValueCurveAtTime(
      Float32Array.from(
        { length: curveSteps },
        (_, index) =>
          getPortableEqualPowerFadeGain(index / (curveSteps - 1), "in"),
      ),
      item.placement.when,
      fadeInDuration,
    );
  } else if (!item.overlapFadeIn) {
    gain.gain.setValueAtTime(1, item.placement.when);
  }
  if (item.fadeOut && fadeOutDuration > TIME_EPSILON) {
    gain.gain.setValueCurveAtTime(
      Float32Array.from(
        { length: curveSteps },
        (_, index) =>
          getPortableEqualPowerFadeGain(index / (curveSteps - 1), "out"),
      ),
      item.placement.when + duration - fadeOutDuration,
      fadeOutDuration,
    );
  }
  source.start(item.placement.when, item.placement.offset, duration);
}

export type VideoMixClipAudioOverlapEnvelope = Readonly<{
  fadeIn: Readonly<{ start: number; end: number }> | null;
  fadeOut: Readonly<{ start: number; end: number }> | null;
}>;

/**
 * Returns timeline fades for one clip independently of whether either
 * neighboring clip actually contains decodable audio. This is important for
 * audible-to-silent and silent-to-audible transitions: the audible side must
 * still follow the same equal-power envelope as the visual preview.
 */
export function getVideoMixClipAudioOverlapEnvelope(
  plan: VideoCompositionPlan,
  clipIndex: number,
): VideoMixClipAudioOverlapEnvelope {
  const toWindow = (boundary: VideoCompositionPlan["boundaries"][number] | undefined) =>
    boundary &&
    boundary.transition.duration > TIME_EPSILON &&
    videoCompositionTransitionUsesOverlap(boundary.transition.type)
      ? {
          start: boundary.editedTime,
          end: boundary.editedTime + boundary.transition.duration,
        }
      : null;
  return {
    fadeIn: toWindow(plan.boundaries[clipIndex - 1]),
    fadeOut: toWindow(plan.boundaries[clipIndex]),
  };
}

function applyMixAudioCrossfades(
  groups: ScheduledMixAudio[][],
  plan: VideoCompositionPlan,
) {
  groups.forEach((group, clipIndex) => {
    if (group.length === 0) return;
    group[0].fadeIn = true;
    group[group.length - 1].fadeOut = true;
    const envelope = getVideoMixClipAudioOverlapEnvelope(plan, clipIndex);
    if (envelope.fadeIn) {
      group.forEach((item) => {
        item.overlapFadeIn = envelope.fadeIn!;
      });
      group[0].fadeIn = false;
    }
    if (envelope.fadeOut) {
      group.forEach((item) => {
        item.overlapFadeOut = envelope.fadeOut!;
      });
      group[group.length - 1].fadeOut = false;
    }
  });
  for (let index = 0; index < groups.length - 1; index += 1) {
    const boundary = plan.boundaries[index];
    if (
      boundary &&
      boundary.transition.duration > TIME_EPSILON &&
      videoCompositionTransitionUsesOverlap(boundary.transition.type)
    ) {
      continue;
    }
    const outgoing = groups[index].at(-1);
    const incoming = groups[index + 1][0];
    if (!outgoing || !incoming) continue;
    const crossfade = buildPortableAudioCrossfadePlan(
      outgoing.placement,
      outgoing.buffer.duration,
      incoming.placement,
    );
    if (!crossfade) continue;
    outgoing.placement = crossfade.outgoing;
    outgoing.fadeOutDuration = crossfade.fadeDuration;
    incoming.fadeInDuration = crossfade.fadeDuration;
  }
}

async function collectVideoMixAudio(
  media: typeof import("mediabunny"),
  prepared: readonly PreparedVideoMixSource[],
  plan: VideoCompositionPlan,
  signal?: AbortSignal,
) {
  const groups: ScheduledMixAudio[][] = Array.from(
    { length: plan.clips.length },
    () => [],
  );

  for (const [sourceIndex, item] of prepared.entries()) {
    throwIfAborted(signal);
    const audioTrack = item.audioTrack;
    if (!audioTrack) continue;
    if (!(await audioTrack.canDecode())) {
      throw new PortableVideoExportUnsupportedError(
        "audio-decode",
        `「${item.source.file.name}」の音声をこの端末で読み取れません。`,
      );
    }
    const sink = new media.AudioBufferSink(audioTrack as InputAudioTrack);
    const sourcePlan = plan.sources[sourceIndex];
    if (!sourcePlan) {
      throw new Error("動画の並び順を確認できませんでした。");
    }

    for (const clip of sourcePlan.clips) {
      const group = groups[clip.globalClipIndex];
      for await (const wrapped of sink.buffers(clip.start, clip.end)) {
        throwIfAborted(signal);
        const placement = getPortableAudioSlicePlacement(
          clip,
          clip.editedStart,
          wrapped.timestamp,
          wrapped.duration,
        );
        if (!placement) continue;
        group.push({
          buffer: wrapped.buffer,
          sourceIndex,
          placement,
          fadeIn: false,
          fadeOut: false,
        });
      }
    }
  }

  applyMixAudioCrossfades(groups, plan);
  return groups.flat();
}

async function renderVideoMixAudio(
  media: typeof import("mediabunny"),
  prepared: readonly PreparedVideoMixSource[],
  plan: VideoCompositionPlan,
  options: Readonly<{
    audioGain: number;
    narrationAudio: Blob | null;
    narrationGain: number;
    narrationNormalizationGain: number | null;
    duckSourceAudioDuringNarration: boolean;
    signal?: AbortSignal;
  }>,
): Promise<RenderedVideoMixAudio> {
  const noNarration = {
    hasDecodedSamples: false,
    hasActivity: false,
    contributedToMix: false,
    duckedSourceAudio: false,
  } as const;
  if (options.audioGain <= 0 && !options.narrationAudio) {
    return {
      buffer: null,
      contributingSourceIndexes: null,
      narration: noNarration,
    };
  }
  const scheduled =
    options.audioGain > 0
      ? await collectVideoMixAudio(media, prepared, plan, options.signal)
      : [];
  const contributingSourceIndexes =
    options.audioGain > 0
      ? new Set(scheduled.map((item) => item.sourceIndex))
      : null;
  if (scheduled.length === 0 && !options.narrationAudio) {
    return {
      buffer: null,
      contributingSourceIndexes,
      narration: noNarration,
    };
  }

  const OfflineAudioContextConstructor = getOfflineAudioContextConstructor();
  if (!OfflineAudioContextConstructor) {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      "このブラウザでは複数動画の音声を書き出せません。",
    );
  }
  const context = new OfflineAudioContextConstructor(
    OUTPUT_AUDIO_CHANNELS,
    Math.max(1, Math.ceil(plan.duration * OUTPUT_AUDIO_SAMPLE_RATE)),
    OUTPUT_AUDIO_SAMPLE_RATE,
  );
  let narrationBuffer: AudioBuffer | null = null;
  if (options.narrationAudio) {
    try {
      const encodedNarration = await options.narrationAudio.arrayBuffer();
      throwIfAborted(options.signal);
      narrationBuffer = await context.decodeAudioData(encodedNarration);
    } catch (error) {
      if (error instanceof PortableVideoExportAbortedError) throw error;
      throw new PortableVideoExportUnsupportedError(
        "audio-decode",
        "ナレーション音声を読み取れません。音声を作り直してから、もう一度お試しください。",
        { cause: error },
      );
    }
  }
  const narrationDuration = narrationBuffer
    ? Math.min(plan.duration, narrationBuffer.duration)
    : 0;
  const narrationChannels = narrationBuffer
    ? Array.from(
        { length: narrationBuffer.numberOfChannels },
        (_, channel) => narrationBuffer!.getChannelData(channel),
      )
    : [];
  const narrationActivity = narrationBuffer
    ? detectPortableNarrationActivity(
        narrationChannels,
        narrationBuffer.sampleRate,
        narrationDuration,
      )
    : [];
  const narrationHasDecodedSamples =
    narrationBuffer !== null && narrationDuration > TIME_EPSILON;
  const narrationContributedToMix =
    narrationHasDecodedSamples && options.narrationGain > 0;
  const duckedSourceAudio =
    options.duckSourceAudioDuringNarration &&
    scheduled.length > 0 &&
    narrationActivity.length > 0;

  const masterGain = context.createGain();
  if (duckedSourceAudio) {
    const envelope = buildVideoMixNarrationDuckingMetadata({
      activity: narrationActivity,
      baseGain: options.audioGain,
      duration: plan.duration,
    }).envelope;
    masterGain.gain.cancelScheduledValues(0);
    envelope.forEach((point, index) => {
      if (index === 0) {
        masterGain.gain.setValueAtTime(point.gain, point.time);
      } else {
        masterGain.gain.linearRampToValueAtTime(point.gain, point.time);
      }
    });
  } else {
    masterGain.gain.value = options.audioGain;
  }
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  masterGain.connect(limiter).connect(context.destination);
  const sourceGains = prepared.map((_, sourceIndex) => {
    const cachedGain = normalizeSourceAudioNormalizationGain(
      prepared[sourceIndex].source.audioNormalizationGain,
    );
    if (cachedGain !== null) return cachedGain;
    const accumulator = createVideoMixLoudnessAccumulator();
    scheduled
      .filter((item) => item.sourceIndex === sourceIndex)
      .forEach((item) => {
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
        if (endFrame <= startFrame) return;
        addVideoMixAudioBufferMeasurement(
          accumulator,
          item.buffer,
          startFrame,
          endFrame,
        );
      });
    return finishVideoMixAudioNormalization(accumulator);
  });
  const sourceNodes = sourceGains.map((gain) => {
    const node = context.createGain();
    // The portable normalizer uses integrated LUFS when available and an
    // RMS/peak-safe fallback otherwise. A per-source node prevents a quiet
    // phone clip and a hot mastered clip from changing volume abruptly.
    node.gain.value = Math.max(0.4, Math.min(1.8, gain));
    node.connect(masterGain);
    return node;
  });
  scheduled.forEach((item) =>
    scheduleAudioBuffer(
      context,
      sourceNodes[item.sourceIndex],
      item,
    ),
  );
  if (narrationBuffer && narrationDuration > TIME_EPSILON) {
    const conservativeNormalization = options.narrationNormalizationGain ?? (() => {
      const narrationMeasurement = measureAudioLoudness(
        narrationChannels,
        narrationBuffer.sampleRate,
        {
          startFrame: 0,
          endFrame: Math.min(
            narrationBuffer.length,
            Math.ceil(narrationDuration * narrationBuffer.sampleRate),
          ),
        },
      );
      const measuredNormalization = narrationMeasurement.integratedLufs === null
        ? computePortableOriginalNormalizationGain(
            Math.sqrt(Math.max(0, narrationMeasurement.ungatedMeanSquare)),
            narrationMeasurement.samplePeak,
          )
        : computeLoudnessNormalizationGain(narrationMeasurement, {
            targetLufs: -18,
            truePeakLimitDbtp: -2,
            minimumGain: 0.65,
            maximumGain: 1.35,
          });
      return Math.max(0.65, Math.min(1.35, measuredNormalization));
    })();
    const narrationGainNode = context.createGain();
    narrationGainNode.gain.value =
      options.narrationGain * conservativeNormalization;
    narrationGainNode.connect(limiter);
    scheduleAudioBuffer(context, narrationGainNode, {
      buffer: narrationBuffer,
      sourceIndex: 0,
      placement: {
        when: 0,
        offset: 0,
        duration: narrationDuration,
      },
      fadeIn: true,
      fadeOut: true,
    });
  }
  throwIfAborted(options.signal);
  return {
    buffer: await context.startRendering(),
    contributingSourceIndexes,
    narration: {
      hasDecodedSamples: narrationHasDecodedSamples,
      hasActivity: narrationActivity.length > 0,
      contributedToMix: narrationContributedToMix,
      duckedSourceAudio,
    },
  };
}

function copyCanvasFrame(
  source: HTMLCanvasElement,
  target: HTMLCanvasElement,
) {
  const context = target.getContext("2d", { alpha: false });
  if (!context) {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      "動画の切り替えフレームを準備できません。",
    );
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.drawImage(source, 0, 0);
}

type VideoMixDrawableSample = Readonly<{
  draw: (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
}>;

function drawVideoMixSourceFrame(
  context: CanvasRenderingContext2D,
  sample: VideoMixDrawableSample,
  layout: VideoMixFrameLayout,
) {
  const { width, height } = context.canvas;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.filter = "none";
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  if (layout.background.kind === "blurred-video") {
    const background = layout.background;
    context.save();
    context.filter = `blur(${background.blurPixels}px) saturate(0.88)`;
    // A slight overscan keeps blur kernels from exposing dark canvas edges.
    const overscan = 1.08;
    const extraWidth = background.rect.width * (overscan - 1);
    const extraHeight = background.rect.height * (overscan - 1);
    sample.draw(
      context,
      background.rect.x - extraWidth / 2,
      background.rect.y - extraHeight / 2,
      background.rect.width + extraWidth,
      background.rect.height + extraHeight,
    );
    context.restore();
    context.fillStyle = "rgba(0,0,0,0.18)";
    context.fillRect(0, 0, width, height);
  }

  const rect = layout.foregroundRect;
  sample.draw(context, rect.x, rect.y, rect.width, rect.height);
  context.filter = "none";
}

function releaseVideoMixTransitionCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function drawFrameTransition(
  context: CanvasRenderingContext2D,
  frame: VideoCompositionFrameScheduleEntry,
  outgoingFrame: HTMLCanvasElement | null,
  incomingFrame: HTMLCanvasElement | null,
  incomingFrameAlreadyCaptured = false,
) {
  const transition = frame.transition;
  if (!transition) return;
  const visual = transition.visual;
  if (
    transitionTypeUsesOutgoingFrame(transition.type) &&
    !outgoingFrame
  ) {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      "動画の切り替え元フレームを準備できません。カットを少し長くして、もう一度お試しください。",
    );
  }
  if (outgoingFrame) {
    if (!incomingFrame) {
      throw new PortableVideoExportUnsupportedError(
        "browser",
        "動画の切り替えフレームを準備できません。",
      );
    }
    if (!incomingFrameAlreadyCaptured) {
      copyCanvasFrame(context.canvas, incomingFrame);
    }

    const drawLayer = (
      image: CanvasImageSource,
      opacity: number,
      scale: number,
      offsetX: number,
      reveal: number,
    ) => {
      const width = context.canvas.width;
      const height = context.canvas.height;
      context.save();
      context.globalAlpha = Math.max(0, Math.min(1, opacity));
      if (reveal < 1) {
        const visibleWidth = Math.max(0, width * reveal);
        context.beginPath();
        context.rect(width - visibleWidth, 0, visibleWidth, height);
        context.clip();
      }
      context.translate(width / 2 + width * offsetX, height / 2);
      context.scale(scale, scale);
      context.translate(-width / 2, -height / 2);
      context.drawImage(image, 0, 0);
      context.restore();
    };

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.fillStyle = "#000";
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    drawLayer(
      outgoingFrame,
      visual.outgoingOpacity,
      visual.outgoingScale,
      visual.outgoingOffsetX,
      1,
    );
    drawLayer(
      incomingFrame,
      visual.incomingOpacity,
      visual.incomingScale,
      visual.incomingOffsetX,
      visual.incomingReveal,
    );
  }
  if (visual.overlayColor && visual.overlayOpacity > 0) {
    context.save();
    context.globalAlpha = Math.max(0, Math.min(1, visual.overlayOpacity));
    context.fillStyle = visual.overlayColor;
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }
}

function transitionUsesOutgoingFrame(
  frame: VideoCompositionFrameScheduleEntry,
) {
  const type = frame.transition?.type;
  return type ? transitionTypeUsesOutgoingFrame(type) : false;
}

/**
 * Exports up to five ordered source videos as one deterministic 1080x1920
 * H.264/AAC MP4. This intentionally has no real-time recorder fallback,
 * because real-time seeking cannot preserve multi-source timing reliably.
 */
export async function exportVideoMixMp4(
  options: VideoMixExportOptions,
): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      "複数動画の書き出しはブラウザ上でのみ利用できます。",
    );
  }
  if (
    options.sources.length < 1 ||
    options.sources.length > VIDEO_COMPOSITION_MAX_SOURCES
  ) {
    throw new RangeError(
      `動画は1本から${VIDEO_COMPOSITION_MAX_SOURCES}本まで選べます。`,
    );
  }
  options.sources.forEach((source) => {
    if (!(source.file instanceof File) || source.file.size <= 0) {
      throw new TypeError("Each video mix source must contain a non-empty File.");
    }
  });

  const audioGain = normalizeAudioGain(options.audioGain);
  const narrationAudio = options.narrationAudio ?? null;
  if (
    narrationAudio &&
    (!(narrationAudio instanceof Blob) || narrationAudio.size <= 0)
  ) {
    throw new TypeError("narrationAudio must be a non-empty Blob.");
  }
  const narrationGain = normalizeAudioGain(options.narrationGain);
  const narrationNormalizationGain = options.narrationNormalizationGain === undefined
    ? null
    : Math.max(0.65, Math.min(1.35, options.narrationNormalizationGain));
  if (
    options.narrationNormalizationGain !== undefined &&
    (!Number.isFinite(options.narrationNormalizationGain) ||
      options.narrationNormalizationGain < 0.65 ||
      options.narrationNormalizationGain > 1.35)
  ) {
    throw new RangeError(
      "Video mix narration normalization gain must be between 0.65 and 1.35.",
    );
  }
  const duckSourceAudioDuringNarration =
    options.duckSourceAudioDuringNarration ?? true;
  const provisionalPlan = createVideoCompositionPlan({
    sources: options.sources.map((source) => ({
      id: source.id,
      fileSize: source.file.size,
      duration: Math.max(0.001, ...source.clips.map((clip) => clip.end)),
      clips: source.clips,
    })),
    transition: options.transition,
    boundaryTransitions: options.boundaryTransitions,
  });
  const deviceMemoryGb =
    typeof navigator === "undefined"
      ? null
      : ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
        null);
  const memoryPreflight = getVideoMixExportMemoryPreflight({
    plan: provisionalPlan,
    includeSourceAudio: audioGain > 0,
    narrationAudioBytes: narrationAudio?.size ?? 0,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    maximumTouchPoints:
      typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
    deviceMemoryGb,
  });
  if (!memoryPreflight.ok) {
    throw new PortableVideoExportUnsupportedError(
      "browser",
      memoryPreflight.message ??
        "この端末では複数動画を安全に書き出せません。",
    );
  }
  const media = await import("mediabunny");
  const prepared: PreparedVideoMixSource[] = [];
  let output: InstanceType<(typeof import("mediabunny"))["Output"]> | null =
    null;
  options.onProgress?.(0);

  try {
    for (const [sourceIndex, source] of options.sources.entries()) {
      throwIfAborted(options.signal);
      const input = new media.Input({
        source: new media.BlobSource(source.file),
        formats: media.ALL_FORMATS,
      });
      if (!(await input.canRead())) {
        input.dispose();
        throw new PortableVideoExportUnsupportedError(
          "input",
          `「${source.file.name}」を読み取れません。MP4・MOV・M4V・WebMでお試しください。`,
        );
      }
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        input.dispose();
        throw new PortableVideoExportUnsupportedError(
          "input",
          `「${source.file.name}」に映像が見つかりません。`,
        );
      }
      if (!(await videoTrack.canDecode())) {
        input.dispose();
        throw new PortableVideoExportUnsupportedError(
          "video-decode",
          `「${source.file.name}」をこの端末で再生できません。`,
        );
      }
      const [
        duration,
        width,
        height,
        colorSpace,
        hasHighDynamicRange,
        audioTrack,
      ] = await Promise.all([
          videoTrack.computeDuration(),
          videoTrack.getDisplayWidth(),
          videoTrack.getDisplayHeight(),
          videoTrack.getColorSpace().catch(() => ({})),
          videoTrack.hasHighDynamicRange().catch(() => false),
          getPreferredPortableInputAudioTrack(input),
        ]);
      const colorConversionPlan = createPortableVideoColorConversionPlan({
        colorSpace,
        hasHighDynamicRange,
      });
      prepared.push({
        source,
        input,
        videoTrack,
        audioTrack,
        duration,
        frameLayout: computeVideoMixFrameLayout(
          width,
          height,
          VIDEO_COMPOSITION_OUTPUT_WIDTH,
          VIDEO_COMPOSITION_OUTPUT_HEIGHT,
          source.framing,
        ),
        colorConversionPlan,
      });
      options.onProgress?.(
        0.06 * ((sourceIndex + 1) / options.sources.length),
      );
    }

    const plan = createVideoCompositionPlan({
      sources: prepared.map((item) => ({
        id: item.source.id,
        fileSize: item.source.file.size,
        duration: item.duration,
        clips: item.source.clips,
      })),
      transition: options.transition,
      boundaryTransitions: options.boundaryTransitions,
    });
    const schedule = buildVideoCompositionFrameSchedule(plan);
    const decodeBatches = buildVideoMixFrameDecodeBatches(plan, schedule);
    options.onPlan?.(plan);
    options.onColorConversionPlans?.(
      prepared.map((item, sourceIndex) => ({
        sourceId: plan.sources[sourceIndex].id,
        sourceIndex,
        plan: item.colorConversionPlan,
      })),
    );
    const transitionCanvasWorkingBytes =
      getVideoMixTransitionCanvasWorkingBytes(plan);

    const videoEncodingSettings = createPortableVideoEncodingSettings(
      VIDEO_COMPOSITION_OUTPUT_WIDTH,
      VIDEO_COMPOSITION_OUTPUT_HEIGHT,
      HIGH_QUALITY_VIDEO_BITRATE,
      VIDEO_COMPOSITION_FRAME_RATE,
    );
    if (!(await media.canEncodeVideo("avc", videoEncodingSettings))) {
      throw new PortableVideoExportUnsupportedError(
        "video-encode",
        "この端末では複数動画を高画質MP4へ書き出せません。最新版のSafariまたはChromeでお試しください。",
      );
    }

    const renderedAudio = await renderVideoMixAudio(
      media,
      prepared,
      plan,
      {
        audioGain,
        narrationAudio,
        narrationGain,
        narrationNormalizationGain,
        duckSourceAudioDuringNarration,
        signal: options.signal,
      },
    );
    const mixedAudio = renderedAudio.buffer;
    const audioMetadata = createVideoMixAudioExportMetadata({
      sources: prepared.map((item) => ({
        sourceId: item.source.id,
        hasAudioTrack: item.audioTrack !== null,
      })),
      audioGain,
      contributingSourceIndexes: renderedAudio.contributingSourceIndexes,
      outputHasAudioTrack: mixedAudio !== null,
      narration: {
        requested: narrationAudio !== null,
        ...renderedAudio.narration,
      },
    });
    if (
      mixedAudio &&
      !(await ensurePortableAacEncoding(media, {
        numberOfChannels: OUTPUT_AUDIO_CHANNELS,
        sampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
        bitrate: OUTPUT_AUDIO_BITRATE,
      }))
    ) {
      throw new PortableVideoExportUnsupportedError(
        "audio-encode",
        "この端末では複数動画の音声をAACへ書き出せません。最新版のSafariまたはChromeでお試しください。",
      );
    }
    throwIfAborted(options.signal);
    options.onProgress?.(0.16);

    const canvas = document.createElement("canvas");
    canvas.width = VIDEO_COMPOSITION_OUTPUT_WIDTH;
    canvas.height = VIDEO_COMPOSITION_OUTPUT_HEIGHT;
    const context = canvas.getContext("2d", {
      alpha: false,
      colorSpace: "srgb",
    });
    if (!context) {
      throw new PortableVideoExportUnsupportedError(
        "browser",
        "複数動画のフレームを描画できません。",
      );
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    const target = new media.BufferTarget();
    output = new media.Output({
      format: new media.Mp4OutputFormat({ fastStart: false }),
      target,
    });
    const videoSource = new media.CanvasSource(canvas, {
      codec: "avc",
      bitrate: HIGH_QUALITY_VIDEO_BITRATE,
      bitrateMode: videoEncodingSettings.bitrateMode,
      latencyMode: videoEncodingSettings.latencyMode,
      contentHint: videoEncodingSettings.contentHint,
      keyFrameInterval: 2,
    });
    output.addVideoTrack(videoSource, {
      frameRate: VIDEO_COMPOSITION_FRAME_RATE,
    });
    const audioSource = mixedAudio
      ? new media.AudioBufferSource({
          codec: "aac",
          bitrate: OUTPUT_AUDIO_BITRATE,
          transform: {
            numberOfChannels: OUTPUT_AUDIO_CHANNELS,
            sampleRate: OUTPUT_AUDIO_SAMPLE_RATE,
          },
        })
      : null;
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();
    const audioWrite = audioSource && mixedAudio
      ? audioSource.add(mixedAudio).then(() => audioSource.close())
      : Promise.resolve();
    const usesOutgoingTransitionFrame = transitionCanvasWorkingBytes > 0;
    const outgoingTransitionFrame = usesOutgoingTransitionFrame
      ? document.createElement("canvas")
      : null;
    const incomingTransitionFrame = usesOutgoingTransitionFrame
      ? document.createElement("canvas")
      : null;
    for (const transitionCanvas of [
      outgoingTransitionFrame,
      incomingTransitionFrame,
    ]) {
      if (!transitionCanvas) continue;
      transitionCanvas.width = canvas.width;
      transitionCanvas.height = canvas.height;
    }
    const outgoingTransitionContext = outgoingTransitionFrame?.getContext("2d", {
      alpha: false,
      colorSpace: "srgb",
    }) ?? null;
    if (outgoingTransitionContext) {
      outgoingTransitionContext.imageSmoothingEnabled = true;
      outgoingTransitionContext.imageSmoothingQuality = "high";
    }
    let emittedFrames = 0;

    try {
      // Each selected clip owns one monotonic decoder stream. During a blend,
      // the current and outgoing streams advance together, but neither is
      // recreated per frame and only two reusable transition canvases exist.
      const decodeStates = new Map(
        decodeBatches.map((batch) => {
          const item = prepared[batch.sourceIndex];
          const sink = new media.VideoSampleSink(item.videoTrack);
          const state = {
            batch,
            item,
            requestIndex: 0,
            iterator: sink
              .samplesAtTimestamps(
                abortAwareVideoMixTimestamps(batch.requests, options.signal),
              )
              [Symbol.asyncIterator](),
          };
          return [batch.globalClipIndex, state] as [number, typeof state];
        }),
      );
      const takeSample = async (
        globalClipIndex: number,
        frameIndex: number,
        role: VideoMixFrameDecodeRequest["role"],
      ) => {
        const state = decodeStates.get(globalClipIndex);
        const request = state?.batch.requests[state.requestIndex];
        if (
          !state ||
          !request ||
          request.frameIndex !== frameIndex ||
          request.role !== role
        ) {
          throw new Error("動画のフレーム順序を確認できませんでした。");
        }
        const decoded = await state.iterator.next();
        state.requestIndex += 1;
        if (decoded.done || !decoded.value) {
          throw new Error(
            `「${state.item.source.file.name}」の映像フレームを読み取れませんでした。`,
          );
        }
        return decoded.value;
      };

      try {
        for (const frame of schedule) {
          throwIfAborted(options.signal);
          const item = prepared[frame.sourceIndex];
          const primarySample = await takeSample(
            frame.globalClipIndex,
            frame.frameIndex,
            "primary",
          );
          let outgoingSample: Awaited<ReturnType<typeof takeSample>> | null = null;
          try {
            throwIfAborted(options.signal);
            drawVideoMixSourceFrame(context, primarySample, item.frameLayout);

            if (transitionUsesOutgoingFrame(frame) && frame.transition) {
              const boundary = plan.boundaries[frame.transition.boundaryIndex];
              const outgoingClip = plan.clips[boundary.outgoingClipIndex];
              outgoingSample = await takeSample(
                outgoingClip.globalClipIndex,
                frame.frameIndex,
                "transition-outgoing",
              );
              if (
                !outgoingTransitionFrame ||
                !outgoingTransitionContext ||
                !incomingTransitionFrame
              ) {
                throw new PortableVideoExportUnsupportedError(
                  "browser",
                  "動画の切り替えフレームを準備できません。",
                );
              }
              drawVideoMixSourceFrame(
                outgoingTransitionContext,
                outgoingSample,
                prepared[outgoingClip.sourceIndex].frameLayout,
              );
              drawFrameTransition(
                context,
                frame,
                outgoingTransitionFrame,
                incomingTransitionFrame,
              );
            } else {
              drawFrameTransition(context, frame, null, null);
            }
            await options.drawOverlay?.({
              canvas,
              context,
              plan,
              frame,
              frameIndex: frame.frameIndex,
              editedTime: frame.editedTime,
              sourceTime: frame.sourceTime,
              sourceId: frame.sourceId,
              sourceIndex: frame.sourceIndex,
              clipIndex: frame.clipIndex,
              duration: frame.duration,
            });
            await videoSource.add(frame.editedTime, frame.duration);
          } finally {
            primarySample.close();
            outgoingSample?.close();
          }
          emittedFrames += 1;
          options.onProgress?.(
            0.16 + (emittedFrames / schedule.length) * 0.79,
          );
        }
        for (const state of decodeStates.values()) {
          if (state.requestIndex !== state.batch.requests.length) {
            throw new Error(
              `「${state.item.source.file.name}」の映像を最後まで読み取れませんでした。`,
            );
          }
        }
      } finally {
        await Promise.allSettled(
          [...decodeStates.values()].map((state) => state.iterator.return?.()),
        );
      }
      if (emittedFrames !== schedule.length) {
        throw new Error("複数動画を最後まで書き出せませんでした。");
      }
      videoSource.close();
      await audioWrite;
      throwIfAborted(options.signal);
      options.onProgress?.(0.97);
      await output.finalize();
    } catch (error) {
      await Promise.allSettled([audioWrite]);
      throw error;
    } finally {
      // Setting both dimensions to zero releases the transition canvases'
      // backing stores on success and on every cancellation/error path.
      releaseVideoMixTransitionCanvas(outgoingTransitionFrame);
      releaseVideoMixTransitionCanvas(incomingTransitionFrame);
    }

    if (!target.buffer || target.buffer.byteLength === 0) {
      throw new Error("書き出した動画が空でした。");
    }
    options.onAudioMetadata?.(audioMetadata);
    options.onProgress?.(1);
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (error) {
    await output?.cancel().catch(() => undefined);
    throw error;
  } finally {
    prepared.forEach((item) => item.input.dispose());
  }
}
