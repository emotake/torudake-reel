import type { Metadata } from "next";
import { buildPublicPageStructuredData } from "../../lib/seo";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import { VideoEditExperience } from "../page";
import StructuredData from "../structured-data";

const title = "スマホ動画をAIで自動編集｜撮るだけリール";
const description =
  "スマホで撮った1本の動画を、自動カット・日本語の自動テロップ・AIナレーションでショート動画へ。編集とプレビューは無料で、InstagramリールやYouTubeショート向けに仕上げられます。";

export const metadata: Metadata = buildPublicPageMetadata({
  title,
  description,
  path: "/video-edit",
});

export default function VideoEditPage() {
  return (
    <>
      <StructuredData
        data={buildPublicPageStructuredData({
          name: title,
          description,
          path: "/video-edit",
        })}
      />
      <VideoEditExperience />
    </>
  );
}
