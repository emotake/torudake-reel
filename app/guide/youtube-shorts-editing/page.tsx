import Link from "next/link";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";

const title = "YouTubeショート用の動画をスマホで編集する方法";
const description =
  "スマホで撮った動画や写真を、YouTubeショート向けの縦型動画へ整える方法を紹介します。自動カット、自動テロップ、AIナレーションを必要に応じて選べます。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/youtube-shorts-editing",
});

export default function YoutubeShortsEditingGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/youtube-shorts-editing"
    >
      <article>
        <h2>手元にある素材から作り方を選ぶ</h2>
        <p>
          動画1本は<Link href="/video-edit">1本の動画を整える</Link>、2〜5本は
          <Link href="/video-mix">複数の動画をつなぐ</Link>、写真2〜10枚は
          <Link href="/photo-reel">写真から作る</Link>を選びます。完成動画はいずれも縦型のプレビューで確認できます。
        </p>
      </article>
      <article>
        <h2>元の声を活かすかAIナレーションを選ぶ</h2>
        <p>
          説明や会話が入っている動画は元音声を活かし、必要な場合だけ自動テロップを付けられます。風景や商品の映像にはAIナレーションを加え、元動画の音量や自動カットの有無を選べます。
        </p>
      </article>
      <article>
        <h2>ショート動画で読みやすいテロップを確認する</h2>
        <p>
          テロップは声に合わせて順番に表示されます。文字の誤り、表示しない部分、デザインをプレビューで確認し、必要な箇所だけを修正します。
        </p>
      </article>
      <article>
        <h2>投稿前に完成尺と画質を見る</h2>
        <p>
          撮るだけリールで作れる動画は1本90秒までです。保存前のプレビューで構図、音声、テロップのタイミングを確認し、完成動画は最大1080p・透かしなしで書き出せます。
        </p>
      </article>
      <article>
        <h2>Instagramリールにも同じ動画を使える</h2>
        <p>
          縦型ショート動画として書き出すため、内容や投稿文を各SNSに合わせて確認すれば、YouTubeショートだけでなくInstagramリール用の素材としても利用できます。
        </p>
      </article>
    </GuideArticle>
  );
}
