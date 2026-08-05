import Link from "next/link";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import {
  NARRATION_DISCLOSURE_TEXT,
  NARRATION_TERMS_VERSION,
} from "../../lib/narration";
import {
  LIGHT_MONTHLY_PRICE_JPY,
  LIGHT_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PRICE_JPY,
} from "../../lib/billing-policy";

export const metadata = buildPublicPageMetadata({
  title: "利用規約｜撮るだけリール",
  description: "撮るだけリールの利用条件です。",
  path: "/terms",
});

export default function TermsPage() {
  return (
    <main className="legalPage">
      <Link className="legalBack" href="/">
        ← 撮るだけリールへ戻る
      </Link>
      <header>
        <p className="eyebrow">TERMS OF SERVICE</p>
        <h1>利用規約</h1>
        <p>規約バージョン：{NARRATION_TERMS_VERSION}</p>
      </header>

      <article>
        <h2>1. 本サービスについて</h2>
        <p>
          撮るだけリールは、利用者が提供する動画・音声・補足情報をもとに、編集候補、字幕、投稿文、AIナレーション等を作成する支援サービスです。生成結果は公開前に利用者自身で確認してください。
        </p>
      </article>

      <article>
        <h2>2. AIナレーションの表示</h2>
        <p>
          AIナレーションを利用した動画には、投稿先の閲覧者がAI生成音声であると分かるよう、投稿文など見える場所に次の表示を含めてください。
        </p>
        <p>
          <strong>{NARRATION_DISCLOSURE_TEXT}</strong>
        </p>
        <ul>
          <li>
            本サービスは、公開動画へサービス名や透かしを常時焼き込みません。
          </li>
          <li>
            投稿文をコピーする際は上記表示を自動追加し、動画書き出し前に確認を求めます。
          </li>
          <li>
            投稿時に表示を削除、隠す、または閲覧者が認識できない方法へ変更しないでください。
          </li>
          <li>
            表示を外して公開した場合、本規約違反として機能制限や利用停止の対象となることがあります。
          </li>
        </ul>
      </article>

      <article>
        <h2>3. 利用者の確認事項</h2>
        <p>
          利用者は、動画・画像・音楽・商標・出演者の肖像その他の素材を利用する権限を有すること、生成された台本や字幕に事実と異なる表現がないこと、投稿先の規約や法令に適合することを確認するものとします。
        </p>
      </article>

      <article>
        <h2>4. 禁止事項</h2>
        <p>
          第三者へのなりすまし、本人の同意なく実在人物の声であると誤認させる利用、詐欺的・違法な表示、権利侵害、サービスの不正利用を禁止します。
        </p>
      </article>

      <article>
        <h2>5. 有料プランとお支払い</h2>
        <ul>
          <li>
            月{LIGHT_MONTHLY_VIDEO_LIMIT}本プランは月額
            {LIGHT_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円です。解約するまで1か月ごとに自動更新されます。
          </li>
          <li>
            1動画作成は{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}円です。購入した利用枠に有効期限はありません。
          </li>
          <li>
            支払いと解約はStripeの決済画面およびアカウント画面から行います。月額プランを解約した場合、支払済み期間の終了時に月額利用枠が終了します。
          </li>
          <li>
            デジタルサービスの性質上、利用済みの利用枠は、法令上必要な場合または本サービス側の不具合が認められる場合を除き返金対象外です。
          </li>
        </ul>
      </article>

      <article>
        <h2>6. 生成結果とサービス運営</h2>
        <p>
          AIによる生成結果は常に正確または完全とは限りません。本サービスは、確認画面、開示文の自動追加、確認記録など、適切な利用を支える合理的な仕組みを継続して整備します。
        </p>
      </article>
    </main>
  );
}
