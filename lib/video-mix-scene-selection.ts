import type { VideoCompositionClip } from "./video-composition";

export const VIDEO_MIX_RECOMMENDED_MAX_SOURCE_SECONDS = 18;
export const VIDEO_MIX_RECOMMENDED_MIN_CLIP_SECONDS = 0.35;

export type VideoMixSceneSample = Readonly<{
  /** Source-video time in seconds. */
  time: number;
  /** Locally measured visual quality, normalized to 0..1. */
  qualityScore: number;
  /** Difference from the preceding sample, normalized to 0..1. */
  sceneChangeScore: number;
}>;

export type VideoMixSceneRecommendationReason =
  | "whole-source"
  | "scene-pair"
  | "best-continuous"
  | "centered-fallback";

export type VideoMixSceneRecommendation = Readonly<{
  clips: readonly VideoCompositionClip[];
  reason: VideoMixSceneRecommendationReason;
  confidence: "high" | "medium" | "low";
  analyzedFrameCount: number;
}>;

type NormalizedSceneSample = VideoMixSceneSample & Readonly<{
  sceneIndex: number;
}>;

type WindowCandidate = Readonly<{
  clip: VideoCompositionClip;
  anchorTime: number;
  sceneIndex: number;
  score: number;
}>;

const SCENE_CHANGE_THRESHOLD = 0.32;
const RECOMMENDED_PAIR_GAP_SECONDS = 0.35;
const TIME_EPSILON = 1e-6;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundMilliseconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function centeredClip(center: number, length: number, duration: number) {
  const safeLength = Math.min(duration, Math.max(0, length));
  const start = roundMilliseconds(
    Math.max(0, Math.min(duration - safeLength, center - safeLength / 2)),
  );
  return {
    start,
    end: Math.min(duration, roundMilliseconds(start + safeLength)),
  } satisfies VideoCompositionClip;
}

function normalizeSamples(
  samples: readonly VideoMixSceneSample[],
  duration: number,
) {
  const byMillisecond = new Map<number, VideoMixSceneSample>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.time) || sample.time < 0 || sample.time > duration) {
      continue;
    }
    const time = roundMilliseconds(sample.time);
    const normalized = {
      time,
      qualityScore: clamp01(sample.qualityScore),
      sceneChangeScore: clamp01(sample.sceneChangeScore),
    };
    const existing = byMillisecond.get(time);
    if (
      !existing ||
      normalized.qualityScore > existing.qualityScore ||
      normalized.sceneChangeScore > existing.sceneChangeScore
    ) {
      byMillisecond.set(time, normalized);
    }
  }

  let sceneIndex = 0;
  return [...byMillisecond.values()]
    .sort((left, right) => left.time - right.time)
    .map((sample, index): NormalizedSceneSample => {
      if (index > 0 && sample.sceneChangeScore >= SCENE_CHANGE_THRESHOLD) {
        sceneIndex += 1;
      }
      return { ...sample, sceneIndex };
    });
}

function scoreWindow(
  clip: VideoCompositionClip,
  anchor: NormalizedSceneSample,
  samples: readonly NormalizedSceneSample[],
) {
  let relevant = samples.filter(
    (sample) =>
      sample.time >= clip.start - TIME_EPSILON &&
      sample.time <= clip.end + TIME_EPSILON,
  );
  if (relevant.length === 0) {
    relevant = [...samples]
      .sort(
        (left, right) =>
          Math.abs(left.time - anchor.time) - Math.abs(right.time - anchor.time),
      )
      .slice(0, 1);
  }
  if (relevant.length === 0) return 0;

  const midpoint = clip.start + (clip.end - clip.start) / 2;
  const halfLength = Math.max(TIME_EPSILON, (clip.end - clip.start) / 2);
  const meanQuality =
    relevant.reduce((total, sample) => total + sample.qualityScore, 0) /
    relevant.length;
  let weightedQualityTotal = 0;
  let weightTotal = 0;
  let lowQualityCount = 0;
  for (const sample of relevant) {
    const centerWeight = 0.45 + 0.55 * clamp01(
      1 - Math.abs(sample.time - midpoint) / halfLength,
    );
    weightedQualityTotal += sample.qualityScore * centerWeight;
    weightTotal += centerWeight;
    if (sample.qualityScore < 0.28) lowQualityCount += 1;
  }
  const weightedQuality = weightedQualityTotal / Math.max(TIME_EPSILON, weightTotal);
  const usableFrameRatio = 1 - lowQualityCount / relevant.length;
  const anchorQuality = anchor.qualityScore;
  return (
    meanQuality * 0.56 +
    weightedQuality * 0.22 +
    anchorQuality * 0.14 +
    usableFrameRatio * 0.08
  );
}

