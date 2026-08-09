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
  assert.match(html, /面倒な編集は、ここで終わり。/);
  assert.match(html, /動画を選んで無料で試す/);
  assert.match(html, /編集・プレビューは無料/);
  assert.match(html, /保存は1動画/);
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
  assert.match(html, /保存方法は、2つだけ。/);
  assert.match(html, /最大500MB/);
  assert.match(html, /合計3分または2動画まで/);
  assert.match(html, /編集・プレビューまで/);
  assert.match(html, /完成動画の保存は有料/);
  assert.match(html, /月8本プランを始める/);
  assert.match(html, /1本あたり185円/);
  assert.match(html, /¥(?:<!-- -->)?200/);
  assert.match(html, /カード情報は撮るだけリールに保存されません/);
  assert.match(html, /編集結果が完成した時点/);
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
  assert.match(html, /追加API料金 0円/);
  assert.match(html, /1080×1920/);
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
  assert.match(html, /月(?:<!-- -->)?8(?:<!-- -->)?本プラン/);
  assert.match(html, /1動画作成/);
  assert.match(html, /Stripe/);
  assert.match(html, /最大500MB/);
  assert.match(html, /無料体験は編集とプレビューまで/);
  assert.match(html, /写真リールは書き出し成功時点/);
  assert.match(html, /AI処理の利用上限/);
  assert.match(html, /文字起こし、高精度再解析、AI台本の生成、AI音声の生成/);
  assert.match(html, /1動画あたり3回/);
  assert.match(html, /1動画あたり5回/);
  assert.match(html, /1動画あたり10回/);
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
  assert.match(html, /無料体験3回、1動画作成5回、月額プラン10回/);
  assert.match(html, /各処理が正常に完了するごとに1回分を使用/);
});
