import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import PhotoReelClient from "./photo-reel-client";

export const metadata: Metadata = buildPublicPageMetadata({
  title: "写真からリールを自動作成｜撮るだけリール",
  description:
    "スマホで撮った写真を2〜10枚選ぶだけ。5種類の自動編集から選んで、縦型リール動画を端末内で作成できます。",
  path: "/photo-reel",
});

export default function PhotoReelPage() {
  return <PhotoReelClient />;
}
