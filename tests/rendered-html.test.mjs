import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the Torudake Reel product experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>撮るだけリール｜リール動画をAIで自動編集・字幕生成<\/title>/);
  assert.match(html, /動画を選ぶだけ。/);
  assert.match(html, /編集の手間を、もっと軽く。/);
  assert.match(html, /class="heroVisual realDemo"/);
  assert.match(html, /src="\/demo\/torudake-demo-lite\.mp4"/);
  assert.match(html, /poster="\/demo\/torudake-demo-poster\.jpg"/);
  assert.match(html, /再生すると音声付き1080p本編を読み込みます/);
  assert.match(html, /実際の動画・音声・テロップで確認/);
  assert.match(html, /AIナレーションの仕上がりを、先に聴けます/);
  assert.match(html, /動画本体は通常、端末内で編集/);
  assert.doesNotMatch(html, /lifestyleGallery/);
  assert.doesNotMatch(html, /4工程|AUTO CUT/);
  assert.match(html, /動画を選んで無料で試す/);
  assert.match(html, /編集・プレビューは無料/);
  assert.match(html, /動画1本だけ保存/);
  assert.match(html, /料金を見る/);
  assert.match(html, /写真からリールを作る/);
  assert.match(html, /最大10枚・自動編集5パターン/);
  assert.match(html, /スマホであとから試したい方へ/);
  assert.match(html, /LINEに送る/);
  assert.match(html, /LINEに送る（スマホであとから開く）/);
  assert.match(
    html,
    /https:\/\/social-plugins\.line\.me\/lineit\/share\?[^\"]*url=/,
  );
  assert.match(html, /送信されるのは公開ページのURLと案内文だけです/);
  assert.doesNotMatch(html, /動画を預ける|安全な受け渡し画面へ/);
  assert.match(html, /あなたがするのは、/);
  assert.match(html, /目的に合わせて自動編集/);
  assert.doesNotMatch(html, /AIが全部整える/);
  assert.match(html, /使い方に合う保存方法を。/);
  assert.match(html, /最大500MB/);
  assert.match(
    html,
    /合計3分以内・最大2動画まで（いずれか先に達するまで）/,
  );
  assert.match(html, /編集・プレビューまで/);
  assert.match(html, /完成動画の保存は有料/);
  assert.match(html, /1か月に動画(?:<!-- -->)?7(?:<!-- -->)?本まで/);
  assert.match(html, /1か月に動画(?:<!-- -->)?3(?:<!-- -->)?本まで/);
  assert.match(html, /月7本プランを始める/);
  assert.match(html, /月3本プランを始める/);
  assert.match(
    html,
    /1本あたり約(?:<!-- -->)?143(?:<!-- -->)?円/,
  );
  assert.match(html, /1本あたり約167円/);
  assert.match(html, /¥(?:<!-- -->)?200/);
  assert.match(html, /カード情報は撮るだけリールに保存されません/);
  assert.match(html, /無料体験は編集結果が完成した時点/);
  assert.match(html, /有料プランでは、動画の書き出しに成功した時点で、保存できる残り本数が1本減ります/);
  assert.match(html, /月3本・月7本プランは1か月ごとの自動更新/);
  assert.match(html, /動画1本プランは1回払い/);
  assert.doesNotMatch(
    html,
    /device-access-7k9m2p|運営端末を登録|登録コード/,
  );
});

test("renders the five-pattern photo reel editor as a separate public route", async () => {
  const response = await render("/photo-reel");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /写真を選ぶだけ。/);
  assert.match(html, /動きのある1本に。/);
  assert.match(html, /自動編集を選ぶ/);
  assert.match(html, /シネマ/);
  assert.match(html, /リズム/);
  assert.match(html, /エディトリアル/);
  assert.match(html, /ダイアリー/);
  assert.match(html, /クリーン/);
  assert.match(html, /プレビュー中の変更は追加料金なし/);
  assert.doesNotMatch(html, /API料金/);
  assert.match(html, /1080×1920/);
  assert.match(html, /仕上がりプレビューは無料/);
  assert.match(html, /動画1本プラン/);
  assert.match(html, /月3本プラン/);
  assert.match(html, /月7本プラン/);
  assert.match(html, /¥(?:<!-- -->)?500/);
  assert.match(html, /¥(?:<!-- -->)?1,000/);
  assert.match(html, /1か月に動画(?:<!-- -->)?7(?:<!-- -->)?本まで/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/photo-reel"/,
  );
});

