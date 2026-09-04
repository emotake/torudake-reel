import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";
import { EDITOR_SCREENSHOTS } from "../guide-proof-assets";

const title = "iPhoneのMOV動画からリールを作る方法";
const description =
  "iPhoneで撮ったMOV動画を、縦横の向きを保ちながら自動テロップやカットを加えてリール向けに整える手順を紹介します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/iphone-mov-reel",
  image: {
    path: "/campaign/recognition-202609/editor-step-setup.png",
    width: 1265,
    height: 1787,
    alt: "iPhoneのMOVと大きな動画に対応する撮るだけリールの選択画面",
  },
});

export default function IphoneMovReelGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/iphone-mov-reel"
      imagePath="/campaign/recognition-202609/editor-step-setup.png"
      screenshots={[EDITOR_SCREENSHOTS[0]]}
      demo={{
        id: "iphone_mov",
        title: "iPhoneのMOVを変換してから始める必要はありません。",
        conclusion: "写真アプリのMOVをそのまま選べます。25MBを超える場合も、最大500MBまで端末内で音声を取り出してから必要な解析へ進みます。",
        imagePath: "/campaign/recognition-202609/editor-step-setup.png",
        posterPath: "/campaign/recognition-202609/editor-step-setup.png",
        videoDescription: "公開中のサンプル編集画面です。左側の元動画欄と、iPhone MOV・大容量動画を端末内で扱う案内を確認できます。",
        mediaLabel: "実際の動画選択画面",
        facts: [
          { label: "入力", value: "MP4・MOV・WebM／縦・横・正方形" },
          { label: "上限", value: "動画1本・最大5分・500MB" },
          { label: "処理", value: "大容量時の音声抽出は端末内で実行" },
        ],
        available: [
          "iPhoneの写真アプリにあるMOVをそのまま選択",
          "回転情報を読み取り、縦横の向きを保ってプレビュー",
          "対応端末では最大1080pのMP4へ書き出し",
        ],
        notes: [
          "空間オーディオだけの動画など、互換音声トラックがない素材には対応できない場合があります。",
          "元動画が低解像度の場合、書き出しだけで画質が高精細になるわけではありません。",
          "書き出し可否はブラウザ・端末の動画エンコーダー対応状況にも左右されます。",
        ],
        ctaHref: "/video-edit",
        ctaLabel: "iPhoneの動画で確認する",
      }}
    >
      <article>
        <h2>MOVのまま選べます</h2>
        <p>
          iPhoneの「写真」から撮影した動画を選択します。撮影時の回転情報を読み取り、縦動画は縦のまま、横動画は横の構図を保ったままプレビューします。
        </p>
      </article>
      <article>
        <h2>声を活かすか、AI音声を付けるか選ぶ</h2>
        <p>
          会話や説明を活かしたい動画には「元の音声を活かす」がおすすめです。無言の風景・商品動画や、元の声をAI音声へ置き換えたい動画では「AIナレーション」を選べます。元音声モードでは、自動テロップの有無と映像をつなぎ直すかどうかも選択できます。
        </p>
      </article>
      <article>
        <h2>低画質に見えるときの確認点</h2>
        <p>
          書き出し前に出力解像度を確認できます。元動画が小さい場合は、その理由も画面に表示されます。通信アプリから保存し直した動画は圧縮されていることがあるため、できればiPhoneの「写真」にある元動画を選んでください。
        </p>
      </article>
    </GuideArticle>
  );
}
