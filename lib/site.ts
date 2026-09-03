export const SITE_ORIGIN = "https://torudake-reel.pages.dev";
export const SITE_NAME = "撮るだけリール";
export const SITE_TITLE =
  "撮るだけリール｜AIでショート動画をかんたん編集";
export const SITE_DESCRIPTION =
  "スマホで撮った最大5本の動画や10枚の写真から、Instagramリール・YouTubeショート向けの縦型動画をかんたん作成。自動カット、自動テロップ、AIナレーションに対応し、編集とプレビューは無料です。";
export const SITE_LAST_MODIFIED = "2026-09-04";
export const SITE_OG_IMAGE_PATH = "/og.png?v=20260811-accessibility";

export function siteUrl(path = "/") {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}
