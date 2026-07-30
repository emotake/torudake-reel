import type { CaptionSegment } from "./captions";

export type EditGoal = "follow" | "sales" | "reach";

export type EditRange = {
  start: number;
  end: number;
};

type BuildEditRangesOptions = {
  maxJoinGapSeconds?: number;
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

export function buildEditRanges(
  captions: CaptionSegment[],
  options: BuildEditRangesOptions = {},
): EditRange[] {
  const maxJoinGapSeconds = Math.max(
    0,
    options.maxJoinGapSeconds ?? MAX_JOIN_GAP_SECONDS,
  );
  const kept = captions
    .filter(
      (caption) =>
        !caption.removed &&
        caption.text.trim() &&
        Number.isFinite(caption.start) &&
        Number.isFinite(caption.end) &&
        caption.end > caption.start,
    )
    .sort((left, right) => left.start - right.start);
  const ranges: EditRange[] = [];

  kept.forEach((caption) => {
    const previous = ranges.at(-1);
    if (
      previous &&
      caption.start - previous.end <= maxJoinGapSeconds
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

function scoreEditWindow(
  blocks: SentenceBlock[],
  duration: number,
  targetDuration: number,
  goal: EditGoal,
  sourceEnd: number,
) {
  const first = blocks[0];
  const last = blocks.at(-1)!;
  const text = blocks.map((block) => block.text).join("");
  const goalHits = text.match(GOAL_KEYWORDS[goal])?.length ?? 0;
  const numberHits = text.match(/[0-9０-９]+/g)?.length ?? 0;
  const characterDensity = Math.min(
    7,
    normalizeForComparison(text).length / Math.max(duration, 1),
  );
  let score =
    -Math.abs(targetDuration - duration) * 1.7 +
    Math.min(duration / targetDuration, 1) * 11 +
    Math.min(goalHits, 4) * 1.6 +
    Math.min(numberHits, 3) * 0.7 +
    characterDensity * 0.35;

  if (!CONNECTIVE_OPENING.test(first.text)) score += 2.4;
  if (SENTENCE_ENDING.test(last.text)) score += 3.2;
  if (duration >= targetDuration * 0.88) score += 2;
  if (first.start <= sourceEnd * 0.16) {
    score += goal === "reach" ? 2.2 : 0.8;
  }
  if (last.end >= sourceEnd * 0.78) {
    score += goal === "sales" ? 2.4 : 0.7;
  }

  return score;
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
    const sourceEnd = usefulCaptions.at(-1)!.end;
    let best:
      | {
          ids: Set<number>;
          duration: number;
          score: number;
        }
      | undefined;

    for (let start = 0; start < blocks.length; start += 1) {
      const windowBlocks: SentenceBlock[] = [];
      for (let end = start; end < blocks.length; end += 1) {
        windowBlocks.push(blocks[end]);
        const windowCaptions = windowBlocks.flatMap(
          (block) => block.captions,
        );
        const duration = getEditedDuration(
          buildEditRanges(
            windowCaptions.map((caption) => ({
              ...caption,
              removed: false,
            })),
          ),
        );

        if (duration > safeTarget + 0.35) break;
        if (duration < Math.min(safeTarget * 0.58, usefulDuration)) {
          continue;
        }

        const score = scoreEditWindow(
          windowBlocks,
          duration,
          safeTarget,
          goal,
          sourceEnd,
        );
        if (!best || score > best.score) {
          best = {
            ids: new Set(windowCaptions.map((caption) => caption.id)),
            duration,
            score,
          };
        }
      }
    }

    if (best) selectedIds = best.ids;
  }

  return sorted.map((caption) => ({
    ...caption,
    removed:
      excludedIds.has(caption.id) || !selectedIds.has(caption.id),
  }));
}
