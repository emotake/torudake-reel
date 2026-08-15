"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  ONE_TIME_PRICE_JPY,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_VIDEO_LIMIT,
} from "../lib/billing-policy";
import { trackClientEvent } from "../lib/client-analytics";
import { NARRATION_STYLES } from "../lib/narration";
import { VOICE_SAMPLE_SCRIPTS } from "../lib/voice-sample-catalog";
import { ModeMediaVisual } from "./home-rich-visuals";

type LandingSharedProps = {
  openPicker: () => void;
  openSample: () => void | Promise<void>;
  isSampleLoading: boolean;
  demo: ReactNode;
  recoverableDraftName?: string;
  recoverDraft: () => void;
  discardDraft: () => void;
};

function DraftRecovery({
  name,
  recoverDraft,
  discardDraft,
}: {
  name?: string;
  recoverDraft: () => void;
  discardDraft: () => void;
}) {
  if (!name) return null;

  return (
    <aside className="draftRecovery" aria-label="前回の編集を再開">
      <span aria-hidden="true">↻</span>
      <p>
        <strong>前回の編集を続けられます</strong>
        <small>{name}・この端末に設定だけ一時保存</small>
      </p>
      <button type="button" onClick={recoverDraft}>
        同じ動画を選んで再開
      </button>
      <button
        type="button"
        className="draftDiscard"
        onClick={discardDraft}
        aria-label="前回の編集データを削除"
      >
        削除
      </button>
    </aside>
  );
}

function CreationChooser({
  openPicker,
  openSample,
  isSampleLoading,
}: Pick<LandingSharedProps, "openPicker" | "openSample" | "isSampleLoading">) {
  return (
    <section
      className="creationChooser"
      id="create"
      aria-labelledby="creationChooserTitle"
    >
      <header>
        <h2 id="creationChooserTitle">何から作りますか？</h2>
        <p>編集とプレビューは無料です。</p>
      </header>
      <div className="creationModeGrid">
        <article
          className="creationModeCard isRecommended creationModeSingle"
        >
          <div className="creationModeLabel">
            <span aria-hidden="true">1</span>
            <em>はじめてにおすすめ</em>
          </div>
          <ModeMediaVisual mode="single" />
          <div className="creationModeCopy">
            <h3>動画1本から作る</h3>
            <p>自動カット、必要なテロップ、音声、表紙を順番に選んで仕上げます。</p>
          </div>
          <button className="creationModeAction" type="button" onClick={openPicker}>
            動画を1本選ぶ <span aria-hidden="true">→</span>
          </button>
          <button
            className="creationModeSecondary"
            type="button"
            disabled={isSampleLoading}
            onClick={() => void openSample()}
          >
            {isSampleLoading ? "サンプルを読込中…" : "サンプルで先に体験"}
          </button>
        </article>

        <article
          className="creationModeCard creationModeMultiple"
        >
          <div className="creationModeLabel">
            <span aria-hidden="true">2–5</span>
          </div>
          <ModeMediaVisual mode="multiple" />
          <div className="creationModeCopy">
            <h3>複数の動画から作る</h3>
            <p>2〜5本から使う場面を選び、素材の順番を保ったまま1本にします。</p>
          </div>
          <Link className="creationModeAction" href="/video-mix">
            複数動画で作る <span aria-hidden="true">→</span>
          </Link>
        </article>

        <article
          className="creationModeCard creationModePhotos"
        >
          <div className="creationModeLabel">
            <span aria-hidden="true">写真</span>
          </div>
          <ModeMediaVisual mode="photos" />
          <div className="creationModeCopy">
            <h3>写真から作る</h3>
            <p>最大10枚の写真を選び、動きのある縦型リールへまとめます。</p>
          </div>
          <Link className="creationModeAction" href="/photo-reel">
            写真で作る <span aria-hidden="true">→</span>
          </Link>
        </article>
      </div>
    </section>
  );
}

