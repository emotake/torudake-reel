export const PERSONAL_EDIT_RECIPE_VERSION = 1 as const;

export type PersonalEditAudioMode = "spoken" | "narration";
export type PersonalEditPace = "relaxed" | "balanced" | "dynamic";
export type PersonalEditSpokenCutMode = "auto" | "manual" | "none";
export type PersonalEditNarrationStyle =
  | "bright"
  | "calm"
  | "comedy"
  | "party";

export type PersonalEditRecipe = Readonly<{
  version: typeof PERSONAL_EDIT_RECIPE_VERSION;
  audioMode: PersonalEditAudioMode;
  targetDurationSeconds: 30 | 60 | 90;
  editingPace: PersonalEditPace;
  spokenCaptionsEnabled: boolean;
  spokenCutMode: PersonalEditSpokenCutMode;
  narrationStyle: PersonalEditNarrationStyle;
  narrationCaptionsEnabled: boolean;
  narrationAutoCutEnabled: boolean;
  narrationOriginalAudioPercent: number;
}>;

export type PronunciationDictionaryEntry = Readonly<{
  display: string;
  reading: string;
}>;

export type StoredPronunciationDictionaryEntry =
  PronunciationDictionaryEntry &
    Readonly<{
      matchKey: string;
    }>;

export const PERSONAL_EDIT_PREFERENCE_LIMITS = Object.freeze({
  requestBytes: 32 * 1024,
  dictionaryEntries: 50,
  dictionaryDisplayCharacters: 50,
  dictionaryReadingCharacters: 80,
});

export const DEFAULT_PERSONAL_EDIT_RECIPE: PersonalEditRecipe = Object.freeze({
  version: PERSONAL_EDIT_RECIPE_VERSION,
  audioMode: "spoken",
  targetDurationSeconds: 60,
  editingPace: "balanced",
  spokenCaptionsEnabled: false,
  spokenCutMode: "auto",
  narrationStyle: "calm",
  narrationCaptionsEnabled: true,
  narrationAutoCutEnabled: false,
  narrationOriginalAudioPercent: 0,
});

const AUDIO_MODES = new Set<PersonalEditAudioMode>(["spoken", "narration"]);
const TARGET_DURATIONS = new Set<PersonalEditRecipe["targetDurationSeconds"]>([
  30,
  60,
  90,
]);
const EDITING_PACES = new Set<PersonalEditPace>([
  "relaxed",
  "balanced",
  "dynamic",
]);
const SPOKEN_CUT_MODES = new Set<PersonalEditSpokenCutMode>([
  "auto",
  "manual",
  "none",
]);
const NARRATION_STYLES = new Set<PersonalEditNarrationStyle>([
  "bright",
  "calm",
  "comedy",
  "party",
]);

export function normalizePersonalEditRecipe(value: unknown): PersonalEditRecipe {
  const candidate = recordValue(value);
  return {
    version: PERSONAL_EDIT_RECIPE_VERSION,
    audioMode: enumValue(
      candidate?.audioMode,
      AUDIO_MODES,
      DEFAULT_PERSONAL_EDIT_RECIPE.audioMode,
    ),
    targetDurationSeconds: enumValue(
      candidate?.targetDurationSeconds,
      TARGET_DURATIONS,
      DEFAULT_PERSONAL_EDIT_RECIPE.targetDurationSeconds,
    ),
    editingPace: enumValue(
      candidate?.editingPace,
      EDITING_PACES,
      DEFAULT_PERSONAL_EDIT_RECIPE.editingPace,
    ),
    spokenCaptionsEnabled: booleanValue(
      candidate?.spokenCaptionsEnabled,
      DEFAULT_PERSONAL_EDIT_RECIPE.spokenCaptionsEnabled,
    ),
    spokenCutMode: enumValue(
      candidate?.spokenCutMode,
      SPOKEN_CUT_MODES,
      DEFAULT_PERSONAL_EDIT_RECIPE.spokenCutMode,
    ),
    narrationStyle: enumValue(
      candidate?.narrationStyle,
      NARRATION_STYLES,
      DEFAULT_PERSONAL_EDIT_RECIPE.narrationStyle,
    ),
    narrationCaptionsEnabled: booleanValue(
      candidate?.narrationCaptionsEnabled,
      DEFAULT_PERSONAL_EDIT_RECIPE.narrationCaptionsEnabled,
    ),
    narrationAutoCutEnabled: booleanValue(
      candidate?.narrationAutoCutEnabled,
      DEFAULT_PERSONAL_EDIT_RECIPE.narrationAutoCutEnabled,
    ),
    narrationOriginalAudioPercent: boundedInteger(
      candidate?.narrationOriginalAudioPercent,
      0,
      20,
      DEFAULT_PERSONAL_EDIT_RECIPE.narrationOriginalAudioPercent,
    ),
  };
}

export function normalizePronunciationDictionary(
  value: unknown,
): StoredPronunciationDictionaryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: StoredPronunciationDictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(
    0,
    PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryEntries,
  )) {
    const record = recordValue(item);
    const display = normalizedDictionaryText(
      record?.display,
      PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryDisplayCharacters,
    );
    const reading = normalizedDictionaryText(
      record?.reading,
      PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryReadingCharacters,
    );
    if (!display || !reading) continue;
    const matchKey = dictionaryMatchKey(display);
    if (!matchKey || seen.has(matchKey)) continue;
    seen.add(matchKey);
    entries.push({ matchKey, display, reading });
  }
  return entries;
}

export function dictionaryMatchKey(display: string) {
  return Array.from(
    normalizedDictionaryText(
      display,
      PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryDisplayCharacters,
    ).toLocaleLowerCase("ja-JP"),
  )
    .slice(0, PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryDisplayCharacters)
    .join("");
}

function normalizedDictionaryText(value: unknown, maximumCharacters: number) {
  if (typeof value !== "string") return "";
  const normalized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, maximumCharacters).join("");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function enumValue<T>(value: unknown, allowed: Set<T>, fallback: T) {
  return allowed.has(value as T) ? (value as T) : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}
