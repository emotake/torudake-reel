import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const source = await readFile(
  new URL("../lib/client-video-mix-draft.ts", import.meta.url),
  "utf8",
);

function loadModule() {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  Function("module", "exports", "require", javascript)(compiledModule, compiledModule.exports, require);
  return compiledModule.exports;
}

test("stores only fingerprints and editing settings, never file blobs", () => {
  assert.doesNotMatch(source, /\bFile\b|\bBlob\b/);
  assert.match(source, /fingerprint/);
  assert.match(source, /boundaryTransitions/);
  assert.match(source, /framing/);
});

test("reads a valid video mix draft and rejects corrupt data", () => {
  const { readVideoMixClientDraft, VIDEO_MIX_DRAFT_STORAGE_KEY } = loadModule();
  const draft = {
    version: 1,
    savedAt: 1,
    sources: [{
      id: "a",
      fingerprint: "clip.mov:1:2:video/quicktime",
      name: "clip.mov",
      duration: 5,
      width: 1920,
      height: 1080,
      clips: [{ start: 0, end: 2 }],
      framing: { mode: "blur", focusX: 0.5, focusY: 0.5 },
    }],
    transition: "crossfade",
    boundaryTransitions: {},
    narrationEnabled: false,
    narrationCaptionsEnabled: true,
    narrationStyle: "bright",
    narrationGoal: "follow",
    narrationBrief: "",
  };
  const storage = { getItem: (key) => key === VIDEO_MIX_DRAFT_STORAGE_KEY ? JSON.stringify(draft) : null };
  assert.equal(readVideoMixClientDraft(storage)?.sources[0].name, "clip.mov");
  assert.equal(readVideoMixClientDraft({ getItem: () => "not-json" }), null);
});

test("clamps restored cuts and rejects overlapping or tiny ranges", () => {
  const { clampVideoMixDraftClips } = loadModule();
  assert.deepEqual(clampVideoMixDraftClips([{ start: 1, end: 20 }], 5), [{ start: 1, end: 5 }]);
  assert.equal(clampVideoMixDraftClips([{ start: 0, end: 1 }, { start: 0.5, end: 2 }], 5), null);
  assert.equal(clampVideoMixDraftClips([{ start: 0, end: 0.2 }], 5), null);
});

test("defaults portrait sources to cover and wider sources to a blurred fill", () => {
  const { defaultVideoMixFraming } = loadModule();
  assert.equal(defaultVideoMixFraming(1080, 1920).mode, "cover");
  assert.equal(defaultVideoMixFraming(1920, 1080).mode, "blur");
});
