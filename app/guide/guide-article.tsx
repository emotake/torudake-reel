import Link from "next/link";
import { buildGuideStructuredData } from "../../lib/seo";
import SiteFooter from "../site-footer";
import StructuredData from "../structured-data";

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
  const structuredData = buildGuideStructuredData({
    name: title,
    description,
    path,
  });
  return (
    <>
      <main className="legalPage">
      <StructuredData data={structuredData} />
      <nav className="legalBack" aria-label="パンくずリスト">
        <Link href="/">撮るだけリール</Link>
        <span aria-hidden="true">／</span>
        <Link href="/guide">動画編集ガイド</Link>
      </nav>
      <header>
        <p className="eyebrow">REEL EDITING GUIDE</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
      <article>
        <h2>まずは無料で仕上がりを確認</h2>
        <p>
          撮るだけリールは編集とプレビューまで無料です。完成動画の保存時に、動画1本200円または月額プランを選べます。
        </p>
        <p>
          <Link href="/video-edit">動画を1本選んで試す</Link>
          {" ／ "}
          <Link href="/video-mix">複数の動画から作る</Link>
          {" ／ "}
          <Link href="/photo-reel">写真からリールを作る</Link>
        </p>
      </article>
      </main>
      <SiteFooter />
    </>
  );
}
