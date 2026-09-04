import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GA4_MEASUREMENT_IDS,
  GOOGLE_TAG_SCRIPT_ID,
  GOOGLE_TAG_SCRIPT_URL,
  LEGACY_GA4_MEASUREMENT_ID,
  MANAGEMENT_GA4_MEASUREMENT_ID,
  createGoogleTagCommandQueue,
  isGoogleAnalyticsExcludedPath,
  sendGoogleAnalyticsEvent,
} from "../lib/google-analytics.ts";

test("queues Google tag commands as Arguments objects", () => {
  const dataLayer = [];
  const gtag = createGoogleTagCommandQueue(dataLayer);

  gtag("config", MANAGEMENT_GA4_MEASUREMENT_ID, { send_page_view: false });

  assert.equal(dataLayer.length, 1);
  assert.equal(Array.isArray(dataLayer[0]), false);
  assert.equal(Object.prototype.toString.call(dataLayer[0]), "[object Arguments]");
  assert.deepEqual(Array.from(dataLayer[0]), [
    "config",
    MANAGEMENT_GA4_MEASUREMENT_ID,
    { send_page_view: false },
  ]);
});

test("configures both GA4 measurements without exposing private routes", async () => {
  assert.equal(LEGACY_GA4_MEASUREMENT_ID, "G-CV2ZLFXCCT");
  assert.equal(MANAGEMENT_GA4_MEASUREMENT_ID, "G-PNXQYMN97S");
  assert.deepEqual(GA4_MEASUREMENT_IDS, [
    "G-CV2ZLFXCCT",
    "G-PNXQYMN97S",
  ]);
  assert.equal(new Set(GA4_MEASUREMENT_IDS).size, GA4_MEASUREMENT_IDS.length);
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
  const clientAnalyticsSource = await readFile(
    new URL("../lib/client-analytics.ts", import.meta.url),
    "utf8",
  );

  assert.match(layoutSource, /<GoogleAnalytics \/>/);
  assert.match(analyticsSource, /for \(const measurementId of GA4_MEASUREMENT_IDS\)/);
  assert.match(analyticsSource, /"config", measurementId/);
  assert.match(analyticsSource, /send_page_view: false/);
  assert.match(analyticsSource, /sendGoogleAnalyticsEvent\(runtime\.gtag, "page_view"/);
  assert.match(
    analyticsSource,
    /page_location: `\$\{window\.location\.origin\}\$\{safePath\}\$\{attributionToSearch\(attribution\)\}`/,
  );
  assert.match(analyticsSource, /captureCurrentAttribution\(\)/);
  assert.match(analyticsSource, /"acquisition_landing"/);
  assert.match(analyticsSource, /isGoogleAnalyticsExcludedPath\(safePath\)/);
  assert.match(analyticsSource, /configuredIds\.has\(measurementId\)/);
  assert.match(analyticsSource, /__torudakeGaLastPath === safePath/);
  assert.match(clientAnalyticsSource, /sendGoogleAnalyticsEvent\(/);
});

test("routes each safe event exactly once to both GA4 measurements", () => {
  const calls = [];

  sendGoogleAnalyticsEvent(
    (...args) => calls.push(args),
    "page_view",
    { page_path: "/pricing" },
  );

  assert.deepEqual(calls, [
    [
      "event",
      "page_view",
      { page_path: "/pricing", send_to: "G-CV2ZLFXCCT" },
    ],
    [
      "event",
      "page_view",
      { page_path: "/pricing", send_to: "G-PNXQYMN97S" },
    ],
  ]);
});

test("discloses Google Analytics in the privacy policy", async () => {
  const privacySource = await readFile(
    new URL("../app/privacy/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(privacySource, /Google Analytics/);
  assert.match(privacySource, /Googleへ送信される場合があります/);
  assert.match(privacySource, /2026年8月22日/);
  assert.match(privacySource, /ファイル名、動画・音声の内容、字幕・台本本文、メールアドレスは/);
  assert.match(privacySource, /利用工程・エラー記録は90日、選択式の評価は180日/);
});
