import Link from "next/link";
import { SITE_NAME, SITE_ORIGIN } from "../../lib/site";

export function GuideArticle({
  title,
  description,
  path,
  children,
}: {
  title: string;
  description: string;
  path: string;
  children: React.ReactNode;
}) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    inLanguage: "ja-JP",
    datePublished: "2026-08-12",
    dateModified: "2026-08-12",
    mainEntityOfPage: `${SITE_ORIGIN}${path}`,
    publisher: { "@type": "Organization", name: SITE_NAME },
  };
  return (
    <main className="legalPage">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
      />
      <Link className="legalBack" href="/">
        ← 撮るだけリールへ戻る
      </Link>
      <header>
        <p className="eyebrow">REEL EDITING GUIDE</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
      <article>
        <h2>まずは無料で仕上がりを確認</h2>
        <p>
          撮るだけリールは編集とプレビューまで無料です。完成動画の保存時に、1動画200円または月額プランを選べます。
        </p>
        <p>
          <Link href="/">動画を選んで試す</Link>
          {" ／ "}
          <Link href="/photo-reel">写真からリールを作る</Link>
        </p>
      </article>
    </main>
  );
}
