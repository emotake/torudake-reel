export const SITE_ORIGIN = "https://torudake-reel.pages.dev";
export const SITE_NAME = "撮るだけリール";
export const SITE_TITLE =
  "撮るだけリール｜編集が面倒で投稿できない悩みを軽くする";
export const SITE_DESCRIPTION =
  "撮った動画や写真はあるのに、編集が面倒で投稿できない人へ。素材を選び、必要な仕上げだけを決めて、Instagramリール・YouTubeショート向けの1本を作れます。編集とプレビューは無料です。";
export const SITE_LAST_MODIFIED = "2026-09-04";
export const SITE_OG_IMAGE_PATH = "/og.png?v=20260811-accessibility";

export function siteUrl(path = "/") {
  return new URL(path, `${SITE_ORIGIN}/`).toString();
}
