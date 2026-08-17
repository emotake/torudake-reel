import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [landingSource, visualSource, visualCss, pageSource, globalCss] = await Promise.all([
  readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/home-rich-visuals.module.css", import.meta.url), "utf8"),
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

const homeVisualSource = `${landingSource}\n${visualSource}`;

function modeConditionalSource(mode, nextMode) {
  const startMarker = `{mode === "${mode}" ? (`;
  const start = visualSource.indexOf(startMarker);
  assert.ok(start >= 0, `Missing ${mode} visual branch`);

  if (!nextMode) return visualSource.slice(start);
  const end = visualSource.indexOf(`{mode === "${nextMode}" ? (`, start);
  assert.ok(end > start, `Could not isolate ${mode} visual branch`);
  return visualSource.slice(start, end);
}

function localDemoAssets(source) {
  return new Set(
    Array.from(
      source.matchAll(/src=["'](\/demo\/[^"']+)["']/g),
      (match) => match[1],
    ),
  );
}

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

test("places one playable finished video before the creation choices", () => {
  const homeSource = landingSource.slice(
    landingSource.indexOf("export function HomeLanding"),
    landingSource.indexOf("export function VideoEditLanding"),
  );
  const heroIndex = homeSource.indexOf('className="landingHeroResult"');
  const demoIndex = homeSource.indexOf("{props.demo}", heroIndex);
  const chooserIndex = homeSource.indexOf("<CreationChooser");
  const demoSource = pageSource.slice(
    pageSource.indexOf("function RealVideoDemo"),
    pageSource.indexOf("function Landing", pageSource.indexOf("function RealVideoDemo")),
  );

  assert.ok(heroIndex >= 0 && heroIndex < demoIndex && demoIndex < chooserIndex);
  assert.equal((homeSource.match(/\{props\.demo\}/g) ?? []).length, 1);
  assert.match(
    demoSource,
    /<video[\s\S]*?\bcontrols\b[\s\S]*?\bplaysInline\b[\s\S]*?preload="none"[\s\S]*?poster="\/demo\/torudake-demo-poster\.jpg"/,
  );
  assert.match(demoSource, /<source src="\/demo\/torudake-demo\.mp4" type="video\/mp4" \/>/);
  assert.match(demoSource, /<track[\s\S]*?\bdefault\b[\s\S]*?kind="captions"/);
  assert.doesNotMatch(demoSource, /\bautoPlay\b|\bmuted\b|\bloop\b/);
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
  assert.match(landingSource, />動画 1本</);
  assert.match(landingSource, />動画 2〜5本</);
  assert.match(landingSource, />写真 2〜10枚</);
});

test("does not present multiple videos and photos as the same material in a different grid", async () => {
  const multipleSource = modeConditionalSource("multiple", "photos");
  const photosSource = modeConditionalSource("photos");
  const multipleAssets = localDemoAssets(multipleSource);
  const photoAssets = localDemoAssets(photosSource);

  assert.match(visualSource, /multiple:\s*["']video-sequence["']/);
  assert.match(visualSource, /photos:\s*["']photo-selection["']/);
  assert.match(visualSource, /data-visual-kind=\{MODE_VISUAL_KINDS\[mode\]\}/);
  assert.match(multipleSource, /data-mode-item=["']video["']/);
  assert.match(photosSource, /data-mode-item=["']photo["']/);

  assert.ok(multipleAssets.size >= 2, "The video sequence needs at least two visible clips");
  assert.ok(photoAssets.size >= 2, "The photo selection needs at least two visible photos");
  assert.deepEqual(
    [...multipleAssets].filter((asset) => photoAssets.has(asset)),
    [],
    "Video thumbnails and photo examples must use different source material",
  );

  for (const asset of multipleAssets) {
    const bytes = await readFile(new URL(`../public${asset}`, import.meta.url));
    const dimensions = jpegDimensions(bytes);
    assert.ok(
      dimensions.height > dimensions.width,
      `${asset} must read as a portrait video clip`,
    );
  }
  for (const asset of photoAssets) {
    const bytes = await readFile(new URL(`../public${asset}`, import.meta.url));
    const dimensions = jpegDimensions(bytes);
    assert.ok(
      dimensions.width > dimensions.height,
      `${asset} must read as a landscape photo selection`,
    );
  }
});

test("describes each mode clearly without exposing decorative thumbnails to assistive tech", () => {
  assert.match(
    visualSource,
    /multiple:\s*["'][^"']*動画[^"']*(?:つな|順番|シーン)[^"']*["']/,
  );
  assert.match(
    visualSource,
    /photos:\s*["'][^"']*写真[^"']*(?:選|リール|動き)[^"']*["']/,
  );
  assert.match(visualSource, /role=["']img["'][\s\S]*aria-label=\{MODE_LABELS\[mode\]\}/);

  const stillStart = visualSource.indexOf("function Still");
  const modeStart = visualSource.indexOf("export function ModeMediaVisual");
  const stillRenderer = visualSource.slice(stillStart, modeStart);
  assert.match(stillRenderer, /<img[\s\S]*?alt=["']["']/);
});

test("keeps every mode preview contained at narrow viewport widths", () => {
  assert.match(visualCss, /\.modeMedia\s*\{[\s\S]*?width:\s*100%[\s\S]*?overflow:\s*hidden/);
  assert.match(visualCss, /\.modeMedia img\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*100%/);
  assert.match(visualCss, /@media\s*\(max-width:\s*420px\)/);
  assert.match(
    globalCss,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.creationModeCard[\s\S]*?grid-template-columns:\s*116px minmax\(0, 1fr\)[\s\S]*?> \[role="img"\][\s\S]*?height:\s*116px/,
  );
  assert.match(
    globalCss,
    /@media\s*\(max-width:\s*340px\)[\s\S]*?> \[role="img"\][\s\S]*?height:\s*104px/,
  );
});

test("renders the real source scenes with intrinsic image metadata", () => {
  const stillStart = visualSource.indexOf("function Still");
  const modeStart = visualSource.indexOf("export function ModeMediaVisual");
  assert.ok(stillStart >= 0 && modeStart > stillStart);
  const stillRenderer = visualSource.slice(stillStart, modeStart);

  assert.match(stillRenderer, /<img\b/);
  assert.ok(
    /\bwidth=(?:\{\d+\}|["']\d+["'])/.test(stillRenderer) ||
      (/\bwidth=\{width\}/.test(stillRenderer) && /\bwidth\s*=\s*\d+/.test(stillRenderer)),
    "Still images need a numeric intrinsic width",
  );
  assert.ok(
    /\bheight=(?:\{\d+\}|["']\d+["'])/.test(stillRenderer) ||
      (/\bheight=\{height\}/.test(stillRenderer) && /\bheight\s*=\s*\d+/.test(stillRenderer)),
    "Still images need a numeric intrinsic height",
  );
  assert.match(stillRenderer, /\balt=(?:\{[^}]*\}|["'][^"']*["'])/);

  for (const asset of [
    "torudake-demo-scene-rain.jpg",
    "torudake-demo-scene-sea.jpg",
    "torudake-demo-scene-river.jpg",
  ]) {
    assert.match(
      visualSource,
      new RegExp(`<(?:Still|img)\\b[^>]*src=["'][^"']*${asset.replace(".", "\\.")}["']`),
    );
  }

  assert.doesNotMatch(homeVisualSource, /\bautoPlay\b|\bautoplay\b/i);
});

test("removes fake editing interfaces, comparison controls, and motion scaffolding", () => {
  for (const retiredName of [
    "HeroOutcomeVisual",
    "ModeMiniVisual",
    "WorkflowMiniVisual",
    "HomeEditorialHero",
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

test("keeps the mode previews still and readable", () => {
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
