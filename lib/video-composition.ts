export const VIDEO_COMPOSITION_MAX_SOURCES = 5;
export const VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE = 2;
export const VIDEO_COMPOSITION_MAX_TOTAL_SOURCE_BYTES = 500 * 1024 * 1024;
export const VIDEO_COMPOSITION_MAX_AGGREGATE_SOURCE_DURATION_SECONDS = 300;
export const VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS = 90;
export const VIDEO_COMPOSITION_FRAME_RATE = 30;
export const VIDEO_COMPOSITION_OUTPUT_WIDTH = 1080;
export const VIDEO_COMPOSITION_OUTPUT_HEIGHT = 1920;

const TIME_EPSILON = 1e-7;
const MAX_TRANSITION_DURATION_SECONDS = 1.5;

export type VideoCompositionTransitionType =
  | "cut"
  | "crossfade"
  | "fade-black"
  | "fade-white";

export const VIDEO_COMPOSITION_DEFAULT_TRANSITION_DURATIONS = {
  cut: 0,
  crossfade: 0.3,
  "fade-black": 0.4,
  "fade-white": 0.4,
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

export type VideoCompositionFrameTransition = Readonly<{
  boundaryIndex: number;
  type: Exclude<VideoCompositionTransitionType, "cut">;
  phase: "crossfade" | "fade-out" | "fade-in";
  /** Linear progress from 0 to 1 within this phase. */
  progress: number;
  from: Readonly<{
    sourceId: string;
    sourceIndex: number;
    clipIndex: number;
    sourceTime: number;
  }>;
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

export function normalizeVideoCompositionTransition(
  transition:
    | VideoCompositionTransitionType
    | Partial<VideoCompositionTransition>
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
}: {
  sources: readonly VideoCompositionSourceDescriptor[];
  transition?:
    | VideoCompositionTransitionType
    | Partial<VideoCompositionTransition>;
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
      if (clip.end - clip.start <= TIME_EPSILON) {
        throw new RangeError("Every video clip must have a positive duration.");
      }
      if (clip.end > source.duration + 0.001) {
        throw new RangeError("A video clip cannot extend beyond its source duration.");
      }
      if (clip.start < previousEnd - TIME_EPSILON) {
        throw new RangeError(
          "Clips within each video must be chronological and non-overlapping.",
        );
      }

      const duration = roundTimelineSeconds(clip.end - clip.start);
      const planned: VideoCompositionPlannedClip = {
        sourceId: id,
        sourceIndex,
        clipIndex,
        globalClipIndex: plannedClips.length,
        start: roundTimelineSeconds(clip.start),
        end: roundTimelineSeconds(clip.end),
        duration,
        editedStart: roundTimelineSeconds(editedCursor),
        editedEnd: roundTimelineSeconds(editedCursor + duration),
      };
      clips.push(planned);
      plannedClips.push(planned);
      editedCursor += duration;
      previousEnd = clip.end;
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
  if (editedCursor > VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS + TIME_EPSILON) {
    throw new RangeError("The edited video must be 90 seconds or less.");
  }

  const boundaries: VideoCompositionBoundary[] = plannedClips
    .slice(1)
    .map((incoming, index) => {
      const outgoing = plannedClips[index];
      return {
        index,
        outgoingClipIndex: outgoing.globalClipIndex,
        incomingClipIndex: incoming.globalClipIndex,
        editedTime: incoming.editedStart,
        transition: {
          type: normalizedTransition.type,
          duration:
            normalizedTransition.type === "cut"
              ? 0
              : Math.min(
                  normalizedTransition.duration,
                  outgoing.duration,
                  incoming.duration,
                ),
        },
      };
    });

  return {
    sources: plannedSources,
    clips: plannedClips,
    boundaries,
    transition: normalizedTransition,
    duration: roundTimelineSeconds(editedCursor),
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

function transitionForFrame(
  plan: VideoCompositionPlan,
  clip: VideoCompositionPlannedClip,
  editedTime: number,
  frameDuration: number,
): VideoCompositionFrameTransition | null {
  const incomingBoundary = plan.boundaries[clip.globalClipIndex - 1];
  const outgoingBoundary = plan.boundaries[clip.globalClipIndex];

  if (
    incomingBoundary &&
    incomingBoundary.transition.type === "crossfade" &&
    incomingBoundary.transition.duration > TIME_EPSILON
  ) {
    const localTime = editedTime - clip.editedStart;
    if (localTime < incomingBoundary.transition.duration - TIME_EPSILON) {
      const outgoing = plan.clips[incomingBoundary.outgoingClipIndex];
      return {
        boundaryIndex: incomingBoundary.index,
        type: "crossfade",
        phase: "crossfade",
        progress: clamp01(
          (localTime + frameDuration) / incomingBoundary.transition.duration,
        ),
        from: {
          sourceId: outgoing.sourceId,
          sourceIndex: outgoing.sourceIndex,
          clipIndex: outgoing.clipIndex,
          sourceTime: Math.max(
            outgoing.start,
            outgoing.end - frameDuration / 2,
          ),
        },
      };
    }
  }

  if (
    outgoingBoundary &&
    (outgoingBoundary.transition.type === "fade-black" ||
      outgoingBoundary.transition.type === "fade-white") &&
    outgoingBoundary.transition.duration > TIME_EPSILON
  ) {
    const halfDuration = outgoingBoundary.transition.duration / 2;
    const phaseStart = clip.editedEnd - halfDuration;
    if (editedTime + frameDuration > phaseStart + TIME_EPSILON) {
      return {
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
      };
    }
  }

  if (
    incomingBoundary &&
    (incomingBoundary.transition.type === "fade-black" ||
      incomingBoundary.transition.type === "fade-white") &&
    incomingBoundary.transition.duration > TIME_EPSILON
  ) {
    const halfDuration = incomingBoundary.transition.duration / 2;
    const localTime = editedTime - clip.editedStart;
    if (localTime < halfDuration - TIME_EPSILON) {
      const outgoing = plan.clips[incomingBoundary.outgoingClipIndex];
      return {
        boundaryIndex: incomingBoundary.index,
        type: incomingBoundary.transition.type,
        phase: "fade-in",
        progress: clamp01((localTime + frameDuration) / halfDuration),
        from: {
          sourceId: outgoing.sourceId,
          sourceIndex: outgoing.sourceIndex,
          clipIndex: outgoing.clipIndex,
          sourceTime: Math.max(
            outgoing.start,
            outgoing.end - frameDuration / 2,
          ),
        },
      };
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
      editedTime >= plan.clips[clipIndex].editedEnd - TIME_EPSILON
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
