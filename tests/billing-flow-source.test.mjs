import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [accountSource, checkoutSource, portalSource] = await Promise.all([
  readFile(new URL("../app/account/account-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api/billing/checkout/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/billing/portal/route.ts", import.meta.url), "utf8"),
]);

test("polls the authenticated account after Stripe redirects back", () => {
  assert.match(
    checkoutSource,
    /checkout=success&plan=\$\{payload\.plan\}&credits_before=\$\{billingStatus\.oneTimeCreditsRemaining\}/,
  );
  assert.match(accountSource, /CHECKOUT_STATUS_POLL_ATTEMPTS = 8/);
  assert.match(accountSource, /CHECKOUT_STATUS_POLL_INTERVAL_MS = 1_500/);
  assert.match(accountSource, /oneTimeCreditsBefore/);
  assert.match(accountSource, /checkoutReflected\([\s\S]*latest,[\s\S]*checkoutPlan,[\s\S]*oneTimeCreditsBefore/);
  assert.match(accountSource, /await loadStatus\(\)/);
  assert.match(accountSource, /お支払いが利用枠へ反映されました/);
  assert.match(accountSource, /window\.history\.replaceState\(\{\}, "", "\/account"\)/);
  assert.match(accountSource, /運営へ復旧・解約を相談/);
  assert.match(accountSource, /type CheckoutPlan = "starter" \| "standard" \| "one_time"/);
  assert.match(accountSource, /startCheckout\("starter"\)/);
  assert.match(accountSource, /startCheckout\("standard"\)/);
  assert.doesNotMatch(accountSource, /startCheckout\("light"\)/);
  assert.match(accountSource, /accountPlanRecommend">おすすめ/);
  assert.match(accountSource, /STARTER_MONTHLY_PRICE_JPY/);
  assert.match(accountSource, /STANDARD_MONTHLY_PRICE_JPY/);
  assert.ok(
    accountSource.indexOf('className="accountPlanCard standardPlan featured"') <
      accountSource.indexOf('className="accountPlanCard starterPlan"'),
  );
});

test("rejects Checkout and Portal calls from old deployment hosts", () => {
  assert.match(checkoutSource, /isCanonicalBillingRequest\(request\)/);
  assert.match(checkoutSource, /non_canonical_billing_origin/);
  assert.match(portalSource, /isCanonicalBillingRequest\(request\)/);
  assert.match(portalSource, /non_canonical_billing_origin/);
});

test("explains the per-video shared AI processing limits on the account screen", () => {
  assert.match(accountSource, /月額プラン[\s\S]*SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT/);
  assert.match(accountSource, /文字起こし、高精度再解析、AI台本の生成、AI音声の生成/);
  assert.match(accountSource, /初回ナレーションは台本完成時に1回分/);
  assert.match(accountSource, /続く初回音声と内部の自動調整では追加回数を使用しません/);
  assert.match(accountSource, /作成後の再生成などは正常に完了するごとに1回分/);
});

test("shows a billing-management notice only when monthly access was revoked", () => {
  assert.match(accountSource, /accessRevoked:\s*boolean/);
  assert.match(accountSource, /status\?\.monthly\?\.accessRevoked/);
  assert.match(accountSource, /返金または支払い異議により今月の利用枠は停止中です/);
  assert.match(accountSource, /支払い方法・解約を管理/);
});
