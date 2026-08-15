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

test("keeps decorative motion optional and content order semantic", () => {
  assert.match(visualCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(visualCss, /animation-duration:\s*0\.01ms !important/);
  assert.match(globalCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none !important/);
  const richCss = globalCss.slice(globalCss.indexOf("Rich home preview"));
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
