import Link from "next/link";
import {
  FREE_AI_OPERATION_SUCCESS_LIMIT,
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  ONE_TIME_PLAN_LABEL,
  ONE_TIME_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
} from "../../lib/billing-policy";
import { buildPublicPageMetadata } from "../../lib/site-metadata";
import CheckoutLink from "./checkout-link";
import styles from "./pricing.module.css";

const FREE_MINUTES = Math.floor(FREE_SECONDS_LIMIT / 60);

export const metadata = buildPublicPageMetadata({
  title: "料金プラン｜撮るだけリール",
  description: `まずは無料で編集とプレビュー。完成動画は1本${ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}円、月${STARTER_MONTHLY_VIDEO_LIMIT}本${STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円、月${STANDARD_MONTHLY_VIDEO_LIMIT}本${STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}円から保存できます。表示価格はすべて税込です。`,
  path: "/pricing",
});

const plans = [
  {
    key: "one_time",
    badge: "初めての保存におすすめ",
    cadence: "1回だけ",
    name: ONE_TIME_PLAN_LABEL,
    title: "動画1本だけ保存",
    price: ONE_TIME_PRICE_JPY,
    priceSuffix: "/ 1本・税込",
    unit: "月額料金なし・有効期限なし",
    features: [
      "90秒までの完成動画を1本保存",
      `AI処理はこの動画で${ONE_TIME_AI_OPERATION_SUCCESS_LIMIT}回`,
      "最大1080p・透かしなし",
      "表紙つき・AIナレーションなら投稿文も作成",
      "1回払い・自動更新なし",
    ],
    cta: "動画1本分を購入する",
  },
  {
    key: "starter",
    badge: "月に数回使う方",
    cadence: "1か月ごと",
    name: STARTER_MONTHLY_PLAN_LABEL,
    title: `1か月に動画${STARTER_MONTHLY_VIDEO_LIMIT}本まで`,
    price: STARTER_MONTHLY_PRICE_JPY,
    priceSuffix: "/ 1か月・税込",
    unit: `1本あたり約${Math.round(
      STARTER_MONTHLY_PRICE_JPY / STARTER_MONTHLY_VIDEO_LIMIT,
    ).toLocaleString("ja-JP")}円`,
    features: [
      "1本90秒まで",
      `AI処理は1動画につき${SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回`,
      "最大1080p・透かしなし",
      "編集スタイルを記憶",
      "1か月ごとに自動更新・未使用分の繰り越しなし",
    ],
    cta: `${STARTER_MONTHLY_PLAN_LABEL}を始める`,
  },
  {
    key: "standard",
    badge: "継続して投稿する方",
    cadence: "1か月ごと",
    name: STANDARD_MONTHLY_PLAN_LABEL,
    title: `1か月に動画${STANDARD_MONTHLY_VIDEO_LIMIT}本まで`,
    price: STANDARD_MONTHLY_PRICE_JPY,
    priceSuffix: "/ 1か月・税込",
    unit: `1本あたり約${Math.round(
      STANDARD_MONTHLY_PRICE_JPY / STANDARD_MONTHLY_VIDEO_LIMIT,
    ).toLocaleString("ja-JP")}円`,
    features: [
      "1本90秒まで",
      `AI処理は1動画につき${SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回`,
      "最大1080p・透かしなし",
      "編集スタイルを記憶",
      "1か月ごとに自動更新・未使用分の繰り越しなし",
    ],
    cta: `${STANDARD_MONTHLY_PLAN_LABEL}を始める`,
  },
] as const;

