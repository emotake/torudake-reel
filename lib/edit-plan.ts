import { getCaptionDisplayRange, type CaptionSegment } from "./captions";

export type EditGoal = "follow" | "sales" | "reach";

export type SpokenCutMode = "auto" | "manual" | "none";

export type CaptionCutReasonCode =
  | "manual"
  | "filler"
  | "duplicate"
  | "duration";

export type CaptionCutReason = Readonly<{
  code: CaptionCutReasonCode;
  label: string;
  detail: string;
}>;

export type AutomaticSilenceSummary = Readonly<{
  count: number;
  totalSeconds: number;
}>;

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

export type EditPlanVisualEvidence = Readonly<{
  time: number;
  qualityScore?: number;
  sceneChangeScore?: number;
  faceScore?: number;
}>;

export type NaturalEditOptions = Readonly<{
  /** Locally measured frame evidence. Supplying it never triggers an API call. */
  visualEvidence?: readonly EditPlanVisualEvidence[];
  /** Maximum point bonus contributed by visual evidence. Defaults to 3.2. */
  visualInfluence?: number;
}>;

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

/**
 * Explains an already-decided caption cut without invoking another model.
 * The classification intentionally mirrors createNaturalEdit's deterministic
 * filler/duplicate rules; remaining automatic cuts are attributed to fitting
 * the requested duration instead of exposing an opaque AI score.
 */
export function explainCaptionCut(
  captions: readonly CaptionSegment[],
  captionId: number,
  cutMode: SpokenCutMode,
  targetDurationSeconds: number,
): CaptionCutReason | null {
  const sorted = captions
    .filter(
      (caption) =>
        Number.isFinite(caption.start) &&
        Number.isFinite(caption.end) &&
        caption.end > caption.start &&
        caption.text.trim(),
    )
    .sort((left, right) => left.start - right.start);
  const target = sorted.find((caption) => caption.id === captionId);
  if (!target?.removed) return null;

  if (cutMode === "manual") {
    return {
      code: "manual",
      label: "自分でカット",
      detail: "あなたが使わないと選んだ区間です。いつでも元に戻せます。",
    };
  }

  const recentNormalized: string[] = [];
  for (const caption of sorted) {
    const normalized = normalizeForComparison(
      caption.text.replace(FILLER_EXPRESSION, ""),
    );
    const filler = isLowValueFiller(caption);
    const duplicate = !filler && isNearDuplicate(normalized, recentNormalized);
    if (caption.id === captionId) {
      if (filler) {
        return {
          code: "filler",
          label: "言いよどみを整理",
          detail: "短い相づちや言い直しを省き、話の流れを整えています。",
        };
      }
      if (duplicate) {
        return {
          code: "duplicate",
          label: "重複を整理",
          detail: "直前と近い内容が続くため、片方を残しています。",
        };
      }
      const safeTarget = Math.max(
        1,
        Number.isFinite(targetDurationSeconds) ? targetDurationSeconds : 1,
      );
      return {
        code: "duration",
        label: `${Math.round(safeTarget)}秒に整えるため`,
        detail: "全体の要点と流れを残しながら、選んだ長さへ収めています。",
      };
    }
    if (!filler && !duplicate) {
      recentNormalized.push(normalized);
      if (recentNormalized.length > 3) recentNormalized.shift();
    }
  }

  return null;
}

/** Counts real gaps in the transcript that automatic editing can tighten. */
export function summarizeAutomaticSilenceCuts(
  captions: readonly CaptionSegment[],
  cutMode: SpokenCutMode,
  minimumGapSeconds = 0.8,
): AutomaticSilenceSummary {
  if (cutMode !== "auto") return { count: 0, totalSeconds: 0 };
  const safeMinimum = Number.isFinite(minimumGapSeconds)
    ? Math.max(0.2, minimumGapSeconds)
    : 0.8;
  const timed = captions
    .filter(isTimedCaption)
    .sort((left, right) => left.start - right.start);
  let count = 0;
  let totalSeconds = 0;
  for (let index = 1; index < timed.length; index += 1) {
    const gap = timed[index].start - timed[index - 1].end;
    if (gap + 0.001 < safeMinimum) continue;
    count += 1;
    totalSeconds += gap;
  }
  return {
    count,
    totalSeconds: roundSeconds(totalSeconds),
  };
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

  return snapEditRangesToTimedSilence(captions, ranges).map((range) => ({
    start: roundSeconds(range.start),
    end: roundSeconds(range.end),
  }));
}

