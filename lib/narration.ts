import { selectCaptionHighlight, type CaptionSegment } from "./captions";
import {
  buildEditRanges,
  type EditRange,
} from "./edit-plan";

export const NARRATION_DISCLOSURE_TEXT =
  "※この動画ではAIナレーションを使用しています。";
export const NARRATION_TERMS_VERSION = "2026-08-11";
export type VideoAudioMode = "spoken" | "narration";
export type NarrationStyle = "bright" | "calm" | "comedy" | "party";
export type NarrationDeliveryPreset =
  | "natural"
  | "firm_ending"
  | "emphasis"
  | "pause"
  | "brighter"
  | "calmer";
export type NarrationOriginalAudioLevel = number;

export type NarrationPronunciationEntry = {
  surface: string;
  reading: string;
};

export const DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT = 0;
export const MAX_NARRATION_ORIGINAL_AUDIO_PERCENT = 20;

export type NarrationSegment = {
  text: string;
  speechText?: string;
  emphasis?: boolean;
  /** Optional finished-video scene grounding used by multi-video narration. */
  sceneId?: string;
};

export type NarrationPlan = {
  title: string;
  script: string;
  socialCaption: string;
  segments: NarrationSegment[];
};

export type NarrationTimelineOptions = {
  autoCut?: boolean;
};

export const NARRATION_STYLES: Array<{
  id: NarrationStyle;
  label: string;
  note: string;
}> = [
  { id: "calm", label: "自然な男性", note: "穏やかで信頼感のある声｜商品・解説" },
  { id: "bright", label: "自然な女性", note: "温かくクリアな声｜日常・説明" },
  {
    id: "comedy",
    label: "明るい男性",
    note: "華やかで勢いのある声｜イベント・SNS",
  },
  {
    id: "party",
    label: "明るい女性",
    note: "華やかでノリのよい声｜イベント・SNS",
  },
];

export const NARRATION_DELIVERY_PRESETS: Array<{
  id: NarrationDeliveryPreset;
  label: string;
  note: string;
}> = [
  {
    id: "natural",
    label: "自然な抑揚",
    note: "今の声と音量を保ち、抑揚だけ整える",
  },
  {
    id: "firm_ending",
    label: "語尾を言い切る",
    note: "文末を上げず、自然に着地する",
  },
  {
    id: "emphasis",
    label: "言葉を強調",
    note: "選んだ言葉だけを自然に立たせる",
  },
  {
    id: "pause",
    label: "間を整える",
    note: "意味の切れ目に短い間を入れる",
  },
  {
    id: "brighter",
    label: "少し明るく",
    note: "声質は変えず、前向きな抑揚にする",
  },
  {
    id: "calmer",
    label: "少し落ち着いて",
    note: "声質は変えず、穏やかに読む",
  },
];

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

export function validateNarrationPronunciationGuide(
  guide: string,
): { entries: NarrationPronunciationEntry[]; error: string } {
  if (typeof guide !== "string" || !guide.trim()) {
    return { entries: [], error: "" };
  }

  const entries = new Map<string, string>();
  const lines = guide.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 20) {
    return { entries: [], error: "読み方は20件まで指定できます。" };
  }

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    const match = line.match(/^(.+?)\s*(?:=>|→|=|：|:)\s*(.+)$/u);
    if (!match) {
      return {
        entries: [],
        error: `${index + 1}行目を「漢字 → よみがな」の形式で入力してください。`,
      };
    }
    const surface = match[1].replace(/\s+/g, " ").trim();
    const reading = match[2].replace(/\s+/g, " ").trim();
    if (!surface || !reading) {
      return {
        entries: [],
        error: `${index + 1}行目の言葉と読み方を両方入力してください。`,
      };
    }
    if (surface.length > 50 || reading.length > 80) {
      return {
        entries: [],
        error: `${index + 1}行目が長すぎます。言葉は50文字、読み方は80文字以内にしてください。`,
      };
    }
    if (surface === reading) {
      return {
        entries: [],
        error: `${index + 1}行目は元の表記と異なる読み方を入力してください。`,
      };
    }
    if (entries.has(surface)) {
      return {
        entries: [],
        error: `「${surface}」の読み方が重複しています。1行にまとめてください。`,
      };
    }
    entries.set(surface, reading);
  }

  return {
    entries: Array.from(entries, ([surface, reading]) => ({ surface, reading }))
      .sort((left, right) => right.surface.length - left.surface.length),
    error: "",
  };
}

