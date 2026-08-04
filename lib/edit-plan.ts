import type { CaptionSegment } from "./captions";

export type EditGoal = "follow" | "sales" | "reach";

export type EditRange = {
  start: number;
  end: number;
};

type BuildEditRangesOptions = {
  maxJoinGapSeconds?: number;
};

export type CaptionCutUpdate<T extends CaptionSegment> = {
  captions: T[];
  changed: boolean;
  blockedReason?: "would-remove-all" | "not-found";
};

const MAX_JOIN_GAP_SECONDS = 0.42;
const MAX_SENTENCE_GAP_SECONDS = 0.78;
const MAX_SENTENCE_BLOCK_SECONDS = 12;
const SENTENCE_ENDING = /[。！？!?]$/;
const CONNECTIVE_OPENING =
  /^(そして|それで|なので|だから|でも|また|ちなみに|つまり|そのため|ただ|一方で)/;
const FILLER_EXPRESSION =
  /(?:えー+と?|えっと|ええと|あの+|その+|まあ+|なんか|うーん+|そうですね|ですね|はい)/g;

const GOAL_KEYWORDS: Record<EditGoal, RegExp> = {
  follow: /(ポイント|コツ|習慣|続け|方法|まず|大切|おすすめ|変わ)/g,
  sales: /(商品|サービス|価格|メリット|おすすめ|ぜひ|詳細|購入|申込|効果)/g,
  reach: /(結論|実は|知ら|理由|なぜ|ポイント|一番|たった|重要|意外)/g,
};

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function normalizeForComparison(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\s、。,.！？!?「」『』（）()・]/g, "")
    .toLowerCase();
}

function isLowValueFiller(caption: CaptionSegment) {
  const normalized = normalizeForComparison(caption.text);
  if (normalized.length <= 2) return true;

  const withoutFillers = normalized.replace(FILLER_EXPRESSION, "");
  const fillerRatio =
    (normalized.length - withoutFillers.length) / normalized.length;
  return (
    withoutFillers.length === 0 ||
    (withoutFillers.length <= 4 && fillerRatio >= 0.35)
  );
}

function isNearDuplicate(
  normalized: string,
  recentNormalized: string[],
) {
  if (normalized.length < 5) return false;
  return recentNormalized.some((previous) => {
    if (normalized === previous) return true;
    const shorter =
      normalized.length <= previous.length ? normalized : previous;
    const longer =
      normalized.length > previous.length ? normalized : previous;
    return (
      shorter.length >= 7 &&
      longer.length - shorter.length <= 4 &&
      longer.includes(shorter)
    );
  });
}

export function isIncludedCaption(caption: CaptionSegment) {
  return (
    !caption.removed &&
    Boolean(caption.text.trim()) &&
    Number.isFinite(caption.start) &&
    Number.isFinite(caption.end) &&
    caption.end > caption.start
  );
}

function isTimedCaption(caption: CaptionSegment) {
  return (
    Number.isFinite(caption.start) &&
    Number.isFinite(caption.end) &&
    caption.end > caption.start
  );
}

export function setCaptionCut<T extends CaptionSegment>(
  captions: T[],
  id: number,
  cut: boolean,
): CaptionCutUpdate<T> {
  const target = captions.find((caption) => caption.id === id);
  if (!target) {
    return {
      captions,
      changed: false,
      blockedReason: "not-found",
    };
  }
  if (target.removed === cut) {
    return { captions, changed: false };
  }

  if (
    cut &&
    isIncludedCaption(target) &&
    !captions.some(
      (caption) =>
        caption.id !== id && isIncludedCaption(caption),
    )
  ) {
    return {
      captions,
      changed: false,
      blockedReason: "would-remove-all",
    };
  }

  return {
    captions: captions.map((caption) =>
      caption.id === id ? { ...caption, removed: cut } : caption,
    ),
    changed: true,
  };
}

