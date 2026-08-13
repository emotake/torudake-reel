import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";

const title = "iPhoneのMOV動画からリールを作る方法";
const description =
  "iPhoneで撮ったMOV動画を、縦横の向きを保ちながら自動テロップやカットを加えてリール向けに整える手順を紹介します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`, description, path: "/guide/iphone-mov-reel",
});

export default function IphoneMovReelGuide() {
  return (
    <GuideArticle title={title} description={description} path="/guide/iphone-mov-reel">
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
