import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import UseCasePage from "../use-case-page";

const title = "会話・解説動画に自動テロップ｜撮るだけリール";
const description = "話して撮った動画の音声を活かし、不要な場面を選び直して自動テロップを付ける使い方を動画で紹介します。";
export const metadata: Metadata = buildPublicPageMetadata({ title, description, path: "/use-cases/talking-video" });

export default function TalkingVideoPage() {
  return <UseCasePage content={{
    slug: "talking-video",
    eyebrow: "会話・解説動画",
    title: "話した内容はそのまま。見やすさだけ整える。",
    lead: description,
    pain: "字幕起こしと無言部分の調整だけで、投稿前に時間がなくなる。",
    outcome: "文字を直し、使わない発話を外し、元の音声を活かして仕上げる。",
    steps: ["話している動画を選んで文字起こし", "テロップの文字と使う発話を確認", "映像をつなぎ直すか、そのまま残すか選ぶ"],
    video: "/campaign/recognition-202609/talking-a.mp4",
    poster: "/campaign/recognition-202609/talking-poster.jpg",
    videoName: "会話・解説動画の自動テロップ実演",
    videoDescription: "元音声を活かしながら、テロップと編集方法を選ぶ流れの試作実演です。",
    ctaHref: "/video-edit",
    ctaLabel: "自動テロップを無料で試す",
  }} />;
}