test("ships production metadata without starter markers", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /property="og:title" content="撮るだけリール｜リール動画をAIで自動編集・字幕生成"/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/"/,
  );
  assert.match(
    html,
    /property="og:url" content="https:\/\/torudake-reel\.pages\.dev\/"/,
  );
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(html, /nonoimageindex/);
  assert.match(html, /rel="icon"[^>]+favicon\.svg/);
  assert.match(html, /rel="manifest"[^>]+manifest\.webmanifest/);
  assert.match(html, /type="application\/ld\+json"/);
  assert.match(html, /"@type":"WebApplication"/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Starter Project|30秒ジャッジ/);
});

test("keeps canonical metadata on the public host for query and forwarded-host variants", async () => {
  const response = await render("/?updated=seo&utm_source=test", {
    "x-forwarded-host": "example.invalid",
  });
  const html = await response.text();

  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/"/,
  );
  assert.match(
    html,
    /property="og:image" content="https:\/\/torudake-reel\.pages\.dev\/og\.png/,
  );
  assert.doesNotMatch(html, /example\.invalid/);
});

test("keeps the operator enrollment page out of search results", async () => {
  const response = await render("/internal/device-access-7k9m2p");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /端末の状態を確認中/);
  assert.match(
    html,
    /name="robots" content="[^"]*noindex[^"]*nofollow[^"]*noarchive/,
  );
  assert.doesNotMatch(html, /OPERATOR_ENROLLMENT_CODE/);
});

test("loads the passkey account screen without a broken ChatGPT sign-in route", async () => {
  const response = await render("/account");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /利用状況を確認中/);
  assert.match(
    html,
    /name="robots" content="[^"]*noindex[^"]*nofollow[^"]*noarchive/,
  );
  assert.doesNotMatch(html, /\/signin-with-chatgpt/);
});

test("publishes a privacy policy for uploaded media and external processors", async () => {
  const response = await render("/privacy");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /プライバシーポリシー/);
  assert.match(html, /OpenAI/);
  assert.match(html, /Cloudflare/);
  assert.match(html, /Stripe/);
  assert.match(html, /Google Analytics/);
  assert.match(html, /72時間/);
  assert.match(html, /動画の静止画フレーム/);
  assert.match(html, /torudake\.reel@gmail\.com/);
  assert.match(html, /特定商取引法に基づく表記/);
  assert.match(html, /請求手数料はかかりません/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/privacy"/,
  );
  assert.match(
    html,
    /property="og:url" content="https:\/\/torudake-reel\.pages\.dev\/privacy"/,
  );
});

