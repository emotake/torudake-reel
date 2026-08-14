import {
  buildNarrationTimeline,
  type NarrationPlan,
  type NarrationSegment,
} from "./narration";
import type { CaptionSegment } from "./captions";
import {
  VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE,
  VIDEO_COMPOSITION_MAX_SOURCES,
  videoCompositionTransitionUsesOverlap,
  type VideoCompositionPlan,
} from "./video-composition";

export const VIDEO_MIX_NARRATION_MAX_SCENES =
  VIDEO_COMPOSITION_MAX_SOURCES * VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE;

export type VideoMixNarrationScene = Readonly<{
  /** Stable finished-video order. No filename or other user metadata is sent. */
  id: string;
  /** Non-overlapping semantic window used to pace narration for this scene. */
  startSeconds: number;
  endSeconds: number;
  /** Zero-based source/clip positions from the local composition plan. */
  sourceIndex: number;
  clipIndex: number;
  /** Zero-based contact-sheet and cell positions sent to the vision endpoint. */
  imageIndex: number;
  cellIndex: number;
  cellCount: 1 | 2;
}>;

export type VideoMixNarrationSceneTimelineResult =
  | Readonly<{ ok: true; scenes: readonly VideoMixNarrationScene[] }>
  | Readonly<{ ok: false; error: string }>;

const SCENE_ID_PATTERN = /^scene-([1-9]|10)$/u;
const TIMELINE_TOLERANCE_SECONDS = 0.075;

