import type {
  VideoCompositionClip,
  VideoCompositionTransitionType,
} from "./video-composition";

export type VideoMixBoundaryPreferenceSource = Readonly<{
  id: string;
  clips: readonly VideoCompositionClip[];
}>;

export type VideoMixBoundaryTransitionPreferences = Readonly<
  Record<string, VideoCompositionTransitionType>
>;

type OrderedClipIdentity = Readonly<{
  sourceId: string;
  clipIndex: number;
}>;

function boundarySideKey(clip: OrderedClipIdentity) {
  return `${encodeURIComponent(clip.sourceId)}:${clip.clipIndex}`;
}

/**
 * Creates stable keys for adjacent clips without allowing the UI to reorder
 * either sources or clips. Keys survive time-range edits and changes to later
 * clips, so a user's per-boundary choice is not moved to a different cut.
 */
export function getVideoMixBoundaryPreferenceKeys(
  sources: readonly VideoMixBoundaryPreferenceSource[],
) {
  const clips = sources.flatMap((source) =>
    source.clips.map((_, clipIndex) => ({
      sourceId: source.id,
      clipIndex,
    })),
  );
  return clips.slice(1).map((incoming, index) => {
    const outgoing = clips[index];
    return `${boundarySideKey(outgoing)}>${boundarySideKey(incoming)}`;
  });
}

export function resolveVideoMixBoundaryTransitions(
  sources: readonly VideoMixBoundaryPreferenceSource[],
  preferences: VideoMixBoundaryTransitionPreferences,
  fallback: VideoCompositionTransitionType,
) {
  return getVideoMixBoundaryPreferenceKeys(sources).map(
    (key) => preferences[key] ?? fallback,
  );
}

/** Removes choices for boundaries that no longer exist after a source edit. */
export function pruneVideoMixBoundaryTransitionPreferences(
  sources: readonly VideoMixBoundaryPreferenceSource[],
  preferences: VideoMixBoundaryTransitionPreferences,
) {
  const validKeys = new Set(getVideoMixBoundaryPreferenceKeys(sources));
  return Object.fromEntries(
    Object.entries(preferences).filter(([key]) => validKeys.has(key)),
  ) as Record<string, VideoCompositionTransitionType>;
}