function createWindowCandidates(
  samples: readonly NormalizedSceneSample[],
  duration: number,
  length: number,
) {
  const candidates = new Map<string, WindowCandidate>();
  for (const sample of samples) {
    const clip = centeredClip(sample.time, length, duration);
    const candidate: WindowCandidate = {
      clip,
      anchorTime: sample.time,
      sceneIndex: sample.sceneIndex,
      score: scoreWindow(clip, sample, samples),
    };
    const key = `${clip.start.toFixed(3)}-${clip.end.toFixed(3)}-${sample.sceneIndex}`;
    const existing = candidates.get(key);
    if (
      !existing ||
      candidate.score > existing.score ||
      (candidate.score === existing.score && candidate.anchorTime < existing.anchorTime)
    ) {
      candidates.set(key, candidate);
    }
  }
  return [...candidates.values()].sort(
    (left, right) =>
      left.clip.start - right.clip.start ||
      right.score - left.score ||
      left.anchorTime - right.anchorTime,
  );
}

function bestWindow(candidates: readonly WindowCandidate[]) {
  return [...candidates].sort(
    (left, right) =>
      right.score - left.score ||
      left.clip.start - right.clip.start ||
      left.anchorTime - right.anchorTime,
  )[0];
}

function bestScenePair(
  candidates: readonly WindowCandidate[],
  duration: number,
) {
  let best:
    | Readonly<{
        clips: readonly [VideoCompositionClip, VideoCompositionClip];
        score: number;
      }>
    | undefined;

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (left.sceneIndex === right.sceneIndex) continue;
      if (
        left.clip.end + RECOMMENDED_PAIR_GAP_SECONDS >
        right.clip.start + TIME_EPSILON
      ) {
        continue;
      }
      const temporalSpread = clamp01(
        (right.anchorTime - left.anchorTime) / Math.max(TIME_EPSILON, duration),
      );
      const sceneSpread = Math.min(1, Math.abs(right.sceneIndex - left.sceneIndex) / 2);
      const score =
        (left.score + right.score) / 2 +
        temporalSpread * 0.055 +
        sceneSpread * 0.035;
      const clips = [left.clip, right.clip] as const;
      if (
        !best ||
        score > best.score ||
        (score === best.score && clips[0].start < best.clips[0].start)
      ) {
        best = { clips, score };
      }
    }
  }
  return best;
}

/**
 * Chooses a safe initial range for one source without changing source order.
 * The result is always one or two chronological, non-overlapping clips and
 * never consumes more than the existing 18-second per-source output budget.
 */
export function selectRecommendedVideoMixClips(
  duration: number,
  samples: readonly VideoMixSceneSample[],
): VideoMixSceneRecommendation {
  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      clips: [],
      reason: "centered-fallback",
      confidence: "low",
      analyzedFrameCount: 0,
    };
  }
  const safeDuration = duration;
  const budget = Math.min(
    safeDuration,
    VIDEO_MIX_RECOMMENDED_MAX_SOURCE_SECONDS,
  );
  const normalized = normalizeSamples(samples, safeDuration);

  if (safeDuration <= VIDEO_MIX_RECOMMENDED_MAX_SOURCE_SECONDS) {
    return {
      clips: [{ start: 0, end: safeDuration }],
      reason: "whole-source",
      confidence: "high",
      analyzedFrameCount: normalized.length,
    };
  }

  if (normalized.length === 0) {
    return {
      clips: [centeredClip(safeDuration / 2, budget, safeDuration)],
      reason: "centered-fallback",
      confidence: "low",
      analyzedFrameCount: 0,
    };
  }

  const continuous = bestWindow(
    createWindowCandidates(normalized, safeDuration, budget),
  );
  if (!continuous) {
    return {
      clips: [centeredClip(safeDuration / 2, budget, safeDuration)],
      reason: "centered-fallback",
      confidence: "low",
      analyzedFrameCount: normalized.length,
    };
  }

  const sceneCount = new Set(normalized.map((sample) => sample.sceneIndex)).size;
  const strongestSceneChange = Math.max(
    0,
    ...normalized.map((sample) => sample.sceneChangeScore),
  );
  const pairLength = budget / 2;
  const pair =
    pairLength >= VIDEO_MIX_RECOMMENDED_MIN_CLIP_SECONDS &&
    safeDuration >= budget + RECOMMENDED_PAIR_GAP_SECONDS &&
    sceneCount >= 2
      ? bestScenePair(
          createWindowCandidates(normalized, safeDuration, pairLength),
          safeDuration,
        )
      : undefined;

  // Prefer two genuinely distinct scenes when their measured quality is close
  // to the best continuous window. A small tolerance avoids collapsing back
  // to one clip merely because one scene is marginally brighter than another.
  if (pair && pair.score >= continuous.score - 0.075) {
    return {
      clips: pair.clips,
      reason: "scene-pair",
      confidence:
        normalized.length >= 8 && strongestSceneChange >= 0.48
          ? "high"
          : "medium",
      analyzedFrameCount: normalized.length,
    };
  }

  return {
    clips: [continuous.clip],
    reason: "best-continuous",
    confidence:
      normalized.length >= 8 && continuous.score >= 0.5 ? "medium" : "low",
    analyzedFrameCount: normalized.length,
  };
}
