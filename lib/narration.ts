import { selectCaptionHighlight, type CaptionSegment } from "./captions";

export const NARRATION_DISCLOSURE_TEXT =
  "※この動画ではAIナレーションを使用しています。";
export const NARRATION_TERMS_VERSION = "2026-07-30";

export type VideoAudioMode = "spoken" | "narration";
export type NarrationStyle = "bright" | "calm" | "tempo" | "refined";

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
  { id: "bright", label: "明るく親しみやすい", note: "日常・お店紹介向け" },
  { id: "calm", label: "やさしく落ち着く", note: "美容・暮らし向け" },
  { id: "tempo", label: "テンポよく軽快", note: "商品・How-to向け" },
  { id: "refined", label: "上品で洗練", note: "ブランド・作品向け" },
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
  const targetDuration = Math.max(
    1,
    Math.min(requestedDuration || safeSourceDuration, safeSourceDuration),
  );
  const weights = validSegments.map((segment) =>
    Math.max(5, Array.from(segment.text).length),
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let outputCursor = 0;

  return validSegments.map((segment, index) => {
    const remaining =
      index === validSegments.length - 1
        ? targetDuration - outputCursor
        : (weights[index] / totalWeight) * targetDuration;
    const duration = Math.max(0.4, remaining);
    const sourceStart =
      targetDuration >= safeSourceDuration
        ? outputCursor
        : outputCursor * (safeSourceDuration / targetDuration);
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

export function buildDisclosedPostCaption(socialCaption: string) {
  const body = socialCaption
    .replaceAll(NARRATION_DISCLOSURE_TEXT, "")
    .trim();
  return [body, NARRATION_DISCLOSURE_TEXT].filter(Boolean).join("\n\n");
}

export function isNarrationStyle(value: unknown): value is NarrationStyle {
  return NARRATION_STYLES.some((style) => style.id === value);
}
