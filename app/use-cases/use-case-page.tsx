import Link from "next/link";
import StructuredData from "../structured-data";
import SiteFooter from "../site-footer";
import { buildPublicPageStructuredData } from "../../lib/seo";
import { siteUrl } from "../../lib/site";
import styles from "./use-cases.module.css";

export type UseCasePageContent = {
  slug: string;
  eyebrow: string;
  title: string;
  lead: string;
  pain: string;
  outcome: string;
  steps: readonly [string, string, string];
  video: string;
  poster: string;
  videoName: string;
  videoDescription: string;
  ctaHref: string;
  ctaLabel: string;
  fit: readonly [string, string, string];
  choices: readonly {
    title: string;
    body: string;
    href?: string;
    linkLabel?: string;
  }[];
  faqs: readonly {
    question: string;
    answer: string;
  }[];
};

export default function UseCasePage({ content }: { content: UseCasePageContent }) {
  const path = `/use-cases/${content.slug}`;
  const pageStructuredData = buildPublicPageStructuredData({
    name: content.title,
    description: content.lead,
    path,
    breadcrumbs: [
      { name: "撮るだけリール", path: "/" },
      { name: content.title, path },
    ],
  });
  const videoStructuredData = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: content.videoName,
    description: content.videoDescription,
    thumbnailUrl: siteUrl(content.poster),
    uploadDate: "2026-09-04",
    duration: "PT10S",
    contentUrl: siteUrl(content.video),
    inLanguage: "ja-JP",
    mainEntityOfPage: { "@id": `${siteUrl(path)}#webpage` },
    publisher: { "@id": `${siteUrl("/")}#organization` },
  };

  return (
    <main className={styles.page}>
      <StructuredData data={pageStructuredData} />
      <StructuredData data={videoStructuredData} />
      <section className={styles.hero}>
        <div className={styles.copy}>
          <Link className={styles.back} href="/">
            ← 撮るだけリール
          </Link>
          <p className={styles.eyebrow}>{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p className={styles.lead}>{content.lead}</p>
          <div className={styles.problemSolution}>
            <p><small>よくある悩み</small>{content.pain}</p>
            <p><small>目指す仕上がり</small>{content.outcome}</p>
          </div>
          <Link className={styles.cta} href={content.ctaHref}>
            {content.ctaLabel}<span aria-hidden="true">→</span>
          </Link>
          <p className={styles.freeNote}>編集とプレビューは無料。保存するときだけ料金を選びます。</p>
        </div>
        <figure className={styles.videoCard}>
          <span>約10秒の実演</span>
          <video controls playsInline preload="metadata" poster={content.poster}>
            <source src={content.video} type="video/mp4" />
          </video>
          <figcaption>{content.videoDescription}</figcaption>
        </figure>
      </section>

      <section className={styles.steps} aria-labelledby="useCaseStepsTitle">
        <p className={styles.eyebrow}>使い方</p>
        <h2 id="useCaseStepsTitle">編集に詳しくなくても、3つの流れで進められます。</h2>
        <ol>
          {content.steps.map((step, index) => (
            <li key={step}><span>0{index + 1}</span><p>{step}</p></li>
          ))}
        </ol>
      </section>

      <section className={styles.guide} aria-labelledby="useCaseGuideTitle">
        <div className={styles.fitCard}>
          <p className={styles.eyebrow}>こんなときに</p>
          <h2 id="useCaseGuideTitle">この使い方が合う人</h2>
          <ul>
            {content.fit.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div className={styles.choiceList}>
          <p className={styles.eyebrow}>自分で決められること</p>
          {content.choices.map((choice) => (
            <article key={choice.title}>
              <h3>{choice.title}</h3>
              <p>{choice.body}</p>
              {choice.href && choice.linkLabel ? (
                <Link href={choice.href}>{choice.linkLabel} →</Link>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className={styles.faq} aria-labelledby="useCaseFaqTitle">
        <p className={styles.eyebrow}>よくある質問</p>
        <h2 id="useCaseFaqTitle">始める前に確認できます。</h2>
        <div>
          {content.faqs.map((faq) => (
            <article key={faq.question}>
              <h3>{faq.question}</h3>
              <p>{faq.answer}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.related} aria-labelledby="relatedUseCasesTitle">
        <h2 id="relatedUseCasesTitle">ほかの使い方を見る</h2>
        <div>
          <Link href="/use-cases/daily-moments">日常・お出かけ動画</Link>
          <Link href="/use-cases/talking-video">会話・解説動画</Link>
          <Link href="/use-cases/shop-introduction">商品・お店紹介</Link>
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
