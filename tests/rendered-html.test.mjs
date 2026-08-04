import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
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
  assert.match(html, /<title>撮るだけリール｜動画を選ぶだけの自動動画編集<\/title>/);
  assert.match(html, /動画を選ぶだけ。/);
  assert.match(html, /編集は、もうしない。/);
  assert.match(html, /動画を選んで無料で試す/);
  assert.doesNotMatch(html, /動画を預ける|安全な受け渡し画面へ/);
  assert.match(html, /あなたがするのは、/);
  assert.match(html, /目的に合わせて自動編集/);
  assert.doesNotMatch(html, /AIが全部整える/);
  assert.match(html, /まず1本、完成を見てから。/);
  assert.match(html, /最大500MB/);
  assert.match(html, /合計3分または2動画まで/);
  assert.match(html, /月8本プランを始める/);
  assert.match(html, /1本あたり185円/);
  assert.match(html, /¥(?:<!-- -->)?200/);
  assert.match(html, /カード情報は撮るだけリールに保存されません/);
  assert.doesNotMatch(
    html,
    /device-access-7k9m2p|運営端末を登録|登録コード/,
  );
});

test("ships production metadata without starter markers", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /property="og:title" content="撮るだけリール｜動画を選ぶだけの自動動画編集"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Starter Project|30秒ジャッジ/);
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
  assert.match(html, /72時間/);
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
});
