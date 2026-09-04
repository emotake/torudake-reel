import Link from "next/link";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";
import { EDITOR_SCREENSHOTS } from "../guide-proof-assets";

const title = "動画にテロップを自動生成する方法";
const description =
  "スマホ動画の日本語音声からテロップを作り、声に合わせて順番に表示し、誤字や不要な部分を直してショート動画へ書き出す手順を紹介します。";
const imagePath = "/campaign/recognition-202609/talking-poster.jpg";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/automatic-video-captions",
  image: {
    path: imagePath,
    width: 1080,
    height: 1920,
    alt: "会話・解説動画に日本語テロップを付けた縦型動画の完成例",
  },
});

export default function AutomaticVideoCaptionsGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/automatic-video-captions"
      imagePath={imagePath}
      screenshots={EDITOR_SCREENSHOTS}
      demo={{
        id: "automatic_captions",
        title: "日本語の話し声から、テロップ付きの完成形まで確認できます。",
        conclusion: "音声を一度認識したあと、誤字・表示しない発話・テロップの見た目を保存前に調整できます。文字修正だけなら音声認識をやり直しません。",
        videoPath: "/campaign/recognition-202609/talking-b.mp4",
        posterPath: imagePath,
        videoDescription: "元の話し声を活かし、認識した文字と使う発話を確認して見やすく整える10秒の例です。",
        facts: [
          { label: "入力", value: "日本語の会話・解説が入った縦動画" },
          { label: "設定", value: "元音声を活かす／テロップあり／元の流れを維持" },
          { label: "完成", value: "10秒・縦1080×1920・MP4" },
        ],
        available: [
          "日本語音声からテロップを自動生成",
          "認識した文字の修正と不要なテロップの非表示",
          "枠付き・文字だけのテロップデザインを比較",
        ],
        notes: [
          "声が小さい、音楽と重なる、複数人が同時に話す場合は認識精度が下がることがあります。",
          "音声認識は作成時に実行されます。文字修正やデザイン変更では再実行しません。",
          "対応ブラウザは最新のSafari、Chrome、Edgeです。",
        ],
        ctaHref: "/video-edit",
        ctaLabel: "自分の動画でテロップを試す",
      }}
    >
      <article>
        <h2>話し声のある動画を選ぶ</h2>
        <p>
          動画が1本なら<Link href="/video-edit">1本の動画を整える</Link>、2〜5本なら
          <Link href="/video-mix">複数の動画をつなぐ</Link>を選びます。元の話し声を残す仕上げでは、必要な場面だけを選んでからテロップを作れます。
        </p>
      </article>
      <article>
        <h2>元音声から日本語テロップを作る</h2>
        <p>
          「元音声のテロップを付ける」をオンにし、作成ボタンを押します。音声認識はこの操作でだけ実行され、文字の修正や見た目の変更ではAI処理回数を使いません。
        </p>
      </article>
      <article>
        <h2>声に合わせて文字を順番に表示</h2>
        <p>
          認識した単語のタイミングを使い、話し始めた言葉から順番にテロップへ表示します。プレビューと完成動画は同じ表示処理を使うため、確認したタイミングのまま書き出せます。
        </p>
      </article>
      <article>
        <h2>誤字と不要なテロップを確認する</h2>
        <p>
          認識が違う文字は入力欄で直せます。使わないテロップは非表示にでき、元動画のその部分を残すかカットするかも仕上げ方に合わせて選べます。
        </p>
      </article>
      <article>
        <h2>見た目を選んでプレビューする</h2>
        <p>
          枠付きと文字だけのテロップから雰囲気を選びます。デザインの変更では音声認識をやり直さないため、追加のAI処理なしで比較できます。
        </p>
      </article>
    </GuideArticle>
  );
}
