import Link from "next/link";
import { buildPublicPageStructuredData } from "../../lib/seo";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import SiteFooter from "../site-footer";
import StructuredData from "../structured-data";

const title = "スマホのショート動画編集ガイド｜撮るだけリール";
const description =
  "InstagramリールやYouTubeショート向けの動画編集、自動テロップ、AIナレーション、iPhoneのMOV動画について、撮るだけリールの機能に沿って解説します。";

export const metadata = buildPublicPageMetadata({
  title,
  description,
  path: "/guide",
});

const guides = [
  {
    href: "/guide/automatic-video-captions",
    title: "動画にテロップを自動生成する方法",
    description: "日本語の話し声を文字にして、声に合わせて順番に表示する手順です。",
  },
  {
    href: "/guide/youtube-shorts-editing",
    title: "YouTubeショート用の動画を編集する方法",
    description: "動画1本・複数動画・写真から、縦型ショート動画へ仕上げる流れです。",
  },
  {
    href: "/guide/iphone-mov-reel",
    title: "iPhoneのMOV動画からリールを作る方法",
    description: "iPhoneで撮った動画の向きと画質を保ちながら編集する手順です。",
  },
  {
    href: "/guide/silent-video-narration",
    title: "無言動画にAIナレーションを付ける方法",
    description: "風景・旅行・商品動画へ、AI音声と必要なテロップを加える手順です。",
  },
  {
    href: "/guide/japanese-reading",
    title: "AIナレーションの読み方を直す方法",
    description: "漢字・地名・商品名の表示を保ったまま、音声の読みだけを修正します。",
  },
] as const;

export default function GuideIndexPage() {
  return (
    <>
      <StructuredData
        data={buildPublicPageStructuredData({
          name: title,
          description,
          path: "/guide",
        })}
      />
      <main className="legalPage">
        <Link className="legalBack" href="/">
          ← 撮るだけリールへ戻る
        </Link>
        <header>
          <p className="eyebrow">SHORT VIDEO EDITING GUIDE</p>
          <h1>スマホのショート動画編集ガイド</h1>
          <p>{description}</p>
        </header>
        {guides.map((guide) => (
          <article key={guide.href}>
            <h2>
              <Link href={guide.href}>{guide.title}</Link>
            </h2>
            <p>{guide.description}</p>
            <p>
              <Link href={guide.href}>詳しい手順を見る →</Link>
            </p>
          </article>
        ))}
      </main>
      <SiteFooter />
    </>
  );
}
