import type { Metadata } from "next";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import UseCasePage from "../use-case-page";

const title = "商品・お店紹介のショート動画を作る｜撮るだけリール";
const description = "商品やお店で撮った複数の動画・写真を、順番を保ちながら1本のInstagramリール・YouTubeショートへ整える使い方を紹介します。";
export const metadata: Metadata = buildPublicPageMetadata({ title, description, path: "/use-cases/shop-introduction" });

export default function ShopIntroductionPage() {
  return <UseCasePage content={{
    slug: "shop-introduction",
    eyebrow: "商品・お店紹介",
    title: "紹介したい場面はある。編集に迷わず投稿へ。",
    lead: description,
    pain: "外観・店内・商品を撮っても、並べ方と説明文で手が止まる。",
    outcome: "撮った順番を保ち、使う場面・テロップ・音声を選んで1本にする。",
    steps: ["動画を2〜5本、または写真を2〜10枚選ぶ", "見せたい場面と順番を確認", "テロップやAIナレーションの有無を選ぶ"],
    video: "/campaign/recognition-202609/shop-a.mp4",
    poster: "/campaign/recognition-202609/shop-poster.jpg",
    videoName: "商品・お店紹介動画の編集実演",
    videoDescription: "複数の素材を選び、投稿用の1本へまとめる流れの試作実演です。",
    ctaHref: "/video-mix",
    ctaLabel: "複数動画で無料プレビュー",
  }} />;
}
