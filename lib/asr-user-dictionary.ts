/**
 * A deliberately small, term-only vocabulary that may be supplied to speech
 * recognition.  It is not a free-form model instruction: line breaks,
 * sentence punctuation, prompt-like language and long phrases are rejected.
 */
export const MAX_ASR_DICTIONARY_TERMS = 12;
export const MAX_ASR_DICTIONARY_TERM_CODEPOINTS = 24;
// Leaves ample room for the fixed high-accuracy context within the upstream
// transcription prompt/token limit.
export const MAX_ASR_DICTIONARY_TOTAL_CODEPOINTS = 96;

const TERM_SEPARATOR = /[,\n\r\t、，]+/u;
const SAFE_TERM_CHARACTERS = /[^\p{L}\p{N}\p{M}・ーｰ&＆+＋'’\-‐‑‒–—―]/gu;
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const PROMPT_LIKE_TERM =
  /(?:指示|命令|プロンプト|システム|ルール|無視|従って|出力して|生成して|書いて|答えて|ignore|instruction|system|prompt|output)/iu;

function collectCandidateValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      ...(Array.isArray(record.productNames) ? record.productNames : []),
      ...(Array.isArray(record.personNames) ? record.personNames : []),
      ...(Array.isArray(record.placeNames) ? record.placeNames : []),
      ...(Array.isArray(record.terms) ? record.terms : []),
    ];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        return collectCandidateValues(JSON.parse(trimmed));
      } catch {
        // Treat malformed JSON as plain terms; the same strict sanitizer below
        // still prevents it from becoming a model instruction.
      }
    }
    return trimmed.split(TERM_SEPARATOR);
  }
  return [];
}

function sanitizeTerm(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .replace(/\s+/gu, "")
    .replace(SAFE_TERM_CHARACTERS, "")
    .trim();
  if (!normalized || !HAS_LETTER_OR_NUMBER.test(normalized)) return "";
  if (PROMPT_LIKE_TERM.test(normalized)) return "";
  const characters = Array.from(normalized);
  if (characters.length > MAX_ASR_DICTIONARY_TERM_CODEPOINTS) return "";
  return normalized;
}

/**
 * Accepts either a string/JSON string, an array, or grouped product/person/
 * place-name arrays. Invalid entries are omitted instead of echoed or logged.
 */
export function sanitizeAsrUserDictionary(value: unknown): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let totalCodepoints = 0;

  for (const candidate of collectCandidateValues(value)) {
    const term = sanitizeTerm(candidate);
    if (!term) continue;
    const key = term.toLocaleLowerCase("ja-JP");
    if (seen.has(key)) continue;
    const termLength = Array.from(term).length;
    if (totalCodepoints + termLength > MAX_ASR_DICTIONARY_TOTAL_CODEPOINTS) {
      break;
    }
    seen.add(key);
    result.push(term);
    totalCodepoints += termLength;
    if (result.length >= MAX_ASR_DICTIONARY_TERMS) break;
  }

  return result;
}

export function buildAsrVocabularyPrompt(
  basePrompt: string | null | undefined,
  dictionary: readonly string[],
) {
  const safeDictionary = sanitizeAsrUserDictionary(dictionary);
  const normalizedBase = basePrompt?.trim() ?? "";
  if (safeDictionary.length === 0) return normalizedBase;
  const vocabulary = `固有語の表記例: ${safeDictionary.join("、")}`;
  return normalizedBase ? `${normalizedBase}\n${vocabulary}` : vocabulary;
}
