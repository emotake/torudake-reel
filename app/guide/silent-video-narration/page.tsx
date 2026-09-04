import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";
import { EDITOR_SCREENSHOTS } from "../guide-proof-assets";

const title = "無言動画にAIナレーションを付ける方法";
const description =
  "風景・旅行・商品などの無言動画から台本を作り、声、テロップ、カットの有無を選んでリールに仕上げる方法を紹介します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/silent-video-narration",
  image: {
    path: "/campaign/recognition-202609/editor-step-preview.png",
    width: 1265,
    height: 3914,
    alt: "AIナレーション、テロップ、カットを確認する仕上がり画面",
  },
});

export default function SilentVideoNarrationGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/silent-video-narration"
      imagePath="/campaign/recognition-202609/editor-step-preview.png"
      screenshots={[EDITOR_SCREENSHOTS[2]]}
      demo={{
        id: "ai_narration",
        title: "AI音声だけ、テロップ付き、映像の自動カットあり・なしを別々に選べます。",
        conclusion: "AIナレーションを作ることと、テロップや映像を自動編集することは別の設定です。元動画を短くしたくない場合は「カットしない」を選べます。",
        audioPath: "/demo/voices/bright-v5.wav",
        posterPath: "/campaign/recognition-202609/editor-step-preview.png",
        videoDescription: "本番と同じ音声モデルで生成し、品質確認を通した自然な女性の固定サンプルです。試聴では新しいAI処理や料金は発生しません。",
        mediaLabel: "実際のAI音声サンプル",
        facts: [
          { label: "入力", value: "風景・旅行・商品などの動画と伝えたい内容" },
          { label: "設定", value: "AIナレーション／テロップ任意／カット任意" },
          { label: "確認", value: "台本・読み方・声・元動画音量を保存前に調整" },
        ],
        available: [
          "話し声のない動画や、話し声のある動画へAIナレーションを追加",
          "元動画の音量を調整し、ナレーションを聞きやすく合成",
          "テロップと映像の自動カットを個別にオン・オフ",
        ],
        notes: [
          "音声サンプルは固定音声です。自分の動画で台本や音声を生成するとAI処理回数を使用します。",
          "固有名詞は、画面に出す表記と音声の読み方を分けて修正できます。",
          "声質やイントネーションは生成ごとにわずかに変わる場合があります。",
        ],
        ctaHref: "/video-edit",
        ctaLabel: "AIナレーションの設定を確認する",
      }}
    >
      <article>
        <h2>無言の風景動画でも利用できます</h2>
        <p>
          AIナレーションモードでは、動画の場面と入力した補足情報をもとに日本語の台本を作ります。現在は自然な男性・自然な女性・ハイテンショントークから声を選べます。
        </p>
      </article>
      <article>
        <h2>映像を勝手に短くしたくない場合</h2>
        <p>
          映像の仕上げ方で「元の映像をそのまま使う」を選べば、AI音声だけを加え、映像の自動カットを行わない構成にできます。自動カットを使う場合も、仕上がりプレビューで確認してから保存します。
        </p>
      </article>
      <article>
        <h2>テロップなしにもできます</h2>
        <p>
          AIナレーションの内容をテロップとして表示するかどうかは選択できます。声だけを載せたい動画ではテロップをオフにし、必要な場合はプレビュー後にデザインを変更できます。
        </p>
      </article>
    </GuideArticle>
  );
}