export function buildEditRanges(
  captions: CaptionSegment[],
  options: BuildEditRangesOptions = {},
): EditRange[] {
  const maxJoinGapSeconds = Math.max(
    0,
    options.maxJoinGapSeconds ?? MAX_JOIN_GAP_SECONDS,
  );
  const kept = captions
    .filter(isIncludedCaption)
    .sort((left, right) => left.start - right.start);
  const removedBarriers = captions.filter(
    (caption) => caption.removed && isTimedCaption(caption),
  );
  const ranges: EditRange[] = [];

  kept.forEach((caption) => {
    const previous = ranges.at(-1);
    const crossesRemovedCaption =
      previous &&
      caption.start > previous.end &&
      removedBarriers.some(
        (removed) =>
          removed.end > previous.end &&
          removed.start < caption.start,
      );
    if (
      previous &&
      (caption.start <= previous.end ||
        (!crossesRemovedCaption &&
          caption.start - previous.end <= maxJoinGapSeconds))
    ) {
      previous.end = Math.max(previous.end, caption.end);
      return;
    }
    ranges.push({ start: caption.start, end: caption.end });
  });

  return ranges.map((range) => ({
    start: roundSeconds(range.start),
    end: roundSeconds(range.end),
  }));
}

export function buildSpokenEditRanges(
  captions: CaptionSegment[],
  sourceDuration: number,
  reconnectToSpeech: boolean,
): EditRange[] {
  if (
    !reconnectToSpeech &&
    Number.isFinite(sourceDuration) &&
    sourceDuration > 0
  ) {
    return [{ start: 0, end: roundSeconds(sourceDuration) }];
  }

  return buildEditRanges(captions);
}

export function getEditedDuration(ranges: EditRange[]) {
  return roundSeconds(
    ranges.reduce(
      (total, range) => total + Math.max(0, range.end - range.start),
      0,
    ),
  );
}

export function sourceTimeToEditedTime(
  ranges: EditRange[],
  sourceTime: number,
) {
  let elapsed = 0;
  for (const range of ranges) {
    if (sourceTime <= range.start) return roundSeconds(elapsed);
    const rangeDuration = range.end - range.start;
    if (sourceTime < range.end) {
      return roundSeconds(elapsed + sourceTime - range.start);
    }
    elapsed += rangeDuration;
  }
  return roundSeconds(elapsed);
}

export function editedTimeToSourceTime(
  ranges: EditRange[],
  editedTime: number,
) {
  if (ranges.length === 0) return 0;
  const safeTime = Math.max(0, editedTime);
  let elapsed = 0;

  for (const range of ranges) {
    const rangeDuration = range.end - range.start;
    if (safeTime <= elapsed + rangeDuration) {
      return roundSeconds(
        range.start + Math.max(0, safeTime - elapsed),
      );
    }
    elapsed += rangeDuration;
  }

  return ranges.at(-1)!.end;
}

export function remapCaptionsToEditedTimeline(
  captions: CaptionSegment[],
  ranges = buildEditRanges(captions),
) {
  return captions
    .filter((caption) => !caption.removed && caption.text.trim())
    .map((caption, index) => {
      const range = ranges.find(
        (candidate) =>
          caption.start >= candidate.start - 0.001 &&
          caption.start < candidate.end,
      );
      const clippedEnd = range
        ? Math.min(caption.end, range.end)
        : caption.end;
      return {
        ...caption,
        id: index + 1,
        removed: false,
        start: sourceTimeToEditedTime(ranges, caption.start),
        end: sourceTimeToEditedTime(ranges, clippedEnd),
      };
    })
    .filter((caption) => caption.end > caption.start);
}

type SentenceBlock = {
  captions: CaptionSegment[];
  start: number;
  end: number;
  text: string;
};

function buildSentenceBlocks(captions: CaptionSegment[]) {
  const blocks: SentenceBlock[] = [];

  captions.forEach((caption) => {
    const current = blocks.at(-1);
    const previousCaption = current?.captions.at(-1);
    const startsNewSentence =
      !current ||
      !previousCaption ||
      caption.start - previousCaption.end > MAX_SENTENCE_GAP_SECONDS ||
      SENTENCE_ENDING.test(previousCaption.text.trim()) ||
      current.end - current.start >= MAX_SENTENCE_BLOCK_SECONDS;

    if (startsNewSentence) {
      blocks.push({
        captions: [caption],
        start: caption.start,
        end: caption.end,
        text: caption.text.trim(),
      });
      return;
    }

    current.captions.push(caption);
    current.end = caption.end;
    current.text += caption.text.trim();
  });

  return blocks;
}

