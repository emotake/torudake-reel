import Link from "next/link";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { GuideArticle } from "../guide-article";
import { EDITOR_SCREENSHOTS } from "../guide-proof-assets";

const title = "YouTubeショート用の動画をスマホで編集する方法";
const description =
  "スマホで撮った動画や写真を、YouTubeショート向けの縦型動画へ整える方法を紹介します。自動カット、自動テロップ、AIナレーションを必要に応じて選べます。";
const imagePath = "/campaign/recognition-202609/shop-poster.jpg";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/guide/youtube-shorts-editing",
  image: {
    path: imagePath,
    width: 600,
    height: 400,
    alt: "商品やお店の動画をYouTubeショート向けに整えた完成例",
  },
});

export default function YoutubeShortsEditingGuide() {
  return (
    <GuideArticle
      title={title}
      description={description}
      path="/guide/youtube-shorts-editing"
      imagePath={imagePath}
      screenshots={EDITOR_SCREENSHOTS}
      demo={{
        id: "youtube_shorts",
        title: "商品やお店の動画も、順番と伝えたい内容を確認してショート動画にできます。",
        conclusion: "撮った順番を保つか、音声に合わせてつなぎ直すかを選べます。テロップやAIナレーションも必要な場合だけ追加できます。",
        videoPath: "/campaign/recognition-202609/shop-b.mp4",
        posterPath: imagePath,
        videoDescription: "外観・店内・商品を撮った順番で確認し、紹介用の縦型動画へまとめる10秒の例です。",
        facts: [
          { label: "入力", value: "商品・お店を撮った複数の縦動画" },
          { label: "設定", value: "撮った順番を維持／テロップあり" },
          { label: "完成", value: "10秒・縦1080×1920・MP4" },
        ],
        available: [
          "複数の動画を撮った順番のまま確認して接続",
          "元音声またはAIナレーションに合わせてテロップを追加",
          "YouTube Shorts用タイトルと説明文の下書きを確認",
        ],
        notes: [
          "YouTubeへの自動アップロードは行いません。保存した動画をYouTubeから投稿します。",
          "最大1080p・透かしなしで書き出します。元素材や端末により解像度は変わります。",
          "完成動画は最大90秒です。投稿前にYouTube側の最新要件も確認してください。",
        ],
        ctaHref: "/video-mix",
        ctaLabel: "複数の動画からショートを作る",
      }}
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
