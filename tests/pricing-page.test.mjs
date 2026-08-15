import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageSource = await readFile(
  new URL("../app/pricing/page.tsx", import.meta.url),
  "utf8",
);
const checkoutLinkSource = await readFile(
  new URL("../app/pricing/checkout-link.tsx", import.meta.url),
  "utf8",
);
const cssSource = await readFile(
  new URL("../app/pricing/pricing.module.css", import.meta.url),
  "utf8",
);
const siteFooterSource = await readFile(
  new URL("../app/site-footer.tsx", import.meta.url),
  "utf8",
);

test("pricing page stays server-rendered and exposes canonical metadata", () => {
  assert.doesNotMatch(pageSource, /^\s*["']use client["']/m);
  assert.match(pageSource, /buildPublicPageMetadata\(/);
  assert.match(pageSource, /path:\s*["']\/pricing["']/);
});

test("pricing page uses billing-policy constants and frequency-first plan order", () => {
  for (const constantName of [
    "ONE_TIME_PRICE_JPY",
    "STARTER_MONTHLY_PRICE_JPY",
    "STANDARD_MONTHLY_PRICE_JPY",
    "STARTER_MONTHLY_VIDEO_LIMIT",
    "STANDARD_MONTHLY_VIDEO_LIMIT",
    "ONE_TIME_AI_OPERATION_SUCCESS_LIMIT",
    "SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT",
  ]) {
    assert.match(pageSource, new RegExp(`\\b${constantName}\\b`));
  }

  const oneTimeIndex = pageSource.indexOf('key: "one_time"');
  const starterIndex = pageSource.indexOf('key: "starter"');
  const standardIndex = pageSource.indexOf('key: "standard"');
  assert.ok(oneTimeIndex > -1);
  assert.ok(oneTimeIndex < starterIndex);
  assert.ok(starterIndex < standardIndex);
});

test("checkout links preserve account plan keys and checkout analytics", () => {
  assert.match(checkoutLinkSource, /href=\{`\/account\?checkout=\$\{plan\}`\}/);
  assert.match(
    checkoutLinkSource,
    /trackClientEvent\("checkout_started",\s*\{\s*plan,\s*source:\s*"landing"\s*\}\)/,
  );
  for (const plan of ["one_time", "starter", "standard"]) {
    assert.match(pageSource, new RegExp(`key:\\s*["']${plan}["']`));
  }
  assert.match(pageSource, /<CheckoutLink\s+plan=\{plan\.key\}/);
});

test("pricing page includes the paid-service trust and legal essentials", () => {
  for (const copy of [
    "すべて税込表示",
    "自動更新",
    "繰り越されません",
    "書き出しに成功した時点",
    "アカウント作成またはログイン",
    "Face ID・Touch ID",
    "Stripe",
    "いつでも解約",
  ]) {
    assert.ok(pageSource.includes(copy), `missing required pricing copy: ${copy}`);
  }

  assert.match(pageSource, /<\/main>\s*<SiteFooter \/>/);
  for (const route of [
    "/support",
    "/terms",
    "/privacy",
    "/commercial-disclosure",
  ]) {
    assert.match(
      siteFooterSource,
      new RegExp(`href: ["']${route}["']`),
      `shared pricing footer must retain legal/support route: ${route}`,
    );
  }
});

test("pricing page supplies keyboard focus and responsive layouts", () => {
  assert.match(cssSource, /:focus-visible/);
  assert.match(cssSource, /@media\s*\(max-width:/);
  assert.match(cssSource, /min-height:\s*44px/);
  assert.match(pageSource, /<details>/);
  assert.match(pageSource, /<summary>/);
  assert.match(pageSource, /aria-labelledby=/);
});
