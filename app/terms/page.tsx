import Link from "next/link";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import SiteFooter from "../site-footer";
import { NARRATION_DISCLOSURE_TEXT } from "../../lib/narration";
import {
  FREE_AI_OPERATION_SUCCESS_LIMIT,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  LEGACY_MONTHLY_PRICE_JPY,
  LEGACY_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PLAN_LABEL,
  ONE_TIME_PRICE_JPY,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_VIDEO_LIMIT,
} from "../../lib/billing-policy";

export const metadata = buildPublicPageMetadata({
  title: "利用規約｜撮るだけリール",
  description: "撮るだけリールの利用条件です。",
  path: "/terms",
});

const TERMS_VERSION = "2026-08-18";
const LAST_UPDATED = "2026年8月18日";
const CONTACT_EMAIL = "torudake.reel@gmail.com";
const FREE_MINUTES = Math.floor(FREE_SECONDS_LIMIT / 60);

export default function TermsPage() {
  return (
    <>
      <main className="legalPage">
      <Link className="legalBack" href="/">
        ← 撮るだけリールへ戻る
      </Link>
      <header>
        <p className="eyebrow">TERMS OF SERVICE</p>
        <h1>利用規約</h1>
        <p>
          規約バージョン：{TERMS_VERSION}／最終更新日：{LAST_UPDATED}
        </p>
      </header>

      <article>
        <h2>1. 本サービスについて</h2>
        <p>
          撮るだけリールは、利用者が提供する動画・音声・補足情報をもとに、編集候補、字幕、投稿文、AIナレーション等を作成する支援サービスです。生成結果は公開前に利用者自身で確認してください。
        </p>
        <p>
          本規約は、本サービスの運営者と利用者との間の利用条件を定めるものです。利用者は、本規約と
          <Link href="/privacy">プライバシーポリシー</Link>
          に同意したうえで本サービスを利用します。
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
            無料体験は合計{FREE_MINUTES}分以内・動画{FREE_VIDEO_LIMIT}
            本までの範囲で、いずれかの上限に先に達するまで利用できます。編集とプレビューは無料ですが、外部AI機能の利用と完成動画の保存にはログインが必要で、保存には有料の利用枠が必要です。新しいアカウントはLINEで作成します。
          </li>
          <li>
            LINEの認証権限はログイン確認の完了後すぐに解除し、アクセストークンを継続して保持しません。アカウント削除が確定した場合は、本サービス内に保存したLINEの連携識別情報も削除します。
          </li>
          <li>
            「動画をつないで作る」機能では、最大5本、全素材の合計500MB・5分まで選択できます。複数素材をつないだ完成動画も、書き出して保存する1本を動画1本分として扱います。
          </li>
          <li>
            AI処理には、文字起こし、高精度再解析、AI台本の生成、AI音声の生成が含まれます。初回ナレーションは台本が正常に生成された時点で1回分を使用し、続く初回音声と内部の自動調整では追加回数を使用しません。作成後の再生成、文字起こし、高精度再解析は正常に完了するごとに1回分を使用します。
          </li>
          <li>
            AI処理の上限は動画1本あたり、無料体験
            {FREE_AI_OPERATION_SUCCESS_LIMIT}回、{ONE_TIME_PLAN_LABEL}
            {ONE_TIME_AI_OPERATION_SUCCESS_LIMIT}回、月3本・月7本プラン
            {SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回です。処理に失敗した場合や、同じ処理内で行われる分割処理・自動調整では追加回数を使用しません。正常に完了したAI処理の回数は、動画を保存せず編集を終了した場合も戻りません。
          </li>
          <li>
            {STARTER_MONTHLY_PLAN_LABEL}は、1か月に動画{STARTER_MONTHLY_VIDEO_LIMIT}本まで保存でき、料金は1か月
            {STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円です。{STANDARD_MONTHLY_PLAN_LABEL}は、1か月に動画
            {STANDARD_MONTHLY_VIDEO_LIMIT}本まで保存でき、料金は1か月
            {STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円です。どちらも解約するまで1か月ごとに自動更新されます。
          </li>
          <li>
            旧月{LEGACY_MONTHLY_VIDEO_LIMIT}本プラン（月額
            {LEGACY_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円）は既存契約者専用で、新規申込は受け付けません。
          </li>
          <li>
            {ONE_TIME_PLAN_LABEL}は、1回の購入で完成動画を1本まで保存でき、料金は{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}円です。月額料金と有効期限はありません。
          </li>
          <li>本ページおよび決済画面に表示する販売価格は、すべて消費税込みです。</li>
          <li>
            支払いと解約はStripeの決済画面およびアカウント画面から行います。月3本・月7本プランを解約した場合、支払済み期間の終了時に利用枠が終了します。
          </li>
          <li>
            無料体験は編集結果が完成した時点で1本分を使用します。有料プランでは、動画の書き出しに成功した時点で、保存できる残り本数が1本減ります。
          </li>
          <li>
            月3本・月7本プランを解約しても、支払済み期間の料金は日割りで返金しません。{ONE_TIME_PLAN_LABEL}を含むデジタルサービスは、注文確定後のお客様都合によるキャンセル・返品・返金を受け付けません。ただし、法令上必要な場合、二重請求、または本サービス側の不具合が認められる場合を除きます。
          </li>
        </ul>
      </article>

      <article>
        <h2>6. 生成結果の確認</h2>
        <p>
          AIによる生成結果は常に正確または完全とは限りません。本サービスは、確認画面、開示文の自動追加、確認記録など、適切な利用を支える合理的な仕組みを継続して整備します。
        </p>
      </article>

      <article>
        <h2>7. 投稿素材と知的財産権</h2>
        <p>
          利用者が提供した動画、画像、音声、文章その他の素材に関する権利は、利用者または正当な権利者に留保されます。利用者は、本サービスの提供、障害調査および不正利用防止に必要な範囲で、運営者が当該素材を一時的に処理することを許諾します。
        </p>
        <p>
          本サービスの画面、プログラム、名称、ロゴ、説明文その他の運営者が作成した内容に関する権利は、運営者または正当な権利者に帰属します。本規約は、これらの権利を利用者へ譲渡するものではありません。
        </p>
      </article>

      <article>
        <h2>8. 利用停止とサービスの変更</h2>
        <p>
          利用者が本規約に違反した場合、不正利用または第三者への被害のおそれがある場合、運営者は必要な範囲で機能制限、利用停止またはアカウントの停止を行うことがあります。
        </p>
        <p>
          保守、障害、セキュリティ上の対応、外部サービスの停止、天災その他やむを得ない事情がある場合、事前の通知なく本サービスの全部または一部を一時停止することがあります。重要な機能変更またはサービス終了を行う場合は、合理的な範囲で事前に本サービス上で案内します。
        </p>
      </article>

      <article>
        <h2>9. 保証と責任の範囲</h2>
        <p>
          運営者は、本サービスが常に中断なく動作すること、すべての端末や素材で同じ結果になること、生成結果が利用者の目的に完全に適合することを保証しません。利用者は、公開前に生成結果、権利関係および投稿先の条件を確認してください。
        </p>
        <p>
          運営者が本サービスに関して責任を負う場合、その範囲は、適用法令に反しない限り、通常かつ直接の損害に限られます。この制限は、運営者の故意または重大な過失がある場合には適用しません。
        </p>
      </article>

      <article>
        <h2>10. 本規約の変更</h2>
        <p>
          法令、料金、機能または運営方法の変更に応じて、本規約を変更することがあります。利用者への影響が大きい変更は、変更内容と適用日を本サービス上で事前に案内します。法令上、利用者の同意が必要な変更については、適切な方法で同意を取得します。
        </p>
      </article>

      <article>
        <h2>11. 準拠法と管轄</h2>
        <p>
          本規約は日本法に準拠します。本サービスに関する紛争については、法令に別段の定めがある場合を除き、東京地方裁判所または東京簡易裁判所を第一審の専属的合意管轄裁判所とします。
        </p>
      </article>

      <article>
        <h2>12. お問い合わせ</h2>
        <p>
          本規約、アカウント、決済またはサービス利用に関するお問い合わせは、
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          までご連絡ください。販売事業者の表示事項は、
          <Link href="/commercial-disclosure">特定商取引法に基づく表記</Link>
          から請求できます。
        </p>
      </article>
      </main>
      <SiteFooter />
    </>
  );
}