test("publishes the commercial disclosure and contact route before checkout", async () => {
  const response = await render("/commercial-disclosure");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /特定商取引法に基づく表記/);
  assert.match(html, /torudake\.reel@gmail\.com/);
  assert.match(html, /遅滞なく電子メールで開示/);
  assert.match(html, /月3本プラン/);
  assert.match(html, /月7本プラン/);
  assert.match(
    html,
    /月7本プラン[\s\S]*1か月に動画(?:<!-- -->)?7(?:<!-- -->)?本まで・1か月(?:<!-- -->)?1,000(?:<!-- -->)?円/,
  );
  assert.match(
    html,
    /旧月(?:<!-- -->)?8(?:<!-- -->)?本プラン（新規申込終了）[\s\S]*月額(?:<!-- -->)?1,480(?:<!-- -->)?円・既存契約者のみ/,
  );
  assert.match(html, /新規申込終了/);
  assert.match(html, /動画1本プラン/);
  assert.match(html, /1回の購入で動画1本まで/);
  assert.match(html, /Stripe/);
  assert.match(html, /最大500MB/);
  assert.match(html, /編集とプレビューを利用できます/);
  assert.match(html, /有料プランでは、動画の書き出しに成功した時点で、保存できる残り本数が1本減ります/);
  assert.match(html, /合計(?:<!-- -->)?3(?:<!-- -->)?分以内・最大(?:<!-- -->)?2(?:<!-- -->)?動画/);
  assert.match(html, /表示価格はすべて消費税込み/);
  assert.match(html, /支払済み期間の料金は日割りで返金しません/);
  assert.match(html, /注文確定後のお客様都合によるキャンセル・返品・返金/);
  assert.match(html, /AI処理の利用上限/);
  assert.match(html, /文字起こし、高精度再解析、AI台本の生成、AI音声の生成/);
  assert.match(html, /初回ナレーションは台本が正常に生成された時点で1回分/);
  assert.match(html, /続く初回音声と内部の自動調整では追加回数を使用しません/);
  assert.match(html, /作成後の再生成などは正常に完了するごとに1回分/);
  assert.match(html, /動画を保存せず編集を終了した場合も戻りません/);
  assert.match(html, /1動画あたり(?:<!-- -->)?3(?:<!-- -->)?回/);
  assert.match(html, /1動画あたり(?:<!-- -->)?5(?:<!-- -->)?回/);
  assert.match(html, /1動画あたり(?:<!-- -->)?6(?:<!-- -->)?回/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/commercial-disclosure"/,
  );
});

test("publishes the shared AI processing limits in the terms", async () => {
  const response = await render("/terms");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /文字起こし、高精度再解析、AI台本の生成、AI音声の生成/);
  assert.match(
    html,
    /無料体験(?:<!-- -->)?3(?:<!-- -->)?回、(?:<!-- -->)?動画1本プラン(?:<!-- -->)?5(?:<!-- -->)?回、月3本・月7本プラン(?:<!-- -->)?6(?:<!-- -->)?回/,
  );
  assert.match(
    html,
    /月3本プラン(?:<!-- -->)?は、1か月に動画(?:<!-- -->)?3(?:<!-- -->)?本まで保存でき、料金は1か月(?:<!-- -->)?500(?:<!-- -->)?円[\s\S]*月7本プラン(?:<!-- -->)?は、1か月に動画(?:<!-- -->)?7(?:<!-- -->)?本まで保存でき、料金は1か月(?:<!-- -->)?1,000(?:<!-- -->)?円/,
  );
  assert.match(
    html,
    /旧月(?:<!-- -->)?8(?:<!-- -->)?本プラン（月額(?:<!-- -->)?1,480(?:<!-- -->)?円）は既存契約者専用/,
  );
  assert.match(html, /初回ナレーションは台本が正常に生成された時点で1回分/);
  assert.match(html, /続く初回音声と内部の自動調整では追加回数を使用しません/);
  assert.match(html, /作成後の再生成、文字起こし、高精度再解析は正常に完了するごとに1回分/);
  assert.match(html, /動画を保存せず編集を終了した場合も戻りません/);
  assert.match(html, /合計(?:<!-- -->)?3(?:<!-- -->)?分以内・最大(?:<!-- -->)?2(?:<!-- -->)?動画/);
  assert.match(html, /すべて消費税込み/);
  assert.match(html, /規約バージョン：(?:<!-- -->)?2026-08-12/);
  assert.match(html, /投稿素材と知的財産権/);
  assert.match(html, /利用停止とサービスの変更/);
  assert.match(html, /保証と責任の範囲/);
  assert.match(html, /準拠法と管轄/);
  assert.match(html, /torudake\.reel@gmail\.com/);
});
