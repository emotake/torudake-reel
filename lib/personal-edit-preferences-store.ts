import { env } from "cloudflare:workers";
import { getOrCreateBillingUser } from "./billing-store";
import type { CurrentUser } from "./current-user";
import {
  DEFAULT_PERSONAL_EDIT_RECIPE,
  normalizePersonalEditRecipe,
  normalizePronunciationDictionary,
  type PersonalEditRecipe,
  type PronunciationDictionaryEntry,
} from "./personal-edit-preferences";

type D1Result = { meta?: { changes?: number } };
type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results?: T[] }>;
  run: () => Promise<D1Result>;
};
type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<D1Result[]>;
};

type RecipeRow = {
  version: number;
  audio_mode: string;
  target_duration_seconds: number;
  editing_pace: string;
  spoken_captions_enabled: number;
  spoken_cut_mode: string;
  narration_style: string;
  narration_captions_enabled: number;
  narration_auto_cut_enabled: number;
  narration_original_audio_percent: number;
};

type DictionaryRow = {
  display_text: string;
  reading_text: string;
};

export type PersonalEditPreferences = Readonly<{
  accountStorageId: string;
  recipe: PersonalEditRecipe;
  dictionary: PronunciationDictionaryEntry[];
}>;

export type PersonalEditPreferencesUpdate = Readonly<{
  recipe?: unknown;
  dictionary?: unknown;
}>;

export class PersonalEditPreferencesValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PersonalEditPreferencesValidationError";
    this.code = code;
  }
}

export async function getPersonalEditPreferences(
  currentUser: CurrentUser,
): Promise<PersonalEditPreferences> {
  const user = await getOrCreateBillingUser(currentUser);
  return loadAccountPersonalEditPreferences(user.id);
}

