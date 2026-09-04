import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import UseCasePage from "../use-case-page";

const title = "日常・お出かけ動画をショート動画へ｜撮るだけリール";
const description = "撮ったまま眠っている日常やお出かけの動画を、Instagramリール・YouTubeショートへ投稿できる形に整える使い方を動画で紹介します。";
export const metadata: Metadata = buildPublicPageMetadata({ title, description, path: "/use-cases/daily-moments" });

export default function DailyMomentsPage() {
  return <UseCasePage content={{
    slug: "daily-moments",
    eyebrow: "日常・お出かけ動画",
    title: "撮ったまま眠っている景色を、投稿できる1本へ。",
    lead: description,
    pain: "旅行や休日の動画は増えるのに、編集が後回しになる。",
    outcome: "使いたい場面を選び、テンポとテロップを確認して投稿へ進める。",
    steps: ["スマホで撮った動画や写真を選ぶ", "使いたい場面と仕上げ方を選ぶ", "無料プレビューを見て必要な所だけ直す"],
    video: "/campaign/recognition-202609/daily-a.mp4",
    poster: "/campaign/recognition-202609/daily-poster.jpg",
    videoName: "日常・お出かけ動画の編集実演",
    videoDescription: "日常の風景を選び、短いショート動画として見せる試作実演です。",
    ctaHref: "/video-edit",
    ctaLabel: "動画1本で無料プレビュー",
  }} />;
}
