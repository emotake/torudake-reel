import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";

const title = "無言動画にAIナレーションを付ける方法";
const description =
  "風景・旅行・商品などの無言動画から台本を作り、声、テロップ、カットの有無を選んでリールに仕上げる方法を紹介します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`, description, path: "/guide/silent-video-narration",
});

export default function SilentVideoNarrationGuide() {
  return (
    <GuideArticle title={title} description={description} path="/guide/silent-video-narration">
      <article>
        <h2>無言の風景動画でも利用できます</h2>
        <p>
          AIナレーションモードでは、動画の場面と入力した補足情報をもとに日本語の台本を作ります。自然な男性・自然な女性・明るい男性・明るい女性から声を選べます。
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
