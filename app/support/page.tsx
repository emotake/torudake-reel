import Link from "next/link";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import SiteFooter from "../site-footer";

export const metadata = buildPublicPageMetadata({
  title: "よくある質問・お問い合わせ｜撮るだけリール",
  description:
    "撮るだけリールの決済・解約、保存失敗、Googleログイン、パスキー紛失、二重請求・返金に関するご案内です。",
  path: "/support",
});

const CONTACT_EMAIL = "torudake.reel@gmail.com";
const CONTACT_SUBJECT = "撮るだけリール 利用サポートの相談";
const CONTACT_BODY = `次の項目だけをご記入ください。

・画面に表示されたエラー番号：
・利用端末とブラウザ（例：iPhone 15／Safari）：
・問題が起きた工程（例：動画選択、プレビュー、決済、書き出し、保存）：

動画ファイル、音声、字幕・台本の本文はメールへ添付・貼り付けしないでください。`;

const CONTACT_URL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  CONTACT_SUBJECT,
)}&body=${encodeURIComponent(CONTACT_BODY)}`;

export default function SupportPage() {
  return (
    <>
      <main className="legalPage">
      <Link className="legalBack" href="/">
        ← 撮るだけリールへ戻る
      </Link>
      <header>
        <p className="eyebrow">サポート</p>
        <h1>よくある質問・お問い合わせ</h1>
        <p>困っている内容に近い項目を、先にご確認ください。</p>
      </header>

      <article>
        <h2>決済・月額プランの解約</h2>
        <p>
          月額プランの解約や支払い方法の確認は、
          <Link href="/account">アカウント画面</Link>
          から行えます。解約後も、支払済み期間の終了までは残っている利用枠を使えます。動画1本プランは1回払いで、自動更新されません。
        </p>
      </article>

      <article>
        <h2>書き出しや保存に失敗した</h2>
        <p>
          まず空き容量を確認し、画面を閉じずに再試行してください。iPhoneではSafariを使い、低電力モードを解除すると改善する場合があります。書き出しに失敗した場合、有料の保存本数は原則として減りません。
        </p>
      </article>

      <article>
        <h2>Googleログインまたはパスキーで困った</h2>
        <p>
          新しいアカウントはGoogleで作成します。Googleで作成したアカウントにパスキーも登録している場合は、パスキーを予備のログイン方法として利用できます。既存のパスキー専用アカウントで、登録済み端末が1台も使えない場合は、下のお問い合わせ先へご相談ください。安全確認なしにログインを解除することはありません。
        </p>
      </article>

      <article>
        <h2>二重請求・返金について</h2>
        <p>
          同じ購入が複数回請求されたように見える場合は、Stripeの領収書とカード明細の日付・金額をご確認ください。法令上必要な場合、二重請求、またはサービス側の不具合が認められる場合は個別に確認します。動画や字幕を送る必要はありません。
        </p>
      </article>

      <article>
        <h2>解決しない場合</h2>
        <p>
          お問い合わせ時は、画面に表示されたエラー番号、利用端末とブラウザ、問題が起きた工程だけをお知らせください。プライバシー保護のため、動画・音声ファイルや字幕・台本の本文はメールへ添付・貼り付けしないでください。
        </p>
        <p>
          <a href={CONTACT_URL}>{CONTACT_EMAIL}へ問い合わせる</a>
        </p>
      </article>

      <article>
        <h2>関連情報</h2>
        <p>
          <Link href="/terms">利用規約</Link>／
          <Link href="/privacy">プライバシーポリシー</Link>／
          <Link href="/commercial-disclosure">特定商取引法に基づく表記</Link>
        </p>
      </article>
      </main>
      <SiteFooter />
    </>
  );
}
