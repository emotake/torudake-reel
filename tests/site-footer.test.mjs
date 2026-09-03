import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  footerSource,
  cssSource,
  homeSource,
  videoEditPageSource,
  photoReelPageSource,
  photoReelSource,
  videoMixPageSource,
  videoMixSource,
  pricingSource,
  privacySource,
  termsSource,
  commercialDisclosureSource,
  supportSource,
  guideArticleSource,
  accountSource,
] = await Promise.all([
  readSource("app/site-footer.tsx"),
  readSource("app/globals.css"),
  readSource("app/page.tsx"),
  readSource("app/video-edit/page.tsx"),
  readSource("app/photo-reel/page.tsx"),
  readSource("app/photo-reel/photo-reel-client.tsx"),
  readSource("app/video-mix/page.tsx"),
  readSource("app/video-mix/video-mix-client.tsx"),
  readSource("app/pricing/page.tsx"),
  readSource("app/privacy/page.tsx"),
  readSource("app/terms/page.tsx"),
  readSource("app/commercial-disclosure/page.tsx"),
  readSource("app/support/page.tsx"),
  readSource("app/guide/guide-article.tsx"),
  readSource("app/account/page.tsx"),
]);

const expectedGroups = [
  { id: "create", title: "作る" },
  { id: "guides", title: "ガイド" },
  { id: "support", title: "料金・サポート" },
  { id: "legal", title: "サービス情報" },
];

const expectedLinks = [
  ["/#create", "作り方を選ぶ"],
  ["/video-edit", "1本の動画を整える"],
  ["/video-mix", "複数の動画をつなぐ"],
  ["/photo-reel", "写真から作る"],
  ["/guide", "動画編集ガイド一覧"],
  ["/guide/instagram-reels-editing", "Instagramリールの編集"],
  ["/guide/automatic-video-captions", "動画にテロップを自動生成"],
  ["/guide/youtube-shorts-editing", "YouTubeショートの編集"],
  ["/guide/iphone-mov-reel", "iPhone動画の編集"],
  ["/guide/silent-video-narration", "無音動画にAI音声"],
  ["/guide/japanese-reading", "読み方を修正する"],
  ["/pricing", "料金を見る"],
  ["/support", "よくある質問・お問い合わせ"],
  ["/privacy", "プライバシーポリシー"],
  ["/terms", "利用規約"],
  ["/commercial-disclosure", "特定商取引法に基づく表記"],
];

function mediaBlock(maxWidth) {
  const start = cssSource.indexOf(`@media (max-width: ${maxWidth}px)`);
  assert.notEqual(start, -1, `${maxWidth}pxのメディアクエリが必要です`);
  const next = cssSource.indexOf("@media ", start + 1);
  return cssSource.slice(start, next === -1 ? undefined : next);
}

function assertFooterFollowsMain(name, source, footerPattern = /<SiteFooter \/>/) {
  const mainStart = source.lastIndexOf("<main");
  const mainEnd = source.lastIndexOf("</main>");
  const footerStart = source.lastIndexOf("<SiteFooter");

  assert.ok(mainStart >= 0, `${name}にはmainが必要です`);
  assert.ok(mainStart < mainEnd, `${name}のmainを閉じる必要があります`);
  assert.ok(
    mainEnd < footerStart,
    `${name}のSiteFooterはmainの外側に配置する必要があります`,
  );
  assert.equal(
    (source.match(/<SiteFooter\b/g) ?? []).length,
    1,
    `${name}はSiteFooterを1回だけ表示する必要があります`,
  );
  assert.match(source.slice(mainEnd), footerPattern);
}

