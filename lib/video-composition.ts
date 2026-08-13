export const VIDEO_COMPOSITION_MAX_SOURCES = 5;
export const VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE = 2;
export const VIDEO_COMPOSITION_MAX_TOTAL_SOURCE_BYTES = 500 * 1024 * 1024;
export const VIDEO_COMPOSITION_MAX_AGGREGATE_SOURCE_DURATION_SECONDS = 300;
export const VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS = 90;
export const VIDEO_COMPOSITION_FRAME_RATE = 30;
export const VIDEO_COMPOSITION_OUTPUT_WIDTH = 1080;
export const VIDEO_COMPOSITION_OUTPUT_HEIGHT = 1920;
/**
 * Browser media metadata can round the duration up by a fraction of a frame
 * compared with the packet-accurate duration used by the exporter. Only the
 * last selected clip may use this tolerance; larger or interior overshoots
 * remain invalid.
 */
export const VIDEO_COMPOSITION_SOURCE_END_TOLERANCE_SECONDS = 0.125;

const TIME_EPSILON = 1e-7;
const MAX_TRANSITION_DURATION_SECONDS = 1.5;

export type VideoCompositionTransitionType =
  | "cut"
  | "crossfade"
  | "fade-black"
  | "fade-white"
  | "flash"
  | "wipe-left"
  | "slide-left"
  | "zoom-dissolve";

export const VIDEO_COMPOSITION_DEFAULT_TRANSITION_DURATIONS = {
  cut: 0,
  crossfade: 0.3,
  "fade-black": 0.4,
  "fade-white": 0.4,
  flash: 0.22,
  "wipe-left": 0.38,
  "slide-left": 0.42,
  "zoom-dissolve": 0.45,
} as const satisfies Record<VideoCompositionTransitionType, number>;

export type VideoCompositionClip = Readonly<{
  start: number;
  end: number;
}>;

export type VideoCompositionSourceDescriptor = Readonly<{
  id: string;
  fileSize: number;
  duration: number;
  clips: readonly VideoCompositionClip[];
}>;

export type VideoCompositionTransition = Readonly<{
  type: VideoCompositionTransitionType;
  duration: number;
}>;

export type VideoCompositionTransitionInput =
  | VideoCompositionTransitionType
  | Partial<VideoCompositionTransition>;

export type VideoCompositionBoundaryTransitionInput =
  | VideoCompositionTransitionInput
  | null
  | undefined;

export type VideoCompositionSource = Readonly<{
  id: string;
  sourceIndex: number;
  fileSize: number;
  duration: number;
  clips: readonly VideoCompositionPlannedClip[];
}>;

export type VideoCompositionPlannedClip = Readonly<{
  sourceId: string;
  sourceIndex: number;
  clipIndex: number;
  globalClipIndex: number;
  start: number;
  end: number;
  duration: number;
  editedStart: number;
  editedEnd: number;
}>;

export type VideoCompositionBoundary = Readonly<{
  index: number;
  outgoingClipIndex: number;
  incomingClipIndex: number;
  editedTime: number;
  transition: VideoCompositionTransition;
}>;

export type VideoCompositionClipTransitionWindows = Readonly<{
  incomingSeconds: number;
  outgoingSeconds: number;
}>;

export type VideoCompositionPlan = Readonly<{
  sources: readonly VideoCompositionSource[];
  clips: readonly VideoCompositionPlannedClip[];
  boundaries: readonly VideoCompositionBoundary[];
  transition: VideoCompositionTransition;
  duration: number;
  aggregateSourceDuration: number;
  totalSourceBytes: number;
  width: typeof VIDEO_COMPOSITION_OUTPUT_WIDTH;
  height: typeof VIDEO_COMPOSITION_OUTPUT_HEIGHT;
  frameRate: typeof VIDEO_COMPOSITION_FRAME_RATE;
}>;

export type VideoCompositionFrameTransitionPhase =
  | "crossfade"
  | "fade-out"
  | "fade-in"
  | "wipe"
  | "slide"
  | "zoom-dissolve";

