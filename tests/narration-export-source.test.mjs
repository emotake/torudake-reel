import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("prepares the narration audio context before recording disclosure", () => {
  const start = pageSource.indexOf("async function confirmNarrationExport()");
  const end = pageSource.indexOf("\n  return (", start);
  const confirmationFlow = pageSource.slice(start, end);
  const prepareIndex = confirmationFlow.indexOf(
    "createRunningNarrationAudioContext()",
  );
  const recordIndex = confirmationFlow.indexOf(
    "recordDisclosureConfirmation()",
  );
  const exportIndex = confirmationFlow.indexOf("exportCaptionedVideo(");

  assert.ok(prepareIndex >= 0);
  assert.ok(prepareIndex < recordIndex);
  assert.ok(recordIndex < exportIndex);
});

test("exports decoded narration through an AudioBuffer source", () => {
  const start = pageSource.indexOf("async function exportCaptionedVideo(");
  const end = pageSource.indexOf(
    "\n  function requestVideoExport()",
    start,
  );
  const exportFlow = pageSource.slice(start, end);

  assert.match(exportFlow, /decodeAudioData\(narrationBytes\)/);
  assert.match(exportFlow, /createBufferSource\(\)/);
  assert.match(exportFlow, /getNarrationBufferSlice\(/);
  assert.doesNotMatch(
    exportFlow,
    /createMediaElementSource\(exportNarration\)/,
  );
});
