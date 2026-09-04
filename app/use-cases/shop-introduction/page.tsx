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
    fit: [
      "お店の外観、店内、商品を別々の動画で撮っている",
      "紹介したい場面はあるが、並べ方を考えるところで止まる",
      "専門的な編集ソフトを使わず、SNS投稿用の縦型動画にしたい",
    ],
    choices: [
      {
        title: "撮った順番を保って複数動画をつなぐ",
        body: "動画は2〜5本まで選び、素材の順番を確認して1本にまとめます。伝えたい流れを崩さず、使わない場面だけ外せます。",
      },
      {
        title: "写真だけでも縦型動画を作る",
        body: "動画がない場合は、2〜10枚の写真から別の作り方を選べます。商品写真や店内写真を投稿用の縦型動画へまとめられます。",
        href: "/photo-reel",
        linkLabel: "写真からショート動画を作る",
      },
      {
        title: "元音声、テロップ、AIナレーションを選ぶ",
        body: "撮影時の声を活かす方法、説明をテロップで見せる方法、AIナレーションを加える方法から、紹介内容に必要なものだけ選べます。",
        href: "/guide/instagram-reels-editing",
        linkLabel: "Instagramリールの編集手順",
      },
    ],
    faqs: [
      {
        question: "動画は何本までまとめられますか？",
        answer: "2〜5本の動画を選べます。1本だけを整える場合は、動画1本用の編集画面から始められます。",
      },
      {
        question: "写真と動画を同時に使えますか？",
        answer: "現在は複数動画と写真リールが別の作り方です。動画は動画同士、写真は写真同士で1本にまとめます。",
      },
      {
        question: "お店の説明を後から付けられますか？",
        answer: "AIナレーションモードで台本を確認し、声とテロップを加えられます。映像を自動カットするかどうかも選択できます。",
      },
    ],
  }} />;
}
