import Link from "next/link";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";

const title = "Instagramリール用の動画をスマホで編集する方法";
const description =
  "スマホで撮った日常の動画や写真から、Instagramリール向けの縦型動画を作る手順を紹介します。自動カット、自動テロップ、AIナレーションを必要に応じて選べます。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/instagram-reels-editing",
});

export default function InstagramReelsEditingGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/instagram-reels-editing"
    >
      <article>
        <h2>動画1本・複数動画・写真から選ぶ</h2>
        <p>
          その日に撮った動画が1本なら「動画1本から作る」、場面ごとに分かれた動画が2〜5本なら「複数の動画から作る」、写真だけなら「写真から作る」を選びます。難しいタイムライン操作は必要ありません。
        </p>
      </article>
      <article>
        <h2>話し声を活かすか、AIナレーションを付けるか決める</h2>
        <p>
          会話や説明が入った動画は元の音声を活かせます。風景、旅行、商品紹介などの無言動画にはAIナレーションを追加できます。話し声のある動画へAIナレーションを重ねる場合は、元動画の音量も調整できます。
        </p>
      </article>
      <article>
        <h2>カットとテロップは必要なものだけ使う</h2>
        <p>
          元の映像をそのまま残すか、声に合わせて映像をつなぎ直すかを選べます。自動テロップはオン・オフを選択でき、認識した文字の誤字や不要な部分も保存前に修正できます。
        </p>
        <p>
          <Link href="/guide/automatic-video-captions">
            自動テロップの詳しい使い方を見る
          </Link>
        </p>
      </article>
      <article>
        <h2>縦型の仕上がりと表紙をプレビューする</h2>
        <p>
          縦・横・正方形の動画を選び、縦型画面で見せたい位置を確認します。動画内の候補フレームから投稿用の表紙を選び、文字を加えた状態も保存前に確認できます。
        </p>
      </article>
      <article>
        <h2>保存前に投稿先をInstagramにする</h2>
        <p>
          仕上げ画面でInstagramを選ぶと、リール投稿前に確認したい項目と投稿文の下書きをまとめて確認できます。編集とプレビューは無料で、完成動画を保存するときにだけ保存方法を選びます。
        </p>
      </article>
    </GuideArticle>
  );
}
