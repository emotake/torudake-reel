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

test("shows the playable finish before three equal creation choices", () => {
  const homeStart = landingSource.indexOf("export function HomeLanding");
  const singleStart = landingSource.indexOf("export function VideoEditLanding");
  const home = landingSource.slice(homeStart, singleStart);

  const finishIndex = home.indexOf('className="landingHeroResult"');
  const playableDemoIndex = home.indexOf("{props.demo}", finishIndex);
  const chooserIndex = home.indexOf("<CreationChooser");
  const benefitsIndex = home.indexOf('className="homeBenefitBand"');
  const stepsIndex = home.indexOf('className="homeSteps"');
  const pricingIndex = home.indexOf("<PricingTeaser");
  const faqIndex = home.indexOf('className="homeFaq"');

  assert.ok(finishIndex >= 0 && finishIndex < playableDemoIndex);
  assert.ok(playableDemoIndex < chooserIndex);
  assert.ok(chooserIndex < benefitsIndex);
  assert.ok(benefitsIndex < stepsIndex);
  assert.ok(stepsIndex < pricingIndex);
  assert.ok(pricingIndex < faqIndex);
  assert.doesNotMatch(home, /<VoiceSamples/);
  assert.doesNotMatch(home, /landingDemoSection/);

  for (const copy of [
    "動画1本でも、複数でも、写真だけでも。",
    "手元の素材に合う作り方を選べます。編集とプレビューは無料です。",
    "動画1本から作る",
    "複数の動画から作る",
    "写真から作る",
  ]) {
    assert.match(landingSource, new RegExp(copy));
  }
  assert.doesNotMatch(
    landingSource,
    /何から作りますか？|素材はどれですか？|まず作り方を選びます/,
  );
  assert.match(landingSource, /href="\/video-mix"/);
  assert.match(landingSource, /href="\/photo-reel"/);
});

test("keeps the hero promises semantic, ordered, and ahead of the finished result", () => {
  const homeStart = landingSource.indexOf("export function HomeLanding");
  const singleStart = landingSource.indexOf("export function VideoEditLanding");
  const home = landingSource.slice(homeStart, singleStart);
  const introCopyIndex = home.indexOf('className="landingIntroCopy"');
  const leadIndex = home.indexOf(
    "画面の案内に沿って、必要な機能だけを選んで仕上げられます。",
    introCopyIndex,
  );
  const promiseListIndex = home.indexOf(
    'className="landingPromiseList"',
    introCopyIndex,
  );
  const promiseListEnd = home.indexOf("</ul>", promiseListIndex);
  const finishedResultIndex = home.indexOf(
    'className="landingHeroResult"',
    introCopyIndex,
  );

  assert.ok(introCopyIndex >= 0);
  assert.ok(introCopyIndex < leadIndex);
  assert.ok(leadIndex < promiseListIndex);
  assert.ok(promiseListIndex < promiseListEnd);
  assert.ok(promiseListEnd < finishedResultIndex);

  const promiseList = home.slice(promiseListIndex, promiseListEnd);
  assert.match(promiseList, /aria-label="共通の仕上がり条件"/);
  assert.equal(
    (promiseList.match(/<li className="landingPromiseItem">/g) ?? []).length,
    3,
  );
  assert.equal(
    (
      promiseList.match(
        /className="landingPromiseMark" aria-hidden="true"/g,
      ) ?? []
    ).length,
    3,
  );

  let previousCopyIndex = -1;
  for (const copy of ["プレビュー無料", "最大1080p", "透かしなし"]) {
    const copyIndex = promiseList.indexOf(copy);
    assert.ok(copyIndex > previousCopyIndex, `${copy} must remain in promise order`);
    previousCopyIndex = copyIndex;
  }

  assert.doesNotMatch(home, /landingPromiseRow/);
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