function roundMilliseconds(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function semanticBoundaryTime(
  boundary: VideoCompositionPlan["boundaries"][number],
) {
  return roundMilliseconds(
    boundary.editedTime +
      (videoCompositionTransitionUsesOverlap(boundary.transition.type)
        ? boundary.transition.duration / 2
        : 0),
  );
}

/**
 * Builds a privacy-minimal scene manifest from the already-selected clips.
 * Overlap transitions switch semantic ownership at their midpoint so the
 * narration windows form one non-overlapping timeline.
 */
export function createVideoMixNarrationSceneTimeline(
  plan: Pick<
    VideoCompositionPlan,
    "sources" | "clips" | "boundaries" | "duration"
  >,
): VideoMixNarrationScene[] {
  if (plan.sources.length > VIDEO_COMPOSITION_MAX_SOURCES) {
    throw new RangeError(
      `Video mix narration supports at most ${VIDEO_COMPOSITION_MAX_SOURCES} sources.`,
    );
  }
  if (plan.clips.length > VIDEO_MIX_NARRATION_MAX_SCENES) {
    throw new RangeError(
      `Video mix narration supports at most ${VIDEO_MIX_NARRATION_MAX_SCENES} scenes.`,
    );
  }

  const imageIndexBySource = new Map(
    plan.sources.map((source, imageIndex) => [source.sourceIndex, imageIndex]),
  );
  const semanticBoundaries = plan.boundaries.map(semanticBoundaryTime);

  return plan.clips.map((clip, index) => {
    const source = plan.sources[clip.sourceIndex];
    const imageIndex = imageIndexBySource.get(clip.sourceIndex);
    if (!source || imageIndex === undefined) {
      throw new RangeError("Every narration scene must belong to a source image.");
    }
    const cellIndex = source.clips.findIndex(
      (candidate) => candidate.globalClipIndex === clip.globalClipIndex,
    );
    if (cellIndex < 0 || cellIndex >= VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE) {
      throw new RangeError("Every narration scene must map to a contact-sheet cell.");
    }
    const startSeconds = index === 0 ? 0 : semanticBoundaries[index - 1];
    const endSeconds =
      index === plan.clips.length - 1
        ? roundMilliseconds(plan.duration)
        : semanticBoundaries[index];
    if (!(endSeconds > startSeconds)) {
      throw new RangeError("Narration scene windows must have positive duration.");
    }
    return {
      id: `scene-${index + 1}`,
      startSeconds,
      endSeconds,
      sourceIndex: clip.sourceIndex,
      clipIndex: clip.clipIndex,
      imageIndex,
      cellIndex,
      cellCount: source.clips.length as 1 | 2,
    };
  });
}

function invalidSceneTimeline(error: string): VideoMixNarrationSceneTimelineResult {
  return { ok: false, error };
}

/**
 * Treats the client manifest as untrusted input before adding it to a model
 * prompt. Only bounded numbers and deterministic scene ids survive.
 */
export function normalizeVideoMixNarrationSceneTimeline(
  input: unknown,
  options: Readonly<{ frameCount: number; durationSeconds: number }>,
): VideoMixNarrationSceneTimelineResult {
  const frameCount = Number(options.frameCount);
  const durationSeconds = Number(options.durationSeconds);
  if (
    !Number.isInteger(frameCount) ||
    frameCount < 1 ||
    frameCount > VIDEO_COMPOSITION_MAX_SOURCES
  ) {
    return invalidSceneTimeline("場面画像は1〜5枚で指定してください。");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return invalidSceneTimeline("完成動画の長さを確認できませんでした。");
  }
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > VIDEO_MIX_NARRATION_MAX_SCENES
  ) {
    return invalidSceneTimeline("場面タイムラインは1〜10場面で指定してください。");
  }

  const scenes: VideoMixNarrationScene[] = [];
  for (const [index, item] of input.entries()) {
    if (typeof item !== "object" || item === null) {
      return invalidSceneTimeline("場面タイムラインの形式が正しくありません。");
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const startSeconds = Number(record.startSeconds);
    const endSeconds = Number(record.endSeconds);
    const sourceIndex = Number(record.sourceIndex);
    const clipIndex = Number(record.clipIndex);
    const imageIndex = Number(record.imageIndex);
    const cellIndex = Number(record.cellIndex);
    const cellCount = Number(record.cellCount);

    if (id !== `scene-${index + 1}` || !SCENE_ID_PATTERN.test(id)) {
      return invalidSceneTimeline("場面IDと完成動画の順番が一致しません。");
    }
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds ||
      endSeconds > durationSeconds + TIMELINE_TOLERANCE_SECONDS
    ) {
      return invalidSceneTimeline("場面の開始・終了時間が正しくありません。");
    }
    if (
      !Number.isInteger(sourceIndex) ||
      sourceIndex < 0 ||
      sourceIndex >= VIDEO_COMPOSITION_MAX_SOURCES ||
      !Number.isInteger(clipIndex) ||
      clipIndex < 0 ||
      clipIndex >= VIDEO_COMPOSITION_MAX_CLIPS_PER_SOURCE ||
      !Number.isInteger(imageIndex) ||
      imageIndex < 0 ||
      imageIndex >= frameCount ||
      !Number.isInteger(cellCount) ||
      (cellCount !== 1 && cellCount !== 2) ||
      !Number.isInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= cellCount
    ) {
      return invalidSceneTimeline("場面と画像セルの対応が正しくありません。");
    }
    const previous = scenes.at(-1);
    if (
      previous &&
      (Math.abs(startSeconds - previous.endSeconds) >
        TIMELINE_TOLERANCE_SECONDS ||
        sourceIndex < previous.sourceIndex ||
        imageIndex < previous.imageIndex ||
        (sourceIndex === previous.sourceIndex &&
          clipIndex <= previous.clipIndex))
    ) {
      return invalidSceneTimeline("場面タイムラインは完成動画の順番で指定してください。");
    }
    scenes.push({
      id,
      startSeconds: roundMilliseconds(startSeconds),
      endSeconds: roundMilliseconds(endSeconds),
      sourceIndex,
      clipIndex,
      imageIndex,
      cellIndex,
      cellCount: cellCount as 1 | 2,
    });
  }

  if (
    scenes[0].startSeconds > TIMELINE_TOLERANCE_SECONDS ||
    Math.abs(scenes.at(-1)!.endSeconds - durationSeconds) >
      TIMELINE_TOLERANCE_SECONDS
  ) {
    return invalidSceneTimeline("場面タイムラインが完成動画の全体を覆っていません。");
  }

  const byImage = new Map<number, VideoMixNarrationScene[]>();
  for (const scene of scenes) {
    const group = byImage.get(scene.imageIndex) ?? [];
    group.push(scene);
    byImage.set(scene.imageIndex, group);
  }
  if (
    byImage.size !== frameCount ||
    [...byImage.keys()].some((imageIndex) => imageIndex >= frameCount)
  ) {
    return invalidSceneTimeline("すべての場面画像に対応情報が必要です。");
  }
  for (let imageIndex = 0; imageIndex < frameCount; imageIndex += 1) {
    const group = byImage.get(imageIndex) ?? [];
    const expectedCellCount = group[0]?.cellCount ?? 0;
    if (
      group.length !== expectedCellCount ||
      group.some(
        (scene) =>
          scene.cellCount !== expectedCellCount ||
          scene.sourceIndex !== group[0].sourceIndex,
      ) ||
      group
        .map((scene) => scene.cellIndex)
        .sort((left, right) => left - right)
        .some((cellIndex, index) => cellIndex !== index)
    ) {
      return invalidSceneTimeline("画像内の場面セル対応が正しくありません。");
    }
  }

  return { ok: true, scenes };
}

