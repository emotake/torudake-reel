import type { EditRange } from "./edit-plan";

export type PreviewRange = {
  index: number;
  sourceStart: number;
  sourceEnd: number;
  editedStart: number;
  editedEnd: number;
};

export type PreviewPosition = {
  rangeIndex: number;
  sourceTime: number;
  editedTime: number;
  ended: boolean;
};

export type NarrationPreviewAction =
  | { type: "stay"; position: PreviewPosition }
  | { type: "wait"; position: PreviewPosition }
  | { type: "seek-video"; position: PreviewPosition }
  | { type: "end"; position: PreviewPosition };

export function buildPreviewRanges(ranges: EditRange[]): PreviewRange[] {
  let editedCursor = 0;

  return ranges
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end > range.start,
    )
    .map((range, index) => {
      const duration = range.end - range.start;
      const previewRange = {
        index,
        sourceStart: range.start,
        sourceEnd: range.end,
        editedStart: editedCursor,
        editedEnd: editedCursor + duration,
      };
      editedCursor += duration;
      return previewRange;
    });
}

export function resolveEditedPreviewPosition(
  ranges: PreviewRange[],
  editedTime: number,
): PreviewPosition {
  if (ranges.length === 0) {
    return {
      rangeIndex: -1,
      sourceTime: 0,
      editedTime: 0,
      ended: true,
    };
  }

  const safeEditedTime = Math.max(
    0,
    Number.isFinite(editedTime) ? editedTime : 0,
  );
  const lastRange = ranges.at(-1)!;
  if (safeEditedTime >= lastRange.editedEnd) {
    return {
      rangeIndex: lastRange.index,
      sourceTime: lastRange.sourceEnd,
      editedTime: lastRange.editedEnd,
      ended: true,
    };
  }

  const activeRange =
    ranges.find((range) => safeEditedTime < range.editedEnd) ?? lastRange;
  return {
    rangeIndex: activeRange.index,
    sourceTime:
      activeRange.sourceStart +
      Math.max(0, safeEditedTime - activeRange.editedStart),
    editedTime: safeEditedTime,
    ended: false,
  };
}

export function decideNarrationPreviewAction(
  ranges: PreviewRange[],
  audioTime: number,
  videoSourceTime: number,
  isInternalSeeking: boolean,
  driftToleranceSeconds = 0.14,
): NarrationPreviewAction {
  const position = resolveEditedPreviewPosition(ranges, audioTime);
  if (position.ended) return { type: "end", position };
  if (isInternalSeeking) return { type: "wait", position };

  const expectedRange = ranges.find(
    (range) => range.index === position.rangeIndex,
  );
  const isSameRange = Boolean(
    expectedRange &&
      videoSourceTime >= expectedRange.sourceStart - 0.035 &&
      videoSourceTime < expectedRange.sourceEnd + 0.035,
  );
  const drift = Math.abs(videoSourceTime - position.sourceTime);

  if (!isSameRange || drift > Math.max(0.04, driftToleranceSeconds)) {
    return { type: "seek-video", position };
  }
  return { type: "stay", position };
}