export function parseNarrationPronunciationGuide(
  guide: string,
): NarrationPronunciationEntry[] {
  return validateNarrationPronunciationGuide(guide).entries;
}

export function canonicalizeNarrationPronunciationGuide(guide: string) {
  const normalizedGuide = guide
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  const validation = validateNarrationPronunciationGuide(normalizedGuide);
  if (validation.error) return normalizedGuide;
  return validation.entries
    .map(({ surface, reading }) => ({ surface, reading }))
    .sort(
      (left, right) =>
        left.surface.localeCompare(right.surface, "ja") ||
        left.reading.localeCompare(right.reading, "ja"),
    )
    .map(({ surface, reading }) => `${surface} → ${reading}`)
    .join("\n");
}

export function countNarrationPronunciationOccurrences(
  script: string,
  surface: string,
) {
  if (!script || !surface) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= script.length - surface.length) {
    const index = script.indexOf(surface, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + surface.length;
  }
  return count;
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NARRATION_INVISIBLE_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
const NARRATION_EMOJI =
  /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic})(?:\ufe0e|\ufe0f|\p{Emoji_Modifier})?(?:\u200d\p{Extended_Pictographic}(?:\ufe0e|\ufe0f|\p{Emoji_Modifier})?)*/gu;

/**
 * Makes speech-only text predictable for Japanese synthesis without guessing
 * kanji readings or rewriting numbers. Display copy must never use this value.
 */
export function normalizeNarrationSpeechText(script: string) {
  if (typeof script !== "string" || !script) return "";

  const normalized = script
    .normalize("NFKC")
    .replace(/\r\n?|\n/gu, "、")
    .replace(NARRATION_EMOJI, "、")
    .replace(NARRATION_INVISIBLE_CHARACTERS, "")
    .replace(/(?:\.{2,}|…+|‥+)/gu, "、")
    .replace(/[／/|｜;；]+/gu, "、")
    .replace(/[—―–]+/gu, "、")
    .replace(/[,，]+/gu, (commas, offset, source: string) => {
      const before = source[offset - 1] ?? "";
      const after = source[offset + commas.length] ?? "";
      return /[0-9]/u.test(before) && /[0-9]/u.test(after) ? commas : "、";
    })
    .replace(/[\t\v\f\p{Zs}]+/gu, " ")
    .replace(/\s*、\s*/gu, "、")
    .replace(/、{2,}/gu, "、")
    .replace(/([。！？!?])、/gu, "$1")
    .replace(/、([。！？!?])/gu, "$1")
    .replace(/。{2,}/gu, "。")
    .replace(/！{2,}/gu, "！")
    .replace(/？{2,}/gu, "？")
    .replace(/!{2,}/gu, "!")
    .replace(/\?{2,}/gu, "?")
    .replace(/ {2,}/gu, " ")
    .replace(/^、|、$/gu, "")
    .trim();

  return normalized;
}

export function applyNarrationPronunciationGuide(
  script: string,
  guide: string,
) {
  const entries = parseNarrationPronunciationGuide(guide);
  if (!entries.length) return normalizeNarrationSpeechText(script);

  const readingBySurface = new Map(
    entries.map((entry) => [entry.surface, entry.reading] as const),
  );
  const pattern = new RegExp(
    entries.map((entry) => escapeRegularExpression(entry.surface)).join("|"),
    "gu",
  );
  const speechText = script.replace(
    pattern,
    (surface) => readingBySurface.get(surface) ?? surface,
  );
  return normalizeNarrationSpeechText(speechText);
}

