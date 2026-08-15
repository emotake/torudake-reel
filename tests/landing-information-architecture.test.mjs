import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [pageSource, landingSource, cssSource, videoEditSource, sitemapSource] =
  await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/video-edit/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
  ]);

test("routes the home page through three equal creation choices before the demo", () => {
  const homeStart = landingSource.indexOf("export function HomeLanding");
  const singleStart = landingSource.indexOf("export function VideoEditLanding");
  const home = landingSource.slice(homeStart, singleStart);

  const chooserIndex = home.indexOf("<CreationChooser");
  const demoIndex = home.indexOf('className="landingDemoSection"');
  const benefitsIndex = home.indexOf('className="homeBenefitBand"');
  const stepsIndex = home.indexOf('className="homeSteps"');
  const pricingIndex = home.indexOf("<PricingTeaser");
  const faqIndex = home.indexOf('className="homeFaq"');

  assert.ok(chooserIndex >= 0 && chooserIndex < demoIndex);
  assert.ok(demoIndex < benefitsIndex);
  assert.ok(benefitsIndex < stepsIndex);
  assert.ok(stepsIndex < pricingIndex);
  assert.ok(pricingIndex < faqIndex);
  assert.doesNotMatch(home, /<VoiceSamples/);

  for (const copy of [
    "何から作りますか？",
    "動画1本から作る",
    "複数の動画から作る",
    "写真から作る",
  ]) {
    assert.match(landingSource, new RegExp(copy));
  }
  assert.doesNotMatch(landingSource, /素材はどれですか？|まず作り方を選びます/);
  assert.match(landingSource, /href="\/video-mix"/);
  assert.match(landingSource, /href="\/photo-reel"/);
});

test("keeps one video editor engine while giving it a focused public entry", () => {
  assert.match(pageSource, /landingVariant\?: "home" \| "video-edit"/);
  assert.match(pageSource, /export function VideoEditExperience\(\)/);
  assert.match(pageSource, /<Home landingVariant="video-edit" \/>/);
  assert.match(videoEditSource, /import \{ VideoEditExperience \} from "\.\.\/page"/);
  assert.match(videoEditSource, /path:\s*"\/video-edit"/);
  assert.match(landingSource, /export function VideoEditLanding/);
  assert.match(landingSource, /AIナレーションの4つの声を試聴する/);
  assert.match(pageSource, /prefers-reduced-motion: reduce/);
});

test("keeps pricing concise on home and links to the full trusted explanation", () => {
  assert.match(landingSource, /ONE_TIME_PRICE_JPY/);
  assert.match(landingSource, /STARTER_MONTHLY_PRICE_JPY/);
  assert.match(landingSource, /STANDARD_MONTHLY_PRICE_JPY/);
  assert.match(landingSource, /href="\/pricing"/);
  assert.match(landingSource, /1回払い・税込・自動更新なし/);
  assert.match(landingSource, /1か月ごとの自動更新・税込/);
});

test("uses DOM order as visual order and collapses mode cards on mobile", () => {
  assert.match(cssSource, /\.creationModeGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3/);
  assert.match(
    cssSource,
    /@media \(max-width: 760px\)[\s\S]*?\.creationModeGrid,[\s\S]*?grid-template-columns:\s*1fr/,
  );
  assert.doesNotMatch(cssSource, /\.landingRouter[\s\S]*?order:\s*-[1-9]/);
  assert.match(cssSource, /\.creationModeAction\s*\{[\s\S]*?min-height:\s*48px/);
  assert.match(
    cssSource,
    /@media \(max-width: 420px\)[\s\S]*?\.creationModeLabel > em\s*\{[\s\S]*?position:\s*static/,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 360px\)[\s\S]*?\.topbar \.brandText\s*\{[\s\S]*?display:\s*none/,
  );
});

test("publishes the new canonical destinations", () => {
  assert.match(sitemapSource, /<loc>https:\/\/torudake-reel\.pages\.dev\/video-edit<\/loc>/);
  assert.match(sitemapSource, /<loc>https:\/\/torudake-reel\.pages\.dev\/pricing<\/loc>/);
});