function formatSeconds(value: number) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function cellLabel(scene: VideoMixNarrationScene) {
  if (scene.cellCount === 1) return "全体";
  return scene.cellIndex === 0 ? "左セル" : "右セル";
}

/** Text placed immediately before one contact-sheet image in model input. */
export function describeVideoMixNarrationImage(
  scenes: readonly VideoMixNarrationScene[],
  imageIndex: number,
  charactersPerSecond: number,
) {
  const safeCharactersPerSecond = Number.isFinite(charactersPerSecond)
    ? Math.max(0, charactersPerSecond)
    : 0;
  const matches = scenes.filter((scene) => scene.imageIndex === imageIndex);
  return [
    `画像${imageIndex + 1}の場面対応（セルは左から右の順）:`,
    ...matches.map((scene) => {
      const duration = scene.endSeconds - scene.startSeconds;
      const characterBudget = Math.max(
        0,
        Math.floor(duration * safeCharactersPerSecond),
      );
      return `- ${scene.id}: ${cellLabel(scene)}、完成映像 ${formatSeconds(scene.startSeconds)}〜${formatSeconds(scene.endSeconds)}秒、ナレーション目安0〜${characterBudget}字`;
    }),
  ].join("\n");
}

export function videoMixNarrationScenePromptRules(
  scenes: readonly VideoMixNarrationScene[],
) {
  const allowedIds = scenes.map((scene) => scene.id).join("、");
  return `
場面とナレーションの対応:
- segmentsの各要素にはsceneIdを必ず付け、${allowedIds}のいずれかを指定してください。
- sceneIdは完成映像の時間順に並べ、前の場面へ戻さないでください。同じ場面に複数の短いsegmentを置くことはできます。
- 物・人物・場所・動作に触れる文は、それを画像で確認できるsceneIdにだけ割り当ててください。まだ映っていない内容を先に話したり、画面から消えた内容を後の場面で説明したりしないでください。
- 短すぎて自然に読めない場面は無理に説明せず、segmentを割り当てないでください。画像だけでは断定できない場面には、映像固有の事実を創作せず、前後をつなぐ一般的な短い表現を使ってください。
- 各画像の直前に記載した完成映像の時間と文字数目安を守り、場面が切り替わる位置で文意も自然に切り替えてください。`;
}

function narrationWeight(text: string) {
  return Math.max(1, Array.from(text.replace(/\s+/gu, "")).length);
}

function hasValidModelSceneAssignments(
  segments: readonly NarrationSegment[],
  scenes: readonly VideoMixNarrationScene[],
) {
  const indexById = new Map(scenes.map((scene, index) => [scene.id, index]));
  let previousIndex = -1;
  for (const segment of segments) {
    const sceneIndex = segment.sceneId
      ? indexById.get(segment.sceneId)
      : undefined;
    if (sceneIndex === undefined || sceneIndex < previousIndex) return false;
    previousIndex = sceneIndex;
  }
  return segments.length > 0;
}

/**
 * Keeps valid model grounding. If an upstream response loses or corrupts a
 * scene id, assigns the already-ordered text deterministically by scene time
 * instead of trusting unknown identifiers or failing the entire narration.
 */
export function ensureVideoMixNarrationSceneAssignments(
  plan: NarrationPlan,
  scenes: readonly VideoMixNarrationScene[],
): NarrationPlan {
  if (
    scenes.length === 0 ||
    hasValidModelSceneAssignments(plan.segments, scenes)
  ) {
    return plan;
  }
  const totalWeight = plan.segments.reduce(
    (total, segment) => total + narrationWeight(segment.speechText || segment.text),
    0,
  );
  const totalDuration = scenes.reduce(
    (total, scene) => total + scene.endSeconds - scene.startSeconds,
    0,
  );
  let weightCursor = 0;
  const segments = plan.segments.map((segment) => {
    const weight = narrationWeight(segment.speechText || segment.text);
    const midpoint =
      totalWeight > 0
        ? ((weightCursor + weight / 2) / totalWeight) * totalDuration
        : 0;
    weightCursor += weight;
    let durationCursor = 0;
    const scene =
      scenes.find((candidate, index) => {
        durationCursor += candidate.endSeconds - candidate.startSeconds;
        return midpoint < durationCursor || index === scenes.length - 1;
      }) ?? scenes[0];
    return { ...segment, sceneId: scene.id };
  });
  return { ...plan, segments };
}

