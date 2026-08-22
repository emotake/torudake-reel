import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import VideoMixClient from "./video-mix-client";

export const metadata: Metadata = buildPublicPageMetadata({
  title: "最大5本の動画を順番どおりにつなぐ｜撮るだけリール",
  description:
    "スマホで撮った動画を最大5本選び、各動画から1〜2カットを選択。素材の順番を前後させず、8種類のつなぎ方で1本にします。元の音声を活かす仕上げと、AIナレーションを主役にする仕上げを選べ、元音声には必要なときだけ自動テロップを追加できます。",
  path: "/video-mix",
});

export default function VideoMixPage() {
  return <VideoMixClient />;
}
