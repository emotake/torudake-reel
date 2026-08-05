export const SITE_ORIGIN = "https://torudake-reel.pages.dev";
export const SITE_NAME = "撮るだけリール";
export const SITE_TITLE =
  "撮るだけリール｜リール動画をAIで自動編集・字幕生成";
export const SITE_DESCRIPTION =
  "撮ったスマホ動画を選ぶだけで、無音カット、自動テロップ、AIナレーション、表紙、投稿文まで。編集が面倒で投稿できない悩みを解決するリール動画編集サービスです。";
export const SITE_OG_IMAGE_PATH = "/og.png?v=20260804-final";

export function siteUrl(path = "/") {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}