export type VideoCompositionFrameTransition = Readonly<{
  boundaryIndex: number;
  type: Exclude<VideoCompositionTransitionType, "cut">;
  phase: VideoCompositionFrameTransitionPhase;
  /** Linear progress from 0 to 1 within this phase. */
  progress: number;
  /**
   * Pure, normalized drawing metadata shared by the live preview and Canvas
   * exporter. Horizontal offsets are expressed as a fraction of frame width.
   */
  visual: VideoCompositionTransitionVisual;
  from: Readonly<{
    sourceId: string;
    sourceIndex: number;
    clipIndex: number;
    sourceTime: number;
  }>;
}>;

export type VideoCompositionTransitionVisual = Readonly<{
  incomingOpacity: number;
  outgoingOpacity: number;
  incomingScale: number;
  outgoingScale: number;
  incomingOffsetX: number;
  outgoingOffsetX: number;
  /** 0 means hidden and 1 means fully revealed from the right edge. */
  incomingReveal: number;
  overlayColor: "#000" | "#fff" | null;
  overlayOpacity: number;
}>;

export type VideoCompositionFrameScheduleEntry = Readonly<{
  frameIndex: number;
  editedTime: number;
  duration: number;
  sourceId: string;
  sourceIndex: number;
  clipIndex: number;
  globalClipIndex: number;
  sourceTime: number;
  transition: VideoCompositionFrameTransition | null;
}>;