export default function PricingPage() {
  return (
    <main className={styles.page}>
      <header className={styles.siteHeader}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label="撮るだけリール トップページ">
            撮るだけリール
          </Link>
          <nav className={styles.nav} aria-label="料金ページ内の案内">
            <a href="#plans">料金プラン</a>
            <a href="#usage">利用枠</a>
            <a href="#questions">よくある質問</a>
            <Link href="/account">アカウント</Link>
          </nav>
        </div>
      </header>

      <div className={styles.shell}>
        <section className={styles.hero} aria-labelledby="pricing-title">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>料金</p>
            <h1 id="pricing-title">
              まず1本。
              <br />
              続けるなら、使う本数に合わせて。
            </h1>
            <p className={styles.lead}>
              編集とプレビューは、先に無料で試せます。仕上がりを確認してから、保存したい本数だけ選べます。
            </p>
            <div className={styles.heroActions}>
              <CheckoutLink plan="one_time" className={styles.primaryLink}>
                1本{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}円から保存する
              </CheckoutLink>
              <Link className={styles.secondaryLink} href="/video-edit">
                無料で編集を試す
              </Link>
            </div>
          </div>

          <aside className={styles.trustPanel} aria-label="料金と決済の要点">
            <p>購入前に確認できること</p>
            <ul>
              <li>
                <strong>すべて税込表示</strong>
                <span>Stripeの注文確定前にも最終金額を表示</span>
              </li>
              <li>
                <strong>有料保存は最大1080p</strong>
                <span>どの有料プランも透かしなし</span>
              </li>
              <li>
                <strong>カード情報はStripeが管理</strong>
                <span>撮るだけリールには保存されません</span>
              </li>
            </ul>
          </aside>
        </section>

        <section className={styles.freeBand} aria-labelledby="free-title">
          <div className={styles.freePrice} aria-hidden="true">
            ¥0
          </div>
          <div>
            <p className={styles.eyebrow}>無料体験</p>
            <h2 id="free-title">まずは編集後の動画を確認</h2>
            <p>
              合計{FREE_MINUTES}分以内・最大{FREE_VIDEO_LIMIT}
              動画まで（いずれか先に達するまで）。AI処理は1動画につき
              {FREE_AI_OPERATION_SUCCESS_LIMIT}
              回です。編集とプレビューは無料、完成動画の保存には有料の利用枠が必要です。
            </p>
          </div>
          <Link className={styles.freeLink} href="/video-edit">
            無料で試す
          </Link>
        </section>

        <section className={styles.planSection} id="plans" aria-labelledby="plans-title">
          <header className={styles.sectionHeader}>
            <p className={styles.eyebrow}>保存方法を選ぶ</p>
            <h2 id="plans-title">使う頻度に合う3つのプラン</h2>
            <p>迷ったら1本だけ。必要になった時点で、月額プランを選べます。</p>
          </header>

          <div className={styles.planGrid}>
            {plans.map((plan, index) => (
              <article
                className={`${styles.planCard} ${index === 0 ? styles.firstPlan : ""}`}
                key={plan.key}
                aria-labelledby={`${plan.key}-title`}
              >
                <span className={styles.planBadge}>{plan.badge}</span>
                <p className={styles.cadence}>{plan.cadence}</p>
                <h3 id={`${plan.key}-title`}>{plan.title}</h3>
                <p className={styles.planName}>{plan.name}</p>
                <p className={styles.price}>
                  <span aria-label={`${plan.price.toLocaleString("ja-JP")}円`}>
                    ¥{plan.price.toLocaleString("ja-JP")}
                  </span>
                  <small>{plan.priceSuffix}</small>
                </p>
                <p className={styles.unit}>{plan.unit}</p>
                <ul className={styles.featureList}>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <CheckoutLink plan={plan.key} className={styles.planLink}>
                  {plan.cta}
                </CheckoutLink>
              </article>
            ))}
          </div>

          <aside className={styles.checkoutNotice} aria-labelledby="checkout-title">
            <div className={styles.lockIcon} aria-hidden="true">
              ✓
            </div>
            <div>
              <h3 id="checkout-title">本人確認後に、Stripeでお支払い</h3>
              <p>
                購入にはアカウント作成またはログインが必要です。Face ID・Touch ID・端末の画面ロックを使うパスキーで本人確認したあと、Stripeの決済画面を開きます。アカウント画面ではまだ決済されません。
              </p>
              <small>
                パスキーの秘密情報は端末から送信されません。カード情報はStripeが管理します。
              </small>
            </div>
          </aside>
        </section>

        <section className={styles.usageSection} id="usage" aria-labelledby="usage-title">
          <header className={styles.sectionHeader}>
            <p className={styles.eyebrow}>利用枠の数え方</p>
            <h2 id="usage-title">本数が減るタイミング</h2>
            <p>試す段階と、保存する段階で数え方が異なります。</p>
          </header>
          <ol className={styles.steps}>
            <li>
              <span>1</span>
              <div>
                <h3>無料体験</h3>
                <p>編集結果が完成した時点で、無料体験を1本分使用します。</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <h3>有料プラン</h3>
                <p>動画の書き出しに成功した時点で、保存できる残り本数が1本減ります。</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <h3>AI処理</h3>
                <p>
                  正常に完了したAI処理だけを数えます。保存せず編集を終了した場合も、完了済みのAI処理回数は戻りません。
                </p>
              </div>
            </li>
          </ol>
          <p className={styles.definitionLink}>
            文字起こしやAI音声など、AI処理の詳しい数え方は
            <Link href="/commercial-disclosure">特定商取引法に基づく表示</Link>
            で確認できます。
          </p>
        </section>

        <section className={styles.termsSection} aria-labelledby="payment-title">
          <header className={styles.sectionHeader}>
            <p className={styles.eyebrow}>お支払いと解約</p>
            <h2 id="payment-title">購入後も、条件を明確に</h2>
          </header>
          <div className={styles.termsGrid}>
            <article>
              <h3>月3本・月7本プラン</h3>
              <ul>
                <li>申込時または契約更新時に支払いが確定します。</li>
                <li>解約されるまで1か月ごとに自動更新されます。</li>
                <li>未使用の保存本数は次の1か月へ繰り越されません。</li>
                <li>
                  <Link href="/account">アカウント画面</Link>
                  からいつでも解約できます。解約後も支払済み期間の終了までは利用でき、日割り返金はありません。
                </li>
              </ul>
            </article>
            <article>
              <h3>動画1本プラン</h3>
              <ul>
                <li>注文確定時に1回分の支払いが確定します。</li>
                <li>1回払いで、自動更新はありません。</li>
                <li>保存枠に有効期限はありません。</li>
                <li>注文確定後のお客様都合によるキャンセル・返品・返金は受け付けていません。</li>
              </ul>
            </article>
          </div>
          <p className={styles.supportNote}>
            二重請求やサービス側の不具合など、法令上または当社の責任により対応が必要な場合は個別に確認します。
            <Link href="/support">サポートへ相談する</Link>
          </p>
        </section>

        <section className={styles.faqSection} id="questions" aria-labelledby="questions-title">
          <header className={styles.sectionHeader}>
            <p className={styles.eyebrow}>よくある質問</p>
            <h2 id="questions-title">購入前の確認</h2>
          </header>
          <div className={styles.faqList}>
            <details>
              <summary>仕上がりを見てから購入できますか？</summary>
              <p>
                はい。無料体験の範囲で編集とプレビューを行い、完成動画を保存したい場合だけ有料プランを選べます。
              </p>
            </details>
            <details>
              <summary>購入ボタンを押すと、すぐ請求されますか？</summary>
              <p>
                いいえ。アカウント作成またはログインのあとにStripeの決済画面が開きます。最終金額を確認し、Stripeで注文を確定するまでは料金は発生しません。
              </p>
            </details>
            <details>
              <summary>月額プランはいつでも解約できますか？</summary>
              <p>
                はい。アカウント画面の「支払い方法・解約を管理」から解約できます。支払済み期間の終了までは利用でき、次回以降の請求は行いません。
              </p>
            </details>
            <details>
              <summary>決済や保存に失敗した場合はどうなりますか？</summary>
              <p>
                有料の保存枠は、動画の書き出しに成功した時点で減ります。二重請求や利用枠が反映されない場合は、動画ファイルを添付せず
                <Link href="/support">サポート</Link>
                へご連絡ください。
              </p>
            </details>
          </div>
        </section>

        <section className={styles.bottomCta} aria-labelledby="bottom-title">
          <div>
            <p className={styles.eyebrow}>まずは無料で</p>
            <h2 id="bottom-title">保存する前に、仕上がりを確認。</h2>
            <p>編集とプレビューを試してから、必要なプランを選べます。</p>
          </div>
          <div className={styles.bottomActions}>
            <Link className={styles.primaryLink} href="/video-edit">
              無料で編集を試す
            </Link>
            <Link className={styles.secondaryLink} href="/account">
              契約を確認する
            </Link>
          </div>
        </section>
      </div>

      <footer className={styles.footer}>
        <Link href="/">トップ</Link>
        <Link href="/support">サポート</Link>
        <Link href="/terms">利用規約</Link>
        <Link href="/privacy">プライバシーポリシー</Link>
        <Link href="/commercial-disclosure">特定商取引法に基づく表示</Link>
      </footer>
    </main>
  );
}
