import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";
import { EDITOR_SCREENSHOTS } from "../guide-proof-assets";

const title = "AIナレーションの漢字・商品名の読み方を直す方法";
const description =
  "AI音声が漢字、地名、商品名を読み間違えたとき、表示するテロップを変えずに読み方と抑揚を修正する方法を紹介します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/japanese-reading",
  image: {
    path: "/campaign/recognition-202609/editor-step-options.png",
    width: 1265,
    height: 3115,
    alt: "商品名・人名・地名の正しい表記を入力する実際の編集画面",
  },
});

export default function JapaneseReadingGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/japanese-reading"
      imagePath="/campaign/recognition-202609/editor-step-options.png"
      screenshots={[EDITOR_SCREENSHOTS[1]]}
      demo={{
        id: "japanese_reading",
        title: "表示する漢字と、AI音声が読むひらがなを分けて修正できます。",
        conclusion: "商品名・人名・地名は作成前に正しい表記を伝え、生成後に読み方だけ直せます。テロップをひらがなへ変える必要はありません。",
        imagePath: "/campaign/recognition-202609/editor-step-options.png",
        posterPath: "/campaign/recognition-202609/editor-step-options.png",
        videoDescription: "公開中の詳細設定画面です。文字起こし前に、商品名・人名・地名の正しい漢字表記を最大12語まで入力できます。",
        mediaLabel: "実際の固有名詞入力欄",
        facts: [
          { label: "作成前", value: "正しい漢字表記を最大12語まで指定" },
          { label: "作成後", value: "テロップ本文とAI音声の読み方を別々に修正" },
          { label: "再生成", value: "読み方を直した区間だけAI音声を作り直す" },
        ],
        available: [
          "漢字、地名、商品名の表示を保ったまま読みだけ変更",
          "一度直した読み方を端末へ保存し、次の動画でも利用",
          "気になる区間だけを選んでAI音声を再生成",
        ],
        notes: [
          "作成前の正しい表記入力は追加のAI処理回数を使いません。",
          "AI音声を再生成する操作はAI処理回数とAPI利用が発生します。",
          "同じ漢字でも文脈で読みが変わる場合は、対象区間ごとに確認してください。",
        ],
        ctaHref: "/video-edit",
        ctaLabel: "読み方の修正手順を試す",
      }}
    >
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
