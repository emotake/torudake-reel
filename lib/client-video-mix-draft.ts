import type { CaptionGoal } from "./caption-design";
import type { NarrationStyle } from "./narration";
import type {
  VideoCompositionClip,
  VideoCompositionTransitionType,
} from "./video-composition";
import type { VideoMixBoundaryTransitionPreferences } from "./video-mix-boundary-preferences";

export const VIDEO_MIX_DRAFT_STORAGE_KEY = "torudake-video-mix-draft-v1";

export type VideoMixFramingMode = "blur" | "cover" | "contain";

export type VideoMixSourceFraming = Readonly<{
  mode: VideoMixFramingMode;
  focusX: number;
  focusY: number;
}>;

export const DEFAULT_VIDEO_MIX_FRAMING: VideoMixSourceFraming = {
  mode: "blur",
  focusX: 0.5,
  focusY: 0.5,
};

export function defaultVideoMixFraming(width: number, height: number): VideoMixSourceFraming {
  return {
    ...DEFAULT_VIDEO_MIX_FRAMING,
    mode: height > 0 && width / height < 0.65 ? "cover" : "blur",
  };
}

const TRANSITIONS = new Set<VideoCompositionTransitionType>([
  "crossfade", "cut", "fade-black", "fade-white", "flash", "wipe-left", "slide-left", "zoom-dissolve",
]);
const NARRATION_STYLES = new Set<NarrationStyle>(["bright", "calm", "comedy", "party"]);
const NARRATION_GOALS = new Set<CaptionGoal>(["follow", "sales", "reach"]);

export type VideoMixDraftSource = Readonly<{
  id: string;
  fingerprint: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  clips: readonly VideoCompositionClip[];
  framing: VideoMixSourceFraming;
}>;

export type VideoMixClientDraft = Readonly<{
  version: 1;
  savedAt: number;
  sources: readonly VideoMixDraftSource[];
  transition: VideoCompositionTransitionType;
  boundaryTransitions: VideoMixBoundaryTransitionPreferences;
  narrationEnabled: boolean;
  narrationSourceAudioMode: "mute" | "ambient";
  narrationCaptionsEnabled: boolean;
  narrationStyle: NarrationStyle;
  narrationGoal: CaptionGoal;
  narrationBrief: string;
}>;

function isFiniteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isFraming(value: unknown): value is VideoMixSourceFraming {
  if (!value || typeof value !== "object") return false;
  const framing = value as Partial<VideoMixSourceFraming>;
  return (
    (framing.mode === "blur" || framing.mode === "cover" || framing.mode === "contain") &&
    isFiniteUnit(framing.focusX) &&
    isFiniteUnit(framing.focusY)
  );
}

function isClip(value: unknown): value is VideoCompositionClip {
  if (!value || typeof value !== "object") return false;
  const clip = value as Partial<VideoCompositionClip>;
  return (
    typeof clip.start === "number" &&
    Number.isFinite(clip.start) &&
    clip.start >= 0 &&
    typeof clip.end === "number" &&
    Number.isFinite(clip.end) &&
    clip.end > clip.start
  );
}

function normalizeSource(value: unknown): VideoMixDraftSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<VideoMixDraftSource>;
  if (
    typeof source.id !== "string" ||
    typeof source.fingerprint !== "string" ||
    typeof source.name !== "string" ||
    typeof source.duration !== "number" ||
    !Number.isFinite(source.duration) ||
    source.duration <= 0 ||
    typeof source.width !== "number" ||
    source.width <= 0 ||
    typeof source.height !== "number" ||
    source.height <= 0 ||
    !Array.isArray(source.clips) ||
    source.clips.length < 1 ||
    source.clips.length > 2 ||
    !source.clips.every(isClip)
  ) {
    return null;
  }
  return {
    id: source.id,
    fingerprint: source.fingerprint,
    name: source.name,
    duration: source.duration,
    width: source.width,
    height: source.height,
    clips: source.clips.map((clip) => ({ start: clip.start, end: clip.end })),
    framing: isFraming(source.framing)
      ? source.framing
      : defaultVideoMixFraming(source.width, source.height),
  };
}

export function readVideoMixClientDraft(
  storage: Pick<Storage, "getItem"> | null | undefined,
): VideoMixClientDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(VIDEO_MIX_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<VideoMixClientDraft>;
    if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 5) return null;
    const sources = value.sources.map(normalizeSource);
    if (sources.some((source) => source === null)) return null;
    if (
      typeof value.savedAt !== "number" ||
      !TRANSITIONS.has(value.transition as VideoCompositionTransitionType) ||
      !value.boundaryTransitions ||
      typeof value.boundaryTransitions !== "object" ||
      typeof value.narrationEnabled !== "boolean" ||
      (value.narrationSourceAudioMode !== undefined &&
        value.narrationSourceAudioMode !== "mute" &&
        value.narrationSourceAudioMode !== "ambient") ||
      typeof value.narrationCaptionsEnabled !== "boolean" ||
      !NARRATION_STYLES.has(value.narrationStyle as NarrationStyle) ||
      !NARRATION_GOALS.has(value.narrationGoal as CaptionGoal) ||
      typeof value.narrationBrief !== "string" ||
      value.narrationBrief.length > 800 ||
      Object.values(value.boundaryTransitions).some(
        (transition) => !TRANSITIONS.has(transition as VideoCompositionTransitionType),
      )
    ) {
      return null;
    }
    return {
      ...value,
      narrationSourceAudioMode:
        value.narrationSourceAudioMode === "ambient" ? "ambient" : "mute",
      sources: sources as VideoMixDraftSource[],
    } as VideoMixClientDraft;
  } catch {
    return null;
  }
}

export function saveVideoMixClientDraft(
  storage: Pick<Storage, "setItem"> | null | undefined,
  draft: VideoMixClientDraft,
) {
  if (!storage) return false;
  try {
    storage.setItem(VIDEO_MIX_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearVideoMixClientDraft(
  storage: Pick<Storage, "removeItem"> | null | undefined,
) {
  if (!storage) return;
  try {
    storage.removeItem(VIDEO_MIX_DRAFT_STORAGE_KEY);
  } catch {
    // Draft cleanup is best-effort in private browsing modes.
  }
}

export function findVideoMixDraftSource(
  draft: VideoMixClientDraft | null,
  fingerprint: string,
) {
  return draft?.sources.find((source) => source.fingerprint === fingerprint) ?? null;
}

export function clampVideoMixDraftClips(
  clips: readonly VideoCompositionClip[],
  duration: number,
): VideoCompositionClip[] | null {
  const normalized = clips.map((clip) => ({
    start: Math.max(0, Math.min(duration, clip.start)),
    end: Math.max(0, Math.min(duration, clip.end)),
  }));
  if (
    normalized.length < 1 ||
    normalized.length > 2 ||
    normalized.some((clip) => clip.end - clip.start < 0.35) ||
    normalized.some((clip, index) => index > 0 && clip.start < normalized[index - 1].end)
  ) {
    return null;
  }
  return normalized;
}
