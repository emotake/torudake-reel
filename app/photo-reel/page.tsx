import type { Metadata } from "next";
import { buildPublicPageStructuredData } from "../../lib/seo";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import StructuredData from "../structured-data";
import PhotoReelClient from "./photo-reel-client";

const title = "写真からショート動画を自動作成｜撮るだけリール";
const description =
  "スマホの写真を2〜10枚選ぶだけで、動きのある縦型ショート動画を端末内で作成。5種類の自動編集から選び、InstagramリールやYouTubeショート向けの仕上がりを無料でプレビューできます。";

export const metadata: Metadata = buildPublicPageMetadata({
  title,
  description,
  path: "/photo-reel",
});

export default function PhotoReelPage() {
  return (
    <>
      <StructuredData
        data={buildPublicPageStructuredData({
          name: title,
          description,
          path: "/photo-reel",
        })}
      />
      <PhotoReelClient />
    </>
  );
}
