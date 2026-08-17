import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);

const [draftSource, pageSource] = await Promise.all([
  readFile(new URL("../lib/client-edit-draft.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
]);

function loadDraftModule() {
  const javascript = ts.transpileModule(draftSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  Function("module", "exports", "require", javascript)(
    compiledModule,
    compiledModule.exports,
    require,
  );
  return compiledModule.exports;
}

test("keeps edit recovery device-local without storing video bytes", () => {
  assert.match(draftSource, /indexedDB\.open/);
  assert.match(draftSource, /sessionStorage/);
  assert.match(draftSource, /fingerprint: VideoDraftFingerprint/);
  assert.doesNotMatch(draftSource, /arrayBuffer\(|FileReader|Blob/);
  assert.match(draftSource, /matchesVideoDraftFingerprint/);
  assert.match(pageSource, /同じ動画を選んで再開/);
  assert.match(pageSource, /前回の編集データをこの端末から削除/);
  assert.match(pageSource, /clearLocalEditDraft/);
});

test("puts monthly plans before the closed one-time rescue at the result gate", () => {
  const gate = pageSource.slice(pageSource.indexOf('id="free-export-plans"'));
  assert.ok(gate.indexOf('checkout=starter') < gate.indexOf('checkout=standard'));
  assert.ok(gate.indexOf('checkout=standard') < gate.indexOf('checkout=one_time'));
  assert.match(gate, /<OneTimeRescue[\s\S]*?この1本だけ・¥/);
  assert.match(pageSource, /resultPrimaryAction/);
});

test("groups optional result controls into accessible disclosure sections", () => {
  assert.match(pageSource, /<details className="narrationStudio resultDetailCard">/);
  assert.match(pageSource, /<details className="editPanel resultDetailCard">/);
  assert.match(pageSource, /<details className="thumbnailMaker resultDetailCard">/);
  assert.match(pageSource, /<details className="deliverables resultDetailCard">/);
  assert.match(pageSource, /動画・音声・字幕の内容は送信されません/);
});

test("normalizes legacy caption preferences to safe mode-specific defaults", () => {
  const { normalizeLocalEditDraft } = loadDraftModule();
  const base = {
    version: 1,
    savedAt: 1,
    fingerprint: {
      name: "clip.mov",
      size: 1,
      lastModified: 1,
      type: "video/quicktime",
      durationSeconds: 10,
    },
    resultReady: true,
    goal: "follow",
    length: 60,
    audioMode: "spoken",
    spokenCutMode: "none",
    narrationStyle: "calm",
    narrationOriginalAudio: 0,
    narrationBrief: "",
    narrationAutoCutEnabled: false,
    captionProfile: {},
    transcript: [],
    usedHighAccuracy: false,
  };
  assert.equal(normalizeLocalEditDraft(base).spokenCaptionsEnabled, false);
  assert.equal(normalizeLocalEditDraft(base).narrationCaptionsEnabled, true);
  assert.equal(
    normalizeLocalEditDraft({
      ...base,
      spokenCaptionsEnabled: true,
      narrationCaptionsEnabled: false,
    }).spokenCaptionsEnabled,
    true,
  );
  assert.equal(
    normalizeLocalEditDraft({
      ...base,
      spokenCaptionsEnabled: true,
      narrationCaptionsEnabled: false,
    }).narrationCaptionsEnabled,
    false,
  );
  assert.equal(normalizeLocalEditDraft({ ...base, audioMode: "invalid" }), null);
  assert.equal(normalizeLocalEditDraft({ ...base, spokenCutMode: undefined }), null);
});
