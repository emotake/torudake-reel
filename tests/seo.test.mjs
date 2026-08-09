import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSiteStructuredData } from "../lib/seo.ts";
import { SITE_ORIGIN } from "../lib/site.ts";

const readProjectFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  layoutSource,
  accountSource,
  privacySource,
  termsSource,
  commercialSource,
  robotsSource,
  sitemapSource,
  manifestSource,
] = await Promise.all([
  readProjectFile("app/layout.tsx"),
  readProjectFile("app/account/page.tsx"),
  readProjectFile("app/privacy/page.tsx"),
  readProjectFile("app/terms/page.tsx"),
  readProjectFile("app/commercial-disclosure/page.tsx"),
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
    `${SITE_ORIGIN}/photo-reel`,
    `${SITE_ORIGIN}/privacy`,
    `${SITE_ORIGIN}/terms`,
    `${SITE_ORIGIN}/commercial-disclosure`,
  ]);
  assert.ok(urls.every((url) => !url.includes("?")));
  assert.ok(urls.every((url) => !url.includes("/account")));
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
  assert.ok(application.featureList.includes("自動テロップ"));
  assert.ok(application.featureList.includes("AIナレーション"));
  assert.ok(
    application.featureList.includes("最大10枚の写真から縦型リールを自動作成"),
  );
  assert.equal("aggregateRating" in application, false);
  assert.equal("review" in application, false);
  assert.deepEqual(
    application.offers.map((offer) => offer.price),
    [0, 200, 1480],
  );
});

test("publishes a Japanese web app manifest", () => {
  const value = JSON.parse(manifestSource);
  assert.equal(value.start_url, "/");
  assert.equal(value.lang, "ja");
  assert.equal(value.icons[0].src, "/favicon.svg");
});
