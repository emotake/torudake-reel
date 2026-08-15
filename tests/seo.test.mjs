import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSiteStructuredData } from "../lib/seo.ts";
import {
  SITE_DESCRIPTION,
  SITE_LAST_MODIFIED,
  SITE_OG_IMAGE_PATH,
  SITE_ORIGIN,
  siteUrl,
} from "../lib/site.ts";

const readProjectFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  layoutSource,
  accountSource,
  privacySource,
  termsSource,
  commercialSource,
  supportSource,
  robotsSource,
  sitemapSource,
  manifestSource,
] = await Promise.all([
  readProjectFile("app/layout.tsx"),
  readProjectFile("app/account/page.tsx"),
  readProjectFile("app/privacy/page.tsx"),
  readProjectFile("app/terms/page.tsx"),
  readProjectFile("app/commercial-disclosure/page.tsx"),
  readProjectFile("app/support/page.tsx"),
  readProjectFile("public/robots.txt"),
  readProjectFile("public/sitemap.xml"),
  readProjectFile("public/manifest.webmanifest"),
]);

test("publishes crawl rules with the canonical sitemap", () => {
  assert.match(robotsSource, /^User-agent: \*$/m);
  assert.match(robotsSource, /^Allow: \/$/m);
  assert.match(robotsSource, /^Disallow: \/api\/$/m);
  assert.match(
    robotsSource,
    new RegExp(`^Sitemap: ${SITE_ORIGIN}/sitemap\\.xml$`, "m"),
  );
  assert.doesNotMatch(robotsSource, /account|device-access|internal/);
});

test("lists only canonical public pages in the sitemap", () => {
  const urls = [...sitemapSource.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .filter((url) => !url.endsWith("/og.png"));
  assert.deepEqual(urls, [
    `${SITE_ORIGIN}/`,
    `${SITE_ORIGIN}/video-mix`,
    `${SITE_ORIGIN}/video-edit`,
    `${SITE_ORIGIN}/photo-reel`,
    `${SITE_ORIGIN}/pricing`,
    `${SITE_ORIGIN}/guide/iphone-mov-reel`,
    `${SITE_ORIGIN}/guide/silent-video-narration`,
    `${SITE_ORIGIN}/guide/japanese-reading`,
    `${SITE_ORIGIN}/support`,
    `${SITE_ORIGIN}/privacy`,
    `${SITE_ORIGIN}/terms`,
    `${SITE_ORIGIN}/commercial-disclosure`,
  ]);
  assert.ok(urls.every((url) => !url.includes("?")));
  assert.ok(urls.every((url) => !url.includes("/account")));
  const lastModifiedValues = [
    ...sitemapSource.matchAll(/<lastmod>([^<]+)<\/lastmod>/g),
  ].map((match) => match[1]);
  assert.equal(lastModifiedValues.length, urls.length);
  assert.ok(lastModifiedValues.every((value) => value === SITE_LAST_MODIFIED));
  assert.match(
    sitemapSource,
    /<image:loc>https:\/\/torudake-reel\.pages\.dev\/og\.png\?v=20260811-accessibility<\/image:loc>/,
  );
});

test("uses a fixed public canonical instead of the request host", () => {
  assert.match(layoutSource, /metadataBase:\s*siteMetadataBase/);
  assert.match(layoutSource, /path:\s*"\/"/);
  assert.doesNotMatch(layoutSource, /x-forwarded-host|headers\(\)/);
});

test("publishes self canonicals for every indexable legal page", () => {
  assert.match(privacySource, /path:\s*"\/privacy"/);
  assert.match(termsSource, /path:\s*"\/terms"/);
  assert.match(commercialSource, /path:\s*"\/commercial-disclosure"/);
  assert.match(supportSource, /path:\s*"\/support"/);
});

test("marks account pages as private from search results", () => {
  assert.match(accountSource, /index:\s*false/);
  assert.match(accountSource, /follow:\s*false/);
  assert.match(accountSource, /noarchive:\s*true/);
});

test("describes the real web application without invented ratings", () => {
  const value = buildSiteStructuredData();
  const application = value["@graph"].find(
    (entry) => entry["@type"] === "WebApplication",
  );
  assert.ok(application);
  assert.equal(application.url, `${SITE_ORIGIN}/`);
  assert.equal(application.applicationCategory, "MultimediaApplication");
  assert.equal(application.dateModified, SITE_LAST_MODIFIED);
  assert.equal(application.image, siteUrl(SITE_OG_IMAGE_PATH));
  assert.equal(application.termsOfService, `${SITE_ORIGIN}/terms`);
  assert.ok(application.featureList.includes("自動テロップ"));
  assert.ok(application.featureList.includes("AIナレーション"));
  assert.ok(
    application.featureList.includes(
      "AIナレーションモードでInstagram投稿文を作成",
    ),
  );
  assert.ok(SITE_DESCRIPTION.includes("AIナレーションモードでは投稿文も作成"));
  assert.ok(
    application.featureList.includes("最大5本の動画を素材順に保って自動編集"),
  );
  assert.ok(
    application.featureList.includes("最大10枚の写真から縦型リールを自動作成"),
  );
  assert.ok(SITE_DESCRIPTION.includes("最大5本の動画"));
  assert.equal("aggregateRating" in application, false);
  assert.equal("review" in application, false);
  assert.deepEqual(
    application.offers.map((offer) => offer.price),
    [0, 200, 500, 1000],
  );
  assert.deepEqual(
    application.offers.map((offer) => offer.name),
    [
      "無料体験（編集・プレビュー）",
      "動画1本プラン",
      "月3本プラン",
      "月7本プラン",
    ],
  );
  assert.equal(
    application.offers.some((offer) => offer.price === 1480),
    false,
  );
  assert.match(application.offers[0].description, /合計3分以内・最大2動画/);
  assert.ok(application.offers.slice(1).every((offer) => /税込/.test(offer.description)));
});

test("publishes a real product demo as VideoObject", () => {
  const value = buildSiteStructuredData();
  const video = value["@graph"].find((entry) => entry["@type"] === "VideoObject");
  assert.ok(video);
  assert.equal(video.contentUrl, `${SITE_ORIGIN}/demo/torudake-demo-lite.mp4`);
  assert.equal(video.thumbnailUrl, `${SITE_ORIGIN}/demo/torudake-demo-poster.jpg`);
  assert.equal(video.uploadDate, "2026-08-12");
});

test("publishes useful, canonical guides without invented capability claims", async () => {
  const guides = await Promise.all([
    readProjectFile("app/guide/iphone-mov-reel/page.tsx"),
    readProjectFile("app/guide/silent-video-narration/page.tsx"),
    readProjectFile("app/guide/japanese-reading/page.tsx"),
  ]);
  assert.match(guides[0], /path: "\/guide\/iphone-mov-reel"/);
  assert.match(guides[1], /元の映像をそのまま使う/);
  assert.match(guides[2], /画面に出す文字と、声の読み方を分けて/);
  assert.ok(guides.every((source) => !/完全無料|無制限|必ず/.test(source)));
});

test("publishes a Japanese web app manifest", () => {
  const value = JSON.parse(manifestSource);
  assert.equal(value.start_url, "/");
  assert.equal(value.lang, "ja");
  assert.equal(value.icons[0].src, "/favicon-v2.svg");
  assert.equal(value.description, SITE_DESCRIPTION);
  assert.equal(value.id, "/");
  assert.equal(value.scope, "/");
  assert.deepEqual(value.categories, ["photo", "video"]);
});
