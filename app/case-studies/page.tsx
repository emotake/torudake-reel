import Link from "next/link";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import { buildPublicPageStructuredData } from "../../lib/seo";
import SiteFooter from "../site-footer";
import StructuredData from "../structured-data";
import styles from "../evidence-pages.module.css";

const title = "ショート動画の運営検証事例";
const description = "日常・お出かけ、会話・解説、商品・お店紹介の3用途で、実際に使った素材、設定、確認箇所、制約を公開します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/case-studies",
  image: {
    path: "/campaign/recognition-202609/editor-step-preview.png",
    width: 1265,
    height: 3914,
    alt: "撮るだけリールの仕上がりプレビューと運営検証事例",
  },
});

const cases = [
  {
    href: "/use-cases/daily-moments",
    label: "日常・お出かけ",
    title: "カメラロールで眠る景色を投稿用の1本へ",
    body: "元の流れを保ち、使う場面・構図・テロップを確認した約10秒の実演です。",
  },
  {
    href: "/use-cases/talking-video",
    label: "会話・解説",
    title: "元の話し声を残して自動テロップを確認",
    body: "文字、文の区切り、表示タイミングと、カットしない選択肢を確認した実演です。",
  },
  {
    href: "/use-cases/shop-introduction",
    label: "商品・お店紹介",
    title: "外観・店内・商品の順番を保って紹介",
    body: "複数の場面を撮影順に確認し、商品が見える構図と冒頭コピーを検証した例です。",
  },
] as const;

export default function CaseStudiesPage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <StructuredData data={buildPublicPageStructuredData({ name: title, description, path: "/case-studies", imagePath: "/campaign/recognition-202609/editor-step-preview.png" })} />
        <Link className={styles.back} href="/">← 撮るだけリール</Link>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>VERIFIED EXAMPLES</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        <p className={styles.notice}>
          現在掲載しているのは実利用者の成果を装った事例ではなく、運営側の検証です。各ページで素材、設定、人が確認した所、うまくいかない条件まで確認できます。
        </p>
        <div className={styles.cardGrid}>
          {cases.map((item) => (
            <Link className={styles.card} href={item.href} key={item.href}>
              <span>{item.label}</span>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
              <strong>条件と動画を見る →</strong>
            </Link>
          ))}
        </div>
        <section className={styles.section}>
          <h2>実利用者の事例は、許諾を得てから追加します。</h2>
          <p>元動画や店舗名を無断で公開せず、公開範囲、匿名化、動画の掲載期間を確認できた事例だけを追加します。</p>
          <Link className={styles.cta} href="/support">事例掲載について問い合わせる</Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