/**
 * Leaves a small amount of real quiet room around an automatic edit instead
 * of joining clips exactly on the first/last spoken sample. Whisper word
 * timestamps expose the gaps between adjacent words, so this stays entirely
 * local and never adds another AI request.
 */
export function snapEditRangesToTimedSilence(
  captions: CaptionSegment[],
  ranges: readonly EditRange[],
): EditRange[] {
  const words = captions
    .flatMap((caption) =>
      getExactWordTimings(caption).map((word) => ({
        start: caption.start + word.startOffset,
        end: caption.start + word.endOffset,
      })),
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (words.length === 0) return ranges.map((range) => ({ ...range }));

  const minimumUsefulSilence = 0.04;
  const maximumNearbySilence = 1.2;
  const quietHandleSeconds = 0.02;
  const snapped = ranges.map((range) => {
    const includedCaptions = captions
      .filter(
        (caption) =>
          isIncludedCaption(caption) &&
          caption.end > range.start - 0.001 &&
          caption.start < range.end + 0.001,
      )
      .sort((left, right) => left.start - right.start);
    const preserveMeasuredStart = Boolean(
      includedCaptions[0]?.localSilenceStart,
    );
    const preserveMeasuredEnd = Boolean(
      includedCaptions.at(-1)?.localSilenceEnd,
    );
    const includedWords = words.filter(
      (word) =>
        word.end > range.start - 0.001 &&
        word.start < range.end + 0.001,
    );
    const firstWord = includedWords[0];
    const lastWord = includedWords.at(-1);
    if (!firstWord || !lastWord) return { ...range };

    let start = range.start;
    const previousWord = words.findLast(
      (word) => word.end <= firstWord.start + 0.001,
    );
    if (previousWord && !preserveMeasuredStart) {
      const gap = firstWord.start - previousWord.end;
      if (gap >= minimumUsefulSilence && gap <= maximumNearbySilence) {
        start = Math.min(
          start,
          firstWord.start - Math.min(quietHandleSeconds, gap / 2),
        );
      }
    }

    let end = range.end;
    const nextWord = words.find(
      (word) => word.start >= lastWord.end - 0.001,
    );
    if (nextWord && !preserveMeasuredEnd) {
      const gap = nextWord.start - lastWord.end;
      if (gap >= minimumUsefulSilence && gap <= maximumNearbySilence) {
        end = Math.max(
          end,
          lastWord.end + Math.min(quietHandleSeconds, gap / 2),
        );
      }
    }

    return { start, end };
  });

  return snapped.map((range, index) => {
    const previous = snapped[index - 1];
    const next = snapped[index + 1];
    const start = previous
      ? Math.max(range.start, previous.end)
      : Math.max(0, range.start);
    const end = next ? Math.min(range.end, next.start) : range.end;
    return end > start ? { start, end } : { ...ranges[index] };
  });
}

export function buildSpokenEditRanges(
  captions: CaptionSegment[],
  sourceDuration: number,
  cutMode: SpokenCutMode,
): EditRange[] {
  const measuredSourceDuration =
    Number.isFinite(sourceDuration) && sourceDuration > 0
      ? roundSeconds(sourceDuration)
      : 0;
  const inferredSourceDuration = roundSeconds(
    captions.reduce(
      (duration, caption) =>
        isTimedCaption(caption) && Number.isFinite(caption.end)
          ? Math.max(duration, caption.end)
          : duration,
      0,
    ),
  );
  const safeSourceDuration =
    measuredSourceDuration > 0
      ? measuredSourceDuration
      : inferredSourceDuration;
  if (cutMode === "none") {
    return safeSourceDuration > 0
      ? [{ start: 0, end: safeSourceDuration }]
      : [];
  }

  if (cutMode === "manual") {
    if (safeSourceDuration <= 0) return [];

    const removedRanges = captions
      .filter((caption) => caption.removed && isTimedCaption(caption))
      .map((caption) => ({
        start: Math.max(0, Math.min(safeSourceDuration, caption.start)),
        end: Math.max(0, Math.min(safeSourceDuration, caption.end)),
      }))
      .filter((range) => range.end > range.start)
      .sort((left, right) => left.start - right.start);
    const mergedRemovedRanges: EditRange[] = [];
    removedRanges.forEach((range) => {
      const previous = mergedRemovedRanges.at(-1);
      if (previous && range.start <= previous.end + 0.001) {
        previous.end = Math.max(previous.end, range.end);
        return;
      }
      mergedRemovedRanges.push({ ...range });
    });

    const keptRanges: EditRange[] = [];
    let cursor = 0;
    mergedRemovedRanges.forEach((range) => {
      if (range.start > cursor + 0.001) {
        keptRanges.push({
          start: roundSeconds(cursor),
          end: roundSeconds(range.start),
        });
      }
      cursor = Math.max(cursor, range.end);
    });
    if (cursor < safeSourceDuration - 0.001) {
      keptRanges.push({
        start: roundSeconds(cursor),
        end: safeSourceDuration,
      });
    }
    return keptRanges;
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
      const displayRange = getCaptionDisplayRange(caption);
      return {
        ...caption,
        id: index + 1,
        removed: false,
        start: sourceTimeToEditedTime(ranges, displayRange.start),
        end: sourceTimeToEditedTime(ranges, displayRange.end),
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

function clamp01(value: number | undefined) {
  return Math.min(
    1,
    Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0),
  );
}

/**
 * Summarizes local frame quality inside one candidate edit unit. Missing
 * evidence is neutral (zero), preserving the selection made by old callers.
 */
export function scoreEditPlanVisualEvidence(
  start: number,
  end: number,
  evidence: readonly EditPlanVisualEvidence[] = [],
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  const relevant = evidence.filter(
    (item) =>
      Number.isFinite(item.time) &&
      item.time >= start - 0.001 &&
      item.time <= end + 0.001,
  );
  if (relevant.length === 0) return 0;

  const quality =
    relevant.reduce(
      (total, item) => total + clamp01(item.qualityScore),
      0,
    ) / relevant.length;
  const sceneChange = Math.max(
    ...relevant.map((item) => clamp01(item.sceneChangeScore)),
  );
  const face = Math.max(
    ...relevant.map((item) => clamp01(item.faceScore)),
  );
  return quality * 0.64 + sceneChange * 0.22 + face * 0.14;
}

function scoreEditUnit(
  unit: EditUnit,
  goal: EditGoal,
  sourceEnd: number,
  options: NaturalEditOptions,
) {
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

  const visualInfluence = Number.isFinite(options.visualInfluence)
    ? Math.max(0, Math.min(8, options.visualInfluence ?? 3.2))
    : 3.2;
  score +=
    scoreEditPlanVisualEvidence(
      unit.start,
      unit.end,
      options.visualEvidence,
    ) * visualInfluence;

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

function joinTimedWords(words: Array<{ word: string }>) {
  return words.reduce((text, timing) => {
    const word = timing.word.trim();
    if (!word) return text;
    const needsSpace = /[a-z0-9]$/i.test(text) && /^[a-z0-9]/i.test(word);
    return `${text}${needsSpace ? " " : ""}${word}`;
  }, "");
}

function splitIntoNaturalTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) return [];

  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("ja", { granularity: "word" }).segment(normalized)]
      .map(({ segment }) => segment)
      .filter((segment) => segment.trim());
  }

  return normalized
    .split(/(?<=[、。，,.！？!?])|\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getExactWordTimings(caption: CaptionSegment) {
  const duration = caption.end - caption.start;
  return (caption.wordTimings ?? [])
    .filter(
      (word) =>
        Number.isFinite(word.startOffset) &&
        Number.isFinite(word.endOffset) &&
        word.startOffset >= 0 &&
        word.endOffset > word.startOffset &&
        word.endOffset <= duration + 0.001 &&
        Boolean(word.word.trim()),
    )
    .sort(
      (left, right) =>
        left.startOffset - right.startOffset ||
        left.endOffset - right.endOffset,
    );
}

function clippedCaptionText(
  caption: CaptionSegment,
  selectedWords: Array<{ word: string }>,
  startRatio: number,
  endRatio: number,
) {
  const joinedWords = joinTimedWords(selectedWords);
  const allTimedWords = joinTimedWords(getExactWordTimings(caption));
  if (
    normalizeForComparison(allTimedWords) ===
    normalizeForComparison(caption.text)
  ) {
    return joinedWords;
  }

  const textTokens = splitIntoNaturalTokens(caption.text);
  if (textTokens.length === 0) return caption.text.trim();
  const startIndex = Math.max(
    0,
    Math.min(textTokens.length - 1, Math.floor(startRatio * textTokens.length)),
  );
  const endIndex = Math.max(
    startIndex + 1,
    Math.min(textTokens.length, Math.ceil(endRatio * textTokens.length)),
  );
  return textTokens.slice(startIndex, endIndex).join("");
}

function clipCaptionToDuration(
  caption: CaptionSegment,
  duration: number,
  preferEnd: boolean,
) {
  const originalDuration = caption.end - caption.start;
  const safeDuration = Math.min(originalDuration, Math.max(0, duration));
  if (safeDuration >= originalDuration - 0.001) return { ...caption };
  // A proportional timing estimate can still land inside a spoken word. When
  // the transcription fallback has no real word timestamps, keep the whole
  // caption interval instead of manufacturing an unsafe intra-caption cut.
  const wordTimings = getExactWordTimings(caption);
  if (wordTimings.length === 0) return null;
  const naturalContentEnd = wordTimings.at(-1)!.endOffset;

  const firstSelectedIndex = preferEnd
    ? wordTimings.findIndex(
        (word) =>
          naturalContentEnd - word.startOffset <= safeDuration + 0.001,
      )
    : 0;
  const lastSelectedIndex = preferEnd
    ? wordTimings.length - 1
    : wordTimings.findLastIndex(
        (word) => word.endOffset <= safeDuration + 0.001,
      );
  if (firstSelectedIndex < 0 || lastSelectedIndex < firstSelectedIndex) {
    return null;
  }

  const selectedWords = wordTimings.slice(
    firstSelectedIndex,
    lastSelectedIndex + 1,
  );
  const startOffset = selectedWords[0].startOffset;
  const endOffset = selectedWords.at(-1)!.endOffset;
  if (endOffset - startOffset < 0.12) return null;

  return {
    ...caption,
    start: roundSeconds(caption.start + startOffset),
    end: roundSeconds(caption.start + endOffset),
    text: clippedCaptionText(
      caption,
      selectedWords,
      startOffset / originalDuration,
      endOffset / originalDuration,
    ),
    wordTimings: selectedWords.map((word) => ({
      ...word,
      startOffset: roundSeconds(word.startOffset - startOffset),
      endOffset: roundSeconds(word.endOffset - startOffset),
    })),
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
      const clipped = clipCaptionToDuration(caption, remaining, preferEnd);
      if (clipped) selected.push(clipped);
    }
    break;
  }

  return selected.sort((left, right) => left.start - right.start);
}

export function createNaturalEdit(
  captions: CaptionSegment[],
  targetDuration: number,
  goal: EditGoal,
  options: NaturalEditOptions = {},
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
      const unitScore = scoreEditUnit(unit, goal, sourceEnd, options);
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
            scoreEditUnit(right.unit, goal, sourceEnd, options) -
            scoreEditUnit(left.unit, goal, sourceEnd, options)
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
          const clipped = clipCaptionToDuration(
            last,
            lastDuration - excess,
            true,
          );
          if (clipped) selectedCaptions.set(last.id, clipped);
          else selectedCaptions.delete(last.id);
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
      if (selectedCaptions.size === 0) {
        return sorted.map((caption) => ({ ...caption, removed: false }));
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
