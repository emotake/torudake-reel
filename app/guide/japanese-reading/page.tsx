import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";

const title = "AIナレーションの漢字・商品名の読み方を直す方法";
const description =
  "AI音声が漢字、地名、商品名を読み間違えたとき、表示するテロップを変えずに読み方と抑揚を修正する方法を紹介します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`, description, path: "/guide/japanese-reading",
});

export default function JapaneseReadingGuide() {
  return (
    <GuideArticle title={title} description={description} path="/guide/japanese-reading">
      <article>
        <h2>画面に出す文字と、声の読み方を分けて直せます</h2>
        <p>
          たとえば画面には漢字の商品名を残し、音声だけひらがなの読みへ指定できます。テロップを書き換える必要はありません。
        </p>
      </article>
      <article>
        <h2>気になる部分だけを再生成</h2>
        <p>
          読み方や抑揚に違和感がある部分を選び、その部分だけ修正できます。音声全体を作り直すより確認しやすく、声質と音量が途中で変わりにくい仕上げ方です。
        </p>
      </article>
      <article>
        <h2>表示テロップの誤字も編集できます</h2>
        <p>
          読み方とは別に、画面へ表示するテロップ本文も編集できます。修正後は仕上がりプレビューで文字と音声の両方を確認してください。
        </p>
      </article>
    </GuideArticle>
  );
}
