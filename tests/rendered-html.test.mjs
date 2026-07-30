import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
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
  assert.match(html, /動画を預ける/);
  assert.match(html, /安全な受け渡し画面へ/);
  assert.match(html, /あなたがするのは、/);
  assert.match(html, /目的に合わせて自動編集/);
  assert.doesNotMatch(html, /AIが全部整える/);
  assert.match(html, /まず1本、完成を見てから。/);
  assert.match(html, /最大500MB/);
  assert.match(html, /合計3分または2動画まで/);
  assert.match(html, /月8本プランを始める/);
  assert.match(html, /1本あたり185円/);
  assert.match(html, /¥(?:<!-- -->)?300/);
  assert.match(html, /カード情報は撮るだけリールに保存されません/);
});

test("ships production metadata without starter markers", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /property="og:title" content="撮るだけリール｜動画を選ぶだけの自動動画編集"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Starter Project|30秒ジャッジ/);
});
