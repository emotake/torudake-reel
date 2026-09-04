import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import UseCasePage from "../use-case-page";

const title = "日常・お出かけ動画をショート動画へ｜撮るだけリール";
const description = "撮ったまま眠っている日常やお出かけの動画を、Instagramリール・YouTubeショートへ投稿できる形に整える使い方を動画で紹介します。";
export const metadata: Metadata = buildPublicPageMetadata({
  title,
  description,
  path: "/use-cases/daily-moments",
  image: {
    path: "/campaign/recognition-202609/daily-poster.jpg",
    width: 1080,
    height: 1920,
    alt: "日常・お出かけ動画をショート動画へ整えた完成例",
  },
});

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
    fit: [
      "旅行、散歩、休日などの日常動画を撮ったままにしている",
      "細かなタイムライン編集はせず、投稿できる形まで進めたい",
      "元の映像を活かしながら、必要な仕上げだけ選びたい",
    ],
    choices: [
      {
        title: "映像をそのまま残すか、テンポよく整えるか",
        body: "元動画の長さや流れを保つ仕上げと、投稿尺に合わせて場面を整える仕上げを選べます。勝手に短くしたくない動画は、そのまま残す設定で進められます。",
      },
      {
        title: "声を活かすか、AIナレーションを加えるか",
        body: "現地の会話や音を残したい動画は元音声を使用できます。説明のない風景動画には、内容に合わせた台本とAIナレーションを追加できます。",
        href: "/guide/silent-video-narration",
        linkLabel: "無音動画へAI音声を付ける手順",
      },
      {
        title: "テロップを付けるか、映像だけにするか",
        body: "テロップは必要な場合だけ使用できます。元音声を使うときは認識した文字を直し、表示しない部分も選べます。",
        href: "/guide/automatic-video-captions",
        linkLabel: "自動テロップの使い方",
      },
    ],
    faqs: [
      {
        question: "横向きで撮った動画も使えますか？",
        answer: "使えます。縦型のプレビューで見せたい位置を確認し、InstagramリールやYouTubeショート向けの画面に整えます。",
      },
      {
        question: "話していない動画でも作れますか？",
        answer: "作れます。映像と元の音だけで仕上げるほか、必要に応じてAIナレーションを加える方法も選べます。",
      },
      {
        question: "確認するだけで料金はかかりますか？",
        answer: "編集とプレビューは無料枠の範囲で確認できます。完成動画を端末へ保存するときに保存方法を選びます。",
      },
    ],
  }} />;
}
