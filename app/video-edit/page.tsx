import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import { VideoEditExperience } from "../page";

export const metadata: Metadata = buildPublicPageMetadata({
  title: "1本の動画をかんたん編集｜撮るだけリール",
  description:
    "スマホで撮った1本の動画を選び、元の話し声を活かすかAIナレーションへ置き換えて、必要なカット・テロップ・表紙まで整えます。編集とプレビューは無料です。",
  path: "/video-edit",
});

export default function VideoEditPage() {
  return <VideoEditExperience />;
}
