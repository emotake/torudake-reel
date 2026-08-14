export const SITE_ORIGIN = "https://torudake-reel.pages.dev";
export const SITE_NAME = "撮るだけリール";
export const SITE_TITLE =
  "撮るだけリール｜動画・写真をかんたんリール編集";
export const SITE_DESCRIPTION =
  "スマホで撮った最大5本の動画や最大10枚の写真を選ぶだけで、自動カット、自動テロップ、AIナレーション、写真リールに対応。AIナレーションモードでは投稿文も作成できる、リール動画編集サービスです。";
export const SITE_LAST_MODIFIED = "2026-08-14";
export const SITE_OG_IMAGE_PATH = "/og.png?v=20260811-accessibility";

export function siteUrl(path = "/") {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}