function finiteNonNegative(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}
function finitePositive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number.`);
  }
  return value;
}

function roundTimelineSeconds(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function videoCompositionTransitionUsesOverlap(
  type: VideoCompositionTransitionType,
) {
  return (
    type === "crossfade" ||
    type === "wipe-left" ||
    type === "slide-left" ||
    type === "zoom-dissolve"
  );
}

function transitionWindowSeconds(transition: VideoCompositionTransition) {
  if (transition.type === "cut") return 0;
  return videoCompositionTransitionUsesOverlap(transition.type)
    ? transition.duration
    : transition.duration / 2;
}

/**
 * Returns the exact portions of a clip occupied by its neighboring effects.
 * The planner guarantees their sum never exceeds the clip duration. Preview
 * and export can therefore use the same collision-free timing metadata.
 */
export function getVideoCompositionClipTransitionWindows(
  plan: Pick<VideoCompositionPlan, "clips" | "boundaries">,
  globalClipIndex: number,
): VideoCompositionClipTransitionWindows {
  if (!Number.isInteger(globalClipIndex) || !plan.clips[globalClipIndex]) {
    throw new RangeError("Unknown video composition clip index.");
  }
  const incoming = plan.boundaries[globalClipIndex - 1]?.transition;
  const outgoing = plan.boundaries[globalClipIndex]?.transition;
  return {
    incomingSeconds: incoming ? transitionWindowSeconds(incoming) : 0,
    outgoingSeconds: outgoing ? transitionWindowSeconds(outgoing) : 0,
  };
}

export function normalizeVideoCompositionTransition(
  transition:
    | VideoCompositionTransitionInput
    | undefined = "cut",
): VideoCompositionTransition {
  const type = typeof transition === "string" ? transition : transition.type ?? "cut";
  if (!(type in VIDEO_COMPOSITION_DEFAULT_TRANSITION_DURATIONS)) {
    throw new RangeError("Unsupported video transition.");
  }
  const requestedDuration =
    typeof transition === "string" || transition.duration === undefined
      ? VIDEO_COMPOSITION_DEFAULT_TRANSITION_DURATIONS[type]
      : transition.duration;
  finiteNonNegative(requestedDuration, "Transition duration");
  if (requestedDuration > MAX_TRANSITION_DURATION_SECONDS) {
    throw new RangeError(
      `Transition duration must be ${MAX_TRANSITION_DURATION_SECONDS} seconds or less.`,
    );
  }
  return {
    type,
    duration: type === "cut" ? 0 : requestedDuration,
  };
}

/**
 * Validates the complete multi-video contract without reordering user input.
 * Source order is presentation order. Clips are required to already be in
 * chronological, non-overlapping order so a malformed request can never make
 * a video jump backwards silently.
 */
export function createVideoCompositionPlan({
  sources,
  transition,
  boundaryTransitions,
}: {
  sources: readonly VideoCompositionSourceDescriptor[];
  transition?: VideoCompositionTransitionInput;
  /**
   * Optional overrides in finished-video boundary order. Missing entries use
   * the global transition. Extra entries are rejected so a stale UI mapping
   * cannot silently style the wrong boundary.
   */
  boundaryTransitions?: readonly VideoCompositionBoundaryTransitionInput[];
}): VideoCompositionPlan {
  if (sources.length < 1 || sources.length > VIDEO_COMPOSITION_MAX_SOURCES) {
    throw new RangeError(
      `Video composition requires between 1 and ${VIDEO_COMPOSITION_MAX_SOURCES} sources.`,
    );
  }

  const normalizedTransition = normalizeVideoCompositionTransition(transition);
  const ids = new Set<string>();
  const plannedSources: VideoCompositionSource[] = [];
  const plannedClips: VideoCompositionPlannedClip[] = [];
  let editedCursor = 0;
  let totalSourceBytes = 0;
  let aggregateSourceDuration = 0;

  sources.forEach((source, sourceIndex) => {
    const id = source.id.trim();
    if (!id || ids.has(id)) {
      throw new RangeError("Each video source must have a unique non-empty id.");
    }
    ids.add(id);
    finiteNonNegative(source.fileSize, `Source ${sourceIndex + 1} file size`);
    finitePositive(source.duration, `Source ${sourceIndex + 1} duration`);
    if (
      source.clips.length < 1 ||
      source.clips.length > VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE
    ) {
      throw new RangeError(
        `Each video source requires between 1 and ${VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE} clips.`,
      );
    }

    let previousEnd = -1;
    const clips: VideoCompositionPlannedClip[] = [];
    source.clips.forEach((clip, clipIndex) => {
      finiteNonNegative(clip.start, `Source ${sourceIndex + 1} clip start`);
      finitePositive(clip.end, `Source ${sourceIndex + 1} clip end`);
      const sourceEndOvershoot = clip.end - source.duration;
      const isLastSelectedClip = clipIndex === source.clips.length - 1;
      const reconciledEnd =
        sourceEndOvershoot > TIME_EPSILON &&
        isLastSelectedClip &&
        sourceEndOvershoot <=
          VIDEO_COMPOSITION_SOURCE_END_TOLERANCE_SECONDS + TIME_EPSILON
          ? source.duration
          : clip.end;
      if (reconciledEnd - clip.start <= TIME_EPSILON) {
        throw new RangeError("Every video clip must have a positive duration.");
      }
      if (reconciledEnd > source.duration + TIME_EPSILON) {
        throw new RangeError("A video clip cannot extend beyond its source duration.");
      }
      if (clip.start < previousEnd - TIME_EPSILON) {
        throw new RangeError(
          "Clips within each video must be chronological and non-overlapping.",
        );
      }

      const duration = roundTimelineSeconds(reconciledEnd - clip.start);
      const planned: VideoCompositionPlannedClip = {
        sourceId: id,
        sourceIndex,
        clipIndex,
        globalClipIndex: plannedClips.length,
        start: roundTimelineSeconds(clip.start),
        end: roundTimelineSeconds(reconciledEnd),
        duration,
        editedStart: roundTimelineSeconds(editedCursor),
        editedEnd: roundTimelineSeconds(editedCursor + duration),
      };
      clips.push(planned);
      plannedClips.push(planned);
      editedCursor += duration;
      previousEnd = reconciledEnd;
    });

    totalSourceBytes += source.fileSize;
    aggregateSourceDuration += source.duration;
    plannedSources.push({
      id,
      sourceIndex,
      fileSize: source.fileSize,
      duration: source.duration,
      clips,
    });
  });

  if (totalSourceBytes > VIDEO_COMPOSITION_MAX_TOTAL_SOURCE_BYTES) {
    throw new RangeError("The combined source files must be 500MB or less.");
  }
  if (
    aggregateSourceDuration >
    VIDEO_COMPOSITION_MAX_AGGREGATE_SOURCE_DURATION_SECONDS + TIME_EPSILON
  ) {
    throw new RangeError("The combined source duration must be 300 seconds or less.");
  }
  const boundaryCount = Math.max(0, plannedClips.length - 1);
  if ((boundaryTransitions?.length ?? 0) > boundaryCount) {
    throw new RangeError(
      `Boundary transition overrides cannot exceed ${boundaryCount}.`,
    );
  }

  const requestedBoundaries: VideoCompositionBoundary[] = plannedClips
    .slice(1)
    .map((incoming, index) => {
      const outgoing = plannedClips[index];
      const override = boundaryTransitions?.[index];
      const boundaryTransition =
        override === null || override === undefined
          ? normalizedTransition
          : normalizeVideoCompositionTransition(
              typeof override === "string"
                ? override
                : override.type === undefined
                  ? { ...normalizedTransition, ...override }
                  : override,
            );
      return {
        index,
        outgoingClipIndex: outgoing.globalClipIndex,
        incomingClipIndex: incoming.globalClipIndex,
        editedTime: incoming.editedStart,
        transition: {
          type: boundaryTransition.type,
          duration:
            boundaryTransition.type === "cut"
              ? 0
              : Math.min(
                  boundaryTransition.duration,
                  outgoing.duration,
                  incoming.duration,
                ),
        },
      };
    });

  // A short middle clip can be touched by both neighboring effects. Allocate
  // those windows together instead of clamping each boundary independently;
  // otherwise the incoming effect wins the same frames and the outgoing
  // effect collapses into a one-frame flash.
  const allocatedDurations = requestedBoundaries.map(
    (boundary) => boundary.transition.duration,
  );
  // A boundary participates in two adjacent clip constraints. Iterate to a
  // fixed point so shrinking it for a later clip can never re-break an earlier
  // one through ordering or rounding.
  for (let pass = 0; pass < plannedClips.length; pass += 1) {
    let changed = false;
    plannedClips.forEach((clip, clipIndex) => {
      const incomingBoundaryIndex = clipIndex - 1;
      const outgoingBoundaryIndex = clipIndex;
      const incoming = requestedBoundaries[incomingBoundaryIndex];
      const outgoing = requestedBoundaries[outgoingBoundaryIndex];
      const incomingWindow = incoming
        ? transitionWindowSeconds({
            ...incoming.transition,
            duration: allocatedDurations[incomingBoundaryIndex],
          })
        : 0;
      const outgoingWindow = outgoing
        ? transitionWindowSeconds({
            ...outgoing.transition,
            duration: allocatedDurations[outgoingBoundaryIndex],
          })
        : 0;
      const occupied = incomingWindow + outgoingWindow;
      if (occupied <= clip.duration + TIME_EPSILON || occupied <= TIME_EPSILON) {
        return;
      }
      const scale = clip.duration / occupied;
      if (incoming) allocatedDurations[incomingBoundaryIndex] *= scale;
      if (outgoing) allocatedDurations[outgoingBoundaryIndex] *= scale;
      changed = true;
    });
    if (!changed) break;
  }

  const allocatedBoundaries = requestedBoundaries.map((boundary, index) => ({
    ...boundary,
    transition: {
      ...boundary.transition,
      duration: roundTimelineSeconds(allocatedDurations[index]),
    },
  }));

  // Blend-style effects are true overlaps: the outgoing and incoming source
  // clocks both advance through the boundary. Fade-to-colour effects retain
  // the established full-length timeline because their halves live on either
  // side of a hard boundary.
  const timelineClips: VideoCompositionPlannedClip[] = [];
  plannedClips.forEach((clip, index) => {
    const previous = timelineClips.at(-1);
    const incomingBoundary = allocatedBoundaries[index - 1];
    const overlap =
      incomingBoundary &&
      videoCompositionTransitionUsesOverlap(incomingBoundary.transition.type)
        ? incomingBoundary.transition.duration
        : 0;
    const editedStart = roundTimelineSeconds(
      previous ? previous.editedEnd - overlap : 0,
    );
    timelineClips.push({
      ...clip,
      editedStart,
      editedEnd: roundTimelineSeconds(editedStart + clip.duration),
    });
  });
  const boundaries: VideoCompositionBoundary[] = allocatedBoundaries.map(
    (boundary) => ({
      ...boundary,
      editedTime: timelineClips[boundary.incomingClipIndex].editedStart,
    }),
  );
  const duration = timelineClips.at(-1)?.editedEnd ?? 0;
  if (duration > VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS + TIME_EPSILON) {
    throw new RangeError("The edited video must be 90 seconds or less.");
  }
  const timelineSources = plannedSources.map((source) => ({
    ...source,
    clips: source.clips.map((clip) => timelineClips[clip.globalClipIndex]),
  }));

  return {
    sources: timelineSources,
    clips: timelineClips,
    boundaries,
    transition: normalizedTransition,
    duration,
    aggregateSourceDuration: roundTimelineSeconds(aggregateSourceDuration),
    totalSourceBytes,
    width: VIDEO_COMPOSITION_OUTPUT_WIDTH,
    height: VIDEO_COMPOSITION_OUTPUT_HEIGHT,
    frameRate: VIDEO_COMPOSITION_FRAME_RATE,
  };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number) {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
}

/**
 * Maps schedule progress to a renderer-independent visual recipe. Preview
 * layers can apply these normalized values directly, while the exporter maps
 * them to Canvas pixels. Keeping this pure prevents preview/export drift.
 */
export function getVideoCompositionTransitionVisual(
  type: Exclude<VideoCompositionTransitionType, "cut">,
  phase: VideoCompositionFrameTransitionPhase,
  progress: number,
): VideoCompositionTransitionVisual {
  const eased = smoothstep(progress);
  const base: VideoCompositionTransitionVisual = {
    incomingOpacity: 1,
    outgoingOpacity: 1,
    incomingScale: 1,
    outgoingScale: 1,
    incomingOffsetX: 0,
    outgoingOffsetX: 0,
    incomingReveal: 1,
    overlayColor: null,
    overlayOpacity: 0,
  };

  if (type === "crossfade" && phase === "crossfade") {
    return { ...base, incomingOpacity: eased };
  }
  if (type === "wipe-left" && phase === "wipe") {
    return { ...base, incomingReveal: eased };
  }
  if (type === "slide-left" && phase === "slide") {
    return {
      ...base,
      incomingOffsetX: 1 - eased,
      outgoingOffsetX: -0.18 * eased,
    };
  }
  if (type === "zoom-dissolve" && phase === "zoom-dissolve") {
    return {
      ...base,
      incomingOpacity: eased,
      incomingScale: 1.055 - 0.055 * eased,
      outgoingOpacity: 1 - 0.28 * eased,
      outgoingScale: 1 + 0.035 * eased,
    };
  }
  if (
    (type === "fade-black" || type === "fade-white" || type === "flash") &&
    (phase === "fade-out" || phase === "fade-in")
  ) {
    const peakOpacity = type === "flash" ? 0.82 : 1;
    return {
      ...base,
      overlayColor: type === "fade-black" ? "#000" : "#fff",
      overlayOpacity:
        peakOpacity * (phase === "fade-out" ? eased : 1 - eased),
    };
  }
  return base;
}

function createFrameTransition(
  options: Omit<VideoCompositionFrameTransition, "visual">,
): VideoCompositionFrameTransition {
  return {
    ...options,
    visual: getVideoCompositionTransitionVisual(
      options.type,
      options.phase,
      options.progress,
    ),
  };
}

function transitionForFrame(
  plan: VideoCompositionPlan,
  clip: VideoCompositionPlannedClip,
  editedTime: number,
  frameDuration: number,
): VideoCompositionFrameTransition | null {
  const incomingBoundary = plan.boundaries[clip.globalClipIndex - 1];
  const outgoingBoundary = plan.boundaries[clip.globalClipIndex];

  const incomingBlendPhase = incomingBoundary
    ? incomingBoundary.transition.type === "crossfade"
      ? "crossfade"
      : incomingBoundary.transition.type === "wipe-left"
        ? "wipe"
        : incomingBoundary.transition.type === "slide-left"
          ? "slide"
          : incomingBoundary.transition.type === "zoom-dissolve"
            ? "zoom-dissolve"
            : null
    : null;
  if (
    incomingBoundary &&
    incomingBlendPhase &&
    incomingBoundary.transition.duration > TIME_EPSILON
  ) {
    const localTime = editedTime - clip.editedStart;
    if (localTime < incomingBoundary.transition.duration - TIME_EPSILON) {
      const outgoing = plan.clips[incomingBoundary.outgoingClipIndex];
      return createFrameTransition({
        boundaryIndex: incomingBoundary.index,
        type: incomingBoundary.transition.type as
          | "crossfade"
          | "wipe-left"
          | "slide-left"
          | "zoom-dissolve",
        phase: incomingBlendPhase,
        progress: clamp01(
          (localTime + frameDuration) / incomingBoundary.transition.duration,
        ),
        from: {
          sourceId: outgoing.sourceId,
          sourceIndex: outgoing.sourceIndex,
          clipIndex: outgoing.clipIndex,
          sourceTime: Math.min(
            outgoing.end,
            outgoing.start + Math.max(0, editedTime - outgoing.editedStart),
          ),
        },
      });
    }
  }

  if (
    outgoingBoundary &&
    (outgoingBoundary.transition.type === "fade-black" ||
      outgoingBoundary.transition.type === "fade-white" ||
      outgoingBoundary.transition.type === "flash") &&
    outgoingBoundary.transition.duration > TIME_EPSILON
  ) {
    const halfDuration = outgoingBoundary.transition.duration / 2;
    const phaseStart = clip.editedEnd - halfDuration;
    if (editedTime + frameDuration > phaseStart + TIME_EPSILON) {
      return createFrameTransition({
        boundaryIndex: outgoingBoundary.index,
        type: outgoingBoundary.transition.type,
        phase: "fade-out",
        progress: clamp01(
          (editedTime + frameDuration - phaseStart) / halfDuration,
        ),
        from: {
          sourceId: clip.sourceId,
          sourceIndex: clip.sourceIndex,
          clipIndex: clip.clipIndex,
          sourceTime: Math.min(clip.end, clip.start + (editedTime - clip.editedStart)),
        },
      });
    }
  }

  if (
    incomingBoundary &&
    (incomingBoundary.transition.type === "fade-black" ||
      incomingBoundary.transition.type === "fade-white" ||
      incomingBoundary.transition.type === "flash") &&
    incomingBoundary.transition.duration > TIME_EPSILON
  ) {
    const halfDuration = incomingBoundary.transition.duration / 2;
    const localTime = editedTime - clip.editedStart;
    if (localTime < halfDuration - TIME_EPSILON) {
      const outgoing = plan.clips[incomingBoundary.outgoingClipIndex];
      return createFrameTransition({
        boundaryIndex: incomingBoundary.index,
        type: incomingBoundary.transition.type,
        phase: "fade-in",
        progress: clamp01((localTime + frameDuration) / halfDuration),
        from: {
          sourceId: outgoing.sourceId,
          sourceIndex: outgoing.sourceIndex,
          clipIndex: outgoing.clipIndex,
          sourceTime: outgoing.end,
        },
      });
    }
  }

  return null;
}

/** A deterministic frame schedule shared by preview and final export. */
export function buildVideoCompositionFrameSchedule(
  plan: VideoCompositionPlan,
): VideoCompositionFrameScheduleEntry[] {
  if (plan.clips.length === 0 || plan.duration <= 0) {
    throw new RangeError("A video composition requires at least one playable clip.");
  }
  const frameDuration = 1 / plan.frameRate;
  const frameCount = Math.max(
    1,
    Math.ceil(plan.duration * plan.frameRate - TIME_EPSILON),
  );
  let clipIndex = 0;

  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const editedTime = frameIndex * frameDuration;
    while (
      clipIndex < plan.clips.length - 1 &&
      editedTime >= plan.clips[clipIndex + 1].editedStart - TIME_EPSILON
    ) {
      clipIndex += 1;
    }
    const clip = plan.clips[clipIndex];
    const duration = Math.min(frameDuration, plan.duration - editedTime);
    const sourceTime = Math.min(
      clip.end,
      clip.start + Math.max(0, editedTime - clip.editedStart),
    );
    return {
      frameIndex,
      editedTime,
      duration,
      sourceId: clip.sourceId,
      sourceIndex: clip.sourceIndex,
      clipIndex: clip.clipIndex,
      globalClipIndex: clip.globalClipIndex,
      sourceTime,
      transition: transitionForFrame(plan, clip, editedTime, duration),
    };
  });
}
