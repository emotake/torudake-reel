import type { RawCaptionSegment } from "./captions";

export type TranscriptionQualityReason =
  | "mojibake"
  | "repetition"
  | "unexpected-language";

function compactText(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\s、。，,.！？!?「」『』（）()[\]【】・…ー~～\-—―]/g, "")
    .toLowerCase();
}

function hasSuspiciousRepetition(text: string) {
  const phrases = text
    .split(/[。！？!?\n]+/)
    .map(compactText)
    .filter((phrase) => phrase.length >= 4);
  const counts = new Map<string, number>();

  for (const phrase of phrases) {
    const count = (counts.get(phrase) ?? 0) + 1;
    if (count >= 3) return true;
    counts.set(phrase, count);
  }

  const compact = compactText(text);
  for (let length = 4; length <= 12; length += 1) {
    for (let offset = 0; offset + length * 3 <= compact.length; offset += 1) {
      const phrase = compact.slice(offset, offset + length);
      if (
        phrase === compact.slice(offset + length, offset + length * 2) &&
        phrase === compact.slice(offset + length * 2, offset + length * 3)
      ) {
        return true;
      }
    }
  }

  return false;
}

function looksUnexpectedlyNonJapanese(text: string) {
  const characters = Array.from(compactText(text));
  if (characters.length < 12) return false;

  const JapaneseExpression =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff々〆ヵヶ]/;
  const LatinExpression = /[a-z]/i;
  const japaneseCharacters = characters.filter((character) =>
    JapaneseExpression.test(character),
  ).length;
  const latinCharacters = characters.filter((character) =>
    LatinExpression.test(character),
  ).length;

  return (
    japaneseCharacters / characters.length < 0.15 &&
    latinCharacters / characters.length > 0.65
  );
}

export function getTranscriptionQualityReasons(text: string) {
  const reasons: TranscriptionQualityReason[] = [];

  if (/�|(?:縺|繧|蜍|髻|蟄|譁){2,}/.test(text)) {
    reasons.push("mojibake");
  }
  if (hasSuspiciousRepetition(text)) {
    reasons.push("repetition");
  }
  if (looksUnexpectedlyNonJapanese(text)) {
    reasons.push("unexpected-language");
  }

  return reasons;
}

function findNaturalBoundary(
  characters: string[],
  start: number,
  targetLength: number,
  remainingSegments: number,
) {
  const minimumRemainder = Math.max(remainingSegments * 2, remainingSegments);
  const maximumEnd = Math.max(
    start + 1,
    characters.length - minimumRemainder,
  );
  const targetEnd = Math.min(maximumEnd, start + Math.max(1, targetLength));
  const radius = Math.max(3, Math.min(10, Math.round(targetLength * 0.4)));
  const searchStart = Math.max(start + 1, targetEnd - radius);
  const searchEnd = Math.min(maximumEnd, targetEnd + radius);
  let bestEnd = targetEnd;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let end = searchStart; end <= searchEnd; end += 1) {
    const character = characters[end - 1] ?? "";
    const prefix = characters.slice(start, end).join("");
    let priority = 5;

    if (/[。！？!?]/.test(character)) {
      priority = 0;
    } else if (/[、，,]/.test(character)) {
      priority = 1;
    } else if (
      /(?:です|ます|でした|ました|ません|ください|なので|だから|けれど|けど|そして|つまり)$/.test(
        prefix,
      )
    ) {
      priority = 2;
    } else if (
      /\s/.test(character) ||
      /(?:から|まで|より|ので|のに|なら|って|とは|では|には|は|が|を|に|で|と|も|へ)$/.test(
        prefix,
      )
    ) {
      priority = 3;
    }

    const score = priority * 100 + Math.abs(end - targetEnd);
    if (score < bestScore) {
      bestScore = score;
      bestEnd = end;
    }
  }

  return Math.max(start + 1, Math.min(bestEnd, maximumEnd));
}

export function alignRefinedTextToSegments(
  refinedText: string,
  sourceSegments: RawCaptionSegment[],
) {
  const normalizedText = refinedText
    .replace(/\s+/g, " ")
    .replace(/\s+([、。，,.！？!?])/g, "$1")
    .trim();
  const validSegments = sourceSegments.filter(
    (segment) =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end > segment.start,
  );

  if (!normalizedText || validSegments.length === 0) return sourceSegments;
  if (validSegments.length === 1) {
    return [{ ...validSegments[0], text: normalizedText }];
  }

  const characters = Array.from(normalizedText);
  const weights = validSegments.map((segment) =>
    Math.max(Array.from(compactText(segment.text)).length, 1),
  );
  const result: RawCaptionSegment[] = [];
  let characterOffset = 0;
  let remainingWeight = weights.reduce((sum, weight) => sum + weight, 0);

  validSegments.forEach((segment, index) => {
    const isLast = index === validSegments.length - 1;
    const remainingCharacters = characters.length - characterOffset;
    const targetLength = isLast
      ? remainingCharacters
      : Math.max(
          1,
          Math.round(remainingCharacters * (weights[index] / remainingWeight)),
        );
    const endOffset = isLast
      ? characters.length
      : findNaturalBoundary(
          characters,
          characterOffset,
          targetLength,
          validSegments.length - index - 1,
        );
    const text = characters
      .slice(characterOffset, endOffset)
      .join("")
      .trim();

    if (text) {
      result.push({ ...segment, text });
    }
    characterOffset = endOffset;
    remainingWeight -= weights[index];
  });

  return result.length > 0 ? result : sourceSegments;
}