type EditUnit = SentenceBlock & {
  phase: 0 | 1 | 2;
};

function scoreEditUnit(unit: EditUnit, goal: EditGoal, sourceEnd: number) {
  const duration = unit.end - unit.start;
  const text = unit.text;
  const goalHits = text.match(GOAL_KEYWORDS[goal])?.length ?? 0;
  const numberHits = text.match(/[0-9０-９]+/g)?.length ?? 0;
  const characterDensity = Math.min(
    7,
    normalizeForComparison(text).length / Math.max(duration, 1),
  );
  let score =
    Math.min(goalHits, 4) * 2.2 +
    Math.min(numberHits, 3) * 0.8 +
    characterDensity * 0.45 +
    Math.min(duration, 8) * 0.28;

  if (!CONNECTIVE_OPENING.test(unit.captions[0]?.text ?? "")) score += 1.5;
  if (SENTENCE_ENDING.test(unit.captions.at(-1)?.text.trim() ?? "")) {
    score += 2.2;
  }
  if (unit.start <= sourceEnd * 0.16) {
    score += goal === "reach" ? 2.2 : 0.8;
  }
  if (unit.end >= sourceEnd * 0.78) {
    score += goal === "sales" ? 2.4 : 0.7;
  }

  return score;
}

function buildEditUnits(
  blocks: SentenceBlock[],
  targetDuration: number,
  sourceStart: number,
  sourceEnd: number,
) {
  const maximumUnitDuration = Math.min(
    8,
    Math.max(3, targetDuration * 0.26),
  );
  const sourceSpan = Math.max(0.001, sourceEnd - sourceStart);
  const units: EditUnit[] = [];

  const pushUnit = (captions: CaptionSegment[]) => {
    if (!captions.length) return;
    const start = captions[0].start;
    const end = captions.at(-1)!.end;
    const midpointRatio =
      (start + (end - start) / 2 - sourceStart) / sourceSpan;
    units.push({
      captions,
      start,
      end,
      text: captions.map((caption) => caption.text.trim()).join(""),
      phase: midpointRatio < 1 / 3 ? 0 : midpointRatio < 2 / 3 ? 1 : 2,
    });
  };

  blocks.forEach((block) => {
    let current: CaptionSegment[] = [];
    block.captions.forEach((caption) => {
      const nextDuration = current.length
        ? caption.end - current[0].start
        : caption.end - caption.start;
      if (current.length && nextDuration > maximumUnitDuration) {
        pushUnit(current);
        current = [];
      }
      current.push(caption);
    });
    pushUnit(current);
  });

  return units;
}

function clipCaptionToDuration(
  caption: CaptionSegment,
  duration: number,
  preferEnd: boolean,
) {
  const originalDuration = caption.end - caption.start;
  const safeDuration = Math.min(originalDuration, Math.max(0, duration));
  if (safeDuration >= originalDuration - 0.001) return { ...caption };

  const characters = Array.from(caption.text.trim());
  const characterCount = Math.max(
    1,
    Math.min(
      characters.length,
      Math.round(characters.length * (safeDuration / originalDuration)),
    ),
  );
  return {
    ...caption,
    start: preferEnd ? roundSeconds(caption.end - safeDuration) : caption.start,
    end: preferEnd ? caption.end : roundSeconds(caption.start + safeDuration),
    text: preferEnd
      ? characters.slice(-characterCount).join("")
      : characters.slice(0, characterCount).join(""),
  };
}

