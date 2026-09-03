import type { Metadata } from "next";
import { buildPublicPageStructuredData } from "../../lib/seo";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import StructuredData from "../structured-data";
import VideoMixClient from "./video-mix-client";

const title = "複数動画を自動でつなぐ・テロップ生成｜撮るだけリール";
const description =
  "スマホで撮った動画を最大5本選び、各動画から1〜2カットを選択して順番を保った1本のショート動画へ。元の音声を活かす仕上げと、AIナレーションを主役にする仕上げを選び、日本語テロップや8種類のつなぎ方でInstagramリール・YouTubeショート向けに編集できます。";

export const metadata: Metadata = buildPublicPageMetadata({
  title,
  description,
  path: "/video-mix",
});

export default function VideoMixPage() {
  return (
    <>
      <StructuredData
        data={buildPublicPageStructuredData({
          name: title,
          description,
          path: "/video-mix",
        })}
      />
      <VideoMixClient />
    </>
  );
}
