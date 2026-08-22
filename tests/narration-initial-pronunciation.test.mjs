import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/narration/script/route.ts", import.meta.url),
  "utf8",
);
const pageSource = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);

test("validates at most twenty saved readings before an initial narration request", () => {
  assert.match(routeSource, /pronunciationGuide\?: unknown/);
  assert.match(
    routeSource,
    /validateNarrationPronunciationGuide\(\s*pronunciationGuide,?\s*\)/,
  );
  assert.match(routeSource, /MAX_PRONUNCIATION_GUIDE_LENGTH/);
  assert.match(pageSource, /if \(validRows\.length >= 20\) break/);
});

test("signs and verifies the speech reading while returning display text unchanged", () => {
  const verificationStart = routeSource.indexOf(
    "const claims = await verifyInitialNarrationToken",
  );
  const verificationEnd = routeSource.indexOf(
    "if (!claims || claims.n !== 1)",
    verificationStart,
  );
  const verification = routeSource.slice(verificationStart, verificationEnd);
  const signingStart = routeSource.indexOf(
    "responseNarrationBundleToken = await createInitialNarrationToken",
  );
  const signingEnd = routeSource.indexOf(
    "scriptAttempt,",
    signingStart,
  );
  const signing = routeSource.slice(signingStart, signingEnd);
  const responseStart = routeSource.indexOf(
    'await recordServerProductEvent(request, "ai_operation_succeeded"',
    signingEnd,
  );
  const responseEnd = routeSource.indexOf("\n  } catch (error)", responseStart);
  const response = routeSource.slice(responseStart, responseEnd);

  assert.match(
    verification,
    /script: applyNarrationPronunciationGuide\(\s*previousScript,\s*pronunciationGuide,?\s*\)/,
  );
  assert.match(
    signing,
    /script: applyNarrationPronunciationGuide\(\s*plan\.script,\s*pronunciationGuide,?\s*\)/,
  );
  assert.match(response, /\{ \.\.\.plan, narrationBundleToken:/);
  assert.doesNotMatch(response, /applyNarrationPronunciationGuide/);
});

test("bundles saved readings into the existing initial operation without another API call", () => {
  const start = pageSource.indexOf("async function startNarrationEditing()");
  const end = pageSource.indexOf("\n  async function regenerateNarration(", start);
  const initialFlow = pageSource.slice(start, end);
  const requestHelperStart = pageSource.indexOf(
    "async function requestNarrationPlan({",
  );
  const requestHelperEnd = pageSource.indexOf(
    "\nasync function reserveVideoUsage(",
    requestHelperStart,
  );
  const requestHelper = pageSource.slice(requestHelperStart, requestHelperEnd);

  assert.match(
    initialFlow,
    /const initialNarrationOperationId = crypto\.randomUUID\(\)/,
  );
  assert.match(
    initialFlow,
    /const initialPronunciationGuide = buildSavedNarrationPronunciationGuide\(\s*personalDictionary,?\s*\)/,
  );
  assert.equal(
    (initialFlow.match(/pronunciationGuide: initialPronunciationGuide/g) ?? [])
      .length,
    2,
    "the first script request and automatic timing retry must use the same guide",
  );
  assert.equal(
    (initialFlow.match(/requestNarrationSpeech\(\s*speechScript,/g) ?? [])
      .length,
    2,
  );
  assert.match(initialFlow, /attachNarrationPronunciationReadings/);
  assert.doesNotMatch(initialFlow, /personal-edit-preferences/);
  assert.match(requestHelper, /pronunciationGuide,/);
  assert.match(requestHelper, /body: JSON\.stringify\(\{[\s\S]*pronunciationGuide,/);
});

test("the result editor only marks readings actually sent with the initial operation", () => {
  const resultStart = pageSource.indexOf("function ResultWorkspace({");
  const resultEnd = pageSource.indexOf("\nfunction ", resultStart + 1);
  const resultSource = pageSource.slice(resultStart, resultEnd);

  assert.match(
    pageSource,
    /setInitialNarrationPronunciationGuide\(initialPronunciationGuide\)/,
  );
  assert.match(resultSource, /initialNarrationPronunciationGuide: string/);
  assert.match(
    resultSource,
    /validateNarrationPronunciationGuide\(\s*initialNarrationPronunciationGuide,?\s*\)/,
  );
  assert.match(
    resultSource,
    /validation\.entries[\s\S]*narrationPlan\?\.script\.includes\(entry\.surface\)/,
  );
  assert.doesNotMatch(
    resultSource,
    /personalDictionary[\s\S]*\.filter\([\s\S]*narrationPlan\?\.script/,
  );
});
