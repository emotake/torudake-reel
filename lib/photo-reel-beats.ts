import type { PhotoReelPlan, PhotoReelSlide } from "./photo-reel";

export type PhotoReelBeatCandidate = Readonly<{
  time: number;
  strength: number;
}>;

export type PhotoReelBeatSnapOptions = Readonly<{
  maximumSnapSeconds?: number;
  minimumSlideDurationSeconds?: number;
  minimumStrength?: number;
}>;

export type PhotoReelAudioBeatAnalysis = Readonly<{
  duration: number;
  beats: readonly PhotoReelBeatCandidate[];
}>;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Finds strong local audio onsets from PCM entirely on-device. It deliberately
 * returns candidates rather than inventing one constant BPM for irregular BGM.
 */
export function detectPhotoReelBeatCandidates(
  channels: readonly Float32Array[],
  sampleRate: number,
  maximumDurationSeconds = Number.POSITIVE_INFINITY,
): PhotoReelBeatCandidate[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a finite positive number.");
  }
  if (
    (!Number.isFinite(maximumDurationSeconds) &&
      maximumDurationSeconds !== Number.POSITIVE_INFINITY) ||
    maximumDurationSeconds <= 0
  ) {
    throw new RangeError("maximumDurationSeconds must be positive.");
  }
  const availableFrames = channels.reduce(
    (maximum, channel) => Math.max(maximum, channel.length),
    0,
  );
  const frameCount = Math.min(
    availableFrames,
    Number.isFinite(maximumDurationSeconds)
      ? Math.floor(maximumDurationSeconds * sampleRate)
      : availableFrames,
  );
  if (channels.length === 0 || frameCount < sampleRate * 0.12) return [];

  const windowFrames = Math.max(1, Math.round(sampleRate * 0.02));
  const levels: number[] = [];
  for (let offset = 0; offset < frameCount; offset += windowFrames) {
    const end = Math.min(frameCount, offset + windowFrames);
    let sumSquares = 0;
    let sampleCount = 0;
    for (const channel of channels) {
      const channelEnd = Math.min(channel.length, end);
      for (let frame = offset; frame < channelEnd; frame += 1) {
        const sample = Number.isFinite(channel[frame]) ? channel[frame] : 0;
        sumSquares += sample * sample;
        sampleCount += 1;
      }
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    levels.push(Math.log1p(rms * 32));
  }
  const maximumLevel = Math.max(...levels);
  if (maximumLevel < Math.log1p(0.004 * 32)) return [];

  const novelty = levels.map((level, index) => {
    if (index < 2) return 0;
    const baseline =
      levels
        .slice(Math.max(0, index - 8), index)
        .reduce((total, value) => total + value, 0) /
      Math.min(8, index);
    return Math.max(0, level - baseline);
  });
  const nonZeroNovelty = novelty.filter((value) => value > 0);
  const globalMedian = median(nonZeroNovelty);
  const deviations = nonZeroNovelty.map((value) =>
    Math.abs(value - globalMedian),
  );
  const globalThreshold = Math.max(
    0.035,
    globalMedian + median(deviations) * 2.2,
  );
  const raw: Array<{ time: number; novelty: number }> = [];
  for (let index = 2; index < novelty.length - 1; index += 1) {
    const local = novelty.slice(Math.max(0, index - 18), index);
    const localThreshold = Math.max(
      globalThreshold,
      median(local) * 1.75,
    );
    if (
      novelty[index] >= localThreshold &&
      novelty[index] >= novelty[index - 1] &&
      novelty[index] > novelty[index + 1]
    ) {
      raw.push({
        time: ((index + 0.5) * windowFrames) / sampleRate,
        novelty: novelty[index],
      });
    }
  }
  if (raw.length === 0) return [];
  const maximumNovelty = Math.max(...raw.map((candidate) => candidate.novelty));
  const selected: typeof raw = [];
  for (const candidate of raw) {
    const previous = selected.at(-1);
    if (previous && candidate.time - previous.time < 0.22) {
      if (candidate.novelty > previous.novelty) {
        selected[selected.length - 1] = candidate;
      }
      continue;
    }
    selected.push(candidate);
  }

  return selected.map((candidate) => ({
    time: Math.round(candidate.time * 1_000) / 1_000,
    strength: clamp(candidate.novelty / maximumNovelty),
  }));
}

function getAudioContextConstructor() {
  if (typeof AudioContext !== "undefined") return AudioContext;
  if (typeof window === "undefined") return null;
  return (
    window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }
  ).webkitAudioContext ?? null;
}

/**
 * Decodes a selected BGM only long enough to extract onset times, then closes
 * the context so its decoder/mixer memory can be reclaimed on iPhone.
 */
