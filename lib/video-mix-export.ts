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

export type VideoMixSourceInput = Readonly<{
  id: string;
  file: File;
  clips: readonly VideoCompositionClip[];
}>;

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
  drawRect: ReturnType<typeof computePortableVideoDrawRect>;
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
  /** The outgoing source frame is captured once after this batch. */
  captureBoundaryIndex: number | null;
  frames: readonly VideoCompositionFrameScheduleEntry[];
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
  for (const frame of schedule) {
    const frames = framesByClip.get(frame.globalClipIndex) ?? [];
    frames.push(frame);
    framesByClip.set(frame.globalClipIndex, frames);
  }

  return plan.clips.flatMap((clip) => {
    const frames = framesByClip.get(clip.globalClipIndex) ?? [];
    if (frames.length === 0) return [];
    const outgoingBoundary = plan.boundaries[clip.globalClipIndex];
    return [{
      sourceIndex: clip.sourceIndex,
      globalClipIndex: clip.globalClipIndex,
      captureBoundaryIndex:
        outgoingBoundary &&
        transitionTypeUsesOutgoingFrame(outgoingBoundary.transition.type)
          ? outgoingBoundary.index
          : null,
      frames,
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
  frames: readonly VideoCompositionFrameScheduleEntry[],
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
  if (!item.fadeIn && !item.fadeOut) {
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
  } else {
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

function applyMixAudioCrossfades(groups: ScheduledMixAudio[][]) {
  groups.forEach((group) => {
    if (group.length === 0) return;
    group[0].fadeIn = true;
    group[group.length - 1].fadeOut = true;
  });
  for (let index = 0; index < groups.length - 1; index += 1) {
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

  applyMixAudioCrossfades(groups);
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
    const envelope = buildPortableDuckingEnvelope(
      narrationActivity,
      options.audioGain,
      plan.duration,
    );
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
    const measurements: AudioLoudnessMeasurement[] = [];
    let sumSquares = 0;
    let peak = 0;
    let sampleCount = 0;
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
        measurements.push(
          measureAudioLoudness(
            Array.from(
              { length: item.buffer.numberOfChannels },
              (_, channel) => item.buffer.getChannelData(channel),
            ),
            item.buffer.sampleRate,
            { startFrame, endFrame },
          ),
        );
        const stride = Math.max(1, Math.ceil((endFrame - startFrame) / 30_000));
        for (
          let channel = 0;
          channel < item.buffer.numberOfChannels;
          channel += 1
        ) {
          const samples = item.buffer.getChannelData(channel);
          for (let frame = startFrame; frame < endFrame; frame += stride) {
            const sample = samples[frame];
            if (!Number.isFinite(sample)) continue;
            sumSquares += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
            sampleCount += 1;
          }
        }
      });
    const loudness = combineAudioLoudnessMeasurements(measurements);
    if (loudness.integratedLufs !== null) {
      return computeLoudnessNormalizationGain(loudness);
    }
    if (sampleCount === 0 || peak < 0.0001) return 1;
    const rms = Math.sqrt(sumSquares / sampleCount);
    const targetRms = 10 ** (-18 / 20);
    return Math.min(1.8, Math.max(0.4, targetRms / rms), 0.9 / peak);
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
    const conservativeNormalization = Math.max(
      0.65,
      Math.min(1.35, measuredNormalization),
    );
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
  const duckSourceAudioDuringNarration =
    options.duckSourceAudioDuringNarration ?? true;
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
        drawRect: computePortableVideoDrawRect(
          width,
          height,
          VIDEO_COMPOSITION_OUTPUT_WIDTH,
          VIDEO_COMPOSITION_OUTPUT_HEIGHT,
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
    const memory = getPortableExportMemoryPreflight({
      editedDurationSeconds: plan.duration,
      videoBitrate: HIGH_QUALITY_VIDEO_BITRATE,
      audioBitrate: OUTPUT_AUDIO_BITRATE,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      maximumTouchPoints:
        typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints,
      deviceMemoryGb:
        typeof navigator === "undefined"
          ? null
          : ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
            null),
    });
    const transitionCanvasWorkingBytes =
      getVideoMixTransitionCanvasWorkingBytes(plan);
    const estimatedWorkingBytes =
      memory.estimatedWorkingBytes + transitionCanvasWorkingBytes;
    const maximumWorkingBytes =
      memory.deviceClass === "ios"
        ? 384 * 1024 * 1024
        : memory.deviceClass === "low-memory"
          ? 768 * 1024 * 1024
          : Number.POSITIVE_INFINITY;
    if (!memory.ok || estimatedWorkingBytes > maximumWorkingBytes) {
      throw new PortableVideoExportUnsupportedError(
        "browser",
        memory.message ??
          "この端末では切り替え効果を含む複数動画を安全に書き出せません。カットを短くするか、PC版Chromeでお試しください。",
      );
    }

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
    let outgoingTransitionFrame = usesOutgoingTransitionFrame
      ? document.createElement("canvas")
      : null;
    let incomingTransitionFrame = usesOutgoingTransitionFrame
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
    let outgoingTransitionBoundaryIndex: number | null = null;
    let emittedFrames = 0;

    try {
      const sinks = prepared.map(
        (item) => new media.VideoSampleSink(item.videoTrack),
      );
      for (const batch of decodeBatches) {
        throwIfAborted(options.signal);
        const item = prepared[batch.sourceIndex];
        const sink = sinks[batch.sourceIndex];
        let batchFrameIndex = 0;
        for await (const sample of sink.samplesAtTimestamps(
          abortAwareVideoMixTimestamps(batch.frames, options.signal),
        )) {
          const frame = batch.frames[batchFrameIndex];
          batchFrameIndex += 1;
          if (!sample) {
            throw new Error(`「${item.source.file.name}」の映像フレームを読み取れませんでした。`);
          }
          try {
            // A sample may arrive just as cancellation is requested. Keep the
            // abort check inside this try so that every yielded VideoSample is
            // closed before the abort is propagated.
            throwIfAborted(options.signal);
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.globalAlpha = 1;
            context.fillStyle = "#000";
            context.fillRect(0, 0, canvas.width, canvas.height);
            sample.draw(
              context,
              item.drawRect.x,
              item.drawRect.y,
              item.drawRect.width,
              item.drawRect.height,
            );

            const captureBoundaryIndex =
              batch.captureBoundaryIndex !== null &&
              batchFrameIndex === batch.frames.length
                ? batch.captureBoundaryIndex
                : null;
            const outgoingFrameForCurrentBoundary = outgoingTransitionFrame;
            const spareTransitionFrame = incomingTransitionFrame;
            let promotedOutgoingFrame: HTMLCanvasElement | null = null;
            let recycledIncomingFrame: HTMLCanvasElement | null = null;
            if (captureBoundaryIndex !== null) {
              if (!outgoingFrameForCurrentBoundary || !spareTransitionFrame) {
                throw new PortableVideoExportUnsupportedError(
                  "browser",
                  "動画の切り替え用フレームを準備できません。もう一度お試しください。",
                );
              }
              // The last frame of a very short middle clip can still belong
              // to its incoming transition while also becoming the outgoing
              // frame for the next boundary. Preserve the raw sample in the
              // spare canvas without replacing the current boundary's frame.
              copyCanvasFrame(canvas, spareTransitionFrame);
              promotedOutgoingFrame = spareTransitionFrame;
              recycledIncomingFrame = outgoingFrameForCurrentBoundary;
            }

            const transition = frame.transition;
            if (transition && transitionUsesOutgoingFrame(frame)) {
              drawFrameTransition(
                context,
                frame,
                outgoingTransitionBoundaryIndex === transition.boundaryIndex
                  ? outgoingFrameForCurrentBoundary
                  : null,
                spareTransitionFrame,
                promotedOutgoingFrame !== null,
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
            if (
              captureBoundaryIndex !== null &&
              promotedOutgoingFrame &&
              recycledIncomingFrame
            ) {
              // Promote only after the current boundary has been rendered.
              // The former outgoing canvas becomes the next scratch canvas.
              outgoingTransitionFrame = promotedOutgoingFrame;
              incomingTransitionFrame = recycledIncomingFrame;
              outgoingTransitionBoundaryIndex = captureBoundaryIndex;
            }
          } finally {
            sample.close();
          }
          emittedFrames += 1;
          options.onProgress?.(
            0.16 + (emittedFrames / schedule.length) * 0.79,
          );
        }
        throwIfAborted(options.signal);
        if (batchFrameIndex !== batch.frames.length) {
          throw new Error(`「${item.source.file.name}」の映像を最後まで読み取れませんでした。`);
        }
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
