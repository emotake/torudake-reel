import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

class D1Statement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.query, values);
  }

  async first() {
    return this.database.sqlite.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return {
      results: this.database.sqlite.prepare(this.query).all(...this.values),
    };
  }

  async raw() {
    return this.database.sqlite
      .prepare(this.query)
      .all(...this.values)
      .map((row) => Object.values(row));
  }

  async run() {
    const result = this.database.sqlite.prepare(this.query).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

class D1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }

  prepare(query) {
    return new D1Statement(this, query);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const migrationDirectory = new URL("../drizzle/", import.meta.url);
const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort();
const migrationSources = await Promise.all(
  migrationFiles.map((name) =>
    readFile(new URL(name, migrationDirectory), "utf8"),
  ),
);
const database = new D1Database();
for (const source of migrationSources) {
  database.sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
}

globalThis.__cloudflareEnv = {
  DB: database,
  TRUST_SITES_AUTH_HEADERS: "true",
};

const preferences = await import("../lib/personal-edit-preferences.ts");
const store = await import("../lib/personal-edit-preferences-store.ts");
const route = await import("../app/api/personal-edit-preferences/route.ts");

test("normalizes a bounded recipe, paused voice, and Japanese display/reading dictionary", () => {
  assert.deepEqual(
    preferences.normalizePersonalEditRecipe({
      audioMode: "narration",
      targetDurationSeconds: 30,
      editingPace: "dynamic",
      spokenCaptionsEnabled: true,
      spokenCutMode: "none",
      narrationStyle: "party",
      narrationCaptionsEnabled: false,
      narrationAutoCutEnabled: true,
      narrationOriginalAudioPercent: 12.6,
    }),
    {
      version: 1,
      audioMode: "narration",
      targetDurationSeconds: 30,
      editingPace: "dynamic",
      spokenCaptionsEnabled: true,
      spokenCutMode: "none",
      narrationStyle: "bright",
      narrationCaptionsEnabled: false,
      narrationAutoCutEnabled: true,
      narrationOriginalAudioPercent: 13,
    },
  );
  assert.deepEqual(
    preferences.normalizePersonalEditRecipe({
      targetDurationSeconds: 45,
      editingPace: "extreme",
      narrationOriginalAudioPercent: 999,
    }),
    {
      ...preferences.DEFAULT_PERSONAL_EDIT_RECIPE,
      narrationOriginalAudioPercent: 20,
    },
  );

  const dictionary = preferences.normalizePronunciationDictionary([
    { display: "  ＡＩ\u0000 音声 ", reading: " エーアイ　おんせい " },
    { display: "ai 音声", reading: "duplicate" },
    { display: "撮るだけリール", reading: "とるだけりーる" },
    { display: "", reading: "empty" },
  ]);
  assert.deepEqual(dictionary, [
    {
      matchKey: "ai 音声",
      display: "AI 音声",
      reading: "エーアイ おんせい",
    },
    {
      matchKey: "撮るだけリール",
      display: "撮るだけリール",
      reading: "とるだけりーる",
    },
  ]);
});

test("stores one account's recipe and dictionary without crossing accounts", async () => {
  const accountA = currentUser("preferences-a");
  const accountB = currentUser("preferences-b");
  const saved = await store.savePersonalEditPreferences(accountA, {
    recipe: {
      audioMode: "narration",
      targetDurationSeconds: 90,
      editingPace: "relaxed",
      spokenCaptionsEnabled: true,
      spokenCutMode: "manual",
      narrationStyle: "bright",
      narrationCaptionsEnabled: false,
      narrationAutoCutEnabled: true,
      narrationOriginalAudioPercent: 8,
    },
    dictionary: [
      { display: "RevenuePilot", reading: "レベニューパイロット" },
      { display: "撮るだけリール", reading: "とるだけりーる" },
    ],
  });
  assert.equal(saved.recipe.audioMode, "narration");
  assert.equal(saved.recipe.narrationOriginalAudioPercent, 8);
  assert.equal(
    saved.accountStorageId,
    expectedAccountStorageId(accountA.id),
  );
  assert.equal(saved.accountStorageId.length, 43);
  assert.doesNotMatch(saved.accountStorageId, /preferences-a/);
  assert.deepEqual(saved.dictionary, [
    { display: "RevenuePilot", reading: "レベニューパイロット" },
    { display: "撮るだけリール", reading: "とるだけりーる" },
  ]);

  const untouched = await store.getPersonalEditPreferences(accountB);
  assert.equal(
    untouched.accountStorageId,
    expectedAccountStorageId(accountB.id),
  );
  assert.notEqual(untouched.accountStorageId, saved.accountStorageId);
  assert.deepEqual(untouched.recipe, preferences.DEFAULT_PERSONAL_EDIT_RECIPE);
  assert.deepEqual(untouched.dictionary, []);

  const recipeOnly = await store.savePersonalEditPreferences(accountA, {
    recipe: { audioMode: "spoken", targetDurationSeconds: 30 },
  });
  assert.equal(recipeOnly.recipe.audioMode, "spoken");
  assert.equal(recipeOnly.recipe.targetDurationSeconds, 30);
  assert.equal(recipeOnly.dictionary.length, 2);
  assert.equal(recipeOnly.accountStorageId, saved.accountStorageId);

  const dictionaryOnly = await store.savePersonalEditPreferences(accountA, {
    dictionary: [{ display: "恵比寿", reading: "えびす" }],
  });
  assert.equal(dictionaryOnly.recipe.targetDurationSeconds, 30);
  assert.deepEqual(dictionaryOnly.dictionary, [
    { display: "恵比寿", reading: "えびす" },
  ]);
  assert.equal(dictionaryOnly.accountStorageId, saved.accountStorageId);
});

test("authenticated API saves, reads and resets preferences with no-store", async () => {
  const headers = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "preferences-route@example.invalid",
  };
  const putResponse = await route.PUT(
    new Request(
      "https://torudake-reel.pages.dev/api/personal-edit-preferences",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          recipe: {
            audioMode: "narration",
            targetDurationSeconds: 60,
            editingPace: "dynamic",
            narrationStyle: "comedy",
            narrationOriginalAudioPercent: 12,
          },
          dictionary: [{ display: "代々木", reading: "よよぎ" }],
        }),
      },
    ),
  );
  assert.equal(putResponse.status, 200);
  assert.equal(putResponse.headers.get("cache-control"), "private, no-store");
  const putPayload = await putResponse.json();
  assert.equal(putPayload.recipe.editingPace, "dynamic");
  assert.equal(putPayload.limits.dictionaryEntries, 50);
  assert.match(putPayload.accountStorageId, /^[a-zA-Z0-9_-]{43}$/);

  const getResponse = await route.GET(
    new Request(
      "https://torudake-reel.pages.dev/api/personal-edit-preferences",
      { headers },
    ),
  );
  assert.equal(getResponse.status, 200);
  const getPayload = await getResponse.json();
  assert.equal(getPayload.accountStorageId, putPayload.accountStorageId);
  assert.deepEqual(getPayload.dictionary, [
    { display: "代々木", reading: "よよぎ" },
  ]);

  const deleteResponse = await route.DELETE(
    new Request(
      "https://torudake-reel.pages.dev/api/personal-edit-preferences",
      { method: "DELETE", headers },
    ),
  );
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.accountStorageId, putPayload.accountStorageId);
  assert.deepEqual(deleted.recipe, preferences.DEFAULT_PERSONAL_EDIT_RECIPE);
  assert.deepEqual(deleted.dictionary, []);
});

