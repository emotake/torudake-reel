import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [draftSource, pageSource] = await Promise.all([
  readFile(new URL("../lib/client-edit-draft.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
]);

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

test("puts the one-time save before monthly plans at the result gate", () => {
  const gate = pageSource.slice(pageSource.indexOf('id="free-export-plans"'));
  assert.ok(gate.indexOf('checkout=one_time') < gate.indexOf('checkout=starter'));
  assert.ok(gate.indexOf('checkout=starter') < gate.indexOf('checkout=standard'));
  assert.match(pageSource, /この動画1本を¥/);
  assert.match(pageSource, /resultPrimaryAction/);
});

test("groups optional result controls into accessible disclosure sections", () => {
  assert.match(pageSource, /<details className="narrationStudio resultDetailCard">/);
  assert.match(pageSource, /<details className="editPanel resultDetailCard">/);
  assert.match(pageSource, /<details className="thumbnailMaker resultDetailCard">/);
  assert.match(pageSource, /<details className="deliverables resultDetailCard">/);
  assert.match(pageSource, /動画・音声・字幕の内容は送信されません/);
});
