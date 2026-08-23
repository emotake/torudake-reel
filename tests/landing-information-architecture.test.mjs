import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  pageSource,
  landingSource,
  cssSource,
  videoEditSource,
  sitemapSource,
  purchaseOptionsSource,
] =
  await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/landing-router.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/video-edit/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
    readFile(new URL("../app/monthly-first-purchase.tsx", import.meta.url), "utf8"),
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

  const promiseItems = Array.from(
    promiseList.matchAll(
      /<li className="landingPromiseItem">([\s\S]*?)<\/li>/g,
    ),
    (match) => match[1],
  );
  const promisePairs = [
    ["プレビュー無料", "プレビュー", "無料"],
    ["最大1080p", "最大", "1080p"],
    ["透かしなし", "透かし", "なし"],
  ];

  assert.equal(promiseItems.length, promisePairs.length);
  for (const [index, [accessibleCopy, term, value]] of promisePairs.entries()) {
    const item = promiseItems[index];
    const accessibleCopyIndex = item.indexOf(
      `<span className="visuallyHidden">${accessibleCopy}</span>`,
    );
    const visualTypographyIndex = item.indexOf(
      'className="landingPromiseTypography" aria-hidden="true"',
    );
    const termIndex = item.indexOf(
      `className="landingPromiseTerm">${term}</span>`,
    );
    const valueIndex = item.indexOf(`>${value}</span>`, termIndex);

    assert.ok(
      accessibleCopyIndex >= 0 && accessibleCopyIndex < visualTypographyIndex,
      `${accessibleCopy} must remain contiguous for assistive technology`,
    );
    assert.ok(
      visualTypographyIndex < termIndex && termIndex < valueIndex,
      `${term}/${value} must remain in visual reading order`,
    );
  }
  assert.equal(
    (
      promiseList.match(
        /className="landingPromiseTypography" aria-hidden="true"/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (promiseList.match(/className="landingPromiseTerm"/g) ?? []).length,
    3,
  );
  assert.equal(
    (promiseList.match(/className="landingPromiseValue(?:\s[^"']*)?"/g) ?? [])
      .length,
    3,
  );
  assert.doesNotMatch(
    promiseList,
    /<strong>\s*(?:プレビュー無料|最大1080p|透かしなし)\s*<\/strong>/,
  );

  assert.doesNotMatch(home, /landingPromiseRow/);
});

test("keeps the original dot and inline promise typography in the base styles", () => {
  const baseStart = cssSource.indexOf(".landingPromiseItem");
  const desktopStart = cssSource.indexOf(
    "@media (min-width: 761px)",
    baseStart,
  );
  const basePromises = cssSource.slice(baseStart, desktopStart);

  function rule(selector) {
    const start = basePromises.lastIndexOf(`${selector} {`);
    const end = basePromises.indexOf("}", start);
    assert.ok(start >= 0 && end > start, `Missing base ${selector} rule`);
    return basePromises.slice(start, end);
  }

  function pixelValue(source, property) {
    const match = source.match(new RegExp(`${property}:\\s*([\\d.]+)px`));
    assert.ok(match, `Missing pixel ${property}`);
    return Number(match[1]);
  }

  assert.ok(baseStart >= 0 && desktopStart > baseStart);
  const itemRule = rule(".landingPromiseItem");
  const markRule = rule(".landingPromiseMark");
  const typographyRule = rule(".landingPromiseTypography");
  const termRule = rule(".landingPromiseTerm");
  const valueRule = rule(".landingPromiseValue");
  const supportingRule = rule(".landingPromiseCopy small");

  assert.match(
    itemRule,
    /grid-template-columns:\s*6px\s+minmax\(0,\s*1fr\)/,
  );
  assert.match(itemRule, /gap:\s*11px;/);
  assert.match(
    typographyRule,
    /display:\s*flex;[\s\S]*?align-items:\s*baseline;[\s\S]*?gap:\s*5px;[\s\S]*?white-space:\s*nowrap;/,
  );
  assert.equal(pixelValue(termRule, "font-size"), 11);
  assert.equal(pixelValue(valueRule, "font-size"), 15);
  assert.equal(pixelValue(supportingRule, "font-size"), 11);
  assert.match(termRule, /color:\s*var\(--muted\);/);
  assert.match(supportingRule, /color:\s*var\(--muted\);/);
  assert.equal(pixelValue(markRule, "width"), 6);
  assert.equal(pixelValue(markRule, "height"), 6);
  assert.match(markRule, /margin-top:\s*6px;/);
  assert.match(markRule, /border-radius:\s*50%;/);
  assert.match(markRule, /background:\s*var\(--mint-dark\);/);
  assert.doesNotMatch(markRule, /height:\s*1px|background:\s*rgba\(/);
});

test("keeps three stacked promise columns and hides support below 520px", () => {
  const desktopPromiseStart = cssSource.indexOf(".landingPromiseTypography");
  const mobileStart = cssSource.indexOf(
    "@media (max-width: 520px)",
    desktopPromiseStart,
  );
  const mobileEnd = cssSource.indexOf("@media", mobileStart + 1);
  const mobilePromises = cssSource.slice(
    mobileStart,
    mobileEnd >= 0 ? mobileEnd : undefined,
  );

  assert.ok(mobileStart >= 0);
  assert.match(
    mobilePromises,
    /\.landingPromiseList\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  );
  assert.match(
    mobilePromises,
    /\.landingPromiseTypography\s*\{[\s\S]*?display:\s*grid;[\s\S]*?justify-items:\s*center;[\s\S]*?white-space:\s*normal;/,
  );
  assert.match(
    mobilePromises,
    /\.landingPromiseMark\s*\{[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;/,
  );
  assert.match(
    mobilePromises,
    /\.landingPromiseCopy small\s*\{[\s\S]*?display:\s*none;/,
  );
});

test("uses full-width stacked promises with readable desktop typography", () => {
  const desktopStart = cssSource.indexOf("@media (min-width: 761px)");
  const desktopEnd = cssSource.indexOf("@media", desktopStart + 1);
  const desktopPromises = cssSource.slice(
    desktopStart,
    desktopEnd >= 0 ? desktopEnd : undefined,
  );

  function rule(selector) {
    const start = desktopPromises.indexOf(`${selector} {`);
    const end = desktopPromises.indexOf("}", start);
    assert.ok(start >= 0 && end > start, `Missing desktop ${selector} rule`);
    return desktopPromises.slice(start, end);
  }

  function pixelValue(source, property) {
    const match = source.match(new RegExp(`${property}:\\s*([\\d.]+)px`));
    assert.ok(match, `Missing pixel ${property}`);
    return Number(match[1]);
  }

  assert.ok(desktopStart >= 0);
  const leadRule = rule(".landingHeroStage .landingIntroCopy > p:last-of-type");
  const itemRule = rule(".landingPromiseItem");
  const markRule = rule(".landingPromiseMark");
  const typographyRule = rule(".landingPromiseTypography");
  const termRule = rule(".landingPromiseTerm");
  const valueRule = rule(".landingPromiseValue");
  const supportingRule = rule(".landingPromiseCopy small");

  assert.match(itemRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(
    typographyRule,
    /display:\s*grid;[\s\S]*?justify-items:\s*start;[\s\S]*?white-space:\s*normal;/,
  );
  assert.ok(pixelValue(leadRule, "font-size") >= 17);
  assert.ok(pixelValue(termRule, "font-size") >= 13);
  assert.ok(pixelValue(valueRule, "font-size") >= 20);
  assert.ok(pixelValue(supportingRule, "font-size") >= 12);
  assert.match(leadRule, /color:\s*#3f4b5e;/i);
  assert.match(termRule, /color:\s*#46536a;/i);
  assert.match(supportingRule, /color:\s*#4f5b70;/i);
  assert.match(markRule, /width:\s*6px;/);
  assert.match(markRule, /height:\s*6px;/);
  assert.match(markRule, /border-radius:\s*50%;/);
  assert.match(markRule, /background:\s*var\(--mint-dark\);/);
  assert.doesNotMatch(markRule, /height:\s*1px|background:\s*rgba\(/);
});

test("keeps one video editor engine while giving it a focused public entry", () => {
  assert.match(pageSource, /landingVariant\?: "home" \| "video-edit"/);
  assert.match(pageSource, /export function VideoEditExperience\(\)/);
  assert.match(pageSource, /<Home landingVariant="video-edit" \/>/);
  assert.match(videoEditSource, /import \{ VideoEditExperience \} from "\.\.\/page"/);
  assert.match(videoEditSource, /path:\s*"\/video-edit"/);
  assert.match(landingSource, /export function VideoEditLanding/);
  assert.match(landingSource, /AIナレーションの3つの声を試聴する/);
  assert.match(pageSource, /prefers-reduced-motion: reduce/);
});

test("keeps pricing concise on home and links to the full trusted explanation", () => {
  const pricing = landingSource.slice(
    landingSource.indexOf("function PricingTeaser"),
    landingSource.indexOf("function VoiceSamples"),
  );
  assert.match(landingSource, /ONE_TIME_PRICE_JPY/);
  assert.match(landingSource, /STARTER_MONTHLY_PRICE_JPY/);
  assert.match(landingSource, /STANDARD_MONTHLY_PRICE_JPY/);
  assert.match(landingSource, /href="\/pricing"/);
  assert.match(pricing, /<MonthlyFirstPurchaseOptions[\s\S]*?source="landing"/);
  assert.match(pricing, /aria-label="月額保存プランの概要"/);
  assert.match(pricing, /<OneTimeRescue\s+source="landing"/);
  assert.match(pricing, /1回払い・自動更新なし・有効期限なし/);
  assert.match(pricing, /1か月ごとの自動更新・税込/);
  const starterIndex = pricing.indexOf("STARTER_MONTHLY_VIDEO_LIMIT");
  const standardIndex = pricing.indexOf("STANDARD_MONTHLY_VIDEO_LIMIT");
  const rescueIndex = pricing.indexOf("<OneTimeRescue");
  assert.ok(starterIndex > -1 && starterIndex < standardIndex);
  assert.ok(standardIndex < rescueIndex);
  assert.match(purchaseOptionsSource, /summary\s*=\s*"月額にせず、今回だけ保存する"/);
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