test("API rejects anonymous, oversized and over-limit preference writes", async () => {
  const anonymous = await route.GET(
    new Request(
      "https://torudake-reel.pages.dev/api/personal-edit-preferences",
    ),
  );
  assert.equal(anonymous.status, 401);

  const headers = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "preferences-limits@example.invalid",
  };
  const tooMany = await route.PUT(
    new Request(
      "https://torudake-reel.pages.dev/api/personal-edit-preferences",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          dictionary: Array.from({ length: 51 }, (_, index) => ({
            display: `word-${index}`,
            reading: `reading-${index}`,
          })),
        }),
      },
    ),
  );
  assert.equal(tooMany.status, 400);
  assert.equal(
    (await tooMany.json()).code,
    "dictionary_entry_limit_exceeded",
  );

  const oversized = await route.PUT(
    new Request(
      "https://torudake-reel.pages.dev/api/personal-edit-preferences",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ dictionary: [], padding: "x".repeat(33_000) }),
      },
    ),
  );
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "preferences_request_too_large");
});

test("migration is additive, repeat-safe and enforces storage bounds", () => {
  const migration = migrationSources.at(-1);
  assert.equal(migrationFiles.at(-1), "0027_personal_edit_preferences.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `personal_edit_recipes`/u);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS `pronunciation_dictionary_entries`/u,
  );
  assert.match(migration, /PRAGMA optimize/u);

  const repeated = new DatabaseSync(":memory:");
  try {
    repeated.exec(migration.replaceAll("--> statement-breakpoint", ""));
    repeated.exec(migration.replaceAll("--> statement-breakpoint", ""));
    assert.throws(
      () =>
        repeated
          .prepare(`
            INSERT INTO personal_edit_recipes (
              user_id, target_duration_seconds, updated_at
            ) VALUES ('invalid-duration', 45, 1)
          `)
          .run(),
      /constraint failed/iu,
    );
    assert.throws(
      () =>
        repeated
          .prepare(`
            INSERT INTO pronunciation_dictionary_entries (
              user_id, match_key, display_text, reading_text, position,
              updated_at
            ) VALUES ('user', 'word', 'word', 'reading', 50, 1)
          `)
          .run(),
      /constraint failed/iu,
    );
  } finally {
    repeated.close();
  }
});

test("runtime storage uses bound prepared statements and account deletion owns cleanup", async () => {
  const [storeSource, deletionSource] = await Promise.all([
    readFile(
      new URL("../lib/personal-edit-preferences-store.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/account-deletion-executor.ts", import.meta.url), "utf8"),
  ]);
  assert.match(storeSource, /\.prepare\([\s\S]*?\.bind\(/u);
  assert.doesNotMatch(storeSource, /\.exec\(/u);
  assert.match(
    deletionSource,
    /DELETE FROM personal_edit_recipes WHERE user_id = \?/u,
  );
  assert.match(
    deletionSource,
    /DELETE FROM pronunciation_dictionary_entries WHERE user_id = \?/u,
  );
});

function currentUser(suffix) {
  return {
    id: `preferences-${suffix}`,
    email: `${suffix}@example.invalid`,
    billingEmail: null,
    fullName: null,
  };
}

function expectedAccountStorageId(userId) {
  return createHash("sha256")
    .update(`torudake-account-storage-v1\0${userId}`)
    .digest("base64url");
}

test.after(() => {
  database.sqlite.close();
  delete globalThis.__cloudflareEnv;
});
