import { siteUrl } from "./site";

export const LINE_SHARE_ENDPOINT =
  "https://social-plugins.line.me/lineit/share";
export const LINE_SHARE_TEXT =
  "撮りっぱなしの動画を、投稿できるリールに。撮るだけリールをスマホで試せます。";

export function buildLineShareUrl({
  url = siteUrl("/"),
  text = LINE_SHARE_TEXT,
}: {
  url?: string;
  text?: string;
} = {}) {
  const shareUrl = new URL(LINE_SHARE_ENDPOINT);
  shareUrl.searchParams.set("url", url);
  shareUrl.searchParams.set("text", text);
  return shareUrl.toString();
}

export const LINE_SHARE_URL = buildLineShareUrl();