test("groups the shared footer into four labelled sections with public routes", () => {
  const groupsStart = footerSource.indexOf("const FOOTER_GROUPS");
  const groupsEnd = footerSource.indexOf("] as const;", groupsStart);
  const groupsSource = footerSource.slice(groupsStart, groupsEnd);
  const groups = [...groupsSource.matchAll(/^\s+id: "([^"]+)",[\s\S]*?^\s+title: "([^"]+)",/gm)]
    .map((match) => ({ id: match[1], title: match[2] }));
  const links = [...groupsSource.matchAll(/\{ href: "([^"]+)", label: "([^"]+)" \}/g)]
    .map((match) => [match[1], match[2]]);

  assert.deepEqual(groups, expectedGroups);
  assert.deepEqual(links, expectedLinks);
  assert.match(footerSource, /動画や写真から、投稿できるショート動画へ/);
  assert.doesNotMatch(footerSource, /素材を選ぶだけで、投稿できる動画へ/);
  assert.match(
    footerSource,
    /<footer className="siteFooter" aria-labelledby="siteFooterTitle">/,
  );
  assert.match(footerSource, /<nav className="siteFooterNav" aria-label="フッターメニュー">/);
  assert.match(
    footerSource,
    /<section[\s\S]*?className="siteFooterGroup"[\s\S]*?aria-labelledby=\{`siteFooter-\$\{group\.id\}`\}[\s\S]*?<h3 id=\{`siteFooter-\$\{group\.id\}`\}>\{group\.title\}<\/h3>[\s\S]*?<ul>[\s\S]*?<li key=\{link\.href\}>/,
  );
});

test("uses the same footer outside main on every public page family", () => {
  for (const [name, source] of [
    ["トップ・1本の動画", homeSource],
    ["写真", photoReelSource],
    ["複数の動画", videoMixSource],
    ["料金", pricingSource],
    ["プライバシー", privacySource],
    ["利用規約", termsSource],
    ["特商法表記", commercialDisclosureSource],
    ["サポート", supportSource],
    ["ガイド", guideArticleSource],
  ]) {
    assertFooterFollowsMain(
      name,
      source,
      name === "複数の動画"
        ? /<SiteFooter preserveWorkspace \/>/
        : /<SiteFooter \/>/,
    );
  }

  assert.match(videoEditPageSource, /<VideoEditExperience \/>/);
  assert.match(photoReelPageSource, /<PhotoReelClient \/>/);
  assert.match(videoMixPageSource, /<VideoMixClient \/>/);
  assert.match(accountSource, /<AccountClient \/>\s*<SiteFooter \/>/);

  const retiredFooterClasses = [
    homeSource,
    photoReelSource,
    videoMixSource,
    pricingSource,
  ].join("\n");
  assert.doesNotMatch(
    retiredFooterClasses,
    /footerLinks|photoReelFooter|videoMixFooter/,
  );
});

test("keeps footer links readable, keyboard-visible, and responsive down to 360px", () => {
  assert.match(
    cssSource,
    /\.siteFooterNav\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    cssSource,
    /\.siteFooterGroup a\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*font-size:\s*14px/,
  );
  assert.match(
    cssSource,
    /\.siteFooter a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--coral-dark\)[^}]*outline-offset:\s*3px/,
  );

  const tablet = mediaBlock(1080);
  assert.match(tablet, /\.siteFooterInner\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(tablet, /\.siteFooterBrand\s*\{[^}]*max-width:\s*560px/);

  const mobile = mediaBlock(760);
  assert.match(
    mobile,
    /\.siteFooterNav\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(mobile, /\.siteFooterBottom\s*\{[^}]*flex-direction:\s*column/);

  const narrow = mediaBlock(360);
  assert.match(
    narrow,
    /\.siteFooterInner,[\s\S]*?\.siteFooterBottom\s*\{[^}]*width:\s*min\(100% - 24px, 1180px\)/,
  );
  assert.match(narrow, /\.siteFooterNav\s*\{[^}]*gap:\s*26px 14px/);
  assert.doesNotMatch(narrow, /\.siteFooterGroup a\s*\{[^}]*font-size:/);
});

test("protects video-mix work by opening every footer destination in a new tab", () => {
  assert.match(videoMixSource, /<SiteFooter preserveWorkspace \/>/);
  assert.match(footerSource, /const navigationTarget = preserveWorkspace \? "_blank" : undefined/);
  assert.match(footerSource, /const navigationRel = preserveWorkspace \? "noreferrer" : undefined/);
  assert.equal((footerSource.match(/target=\{navigationTarget\}/g) ?? []).length, 2);
  assert.equal((footerSource.match(/rel=\{navigationRel\}/g) ?? []).length, 2);
  assert.match(footerSource, /リンクは新しいタブで開きます。/);
  assert.match(
    footerSource,
    /preserveWorkspace[\s\S]*?`\$\{link\.label\}（新しいタブで開く）`/,
  );
});
