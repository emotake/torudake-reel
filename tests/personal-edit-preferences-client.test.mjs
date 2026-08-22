import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, cssSource] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("restores and saves the usual finish without triggering AI", () => {
  assert.match(pageSource, /torudake-personal-edit-preferences/);
  assert.match(pageSource, /fetch\("\/api\/personal-edit-preferences"/);
  assert.match(pageSource, /method: "PUT"/);
  assert.match(pageSource, /この設定を「いつもの仕上がり」として記憶/);
  assert.match(pageSource, /次の動画では、音声モード・長さ・テロップ・カット・元音量を自動で呼び戻します/);
  assert.match(pageSource, /登録・削除だけではAI処理回数や料金は増えません/);
  assert.match(pageSource, /preDemoPersonalRecipeRef/);
  assert.match(pageSource, /if \(!personalPreferencesHydrated \|\| isDemoSample\) return/);

  const resetSource = pageSource.slice(
    pageSource.indexOf("function reset()"),
    pageSource.indexOf("function explainAuthenticationRequired()"),
  );
  assert.doesNotMatch(resetSource, /setAudioMode\(/);
  assert.doesNotMatch(resetSource, /setSpokenCutMode\(/);
  assert.doesNotMatch(resetSource, /setNarrationOriginalAudio\(/);
});

test("reuses saved names for transcription and narration while keeping display text", () => {
  assert.match(pageSource, /名前や商品名の読み方を記憶/);
  assert.match(pageSource, /buildSavedNarrationPronunciationGuide\(\s*personalDictionary/);
  assert.match(pageSource, /attachNarrationPronunciationReadings\(/);
  assert.match(pageSource, /rememberPronunciationEntries\(/);
  assert.match(
    pageSource,
    /\.\.\.sanitizeAsrUserDictionary\(asrDictionaryInput\),[\s\S]*?\.\.\.personalDictionary\.map\(\(entry\) => entry\.display\)/,
  );
  assert.match(cssSource, /\.personalDictionaryPanel\s*\{/);
  assert.match(cssSource, /\.personalDictionaryForm input\s*\{/);
  assert.match(cssSource, /min-height:\s*44px/);
});

test("keeps anonymous preferences separate from authenticated account caches", () => {
  assert.match(
    pageSource,
    /ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY\s*=\s*`\$\{PERSONAL_EDIT_PREFERENCES_STORAGE_KEY\}:anonymous`/,
  );
  assert.match(
    pageSource,
    /ACCOUNT_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY_PREFIX\s*=\s*`\$\{PERSONAL_EDIT_PREFERENCES_STORAGE_KEY\}:account:`/,
  );
  assert.match(
    pageSource,
    /\^\[a-zA-Z0-9_-\]\{43\}\$[\s\S]*ACCOUNT_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY_PREFIX/,
  );
  assert.doesNotMatch(pageSource, /fetch\("\/api\/billing\/status"/);

  const syncStart = pageSource.indexOf(
    "personalPreferencesMountedRef.current = true;",
  );
  const saveStart = pageSource.indexOf(
    "if (!personalPreferencesHydrated || isDemoSample) return;",
    syncStart,
  );
  const syncSource = pageSource.slice(syncStart, saveStart);
  const authenticationHintIndex = syncSource.indexOf(
    "const localPreferences = readLocalPersonalEditPreferences(",
  );
  const hintDecisionIndex = syncSource.indexOf("if (!hasAuthenticationHint)");
  assert.ok(hintDecisionIndex >= 0);
  assert.ok(authenticationHintIndex > hintDecisionIndex);
  assert.match(
    syncSource,
    /const responsePayload: unknown = await response\.json\(\)[\s\S]*authenticatedPersonalPreferencesStorageKey\(responsePayload\)[\s\S]*applyPersonalEditPreferences\(preferences\)[\s\S]*setPersonalPreferencesHydrated\(true\)/,
  );
  assert.match(
    pageSource,
    /migrateLegacyAnonymous[\s\S]*localStorage\.setItem\(storageKey[\s\S]*localStorage\.removeItem\(PERSONAL_EDIT_PREFERENCES_STORAGE_KEY\)/,
  );
});

test("reports failed preference saves and cancels stale requests", () => {
  const saveStart = pageSource.indexOf(
    "if (!personalPreferencesHydrated || isDemoSample) return;",
  );
  const saveEnd = pageSource.indexOf("void loadLocalEditDraft()", saveStart);
  const saveSource = pageSource.slice(saveStart, saveEnd);

  assert.match(saveSource, /const controller = new AbortController\(\)/);
  assert.match(saveSource, /signal: controller\.signal/);
  assert.match(saveSource, /if \(!response\.ok\) \{\s*setPersonalPreferencesSyncStatus\("unavailable"\)/);
  assert.match(
    saveSource,
    /\.catch\(\(error: unknown\) => \{[\s\S]*setPersonalPreferencesSyncStatus\("unavailable"\)/,
  );
  assert.match(saveSource, /window\.clearTimeout\(timeout\);\s*controller\.abort\(\)/);
});
