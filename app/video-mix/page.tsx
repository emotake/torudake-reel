import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import VideoMixClient from "./video-mix-client";

export const metadata: Metadata = buildPublicPageMetadata({
  title: "最大5つの動画を順番どおりにつなぐ｜撮るだけリール",
  description:
    "スマホで撮った動画を最大5つ選び、各動画から1〜2カットを選択。素材の順番を前後させず、自然なフェードで1本のリール動画に仕上げます。",
  path: "/video-mix",
});

export default function VideoMixPage() {
  return <VideoMixClient />;
}