/**
 * Adds speech-only readings to a narration plan without changing anything the
 * viewer sees. The display script and each segment's text remain the source of
 * truth for captions; speechText is used only for timing and synthesis.
 */
export function attachNarrationPronunciationReadings<T extends NarrationPlan>(
  plan: T,
  guide: string,
): T {
  return {
    ...plan,
    segments: plan.segments.map((segment) => ({
      ...segment,
      speechText: applyNarrationPronunciationGuide(segment.text, guide),
    })),
  } as T;
}

export function splitNarrationScript(script: string) {
  const normalized = cleanText(script, 2_000);
  if (!normalized) return [];
  const sentences =
    normalized
      .match(/[^。！？!?]+[。！？!?]?/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
  const compact: string[] = [];

  for (const sentence of sentences) {
    if (
      compact.length > 0 &&
      compact.at(-1)!.length + sentence.length <= 24
    ) {
      compact[compact.length - 1] += sentence;
    } else {
      compact.push(sentence);
    }
  }
  return compact.slice(0, 24);
}

/** Removes presentation-only differences before checking caption coverage. */
export function canonicalizeNarrationTextForComparison(text: string) {
  return cleanText(text, 2_000)
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLocaleLowerCase("ja-JP");
}

export function normalizeNarrationPlan(value: unknown): NarrationPlan {
  const payload =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const script = cleanText(payload.script, 2_000);
  const rawSegments = Array.isArray(payload.segments)
    ? payload.segments
    : [];
  const segments = rawSegments
    .map((item) => {
      const record =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)
          : {};
      return {
        text: cleanText(record.text, 120),
        emphasis: record.emphasis === true,
        ...(typeof record.sceneId === "string" &&
        /^scene-(?:[1-9]|10)$/u.test(record.sceneId.trim())
          ? { sceneId: record.sceneId.trim() }
          : {}),
      };
    })
    .filter((item) => item.text)
    .slice(0, 24);
  const resolvedScript =
    script ||
    segments
      .map((item) => item.text)
      .join("")
      .slice(0, 2_000);
  const fallbackSegments = splitNarrationScript(resolvedScript).map((text, index) => ({
    text,
    emphasis: index === 0,
  }));
  const combinedSegmentText = segments.map((item) => item.text).join("");
  const segmentsCoverScript =
    segments.length > 0 &&
    canonicalizeNarrationTextForComparison(combinedSegmentText) ===
      canonicalizeNarrationTextForComparison(resolvedScript);

  return {
    title: cleanText(payload.title, 80) || "今日のリール",
    script: resolvedScript,
    socialCaption: cleanText(payload.socialCaption, 1_200),
    segments: segmentsCoverScript ? segments : fallbackSegments,
  };
}

