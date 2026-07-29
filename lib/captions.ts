export type RawCaptionSegment = {
  start: number;
  end: number;
  text: string;
};

export type CaptionSegment = RawCaptionSegment & {
  id: number;
  removed: boolean;
  accent?: boolean;
};

const DEFAULT_MAX_CAPTION_CHARS = 16;
const IDEAL_CAPTION_CHARS = 12;
const MIN_CAPTION_CHARS = 6;
const SHORT_CAPTION_CHARS = 5;
const MAX_CAPTION_MERGE_GAP_SECONDS = 0.45;

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function splitCaptionText(
  text: string,
  maxChars = DEFAULT_MAX_CAPTION_CHARS,
) {
  const normalized = text
    .replace(/\s+/g, " ")
    .replace(/\s+([、。，,.！？!?])/g, "$1")
    .trim();
  if (!normalized) return [];

  const characters = Array.from(normalized);
  const chunks: string[] = [];
  const safeMaxChars = Math.max(MIN_CAPTION_CHARS, maxChars);
  let offset = 0;

  while (characters.length - offset > safeMaxChars) {
    const remainingLength = characters.length - offset;
    const searchLength = Math.min(safeMaxChars, remainingLength);
    const candidates: Array<{
      index: number;
      priority: number;
    }> = [];

    for (let length = MIN_CAPTION_CHARS; length <= searchLength; length += 1) {
      const character = characters[offset + length - 1];
      const remainingAfterBreak = remainingLength - length;
      if (remainingAfterBreak > 0 && remainingAfterBreak < MIN_CAPTION_CHARS) {
        continue;
      }

      const prefix = characters
        .slice(offset, offset + length)
        .join("")
        .trimEnd();
      let priority = Number.POSITIVE_INFINITY;

      if (/[。！？!?]/.test(character)) {
        priority = 0;
      } else if (/[、，,]/.test(character)) {
        priority = 1;
      } else if (
        /(?:です|ます|でした|ました|ません|でしょう|ください|なので|だから|けれど|けど|そして|つまり)$/.test(
          prefix,
        )
      ) {
        priority = 2;
      } else if (
        /\s/.test(character) ||
        /(?:から|まで|より|ので|のに|なら|って|とは|では|には|へは|は|が|を|に|で|と|も|へ)$/.test(
          prefix,
        )
      ) {
        priority = 3;
      }

      if (Number.isFinite(priority)) {
        candidates.push({ index: length, priority });
      }
    }

    const idealLength = Math.min(IDEAL_CAPTION_CHARS, safeMaxChars);
    candidates.sort(
      (left, right) =>
        left.priority - right.priority ||
        Math.abs(left.index - idealLength) -
          Math.abs(right.index - idealLength) ||
        right.index - left.index,
    );

    let breakLength = candidates[0]?.index ?? safeMaxChars;
    const remainderAfterFallback = remainingLength - breakLength;
    if (
      remainderAfterFallback > 0 &&
      remainderAfterFallback < MIN_CAPTION_CHARS
    ) {
      breakLength = Math.max(
        MIN_CAPTION_CHARS,
        breakLength - (MIN_CAPTION_CHARS - remainderAfterFallback),
      );
    }

    const chunk = characters
      .slice(offset, offset + breakLength)
      .join("")
      .trim();
    if (chunk) chunks.push(chunk);
    offset += breakLength;
  }

  const remainder = characters.slice(offset).join("").trim();
  if (remainder) chunks.push(remainder);

  return chunks;
}

function captionLength(text: string) {
  return Array.from(text.trim()).length;
}

function joinCaptionText(left: string, right: string) {
  const trimmedLeft = left.trim();
  const trimmedRight = right.trim();
  const needsSpace =
    /[a-z0-9]$/i.test(trimmedLeft) && /^[a-z0-9]/i.test(trimmedRight);
  return `${trimmedLeft}${needsSpace ? " " : ""}${trimmedRight}`;
}

function mergeShortCaptionSegments(
  captions: CaptionSegment[],
  maxChars: number,
) {
  const merged: CaptionSegment[] = [];

  for (const caption of captions) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...caption });
      continue;
    }

    const previousLength = captionLength(previous.text);
    const currentLength = captionLength(caption.text);
    const combinedText = joinCaptionText(previous.text, caption.text);
    const gap = Math.max(0, caption.start - previous.end);
    const canMerge =
      gap <= MAX_CAPTION_MERGE_GAP_SECONDS &&
      captionLength(combinedText) <= maxChars + 2 &&
      !/[。！？!?]$/.test(previous.text.trim()) &&
      (previousLength <= SHORT_CAPTION_CHARS ||
        currentLength <= SHORT_CAPTION_CHARS);

    if (canMerge) {
      previous.text = combinedText;
      previous.end = caption.end;
      continue;
    }

    merged.push({ ...caption });
  }

  return merged.map((caption, index) => ({
    ...caption,
    id: index + 1,
  }));
}

export function buildCaptionSegments(
  sourceSegments: RawCaptionSegment[],
  maxChars = DEFAULT_MAX_CAPTION_CHARS,
) {
  const normalizedMaxChars = Math.max(MIN_CAPTION_CHARS, maxChars);
  const captions: CaptionSegment[] = [];

  for (const source of sourceSegments) {
    const start = Number(source.start);
    const end = Number(source.end);
    const chunks = splitCaptionText(source.text, normalizedMaxChars);

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      chunks.length === 0
    ) {
      continue;
    }

    const weights = chunks.map((chunk) => Math.max(Array.from(chunk).length, 1));
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    const duration = end - start;
    let cursor = start;

    chunks.forEach((chunk, index) => {
      const chunkEnd =
        index === chunks.length - 1
          ? end
          : cursor + duration * (weights[index] / totalWeight);

      captions.push({
        id: captions.length + 1,
        start: roundSeconds(cursor),
        end: roundSeconds(chunkEnd),
        text: chunk,
        removed: false,
      });
      cursor = chunkEnd;
    });
  }

  return mergeShortCaptionSegments(captions, normalizedMaxChars);
}

function formatTimestamp(seconds: number, decimalSeparator: "," | ".") {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${decimalSeparator}${String(milliseconds).padStart(3, "0")}`;
}

export function captionsToSrt(captions: CaptionSegment[]) {
  return captions
    .filter((caption) => !caption.removed && caption.text.trim())
    .map(
      (caption, index) =>
        `${index + 1}\n${formatTimestamp(caption.start, ",")} --> ${formatTimestamp(caption.end, ",")}\n${caption.text.trim()}`,
    )
    .join("\n\n");
}

export function captionsToVtt(captions: CaptionSegment[]) {
  const body = captions
    .filter((caption) => !caption.removed && caption.text.trim())
    .map(
      (caption) =>
        `${formatTimestamp(caption.start, ".")} --> ${formatTimestamp(caption.end, ".")}\n${caption.text.trim()}`,
    )
    .join("\n\n");

  return `WEBVTT\n\n${body}\n`;
}

export function formatCaptionClock(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