function PricingTeaser() {
  const sectionRef = useRef<HTMLElement>(null);
  const viewedRef = useRef(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (viewedRef.current || !entries.some((entry) => entry.isIntersecting)) return;
        viewedRef.current = true;
        trackClientEvent("pricing_viewed", { source: "landing" });
        observer.disconnect();
      },
      { threshold: 0.25 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      className="homePricingTeaser"
      id="price"
      ref={sectionRef}
      aria-labelledby="homePriceTitle"
    >
      <header>
        <p className="eyebrow">料金</p>
        <h2 id="homePriceTitle">仕上がりを見てから、保存方法を選べます。</h2>
        <p>編集とプレビューは無料。完成動画を保存するときだけ、1回払いか月額を選びます。</p>
      </header>
      <div className="homeFreePreview">
        <strong>¥0</strong>
        <span>無料体験は合計3分以内・最大2動画まで。AI処理は1動画につき3回です。</span>
      </div>
      <div className="homePriceChips" aria-label="保存料金の概要">
        <article>
          <small>まず1本だけ</small>
          <strong>¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}</strong>
          <span>1回払い・税込・自動更新なし</span>
        </article>
        <article>
          <small>ときどき投稿</small>
          <strong>月{STARTER_MONTHLY_VIDEO_LIMIT}本 ¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}</strong>
          <span>1か月ごとの自動更新・税込</span>
        </article>
        <article>
          <small>定期的に投稿</small>
          <strong>月{STANDARD_MONTHLY_VIDEO_LIMIT}本 ¥{STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}</strong>
          <span>1か月ごとの自動更新・税込</span>
        </article>
      </div>
      <div className="homePricingActions">
        <Link href="/pricing">料金と違いを詳しく見る</Link>
        <Link href="/support">決済・解約のよくある質問</Link>
      </div>
    </section>
  );
}

