export const SITE_ORIGIN = "https://torudake-reel.pages.dev";
export const SITE_NAME = "撮るだけリール";
export const SITE_TITLE =
  "撮るだけリール｜リール動画をAIで自動編集・字幕生成";
export const SITE_DESCRIPTION =
  "スマホで撮った動画や写真を選ぶだけで、無音カット、自動テロップ、AIナレーション、写真リールに対応。AIナレーションモードでは投稿文も作成できる、リール動画編集サービスです。";
export const SITE_OG_IMAGE_PATH = "/og.png?v=20260804-final";

export function siteUrl(path = "/") {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}
