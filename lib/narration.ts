import { selectCaptionHighlight, type CaptionSegment } from "./captions";

export const NARRATION_DISCLOSURE_TEXT =
  "※この動画ではAIナレーションを使用しています。";
export const NARRATION_TERMS_VERSION = "2026-07-30";

export type VideoAudioMode = "spoken" | "narration";
export type NarrationStyle =
  | "bright"
  | "calm"
  | "tempo"
  | "refined"
  | "comedy";
export type NarrationOriginalAudioLevel = number;

export const DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT = 8;
export const MAX_NARRATION_ORIGINAL_AUDIO_PERCENT = 20;

export type NarrationSegment = {
  text: string;
  emphasis?: boolean;
};

export type NarrationPlan = {
  title: string;
  script: string;
  socialCaption: string;
  segments: NarrationSegment[];
};

export const NARRATION_STYLES: Array<{
  id: NarrationStyle;
  label: string;
  note: string;
}> = [
  { id: "bright", label: "自然な女性", note: "素直な女性声｜日常・説明" },
  { id: "calm", label: "自然な男性", note: "素直な男性声｜商品・解説" },
  { id: "tempo", label: "萌えアニメ", note: "高めのキャラ声｜推し・日常" },
  { id: "refined", label: "低音シネマ", note: "深く重厚な声｜ブランド・作品" },
  {
    id: "comedy",
    label: "関西ツッコミ",
    note: "クセ強ツッコミ声｜検証・オチ",
  },
];

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
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
      };
    })
    .filter((item) => item.text)
    .slice(0, 24);
  const fallbackSegments = splitNarrationScript(script).map((text, index) => ({
    text,
    emphasis: index === 0,
  }));

  return {
    title: cleanText(payload.title, 80) || "今日のリール",
    script:
      script ||
      segments
        .map((item) => item.text)
        .join("")
        .slice(0, 2_000),
    socialCaption: cleanText(payload.socialCaption, 1_200),
    segments: segments.length ? segments : fallbackSegments,
  };
}

export function buildNarrationTimeline(
  segments: NarrationSegment[],
  sourceDuration: number,
  requestedDuration: number,
  narrationDuration?: number,
): CaptionSegment[] {
  const validSegments = segments
    .map((segment) => ({
      text: cleanText(segment.text, 120),
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
    Math.max(5, Array.from(segment.text).length),
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const sourceGapBudget = Math.max(0, safeSourceDuration - targetDuration);
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
    const sourceStart =
      validSegments.length === 1
        ? sourceGapBudget / 2
        : outputCursor + sourceGap * index;
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

export function getNarrationPlaybackRate() {
  return 1;
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

export function isNarrationStyle(value: unknown): value is NarrationStyle {
  return NARRATION_STYLES.some((style) => style.id === value);
}