export async function analyzePhotoReelAudioFileBeats(
  file: File,
  maximumDurationSeconds: number,
  signal?: AbortSignal,
): Promise<PhotoReelAudioBeatAnalysis | null> {
  if (!(file instanceof File)) throw new TypeError("file must be a File.");
  if (!Number.isFinite(maximumDurationSeconds) || maximumDurationSeconds <= 0) {
    throw new RangeError("maximumDurationSeconds must be positive.");
  }
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) return null;
  let context: AudioContext | null = null;
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    context = new AudioContextConstructor();
    const bytes = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const decoded = await context.decodeAudioData(bytes);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const duration = Math.max(0, decoded.duration);
    return {
      duration,
      beats: detectPhotoReelBeatCandidates(
        Array.from(
          { length: decoded.numberOfChannels },
          (_, channel) => decoded.getChannelData(channel),
        ),
        decoded.sampleRate,
        Math.min(duration, maximumDurationSeconds),
      ),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

export function repeatPhotoReelBeatCandidates(
  beats: readonly PhotoReelBeatCandidate[],
  sourceDuration: number,
  targetDuration: number,
): PhotoReelBeatCandidate[] {
  if (
    !Number.isFinite(sourceDuration) ||
    sourceDuration <= 0 ||
    !Number.isFinite(targetDuration) ||
    targetDuration <= 0 ||
    beats.length === 0
  ) {
    return [];
  }
  const normalizedBeats = beats.filter(
    (beat) =>
      Number.isFinite(beat.time) &&
      beat.time > 0 &&
      beat.time < sourceDuration &&
      Number.isFinite(beat.strength) &&
      beat.strength >= 0,
  );
  if (normalizedBeats.length === 0) return [];
  const repeated: PhotoReelBeatCandidate[] = [];
  const repeatCount = Math.max(1, Math.ceil(targetDuration / sourceDuration));
  for (let repeat = 0; repeat < repeatCount; repeat += 1) {
    const offset = repeat * sourceDuration;
    for (const beat of normalizedBeats) {
      const time = beat.time + offset;
      if (time <= 0 || time >= targetDuration) continue;
      repeated.push({ time, strength: beat.strength });
    }
  }
  return repeated;
}

/** Snaps only nearby slide boundaries; the first and final frame never move. */
export function snapPhotoReelPlanToBeats(
  plan: PhotoReelPlan,
  beats: readonly PhotoReelBeatCandidate[],
  options: PhotoReelBeatSnapOptions = {},
): PhotoReelPlan {
  if (plan.slides.length < 2 || beats.length === 0) return plan;
  const maximumSnapSeconds = options.maximumSnapSeconds ?? 0.18;
  const minimumSlideDurationSeconds =
    options.minimumSlideDurationSeconds ?? 0.72;
  const minimumStrength = options.minimumStrength ?? 0.12;
  if (!Number.isFinite(maximumSnapSeconds) || maximumSnapSeconds < 0) {
    throw new RangeError("maximumSnapSeconds must be finite and non-negative.");
  }
  if (
    !Number.isFinite(minimumSlideDurationSeconds) ||
    minimumSlideDurationSeconds <= 0
  ) {
    throw new RangeError("minimumSlideDurationSeconds must be positive.");
  }

  const normalizedBeats = beats
    .filter(
      (beat) =>
        Number.isFinite(beat.time) &&
        beat.time > 0 &&
        beat.time < plan.duration &&
        Number.isFinite(beat.strength) &&
        beat.strength >= minimumStrength,
    )
    .sort((left, right) => left.time - right.time);
  if (normalizedBeats.length === 0) return plan;

  const boundaries = [0];
  const usedBeats = new Set<number>();
  for (let index = 1; index < plan.slides.length; index += 1) {
    const original = plan.slides[index].start;
    const previous = boundaries[index - 1];
    const remainingSlides = plan.slides.length - index;
    const minimum = previous + minimumSlideDurationSeconds;
    const maximum =
      plan.duration - remainingSlides * minimumSlideDurationSeconds;
    const candidates = normalizedBeats
      .map((beat, beatIndex) => ({ beat, beatIndex }))
      .filter(
        ({ beat, beatIndex }) =>
          !usedBeats.has(beatIndex) &&
          beat.time >= minimum &&
          beat.time <= maximum &&
          Math.abs(beat.time - original) <= maximumSnapSeconds + 0.001,
      )
      .sort((left, right) => {
        const leftDistance = Math.abs(left.beat.time - original);
        const rightDistance = Math.abs(right.beat.time - original);
        const leftScore =
          left.beat.strength -
          (leftDistance / Math.max(maximumSnapSeconds, 0.001)) * 0.28;
        const rightScore =
          right.beat.strength -
          (rightDistance / Math.max(maximumSnapSeconds, 0.001)) * 0.28;
        return rightScore - leftScore || leftDistance - rightDistance;
      });
    const selected = candidates[0];
    if (selected) usedBeats.add(selected.beatIndex);
    boundaries.push(selected?.beat.time ?? original);
  }
  boundaries.push(plan.duration);

  const slides: PhotoReelSlide[] = plan.slides.map((slide, index) => {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const duration = end - start;
    return {
      ...slide,
      start,
      end,
      duration,
      transitionDuration:
        index === 0
          ? 0
          : Math.min(slide.transitionDuration, duration * 0.28),
    };
  });
  const changed = slides.some(
    (slide, index) => Math.abs(slide.start - plan.slides[index].start) > 0.0001,
  );
  return changed ? { ...plan, slides } : plan;
}
