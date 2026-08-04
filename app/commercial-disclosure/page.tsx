import type { Metadata } from "next";
import Link from "next/link";
import {
  LIGHT_MONTHLY_PRICE_JPY,
  LIGHT_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PRICE_JPY,
} from "../../lib/billing-policy";

export const metadata: Metadata = {
  title: "特定商取引法に基づく表記｜撮るだけリール",
  description: "撮るだけリールの販売条件と事業者情報の開示方法です。",
};

const CONTACT_EMAIL = "torudake.reel@gmail.com";
const LAST_UPDATED = "2026年8月3日";

export default function CommercialDisclosurePage() {
  return (
    <main className="legalPage">
      <Link className="legalBack" href="/">
        ← 撮るだけリールへ戻る
      </Link>
      <header>
        <p className="eyebrow">COMMERCIAL DISCLOSURE</p>
        <h1>特定商取引法に基づく表記</h1>
        <p>最終更新日：{LAST_UPDATED}</p>
      </header>

      <article>
        <h2>販売事業者に関する表示</h2>
        <p className="legalDisclosureNotice">
          販売事業者の氏名または名称、所在地、電話番号および責任者名は、
          お客様から請求をいただいた場合、遅滞なく電子メールで開示します。
        </p>
        <dl className="legalDetails">
          <div>
            <dt>開示請求・お問い合わせ</dt>
            <dd>
              <a href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("特定商取引法に基づく表示事項の開示請求")}`}>
                {CONTACT_EMAIL}
              </a>
            </dd>
          </div>
          <div>
            <dt>サービス名</dt>
            <dd>撮るだけリール</dd>
          </div>
        </dl>
      </article>

      <article>
        <h2>販売価格</h2>
        <dl className="legalDetails">
          <div>
            <dt>月{LIGHT_MONTHLY_VIDEO_LIMIT}本プラン</dt>
            <dd>月額{LIGHT_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円</dd>
          </div>
          <div>
            <dt>1動画作成</dt>
            <dd>{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}円</dd>
          </div>
        </dl>
        <p>
          適用される税金がある場合は、注文確定前のStripe決済画面に最終的な支払額を表示します。
        </p>
      </article>

      <article>
        <h2>商品代金以外に必要な費用</h2>
        <p>
          本サービスが別途請求する手数料はありません。インターネット接続料金、通信料金その他の利用環境にかかる費用はお客様の負担となります。
        </p>
      </article>

      <article>
        <h2>支払方法と支払時期</h2>
        <ul>
          <li>クレジットカード決済（決済処理はStripeが行います）</li>
          <li>1動画作成は、注文確定時に支払いが確定します。</li>
          <li>
            月{LIGHT_MONTHLY_VIDEO_LIMIT}本プランは、申込時に初回の支払いが確定し、解約されるまで1か月ごとに自動更新されます。
          </li>
        </ul>
      </article>

      <article>
        <h2>サービスの提供時期</h2>
        <p>
          Stripeでの決済完了を確認後、通常は直ちに利用枠へ反映します。通信状況などにより反映に時間がかかる場合があります。
        </p>
      </article>

      <article>
        <h2>キャンセル・解約・返金</h2>
        <ul>
          <li>
            月額プランはアカウント画面の「支払い方法・解約を管理」からいつでも解約できます。解約後も支払済み期間の終了までは利用でき、次回以降の請求は行いません。
          </li>
          <li>月額料金の日割り返金は行いません。</li>
          <li>
            デジタルサービスの性質上、提供開始後または利用済みの利用枠について、お客様都合による返品・返金は受け付けません。
          </li>
          <li>
            二重請求、決済後に利用枠が反映されない場合、その他本サービス側の不具合がある場合は、上記メールアドレスへご連絡ください。
          </li>
        </ul>
      </article>

      <article>
        <h2>動作環境</h2>
        <p>
          JavaScriptとCookieを有効にした最新のSafari、Google ChromeまたはMicrosoft Edgeをご利用ください。スマートフォンでの動画書き出しには最新のiOSまたはAndroidを推奨します。対応動画形式はMP4、MOV、M4V、WebMで、1動画あたり最大500MBです。端末の空き容量やメモリ、動画の形式によって処理できない場合があります。
        </p>
      </article>

      <article>
        <h2>その他</h2>
        <p>
          本サービスの利用には、別途定める
          <Link href="/terms">利用規約</Link>および
          <Link href="/privacy">プライバシーポリシー</Link>が適用されます。
        </p>
      </article>
    </main>
  );
}