export function buildNarrationTimeline(
  segments: NarrationSegment[],
  sourceDuration: number,
  requestedDuration: number,
  narrationDuration?: number,
  options: NarrationTimelineOptions = {},
): CaptionSegment[] {
  const validSegments = segments
    .map((segment) => ({
      text: cleanText(segment.text, 120),
      speechText: cleanText(segment.speechText, 240),
      emphasis: Boolean(segment.emphasis),
    }))
    .filter((segment) => segment.text)
    .slice(0, 24);
  if (!validSegments.length) return [];

  const safeSourceDuration = Math.max(1, sourceDuration || requestedDuration);
  const maximumDuration = Math.max(
    1,
    Math.min(requestedDuration || safeSourceDuration, safeSourceDuration),
  );
  const targetDuration =
    Number.isFinite(narrationDuration) && Number(narrationDuration) > 0
      ? Math.max(1, Math.min(Number(narrationDuration), maximumDuration))
      : maximumDuration;
  const weights = validSegments.map((segment) =>
    Math.max(5, Array.from(segment.speechText || segment.text).length),
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const autoCut = options.autoCut !== false;
  const sourceGapBudget = autoCut
    ? Math.max(0, safeSourceDuration - targetDuration)
    : 0;
  const sourceGap =
    validSegments.length > 1
      ? sourceGapBudget / (validSegments.length - 1)
      : 0;
  let outputCursor = 0;

  return validSegments.map((segment, index) => {
    const remaining =
      index === validSegments.length - 1
        ? targetDuration - outputCursor
        : (weights[index] / totalWeight) * targetDuration;
    const duration = Math.max(0.4, remaining);
    const sourceStart = autoCut
      ? validSegments.length === 1
        ? sourceGapBudget / 2
        : outputCursor + sourceGap * index
      : outputCursor;
    const start = Math.min(sourceStart, Math.max(0, safeSourceDuration - 0.2));
    const end = Math.min(safeSourceDuration, start + duration);
    outputCursor += remaining;
    const highlight = selectCaptionHighlight(segment.text);

    return {
      id: index + 1,
      start: Math.round(start * 1_000) / 1_000,
      end: Math.round(Math.max(start + 0.2, end) * 1_000) / 1_000,
      text: segment.text,
      removed: false,
      accent: segment.emphasis || Boolean(highlight),
      highlight,
    };
  });
}

export function buildNarrationEditRanges(
  timeline: CaptionSegment[],
  sourceDuration: number,
  autoCut: boolean,
): EditRange[] {
  if (!autoCut && Number.isFinite(sourceDuration) && sourceDuration > 0) {
    return [
      {
        start: 0,
        end: Math.round(sourceDuration * 1_000) / 1_000,
      },
    ];
  }
  return buildEditRanges(timeline, { maxJoinGapSeconds: 0.001 });
}

export function getNarrationPlaybackRate() {
  return 1;
}

export function getNarrationBufferSlice(
  elapsed: number,
  rangeDuration: number,
  bufferDuration: number,
) {
  if (
    !Number.isFinite(elapsed) ||
    !Number.isFinite(rangeDuration) ||
    !Number.isFinite(bufferDuration)
  ) {
    return null;
  }
  const offset = Math.max(0, elapsed);
  const availableDuration = Math.max(0, bufferDuration - offset);
  const duration = Math.min(Math.max(0, rangeDuration), availableDuration);
  return duration > 0.01 ? { offset, duration } : null;
}

export function buildDisclosedPostCaption(socialCaption: string) {
  const body = socialCaption
    .replaceAll(NARRATION_DISCLOSURE_TEXT, "")
    .trim();
  return [body, NARRATION_DISCLOSURE_TEXT].filter(Boolean).join("\n\n");
}

export function getNarrationOriginalAudioGain(
  percent: NarrationOriginalAudioLevel,
) {
  if (!Number.isFinite(percent)) return 0;
  const safePercent = Math.min(
    MAX_NARRATION_ORIGINAL_AUDIO_PERCENT,
    Math.max(0, percent),
  );
  return Math.round(safePercent) / 100;
}

export function getNarrationMixLevels(
  percent: NarrationOriginalAudioLevel,
) {
  return {
    original: getNarrationOriginalAudioGain(percent),
    narration: 1,
  };
}

export function isNarrationStyle(value: unknown): value is NarrationStyle {
  return NARRATION_STYLES.some((style) => style.id === value);
}

export function isNarrationDeliveryPreset(
  value: unknown,
): value is NarrationDeliveryPreset {
  return NARRATION_DELIVERY_PRESETS.some((preset) => preset.id === value);
}

export function normalizeNarrationDeliveryPreset(
  value: unknown,
): NarrationDeliveryPreset | null {
  return isNarrationDeliveryPreset(value) ? value : null;
}

/**
 * Converts retired voice-template ids used by already-open editors and old
 * clients into a current template. Unknown input remains invalid so malformed
 * requests are not silently accepted.
 */
export function normalizeNarrationStyle(
  value: unknown,
): NarrationStyle | null {
  if (isNarrationStyle(value)) return value;
  if (value === "tempo") return "party";
  if (value === "refined") return "calm";
  return null;
}
