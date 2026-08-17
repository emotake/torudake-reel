import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("pricing and result checkout events use only allow-listed dimensions", async () => {
  const [landing, videoMix, photoReel] = await Promise.all([
    readSource("app/page.tsx"),
    readSource("app/video-mix/video-mix-client.tsx"),
    readSource("app/photo-reel/photo-reel-client.tsx"),
  ]);

  assert.ok(
    landing.includes(
      'trackClientEvent("pricing_viewed", { source: "landing" })',
    ),
  );
  assert.ok(landing.includes("ref={pricingSectionRef}"));
  for (const plan of ["one_time", "starter", "standard"]) {
    assert.match(
      videoMix,
      new RegExp(
        `trackClientEvent\\("checkout_started", \\{ plan: "${plan}", source: "result", mode: "video_mix", offer_version: MONTHLY_FIRST_OFFER_VERSION \\}\\)`,
      ),
    );
    assert.ok(photoReel.includes(`markCheckoutStarted("${plan}")`));
  }
  assert.match(
    photoReel,
    /trackClientEvent\("checkout_started",\s*\{[\s\S]*?plan,[\s\S]*?source: "result",[\s\S]*?mode: "photo",[\s\S]*?offer_version: MONTHLY_FIRST_OFFER_VERSION/,
  );
});

test("support page covers billing and recovery questions without collecting media", async () => {
  const support = await readSource("app/support/page.tsx");
  for (const text of [
    "決済・月額プランの解約",
    "書き出しや保存に失敗した",
    "Googleログインまたはパスキーで困った",
    "二重請求・返金について",
    "エラー番号",
    "利用端末とブラウザ",
    "問題が起きた工程",
    "動画・音声ファイルや字幕・台本の本文はメールへ添付・貼り付けしないでください",
    "torudake.reel@gmail.com",
  ]) {
    assert.ok(support.includes(text), `missing support guidance: ${text}`);
  }
  assert.doesNotMatch(support, /24時間以内|営業日以内|自動返信|独自ドメイン/);
});