export async function savePersonalEditPreferences(
  currentUser: CurrentUser,
  update: PersonalEditPreferencesUpdate,
): Promise<PersonalEditPreferences> {
  const writesRecipe = Object.hasOwn(update, "recipe");
  const writesDictionary = Object.hasOwn(update, "dictionary");
  if (!writesRecipe && !writesDictionary) {
    throw new PersonalEditPreferencesValidationError("empty_update");
  }
  if (writesDictionary && !Array.isArray(update.dictionary)) {
    throw new PersonalEditPreferencesValidationError("invalid_dictionary");
  }

  const user = await getOrCreateBillingUser(currentUser);
  const database = databaseOrThrow();
  const updatedAt = Math.floor(Date.now() / 1_000);
  const statements: D1Statement[] = [];

  if (writesRecipe) {
    const recipe = normalizePersonalEditRecipe(update.recipe);
    statements.push(
      database
        .prepare(`
          INSERT INTO personal_edit_recipes (
            user_id, version, audio_mode, target_duration_seconds,
            editing_pace, spoken_captions_enabled, spoken_cut_mode,
            narration_style, narration_captions_enabled,
            narration_auto_cut_enabled, narration_original_audio_percent,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            version = excluded.version,
            audio_mode = excluded.audio_mode,
            target_duration_seconds = excluded.target_duration_seconds,
            editing_pace = excluded.editing_pace,
            spoken_captions_enabled = excluded.spoken_captions_enabled,
            spoken_cut_mode = excluded.spoken_cut_mode,
            narration_style = excluded.narration_style,
            narration_captions_enabled = excluded.narration_captions_enabled,
            narration_auto_cut_enabled = excluded.narration_auto_cut_enabled,
            narration_original_audio_percent =
              excluded.narration_original_audio_percent,
            updated_at = excluded.updated_at
        `)
        .bind(
          user.id,
          recipe.version,
          recipe.audioMode,
          recipe.targetDurationSeconds,
          recipe.editingPace,
          recipe.spokenCaptionsEnabled ? 1 : 0,
          recipe.spokenCutMode,
          recipe.narrationStyle,
          recipe.narrationCaptionsEnabled ? 1 : 0,
          recipe.narrationAutoCutEnabled ? 1 : 0,
          recipe.narrationOriginalAudioPercent,
          updatedAt,
        ),
    );
  }

  if (writesDictionary) {
    const dictionary = normalizePronunciationDictionary(update.dictionary);
    statements.push(
      database
        .prepare(
          "DELETE FROM pronunciation_dictionary_entries WHERE user_id = ?",
        )
        .bind(user.id),
    );
    const insert = database.prepare(`
      INSERT INTO pronunciation_dictionary_entries (
        user_id, match_key, display_text, reading_text, position, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    dictionary.forEach((entry, position) => {
      statements.push(
        insert.bind(
          user.id,
          entry.matchKey,
          entry.display,
          entry.reading,
          position,
          updatedAt,
        ),
      );
    });
  }

  await database.batch(statements);
  return loadAccountPersonalEditPreferences(user.id);
}

export async function resetPersonalEditPreferences(currentUser: CurrentUser) {
  const user = await getOrCreateBillingUser(currentUser);
  const database = databaseOrThrow();
  await database.batch([
    database
      .prepare("DELETE FROM personal_edit_recipes WHERE user_id = ?")
      .bind(user.id),
    database
      .prepare(
        "DELETE FROM pronunciation_dictionary_entries WHERE user_id = ?",
      )
      .bind(user.id),
  ]);
  return {
    accountStorageId: await accountStorageIdForUser(user.id),
    recipe: { ...DEFAULT_PERSONAL_EDIT_RECIPE },
    dictionary: [],
  } satisfies PersonalEditPreferences;
}

async function loadAccountPersonalEditPreferences(
  userId: string,
): Promise<PersonalEditPreferences> {
  const [preferences, accountStorageId] = await Promise.all([
    loadPersonalEditPreferencesForUser(userId),
    accountStorageIdForUser(userId),
  ]);
  return { accountStorageId, ...preferences };
}

async function accountStorageIdForUser(userId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`torudake-account-storage-v1\0${userId}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function loadPersonalEditPreferencesForUser(
  userId: string,
): Promise<Omit<PersonalEditPreferences, "accountStorageId">> {
  const database = databaseOrThrow();
  const [recipeRow, dictionaryRows] = await Promise.all([
    database
      .prepare(`
        SELECT version, audio_mode, target_duration_seconds, editing_pace,
          spoken_captions_enabled, spoken_cut_mode, narration_style,
          narration_captions_enabled, narration_auto_cut_enabled,
          narration_original_audio_percent
        FROM personal_edit_recipes
        WHERE user_id = ?
        LIMIT 1
      `)
      .bind(userId)
      .first<RecipeRow>(),
    database
      .prepare(`
        SELECT display_text, reading_text
        FROM pronunciation_dictionary_entries
        WHERE user_id = ?
        ORDER BY position ASC, match_key ASC
        LIMIT 50
      `)
      .bind(userId)
      .all<DictionaryRow>(),
  ]);
  const recipe = recipeRow
    ? normalizePersonalEditRecipe({
        version: recipeRow.version,
        audioMode: recipeRow.audio_mode,
        targetDurationSeconds: recipeRow.target_duration_seconds,
        editingPace: recipeRow.editing_pace,
        spokenCaptionsEnabled: recipeRow.spoken_captions_enabled === 1,
        spokenCutMode: recipeRow.spoken_cut_mode,
        narrationStyle: recipeRow.narration_style,
        narrationCaptionsEnabled: recipeRow.narration_captions_enabled === 1,
        narrationAutoCutEnabled: recipeRow.narration_auto_cut_enabled === 1,
        narrationOriginalAudioPercent:
          recipeRow.narration_original_audio_percent,
      })
    : { ...DEFAULT_PERSONAL_EDIT_RECIPE };
  const dictionary = normalizePronunciationDictionary(
    (dictionaryRows.results ?? []).map((row) => ({
      display: row.display_text,
      reading: row.reading_text,
    })),
  ).map(({ display, reading }) => ({ display, reading }));
  return { recipe, dictionary };
}

function databaseOrThrow() {
  type PreferenceEnvironment = { DB?: D1Database };
  const database = (env as typeof env & PreferenceEnvironment).DB;
  if (!database?.prepare || !database.batch) {
    throw new Error("Personal edit preferences database is unavailable.");
  }
  return database;
}
