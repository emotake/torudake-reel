import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [landingSource, visualSource, visualCss] = await Promise.all([
  readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.module.css", import.meta.url), "utf8"),
]);

const homeVisualSource = `${landingSource}\n${visualSource}`;

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

test("places an editorial real-media hero before the creation choices", () => {
  const heroIndex = landingSource.indexOf("<HomeEditorialHero");
  const chooserIndex = landingSource.indexOf("<CreationChooser");

  assert.ok(heroIndex >= 0 && heroIndex < chooserIndex);
  assert.match(visualSource, /export\s+function\s+HomeEditorialHero\b/);
  assert.match(visualSource, /<figure\b[^>]*aria-(?:label|labelledby)=/s);
  assert.match(visualSource, /<figcaption\b/);
});

test("uses real media to distinguish all three creation modes", () => {
  assert.match(visualSource, /export\s+function\s+ModeMediaVisual\b/);
  for (const mode of ["single", "multiple", "photos"]) {
    assert.match(landingSource, new RegExp(`<ModeMediaVisual mode="${mode}"`));
  }

  assert.match(visualSource, /role=["']img["']/);
  assert.match(visualSource, /aria-label=/);
  assert.match(landingSource, /onClick=\{openPicker\}/);
  assert.match(landingSource, /href="\/video-mix"/);
  assert.match(landingSource, /href="\/photo-reel"/);
});

test("renders the real source scenes and finished poster with intrinsic image metadata", () => {
  const stillStart = visualSource.indexOf("function Still");
  const heroStart = visualSource.indexOf("export function HomeEditorialHero");
  assert.ok(stillStart >= 0 && heroStart > stillStart);
  const stillRenderer = visualSource.slice(stillStart, heroStart);

  assert.match(stillRenderer, /<img\b/);
  assert.match(stillRenderer, /\bwidth=(?:\{\d+\}|["']\d+["'])/);
  assert.match(stillRenderer, /\bheight=(?:\{\d+\}|["']\d+["'])/);
  assert.match(stillRenderer, /\balt=(?:\{[^}]*\}|["'][^"']*["'])/);

  for (const asset of [
    "torudake-demo-scene-rain.jpg",
    "torudake-demo-scene-sea.jpg",
    "torudake-demo-scene-river.jpg",
    "torudake-demo-poster.jpg",
  ]) {
    assert.match(
      visualSource,
      new RegExp(`<(?:Still|img)\\b[^>]*src=["'][^"']*${asset.replace(".", "\\.")}["']`),
    );
  }

  assert.doesNotMatch(visualSource, /\bautoPlay\b|\bautoplay\b/i);
});

test("removes fake editing interfaces, comparison controls, and motion scaffolding", () => {
  for (const retiredName of [
    "HeroOutcomeVisual",
    "ModeMiniVisual",
    "WorkflowMiniVisual",
    "HomeTransformationCompare",
    "HomeMotionExperience",
  ]) {
    assert.doesNotMatch(homeVisualSource, new RegExp(`\\b${retiredName}\\b`));
  }

  assert.doesNotMatch(homeVisualSource, /data-home-motion/);
  assert.doesNotMatch(homeVisualSource, /data-home-compare/);
  assert.doesNotMatch(homeVisualSource, /\bmockWindow\b|\bmockBar\b/);
  assert.doesNotMatch(
    homeVisualSource,
    /\b(?:heroPhone|phoneScreen|settingMiniPhone|previewPhone|finishedPhone)\b/,
  );
  assert.doesNotMatch(homeVisualSource, /type=["']range["']/);
});

test("keeps the real-media presentation still and readable", () => {
  assert.doesNotMatch(visualCss, /@keyframes\b/i);
  assert.doesNotMatch(visualCss, /\banimation(?:-[a-z-]+)?\s*:/i);
  assert.doesNotMatch(visualCss, /\binfinite\b/i);

  const pixelFontSizes = Array.from(
    visualCss.matchAll(/font-size:\s*([\d.]+)px\b/gi),
    (match) => Number(match[1]),
  );
  for (const fontSize of pixelFontSizes) {
    assert.ok(fontSize >= 12, `Found undersized ${fontSize}px text in the home media CSS`);
  }
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