/**
 * Builds caption/edit ranges anchored to the model-grounded scene windows.
 * A scene's assigned segments divide its available narration window by text
 * weight. With at least one segment in every scene reached by the audio, the
 * playable ranges exactly cover `audioDurationSeconds`; sparse model output is
 * kept inside its declared scenes and therefore may leave intentional gaps.
 *
 * This helper maps text and captions only. The current single TTS file still
 * plays continuously, so truly frame-exact gaps would require audio padding or
 * scene-level synthesis in a separate, higher-cost workflow.
 */
export function buildVideoMixSceneNarrationTimeline(
  segments: readonly NarrationSegment[],
  scenes: readonly VideoMixNarrationScene[],
  compositionDurationSeconds: number,
  audioDurationSeconds: number,
): CaptionSegment[] {
  const compositionDuration = Number(compositionDurationSeconds);
  const audioDuration = Number(audioDurationSeconds);
  const safeSegments = segments
    .filter((segment) => segment.text.trim())
    .slice(0, 24);
  if (
    safeSegments.length === 0 ||
    scenes.length === 0 ||
    !Number.isFinite(compositionDuration) ||
    compositionDuration <= 0 ||
    !Number.isFinite(audioDuration) ||
    audioDuration <= 0
  ) {
    return [];
  }

  const narrationEnd = Math.min(compositionDuration, audioDuration);
  const activeScenes = scenes.filter(
    (scene) =>
      scene.startSeconds < narrationEnd - 0.001 &&
      scene.endSeconds > scene.startSeconds,
  );
  if (activeScenes.length === 0) return [];

  const assignedSegments = ensureVideoMixNarrationSceneAssignments(
    {
      title: "",
      script: safeSegments.map((segment) => segment.text).join(""),
      socialCaption: "",
      segments: safeSegments.map((segment) => ({ ...segment })),
    },
    activeScenes,
  ).segments;
  const assignedSceneIds = new Set(
    assignedSegments.flatMap((segment) =>
      segment.sceneId ? [segment.sceneId] : [],
    ),
  );
  if (activeScenes.some((scene) => !assignedSceneIds.has(scene.id))) {
    // The audio is one continuous TTS file. Until scene-level audio or real
    // timestamps exist, leaving an empty scene window would make the audio run
    // ahead of the following visuals. Preserve continuous timing instead.
    return buildNarrationTimeline(
      safeSegments,
      compositionDuration,
      compositionDuration,
      narrationEnd,
      { autoCut: false },
    );
  }
  const baseTimeline = buildNarrationTimeline(
    assignedSegments,
    compositionDuration,
    compositionDuration,
    narrationEnd,
    { autoCut: false },
  );
  const sceneById = new Map(activeScenes.map((scene) => [scene.id, scene]));
  const grouped = new Map<
    string,
    Array<{ caption: CaptionSegment; segment: NarrationSegment }>
  >();
  baseTimeline.forEach((caption, index) => {
    const segment = assignedSegments[index];
    const scene = segment?.sceneId ? sceneById.get(segment.sceneId) : undefined;
    if (!segment || !scene) return;
    const entries = grouped.get(scene.id) ?? [];
    entries.push({ caption, segment });
    grouped.set(scene.id, entries);
  });

  const positioned = new Map<number, CaptionSegment>();
  for (const scene of activeScenes) {
    const entries = grouped.get(scene.id) ?? [];
    if (entries.length === 0) continue;
    const windowStart = Math.max(0, scene.startSeconds);
    const windowEnd = Math.min(narrationEnd, scene.endSeconds);
    const windowDuration = windowEnd - windowStart;
    if (windowDuration <= 0.001) continue;
    const weights = entries.map(({ segment }) =>
      narrationWeight(segment.speechText || segment.text),
    );
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    let cursor = windowStart;
    entries.forEach(({ caption }, index) => {
      const end =
        index === entries.length - 1
          ? windowEnd
          : cursor + windowDuration * (weights[index] / totalWeight);
      positioned.set(caption.id, {
        ...caption,
        start: roundMilliseconds(cursor),
        end: roundMilliseconds(Math.max(cursor + 0.001, end)),
      });
      cursor = end;
    });
  }

  return baseTimeline.flatMap((caption) => {
    const positionedCaption = positioned.get(caption.id);
    return positionedCaption ? [positionedCaption] : [];
  });
}
