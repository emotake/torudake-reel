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
  assert.match(html, /<title>撮るだけリール｜動画・写真をかんたんリール編集<\/title>/);
  assert.match(html, /動画や写真を、/);
  assert.match(html, /リールに。/);
  assert.match(html, /必要な機能だけを選んで仕上げられます。/);
  const heroCopyStart = html.indexOf('class="landingIntroCopy"');
  const heroResultStart = html.indexOf(
    'class="landingHeroResult"',
    heroCopyStart,
  );
  assert.ok(heroCopyStart >= 0);
  assert.ok(heroResultStart > heroCopyStart);

  const heroCopyHtml = html.slice(heroCopyStart, heroResultStart);
  const heroLeadIndex = heroCopyHtml.indexOf(
    "画面の案内に沿って、必要な機能だけを選んで仕上げられます。",
  );
  const heroPromiseIndex = heroCopyHtml.indexOf('class="landingPromiseList"');
  assert.ok(heroLeadIndex >= 0 && heroLeadIndex < heroPromiseIndex);
  assert.match(
    heroCopyHtml,
    /<ul\b[^>]*class="landingPromiseList"[^>]*aria-label="共通の仕上がり条件"/,
  );
  assert.equal(
    (heroCopyHtml.match(/<li class="landingPromiseItem">/g) ?? []).length,
    3,
  );
  assert.equal(
    (
      heroCopyHtml.match(
        /class="landingPromiseMark" aria-hidden="true"/g,
      ) ?? []
    ).length,
    3,
  );

  const renderedPromiseItems = Array.from(
    heroCopyHtml.matchAll(/<li class="landingPromiseItem">([\s\S]*?)<\/li>/g),
    (match) => match[1],
  );
  const renderedPromisePairs = [
    ["プレビュー無料", "プレビュー", "無料"],
    ["最大1080p", "最大", "1080p"],
    ["透かしなし", "透かし", "なし"],
  ];

  assert.equal(renderedPromiseItems.length, renderedPromisePairs.length);
  for (const [index, [accessibleCopy, term, value]] of renderedPromisePairs.entries()) {
    const item = renderedPromiseItems[index];
    const accessibleCopyIndex = item.indexOf(
      `<span class="visuallyHidden">${accessibleCopy}</span>`,
    );
    const visualTypographyIndex = item.indexOf(
      'class="landingPromiseTypography" aria-hidden="true"',
    );
    const termIndex = item.indexOf(
      `<span class="landingPromiseTerm">${term}</span>`,
    );
    const valueIndex = item.indexOf(`>${value}</span>`, termIndex);

    assert.ok(
      accessibleCopyIndex >= 0 && accessibleCopyIndex < visualTypographyIndex,
      `${accessibleCopy} must remain contiguous in SSR for assistive technology`,
    );
    assert.ok(
      visualTypographyIndex < termIndex && termIndex < valueIndex,
      `${term}/${value} must remain in rendered visual reading order`,
    );
  }
  assert.equal(
    (
      heroCopyHtml.match(
        /class="landingPromiseTypography" aria-hidden="true"/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (heroCopyHtml.match(/class="landingPromiseTerm"/g) ?? []).length,
    3,
  );
  assert.equal(
    (heroCopyHtml.match(/class="landingPromiseValue(?:\s[^"']*)?"/g) ?? [])
      .length,
    3,
  );
  assert.doesNotMatch(
    heroCopyHtml,
    /<strong>\s*(?:プレビュー無料|最大1080p|透かしなし)\s*<\/strong>/,
  );
  assert.doesNotMatch(html, /landingPromiseRow/);
  assert.doesNotMatch(html, /素材を選んで、|作り方をひとつ選ぶだけ。/);
  assert.match(html, /<span>かんたん動画編集<\/span>/);
  assert.match(html, /素材を選ぶだけで、投稿できる動画へ/);
  assert.doesNotMatch(html, /<span>AI自動編集<\/span>/);
  assert.doesNotMatch(html, /<span>新着<\/span>/);
  assert.match(html, /id="create"/);
  assert.match(html, /動画1本でも、複数でも、写真だけでも。/);
  assert.match(
    html,
    /手元の素材に合う作り方を選べます。編集とプレビューは無料です。/,
  );
  assert.doesNotMatch(html, /何から作りますか？/);
  assert.match(html, /動画1本から作る/);
  assert.match(html, /複数の動画から作る/);
  assert.match(html, /2〜5本から使う場面を選び/);
  assert.match(html, /写真から作る/);
  assert.match(html, /最大10枚の写真を選び/);
  assert.match(html, /href="\/video-mix"/);
  assert.match(html, /href="\/photo-reel"/);
  assert.match(html, /href="\/pricing"/);
  assert.match(html, /class="heroVisual realDemo"/);
  assert.equal((html.match(/<video\b/g) ?? []).length, 1);
  assert.match(html, /<source src="\/demo\/torudake-demo\.mp4" type="video\/mp4"/);
  assert.match(html, /poster="\/demo\/torudake-demo-poster\.jpg"/);
  assert.match(html, /controls=""/);
  assert.match(html, /playsInline=""/);
  assert.match(html, /preload="none"/);
  assert.match(html, /<track default="" kind="captions"/);
  assert.doesNotMatch(html, /autoplay=""|muted=""|loop=""/);
  assert.match(html, /約10秒・音声付き/);
  assert.match(html, /実際の仕上がり/);
  assert.match(html, /サンプル動画で、仕上がりを確認できます/);
  assert.match(html, /映像・音声・テロップをまとめて確認できます。登録は必要ありません/);
  assert.doesNotMatch(html, /先に見てから、作り始められます/);
  assert.doesNotMatch(html, /AIナレーションの仕上がりを、先に聴けます/);
  assert.doesNotMatch(html, /固定見本は試聴用モデル/);
  assert.doesNotMatch(html, /実際の動画では本番モデル/);
  assert.doesNotMatch(html, /ナイトマーケット/);
  assert.match(html, /動画データの取り扱い/);
  assert.match(html, /カットや書き出しは、お使いのスマホ・タブレット・パソコンで行います/);
  assert.match(html, /写真と選んだ音源を外部のAIサービスへ送信しません/);
  assert.match(html, /動画ファイル、または動画から取り出した音声・静止画を外部サービスへ送信/);
  assert.doesNotMatch(html, /必要な音声・静止画だけを安全に送信/);
  assert.match(html, /編集とプレビューは無料/);
  assert.match(html, /最大1080p・透かしなし/);
  assert.doesNotMatch(html, /lifestyleGallery/);
  assert.doesNotMatch(html, /4工程|AUTO CUT/);
  assert.match(html, /共通の3ステップ/);
  assert.match(html, /素材を選ぶ/);
  assert.match(html, /案内に沿って決める/);
  assert.match(html, /確認して保存する/);
  assert.doesNotMatch(html, /元の音声とAIナレーションを自然に組み合わせる/);
  assert.doesNotMatch(html, /元の音声があっても、なくても対応/);
  assert.doesNotMatch(html, /AIが全部整える/);
  assert.match(html, /仕上がりを見てから、保存方法を選べます/);
  assert.match(html, /無料体験は合計3分以内・最大2動画まで/);
  assert.match(html, /1回払い・税込・自動更新なし/);
  assert.match(html, /月(?:<!-- -->)?3(?:<!-- -->)?本 ¥(?:<!-- -->)?500/);
  assert.match(html, /月(?:<!-- -->)?7(?:<!-- -->)?本 ¥(?:<!-- -->)?1,000/);
  assert.match(html, /¥(?:<!-- -->)?200/);
  assert.match(html, /始める前に知りたいこと/);
  assert.match(html, /いつ料金がかかりますか？/);
  assert.doesNotMatch(
    html,
    /device-access-7k9m2p|運営端末を登録|登録コード/,
  );
});

test("renders the single-video editor as a focused public route", async () => {
  const response = await render("/video-edit");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /<title>1本の動画をかんたん編集｜撮るだけリール<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/video-edit"/);
  assert.match(html, /1本の動画を、/);
  assert.match(html, /投稿できる形へ/);
  assert.match(html, /動画を1本選ぶ/);
  assert.match(html, /AIナレーションの4つの声を試聴する/);
  assert.match(html, /AIナレーションの仕上がりを、先に聴けます/);
  for (const voice of ["calm", "bright", "comedy", "party"]) {
    assert.match(html, new RegExp(`/demo/voices/${voice}-v5\\.wav`));
  }
});

test("renders a dedicated, frequency-first pricing page", async () => {
  const response = await render("/pricing");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /<title>料金プラン｜撮るだけリール<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/pricing"/);
  assert.match(html, /まず1本。/);
  const planHtml = html.slice(html.indexOf('id="plans"'));
  const oneTimeIndex = planHtml.indexOf("動画1本だけ保存");
  const starterIndex = planHtml.search(/1か月に動画(?:<!-- -->)?3(?:<!-- -->)?本まで/);
  const standardIndex = planHtml.search(/1か月に動画(?:<!-- -->)?7(?:<!-- -->)?本まで/);
  assert.ok(oneTimeIndex >= 0 && oneTimeIndex < starterIndex);
  assert.ok(starterIndex < standardIndex);
  assert.match(html, /本人確認後に、Stripeでお支払い/);
  assert.match(html, /1か月ごとに自動更新/);
});

test("renders the five-pattern photo reel editor as a separate public route", async () => {
  const response = await render("/photo-reel");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /写真を選ぶだけ。/);
  assert.match(html, /動きのある1本に。/);
  assert.match(html, /写真を選んで無料でプレビュー/);
  assert.match(html, /無料体験はサービス共通で合計3分以内・最大2動画まで/);
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

test("renders the ordered five-video editor as a separate public route", async () => {
  const response = await render("/video-mix");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /順番を守って/);
  assert.match(html, /各動画から1〜2カット/);
  assert.match(html, /最大5本・合計500MB・合計5分まで/);
  assert.match(html, /自然なフェード/);
  assert.match(html, /黒へフェード/);
  assert.match(html, /ほかの5種類も見る/);
  assert.match(html, /AIナレーションを入れる/);
  assert.match(html, /会話・解説を活かすか、AIナレーションを主役にするかも選べます/);
  assert.match(html, /元の声をAI音声へ置き換えたいとき/);
  assert.match(html, /動画を選んで無料でプレビュー/);
  assert.match(html, /プラン購入時に決済・書き出し成功時に完成動画1本分の利用枠を使用/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/video-mix"/,
  );
});

test("ships production metadata without starter markers", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /property="og:title" content="撮るだけリール｜動画・写真をかんたんリール編集"/);
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
  assert.match(html, /rel="icon"[^>]+favicon-v2\.svg/);
  assert.match(html, /rel="icon"[^>]+favicon-v2-32\.png/);
  assert.match(html, /rel="shortcut icon"[^>]+favicon\.ico/);
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
  assert.match(html, /利用枠の確定前に端末内へ一時保存/);
  assert.match(html, /遅くとも7日を目安に削除対象/);
  assert.match(html, /Cloudflare/);
  assert.match(html, /Stripe/);
  assert.match(html, /Google Analytics/);
  assert.match(html, /72時間/);
  assert.match(html, /本サービス側で一時保管した処理用の動画・音声/);
  assert.match(html, /外部事業者による保存期間/);
  assert.match(html, /動画ファイルまたは動画から抽出した音声/);
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

test("publishes safe support guidance for billing, recovery, and export failures", async () => {
  const response = await render("/support");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /決済・月額プランの解約/);
  assert.match(html, /書き出しや保存に失敗した/);
  assert.match(html, /パスキーを登録した端末を紛失した/);
  assert.match(html, /二重請求・返金について/);
  assert.match(html, /エラー番号/);
  assert.match(html, /利用端末とブラウザ/);
  assert.match(html, /問題が起きた工程/);
  assert.match(html, /動画・音声ファイルや字幕・台本の本文はメールへ添付・貼り付けしないでください/);
  assert.match(html, /torudake\.reel@gmail\.com/);
  assert.doesNotMatch(html, /24時間以内|営業日以内|自動返信|独自ドメイン/);
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/torudake-reel\.pages\.dev\/support"/,
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
  assert.match(html, /規約バージョン：(?:<!-- -->)?2026-08-13/);
  assert.match(html, /投稿素材と知的財産権/);
  assert.match(html, /利用停止とサービスの変更/);
  assert.match(html, /保証と責任の範囲/);
  assert.match(html, /準拠法と管轄/);
  assert.match(html, /torudake\.reel@gmail\.com/);
});