function takeUnitWithinDuration(unit: EditUnit, duration: number) {
  const preferEnd = unit.phase === 2;
  const captions = preferEnd
    ? [...unit.captions].reverse()
    : unit.captions;
  const selected: CaptionSegment[] = [];
  let remaining = duration;

  for (const caption of captions) {
    if (remaining <= 0.04) break;
    const captionDuration = caption.end - caption.start;
    if (captionDuration <= remaining + 0.001) {
      selected.push({ ...caption });
      remaining -= captionDuration;
      continue;
    }
    if (remaining >= 0.35) {
      selected.push(clipCaptionToDuration(caption, remaining, preferEnd));
    }
    break;
  }

  return selected.sort((left, right) => left.start - right.start);
}

export function createNaturalEdit(
  captions: CaptionSegment[],
  targetDuration: number,
  goal: EditGoal,
) {
  const safeTarget = Math.max(1, targetDuration);
  const sorted = captions
    .filter(
      (caption) =>
        Number.isFinite(caption.start) &&
        Number.isFinite(caption.end) &&
        caption.end > caption.start &&
        caption.text.trim(),
    )
    .sort((left, right) => left.start - right.start);
  const excludedIds = new Set<number>();
  const recentNormalized: string[] = [];

  sorted.forEach((caption) => {
    const normalized = normalizeForComparison(
      caption.text.replace(FILLER_EXPRESSION, ""),
    );
    if (
      caption.removed ||
      isLowValueFiller(caption) ||
      isNearDuplicate(normalized, recentNormalized)
    ) {
      excludedIds.add(caption.id);
      return;
    }
    recentNormalized.push(normalized);
    if (recentNormalized.length > 3) recentNormalized.shift();
  });

  const usefulCaptions = sorted.filter(
    (caption) => !excludedIds.has(caption.id),
  );
  if (usefulCaptions.length === 0) {
    return sorted.map((caption) => ({ ...caption, removed: false }));
  }

  const usefulDuration = getEditedDuration(
    buildEditRanges(
      usefulCaptions.map((caption) => ({ ...caption, removed: false })),
    ),
  );
  let selectedIds = new Set(usefulCaptions.map((caption) => caption.id));

  if (usefulDuration > safeTarget + 0.35) {
    const blocks = buildSentenceBlocks(usefulCaptions);
    const sourceStart = usefulCaptions[0].start;
    const sourceEnd = usefulCaptions.at(-1)!.end;
    const units = buildEditUnits(
      blocks,
      safeTarget,
      sourceStart,
      sourceEnd,
    );
    const availablePhaseMask = units.reduce(
      (mask, unit) => mask | (1 << unit.phase),
      0,
    );
    const requireWholeStory = sourceEnd - sourceStart > safeTarget * 1.3;
    const requiredPhaseMask = requireWholeStory ? availablePhaseMask : 0;
    const capacity = Math.floor((safeTarget + 0.35) * 10);
    type SelectionState = {
      duration: number;
      score: number;
      unitIndexes: number[];
      phaseMask: number;
    };
    let states = new Map<string, SelectionState>([
      ["0:0", { duration: 0, score: 0, unitIndexes: [], phaseMask: 0 }],
    ]);

    units.forEach((unit, unitIndex) => {
      const duration = getEditedDuration(
        buildEditRanges(
          unit.captions.map((caption) => ({ ...caption, removed: false })),
        ),
      );
      const durationTicks = Math.ceil(duration * 10);
      if (durationTicks > capacity) return;
      const unitScore = scoreEditUnit(unit, goal, sourceEnd);
      const snapshot = [...states.values()];
      const nextStates = new Map(states);
      snapshot.forEach((state) => {
        const nextTicks = Math.ceil(state.duration * 10) + durationTicks;
        if (nextTicks > capacity) return;
        const phaseMask = state.phaseMask | (1 << unit.phase);
        const next: SelectionState = {
          duration: state.duration + duration,
          score: state.score + unitScore,
          unitIndexes: [...state.unitIndexes, unitIndex],
          phaseMask,
        };
        const key = `${nextTicks}:${phaseMask}`;
        const current = nextStates.get(key);
        if (!current || next.score > current.score) nextStates.set(key, next);
      });
      states = nextStates;
    });

    const countBits = (value: number) =>
      [1, 2, 4].filter((bit) => (value & bit) !== 0).length;
    let best: SelectionState | undefined;
    let bestTotalScore = Number.NEGATIVE_INFINITY;
    states.forEach((state) => {
      if (state.duration <= 0 || state.duration > safeTarget + 0.35) return;
      const missingPhases = countBits(requiredPhaseMask & ~state.phaseMask);
      const totalScore =
        state.score +
        countBits(state.phaseMask & requiredPhaseMask) * 16 -
        missingPhases * 22 -
        Math.abs(safeTarget - state.duration) * 1.55 +
        Math.min(1, state.duration / safeTarget) * 13;
      if (totalScore > bestTotalScore) {
        best = state;
        bestTotalScore = totalScore;
      }
    });

    const selectedCaptions = new Map<number, CaptionSegment>();
    best?.unitIndexes.forEach((unitIndex) => {
      units[unitIndex].captions.forEach((caption) => {
        selectedCaptions.set(caption.id, { ...caption });
      });
    });
    let selectedDuration = best?.duration ?? 0;
    let selectedPhaseMask = best?.phaseMask ?? 0;

    if (selectedDuration < safeTarget - 0.75) {
      const selectedUnitIndexes = new Set(best?.unitIndexes ?? []);
      const fillCandidates = units
        .map((unit, index) => ({ unit, index }))
        .filter(({ index }) => !selectedUnitIndexes.has(index))
        .sort((left, right) => {
          const leftMissing =
            (requiredPhaseMask & ~selectedPhaseMask & (1 << left.unit.phase)) !==
            0;
          const rightMissing =
            (requiredPhaseMask & ~selectedPhaseMask & (1 << right.unit.phase)) !==
            0;
          if (leftMissing !== rightMissing) return leftMissing ? -1 : 1;
          return (
            scoreEditUnit(right.unit, goal, sourceEnd) -
            scoreEditUnit(left.unit, goal, sourceEnd)
          );
        });

      for (const { unit } of fillCandidates) {
        const remaining = safeTarget - selectedDuration;
        if (remaining < 0.35) break;
        const picked = takeUnitWithinDuration(unit, remaining);
        if (!picked.length) continue;
        picked.forEach((caption) => selectedCaptions.set(caption.id, caption));
        selectedPhaseMask |= 1 << unit.phase;
        selectedDuration = getEditedDuration(
          buildEditRanges(
            [...selectedCaptions.values()].map((caption) => ({
              ...caption,
              removed: false,
            })),
          ),
        );
        if (selectedDuration >= safeTarget - 0.75) break;
      }
    }

    if (selectedCaptions.size > 0) {
      let actualDuration = getEditedDuration(
        buildEditRanges(
          [...selectedCaptions.values()].map((caption) => ({
            ...caption,
            removed: false,
          })),
        ),
      );
      while (
        actualDuration > safeTarget + 0.35 &&
        selectedCaptions.size > 0
      ) {
        const last = [...selectedCaptions.values()].sort(
          (left, right) => right.end - left.end,
        )[0];
        const excess = actualDuration - safeTarget;
        const lastDuration = last.end - last.start;
        if (lastDuration - excess >= 0.35) {
          selectedCaptions.set(
            last.id,
            clipCaptionToDuration(last, lastDuration - excess, true),
          );
        } else {
          selectedCaptions.delete(last.id);
        }
        actualDuration = getEditedDuration(
          buildEditRanges(
            [...selectedCaptions.values()].map((caption) => ({
              ...caption,
              removed: false,
            })),
          ),
        );
      }
      selectedIds = new Set(selectedCaptions.keys());
      return sorted.map((caption) => {
        const selected = selectedCaptions.get(caption.id);
        return selected
          ? { ...selected, removed: false }
          : { ...caption, removed: true };
      });
    }
  }

  return sorted.map((caption) => ({
    ...caption,
    removed:
      excludedIds.has(caption.id) || !selectedIds.has(caption.id),
  }));
}
