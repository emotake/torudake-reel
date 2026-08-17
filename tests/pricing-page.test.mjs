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
const purchaseOptionsSource = await readFile(
  new URL("../app/monthly-first-purchase.tsx", import.meta.url),
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

test("pricing page uses billing-policy constants and monthly-first plan order", () => {
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

  const planDefinitions = pageSource.slice(
    pageSource.indexOf("const plans = ["),
    pageSource.indexOf("] as const;"),
  );
  const starterIndex = planDefinitions.indexOf('key: "starter"');
  const standardIndex = planDefinitions.indexOf('key: "standard"');
  assert.ok(starterIndex > -1);
  assert.ok(starterIndex < standardIndex);
  assert.doesNotMatch(planDefinitions, /key:\s*["']one_time["']/);

  const purchaseOptions = pageSource.slice(
    pageSource.indexOf("<MonthlyFirstPurchaseOptions"),
    pageSource.indexOf("</MonthlyFirstPurchaseOptions>"),
  );
  const oneTimeIndex = purchaseOptions.indexOf('plan="one_time"');
  assert.ok(purchaseOptions.indexOf('key: "starter"') < 0);
  assert.ok(oneTimeIndex > purchaseOptions.indexOf("plans.map"));
  assert.match(pageSource, /<MonthlyFirstPurchaseOptions[\s\S]*?source="pricing"/);
  assert.match(pageSource, /<OneTimeRescue\s+source="pricing"/);
});

test("checkout links preserve account plan keys and checkout analytics", () => {
  assert.match(checkoutLinkSource, /href=\{`\/account\?checkout=\$\{plan\}`\}/);
  assert.match(
    checkoutLinkSource,
    /trackClientEvent\("checkout_started",\s*\{[\s\S]*?plan,[\s\S]*?source:\s*"pricing",[\s\S]*?offer_version:\s*MONTHLY_FIRST_OFFER_VERSION/,
  );
  for (const plan of ["starter", "standard"]) {
    assert.match(pageSource, new RegExp(`key:\\s*["']${plan}["']`));
  }
  assert.match(pageSource, /<CheckoutLink\s+plan="one_time"/);
  assert.match(pageSource, /<CheckoutLink\s+plan=\{plan\.key\}/);
});

test("shared purchase options expose monthly impressions and a closed one-time rescue", () => {
  assert.match(purchaseOptionsSource, /^"use client";/);
  assert.match(
    purchaseOptionsSource,
    /MONTHLY_FIRST_OFFER_VERSION\s*=\s*"monthly_primary_rescue_v1"/,
  );
  assert.match(purchaseOptionsSource, /trackClientEvent\("purchase_options_shown"/);
  assert.match(purchaseOptionsSource, /trackClientEvent\("one_time_rescue_revealed"/);
  assert.match(purchaseOptionsSource, /summary\s*=\s*"月額にせず、今回だけ保存する"/);
  assert.match(purchaseOptionsSource, /<details/);
  assert.doesNotMatch(purchaseOptionsSource, /^\s*open(?:=|\s*$)/m);
  assert.match(purchaseOptionsSource, /event\.currentTarget\.open/);
});

test("pricing page includes the paid-service trust and legal essentials", () => {
  for (const copy of [
    "すべて税込表示",
    "自動更新",
    "繰り越されません",
    "書き出しに成功した時点",
    "新しいアカウントはLINEで作成",
    "LINE公式アカウントの友だち追加は行いません",
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
  assert.match(cssSource, /\.planGrid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/);
  assert.match(cssSource, /\.oneTimeRescueLink\s*\{[\s\S]*?min-height:\s*46px/);
  assert.match(purchaseOptionsSource, /<details/);
  assert.match(purchaseOptionsSource, /<summary>/);
  assert.match(pageSource, /aria-labelledby=/);
});