function VoiceSamples() {
  return (
    <section className="voiceSampleShelf" aria-labelledby="voiceSampleTitle">
      <div>
        <p className="eyebrow">AI音声を試聴</p>
        <h2 id="voiceSampleTitle">AIナレーションの仕上がりを、先に聴けます。</h2>
        <p className="voiceSampleDescription">
          4つの話し方を用途別の例文で聴き比べられます。固定見本の再生ではAI処理回数を使いません。
        </p>
      </div>
      <div className="voiceSampleTypes" aria-label="選べるAI音声の固定見本">
        {NARRATION_STYLES.map((style) => {
          const exampleId = `voiceSampleExample-${style.id}`;
          return (
            <article key={style.id}>
              <div>
                <strong>{style.label}</strong>
                <small>{style.note}</small>
              </div>
              <p className="voiceSampleExample" id={exampleId}>
                <span>試聴する例文</span>
                <q>{VOICE_SAMPLE_SCRIPTS[style.id]}</q>
              </p>
              <audio
                controls
                preload="none"
                src={`/demo/voices/${style.id}-v5.wav`}
                aria-label={`${style.label}の用途別固定音声サンプル`}
                aria-describedby={exampleId}
                onPlay={() => trackClientEvent("voice_sample_played", { voice: style.id })}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function HomeLanding(props: LandingSharedProps) {
  return (
    <div className="landingRouter homeEditorialLanding">
      <section className="landingIntro">
        <div className="landingHeroStage">
          <div className="landingIntroCopy">
            <p className="eyebrow">
              <span>かんたん動画編集</span>
              素材を選ぶだけで、投稿できる動画へ
            </p>
            <h1>
              動画や写真を、
              <br />
              <em>リールに。</em>
            </h1>
            <p>
              画面の案内に沿って、必要な機能だけを選んで仕上げられます。
            </p>
            <div className="landingPromiseRow" aria-label="共通の仕上がり条件">
              <span>プレビュー無料</span>
              <span>最大1080p</span>
              <span>透かしなし</span>
            </div>
          </div>
          <div
            className="landingHeroResult"
            aria-labelledby="landingHeroResultTitle"
          >
            <div className="landingHeroResultHeading">
              <p className="eyebrow">実際の仕上がり</p>
              <h2 id="landingHeroResultTitle">
                サンプル動画で、仕上がりを確認できます。
              </h2>
              <p>映像・音声・テロップをまとめて確認できます。登録は必要ありません。</p>
            </div>
            {props.demo}
          </div>
        </div>
        <DraftRecovery
          name={props.recoverableDraftName}
          recoverDraft={props.recoverDraft}
          discardDraft={props.discardDraft}
        />
        <CreationChooser
          openPicker={props.openPicker}
          openSample={props.openSample}
          isSampleLoading={props.isSampleLoading}
        />
      </section>

      <section
        className="homeBenefitBand"
        aria-label="共通する安心ポイント"
      >
        <div className="homeBenefitLead">
          <span aria-hidden="true">●</span>
          <p><strong>無料で仕上がりを確認。</strong>保存するときだけ、料金を選びます。</p>
        </div>
        <div className="homeBenefitGrid">
          <article>
            <span aria-hidden="true">データ</span>
            <h3>動画データの取り扱い</h3>
            <p>
              カットや書き出しは、お使いのスマホ・タブレット・パソコンで行います。AI機能を使う場合は、動画ファイル、または動画から取り出した音声・静止画を外部サービスへ送信します。
            </p>
          </article>
          <article>
            <span aria-hidden="true">¥0</span>
            <h3>編集とプレビューは無料</h3>
            <p>仕上がりを確認して、気に入った動画だけ保存できます。</p>
          </article>
          <article>
            <span aria-hidden="true">HD</span>
            <h3>最大1080p・透かしなし</h3>
            <p>スマホの縦・横・正方形動画を、そのまま選べます。</p>
          </article>
        </div>
      </section>

      <section
        className="homeSteps"
        id="how"
        aria-labelledby="homeStepsTitle"
      >
        <header>
          <p className="eyebrow">共通の3ステップ</p>
          <h2 id="homeStepsTitle">難しいタイムライン操作はありません。</h2>
          <p>素材を選ぶ、仕上げ方を選ぶ、プレビューを確認する。必要なところだけ直せます。</p>
        </header>
        <div className="homeStepGrid homeStepEditorialGrid">
          <article>
            <div className="homeStepCopy">
              <span>01</span>
              <h3>素材を選ぶ</h3>
              <p>動画1本、複数動画、写真から、作りたいものに合う入口を選択。</p>
            </div>
          </article>
          <article>
            <div className="homeStepCopy">
              <span>02</span>
              <h3>案内に沿って決める</h3>
              <p>音声、カット、テロップ、つなぎ方など、必要な項目だけ表示。</p>
            </div>
          </article>
          <article>
            <div className="homeStepCopy">
              <span>03</span>
              <h3>確認して保存する</h3>
              <p>無料プレビューで仕上がりを確認し、保存するときだけプランを選択。</p>
            </div>
          </article>
        </div>
      </section>

      <PricingTeaser />

      <section className="homeFaq" aria-labelledby="homeFaqTitle">
        <header>
          <p className="eyebrow">よくある質問</p>
          <h2 id="homeFaqTitle">始める前に知りたいこと。</h2>
        </header>
        <details>
          <summary>どの作り方を選べばよいですか？</summary>
          <p>動画が1本なら「動画1本から作る」、2〜5本なら「複数の動画から作る」、写真だけなら「写真から作る」を選んでください。</p>
        </details>
        <details>
          <summary>動画や写真はどこで処理されますか？</summary>
          <p>
            カットや書き出しは、お使いのスマホ・タブレット・パソコンで行います。写真から作る機能では、写真と選んだ音源を外部のAIサービスへ送信しません。動画でAI機能を使う場合は、動画ファイル、または動画から取り出した音声・静止画を外部サービスへ送信します。送信先や保存期間は
            <Link href="/privacy">プライバシーポリシー</Link>
            をご確認ください。
          </p>
        </details>
        <details>
          <summary>いつ料金がかかりますか？</summary>
          <p>編集とプレビューは無料です。保存プランを購入した時点で決済され、有料の保存本数は動画の書き出しに成功した時点で減ります。</p>
        </details>
      </section>

      <section
        className="homeFinalChooser"
        aria-labelledby="homeFinalTitle"
      >
        <h2 id="homeFinalTitle">素材に合う作り方から始める</h2>
        <p>仕上がりを確認するまでは無料です。</p>
        <div className="homeFinalActions">
          <button type="button" onClick={props.openPicker}>動画を1本選ぶ</button>
          <Link href="/video-mix">2〜5本の動画をつなぐ</Link>
          <Link href="/photo-reel">写真から作る</Link>
        </div>
      </section>
    </div>
  );
}

export function VideoEditLanding(props: LandingSharedProps) {
  return (
    <div className="landingRouter">
      <section className="videoEditIntro">
        <div className="videoEditIntroCopy">
          <p className="eyebrow">1本の動画を整える</p>
          <h1>
            1本の動画を、
            <br />
            <em>投稿できる形へ。</em>
          </h1>
          <p>
            元の話し声を活かすか、AIナレーションへ置き換えるかを選び、必要なカット・テロップ・表紙を順番に整えます。
          </p>
          <DraftRecovery
            name={props.recoverableDraftName}
            recoverDraft={props.recoverDraft}
            discardDraft={props.discardDraft}
          />
          <div className="videoEditActions">
            <button className="mainCta" type="button" onClick={props.openPicker}>
              <span>動画を1本選ぶ</span><i aria-hidden="true">→</i>
            </button>
            <button
              className="sampleButton"
              type="button"
              disabled={props.isSampleLoading}
              onClick={() => void props.openSample()}
            >
              {props.isSampleLoading ? "サンプルを読込中…" : "サンプルで体験"}
            </button>
          </div>
          <div className="videoEditPromise" aria-label="利用条件">
            <span>編集・プレビュー無料</span>
            <span>5分・500MBまで</span>
            <span>最大1080p・透かしなし</span>
          </div>
        </div>
        {props.demo}
      </section>

      <section className="videoEditDetails" id="how" aria-labelledby="videoEditHowTitle">
        <p className="eyebrow">3ステップ</p>
        <h2 id="videoEditHowTitle">選んだ動画に必要な項目だけを案内します。</h2>
        <div className="homeStepGrid">
          <article>
            <span>01</span>
            <h3>動画を選ぶ</h3>
            <p>MP4・MOV・WebMの縦、横、正方形動画に対応します。</p>
          </article>
          <article>
            <span>02</span>
            <h3>音声と仕上げを選ぶ</h3>
            <p>元の声を活かすかAI音声へ置き換え、テロップは必要な場合だけ追加。</p>
          </article>
          <article>
            <span>03</span>
            <h3>プレビューで確認</h3>
            <p>気になるところだけ直し、保存したいときに料金プランを選びます。</p>
          </article>
        </div>
      </section>

      <details className="voiceSampleDisclosure">
        <summary>AIナレーションの4つの声を試聴する <span aria-hidden="true">＋</span></summary>
        <VoiceSamples />
      </details>

      <PricingTeaser />

      <section className="homeFinalChooser" aria-labelledby="videoEditFinalTitle">
        <h2 id="videoEditFinalTitle">まず無料で仕上がりを見る</h2>
        <p>サンプルなら登録せずに操作を確認できます。</p>
        <div className="homeFinalActions">
          <button type="button" onClick={props.openPicker}>動画を1本選ぶ</button>
          <Link href="/#create">ほかの作り方を見る</Link>
        </div>
      </section>
    </div>
  );
}
