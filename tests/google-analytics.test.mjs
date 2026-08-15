import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GA4_MEASUREMENT_ID,
  GOOGLE_TAG_SCRIPT_ID,
  GOOGLE_TAG_SCRIPT_URL,
  isGoogleAnalyticsExcludedPath,
} from "../lib/google-analytics.ts";

test("configures the supplied GA4 measurement without exposing private routes", async () => {
  assert.equal(GA4_MEASUREMENT_ID, "G-CV2ZLFXCCT");
  assert.equal(
    GOOGLE_TAG_SCRIPT_URL,
    "https://www.googletagmanager.com/gtag/js?id=G-CV2ZLFXCCT",
  );
  assert.equal(GOOGLE_TAG_SCRIPT_ID, "torudake-google-tag");
  assert.equal(isGoogleAnalyticsExcludedPath("/"), false);
  assert.equal(isGoogleAnalyticsExcludedPath("/privacy"), false);
  assert.equal(isGoogleAnalyticsExcludedPath("/account"), true);
  assert.equal(isGoogleAnalyticsExcludedPath("/account/settings"), true);
  assert.equal(isGoogleAnalyticsExcludedPath("/internal"), true);
  assert.equal(isGoogleAnalyticsExcludedPath("/internal/device"), true);

  const layoutSource = await readFile(
    new URL("../app/layout.tsx", import.meta.url),
    "utf8",
  );
  const analyticsSource = await readFile(
    new URL("../app/google-analytics.tsx", import.meta.url),
    "utf8",
  );

  assert.match(layoutSource, /<GoogleAnalytics \/>/);
  assert.match(analyticsSource, /send_page_view: false/);
  assert.match(analyticsSource, /"event", "page_view"/);
  assert.match(
    analyticsSource,
    /page_location: `\$\{window\.location\.origin\}\$\{safePath\}`/,
  );
  assert.doesNotMatch(analyticsSource, /location\.search|searchParams/);
  assert.match(analyticsSource, /isGoogleAnalyticsExcludedPath\(safePath\)/);
});

test("discloses Google Analytics in the privacy policy", async () => {
  const privacySource = await readFile(
    new URL("../app/privacy/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(privacySource, /Google Analytics/);
  assert.match(privacySource, /Googleへ送信される場合があります/);
  assert.match(privacySource, /2026年8月15日/);
  assert.match(privacySource, /ファイル名、動画・音声の内容、字幕・台本本文、メールアドレスは/);
  assert.match(privacySource, /利用工程・エラー記録は90日、選択式の評価は180日/);
});
