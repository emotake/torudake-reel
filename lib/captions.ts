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

const DEFAULT_MAX_CAPTION_CHARS = 22;

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function splitCaptionText(
  text: string,
  maxChars = DEFAULT_MAX_CAPTION_CHARS,
) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let current = "";

  for (const character of Array.from(normalized)) {
    current += character;
    const length = Array.from(current).length;
    const isSentenceEnd = /[。！？!?]/.test(character);
    const isSoftBreak = /[、，,\s]/.test(character);

    if (
      (isSentenceEnd && length >= 6) ||
      (isSoftBreak && length >= 14) ||
      length >= maxChars
    ) {
      const chunk = current.trim();
      if (chunk) chunks.push(chunk);
      current = "";
    }
  }

  const remainder = current.trim();
  if (remainder) chunks.push(remainder);

  return chunks;
}

export function buildCaptionSegments(
  sourceSegments: RawCaptionSegment[],
  maxChars = DEFAULT_MAX_CAPTION_CHARS,
) {
  const captions: CaptionSegment[] = [];

  for (const source of sourceSegments) {
    const start = Number(source.start);
    const end = Number(source.end);
    const chunks = splitCaptionText(source.text, maxChars);

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

  return captions;
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
