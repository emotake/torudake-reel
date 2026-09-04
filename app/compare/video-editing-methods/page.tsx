import Link from "next/link";
import { buildPublicPageMetadata } from "../../../lib/site-metadata";
import { buildPublicPageStructuredData } from "../../../lib/seo";
import SiteFooter from "../../site-footer";
import StructuredData from "../../structured-data";
import styles from "../../evidence-pages.module.css";

const title = "自動編集・テンプレート編集・編集代行の違い";
const description = "ショート動画を作る3つの方法を、誰が編集判断をするか、修正方法、待ち時間、費用の発生地点で比較します。";

export const metadata = buildPublicPageMetadata({
  title: `${title}｜撮るだけリール`,
  description,
  path: "/compare/video-editing-methods",
  image: {
    path: "/campaign/recognition-202609/editor-step-options.png",
    width: 1265,
    height: 3115,
    alt: "自動編集で動画の長さ、テロップ、カットを選ぶ画面",
  },
});

export default function VideoEditingMethodsComparisonPage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <StructuredData data={buildPublicPageStructuredData({ name: title, description, path: "/compare/video-editing-methods", imagePath: "/campaign/recognition-202609/editor-step-options.png" })} />
        <Link className={styles.back} href="/">← 撮るだけリール</Link>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>HOW TO CHOOSE</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        <p className={styles.notice}>
          2026年9月4日時点の運営検証です。特定の競合サービスを使って順位付けした記事ではなく、同じ短い素材から1本を作るときの作業構造を比較しています。
        </p>
        <section className={styles.section}>
          <h2>違いは「編集を誰が決めるか」です。</h2>
          <p>細部をすべて自分で作るならテンプレート編集、完成品質を人へ任せるなら編集代行、細かなタイムライン操作をせず自分で最終判断したい場合は自動編集が向きます。</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>比較項目</th><th>撮るだけリール</th><th>テンプレート編集</th><th>編集代行</th></tr></thead>
              <tbody>
                <tr><th>編集判断</th><td>初稿は自動。カット、テロップ、音声は利用者が選択</td><td>テンプレートを基に利用者が各要素を配置</td><td>依頼内容を基に制作者が判断</td></tr>
                <tr><th>操作</th><td>素材、音声、仕上げ方を順番に選択</td><td>素材配置、尺、文字、動きを個別に調整</td><td>素材共有、要望整理、確認と修正依頼</td></tr>
                <tr><th>修正</th><td>文字、使う発話、読み方、デザインを画面で修正</td><td>タイムラインやキャンバス上で直接修正</td><td>修正内容を伝えて再納品を待つ</td></tr>
                <tr><th>費用の発生</th><td>編集とプレビュー後、完成動画を保存するとき</td><td>サービスのプランや素材により異なる</td><td>見積・発注条件により異なる</td></tr>
                <tr><th>向く人</th><td>編集が面倒で投稿まで進めない人</td><td>見た目を細部まで自分で作りたい人</td><td>予算を取り、編集作業全体を任せたい人</td></tr>
              </tbody>
            </table>
          </div>
        </section>
        <section className={styles.section}>
          <h2>撮るだけリールで実測した範囲</h2>
          <ul>
            <li>公開サンプルを選び、既定の元音声モードで初稿を作成</li>
            <li>サンプル処理はこの検証環境で約8秒。通信・端末・動画尺で変動</li>
            <li>完成尺7秒、縦1080×1920予定、テロップありをプレビューで確認</li>
            <li>サンプルのため外部AI処理と無料体験回数は不使用</li>
          </ul>
          <p>テンプレート編集と編集代行の所要時間・費用は製品や依頼先で変わるため、根拠のない平均値は掲載していません。</p>
          <Link className={styles.cta} href="/video-edit">同じサンプルで確認する</Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
