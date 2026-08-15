import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [landingSource, visualSource, visualCss, globalCss] = await Promise.all([
  readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.module.css", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

function jpegDimensions(bytes) {
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += segmentLength + 2;
  }
  throw new Error("JPEG size marker not found");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function cssBlock(source, selector) {
  const selectorIndex = source.indexOf(selector);
  assert.ok(selectorIndex >= 0, `Missing CSS selector: ${selector}`);
  const openingBrace = source.indexOf("{", selectorIndex);
  assert.ok(openingBrace >= 0, `Missing opening brace for: ${selector}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  throw new Error(`Missing closing brace for: ${selector}`);
}

test("places visual proof before the three creation choices", () => {
  const heroIndex = landingSource.indexOf("<HeroOutcomeVisual");
  const chooserIndex = landingSource.indexOf("<CreationChooser");
  assert.ok(heroIndex >= 0 && heroIndex < chooserIndex);
  assert.match(visualSource, /<figure className=\{styles\.heroOutcome\}>/);
  assert.match(visualSource, /<figcaption>/);
  assert.match(visualSource, /素材.*3つの場面/s);
  assert.match(visualSource, /完成プレビュー/);
});

test("gives every creation mode a distinct labelled preview", () => {
  for (const mode of ["single", "multiple", "photos"]) {
    assert.match(landingSource, new RegExp(`<ModeMiniVisual mode="${mode}"`));
    assert.match(visualSource, new RegExp(`${mode}:`));
  }
  assert.match(visualSource, /role="img"/);
  assert.match(visualSource, /aria-label=\{MODE_LABELS\[mode\]\}/);
  assert.match(landingSource, /href="\/video-mix"/);
  assert.match(landingSource, /href="\/photo-reel"/);
  assert.match(landingSource, /onClick=\{openPicker\}/);
});

test("shows the before-and-after story and three real workflow previews", () => {
  for (const scene of ["rain", "sea", "river"]) {
    assert.match(landingSource, new RegExp(`demoSceneThumb is${scene[0].toUpperCase()}${scene.slice(1)}`));
  }
  assert.match(landingSource, /編集前に選んだ3つの場面/);
  assert.match(landingSource, /10秒の完成動画へ/);
  for (const step of ["select", "settings", "preview"]) {
    assert.match(landingSource, new RegExp(`<WorkflowMiniVisual step="${step}"`));
  }
  assert.match(visualSource, /aria-label=\{WORKFLOW_LABELS\[step\]\}/);
});

test("uses compact settings and preview artwork without squeezing explanatory copy", () => {
  const settingsSource = sourceBetween(
    visualSource,
    "function SettingsArtwork()",
    "function PreviewArtwork()",
  );
  const previewSource = sourceBetween(visualSource, "function PreviewArtwork()");

  for (const className of [
    "settingMiniPhone",
    "settingCaptionLines",
    "settingTools",
    "soundTool",
    "captionTool",
    "settingsDone",
  ]) {
    assert.match(settingsSource, new RegExp(`styles\\.${className}\\b`));
  }
  for (const className of [
    "previewStage",
    "previewPhone",
    "previewCaptionLines",
    "previewProgress",
    "readyChip",
    "previewFinishMark",
  ]) {
    assert.match(previewSource, new RegExp(`styles\\.${className}\\b`));
  }

  assert.match(visualSource, /settings:\s*"音声とテロップを選ぶ操作画面のイメージ"/);
  assert.match(visualSource, /preview:\s*"完成前に縦型動画を確認する画面のイメージ"/);
  assert.doesNotMatch(settingsSource, /元の音声|AI音声|設定できました/);
  assert.doesNotMatch(previewSource, /今日の景色を、15秒に。|プレビュー準備完了|仕上がりを見る|戻る/);
});

test("keeps settings and preview artwork contained at narrow card widths", () => {
  const workflowVisualCss = cssBlock(visualCss, ".workflowVisual");
  const mockWindowCss = cssBlock(visualCss, ".mockWindow");
  const settingPhoneCss = cssBlock(visualCss, ".settingMiniPhone");
  const settingToolsCss = cssBlock(visualCss, ".settingTools");
  const settingControlCss = cssBlock(visualCss, ".soundTool,");
  const previewPhoneCss = cssBlock(visualCss, ".previewPhone");
  const narrowCss = cssBlock(visualCss, "@container (max-width: 150px)");
  const narrowSettingsCss = cssBlock(narrowCss, ".settingsArtwork {");
  const narrowSettingPhoneCss = cssBlock(narrowCss, ".settingMiniPhone");
  const narrowSettingToolsCss = cssBlock(narrowCss, ".settingTools");
  const narrowPreviewStageCss = cssBlock(narrowCss, ".previewStage");
  const narrowMockLabelCss = cssBlock(narrowCss, ".workflow_settings .mockBar small,");
  const narrowFinishMarkCss = cssBlock(narrowCss, ".workflow_preview .previewFinishMark");
  const extraNarrowCss = cssBlock(visualCss, "@container (max-width: 100px)");
  const extraNarrowSettingsDoneCss = cssBlock(
    extraNarrowCss,
    ".workflow_settings .settingsDone",
  );

  assert.match(workflowVisualCss, /container-type:\s*inline-size/);
  assert.match(workflowVisualCss, /overflow:\s*hidden/);
  assert.match(mockWindowCss, /overflow:\s*hidden/);
  assert.match(settingPhoneCss, /width:\s*100%/);
  assert.match(settingPhoneCss, /overflow:\s*hidden/);
  assert.match(settingToolsCss, /min-width:\s*0/);
  assert.match(settingControlCss, /min-width:\s*0/);
  assert.match(settingControlCss, /overflow:\s*hidden/);
  assert.match(settingControlCss, /box-sizing:\s*border-box/);
  assert.match(previewPhoneCss, /width:\s*100%/);
  assert.match(previewPhoneCss, /overflow:\s*hidden/);

  assert.match(
    narrowSettingsCss,
    /grid-template-columns:\s*minmax\(26px,\s*38px\)\s+minmax\(0,\s*1fr\)/,
  );
  assert.match(narrowSettingsCss, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(narrowSettingPhoneCss, /width:\s*clamp\([^;]*100%[^;]*\)/);
  assert.match(narrowSettingToolsCss, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(narrowSettingToolsCss, /grid-template-rows:\s*repeat\(2,\s*28px\)/);
  assert.match(narrowPreviewStageCss, /width:\s*auto/);
  assert.match(narrowPreviewStageCss, /max-width:\s*100%/);
  assert.match(narrowPreviewStageCss, /height:\s*100%/);
  assert.match(narrowMockLabelCss, /display:\s*none/);
  assert.match(narrowFinishMarkCss, /display:\s*none/);
  assert.match(extraNarrowSettingsDoneCss, /display:\s*none/);
  assert.doesNotMatch(narrowCss, /grid-template-columns:\s*74px\s+1fr/);
  assert.doesNotMatch(narrowCss, /overflow:\s*(?:visible|auto|scroll)/);
  assert.doesNotMatch(narrowCss, /writing-mode:\s*vertical/);
  assert.match(globalCss, /\.homeBenefitGrid span,\s*\.homeStepCopy > span\s*\{/);
  assert.doesNotMatch(globalCss, /\.homeStepGrid span\s*\{/);
});

test("keeps decorative motion optional and content order semantic", () => {
  const richMarkerIndex = globalCss.indexOf("Rich home preview");
  assert.ok(richMarkerIndex >= 0);
  const richCss = globalCss.slice(richMarkerIndex);
  assert.match(visualCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(visualCss, /animation-duration:\s*0\.01ms !important/);
  assert.match(richCss, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?transition:\s*none !important;[\s\S]*?\n\}/);
  assert.doesNotMatch(richCss, /\border:\s*-[1-9]/);
});

for (const scene of ["rain", "sea", "river"]) {
  test(`ships a lightweight 9:16 ${scene} demo still`, async () => {
    const bytes = await readFile(
      new URL(`../public/demo/torudake-demo-scene-${scene}.jpg`, import.meta.url),
    );
    assert.deepEqual(jpegDimensions(bytes), { width: 360, height: 640 });
    assert.ok(bytes.byteLength < 100_000);
  });
}
