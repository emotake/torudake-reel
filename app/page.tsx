"use client";

import { useMemo, useState } from "react";

type NicheKey = "ai" | "career" | "fitness";
type Platform = "x" | "instagram";
type Stage = "discover" | "trust" | "sell";
type Scenario = "safe" | "standard" | "growth";

type Offer = {
  title: string;
  price: number;
  category: string;
  format: string;
  promise: string;
};

type NicheData = {
  label: string;
  audience: string;
  signal: string;
  source: string;
  score: number;
  base: { reach: number; visits: number; leads: number; sales: number };
  offers: Offer[];
  drafts: Record<Platform, Record<Stage, string[]>>;
  rows: {
    theme: string;
    role: string;
    impressions: number;
    clicks: number;
    sales: number;
  }[];
};

const niches: Record<NicheKey, NicheData> = {
  ai: {
    label: "AI業務効率化",
    audience: "生成AIを触ったものの、日々の仕事に定着していない会社員",
    signal:
      "「便利そうだけど使いどころが分からない」という悩みが直近7日で増加。テンプレート系投稿の保存・クリック反応が高い。",
    source: "公開投稿 1,284件・あなたの過去投稿 86件から抽出",
    score: 92,
    base: { reach: 12400, visits: 523, leads: 128, sales: 14 },
    offers: [
      {
        title: "AI仕事術・はじめの10テンプレ",
        price: 980,
        category: "入門商品",
        format: "PDF",
        promise: "まず1週間試せる業務別の基本セット",
      },
      {
        title: "残業を減らすAIテンプレ30",
        price: 4980,
        category: "デジタル教材",
        format: "Notion + PDF",
        promise: "明日から使える業務別プロンプト30個",
      },
      {
        title: "90分 AI業務棚卸し",
        price: 19800,
        category: "個別支援",
        format: "オンライン相談",
        promise: "自分の仕事でAI化できる作業を特定",
      },
      {
        title: "週刊 AI仕事術ラボ",
        price: 1480,
        category: "月額商品",
        format: "月額メンバー",
        promise: "毎週1つ、仕事に組み込める実践レシピ",
      },
      {
        title: "チーム向けAI活用研修",
        price: 79800,
        category: "法人研修",
        format: "120分研修",
        promise: "部署共通のAI活用ルールと型を整備",
      },
      {
        title: "業務AI化 伴走パック",
        price: 198000,
        category: "導入支援",
        format: "6週間サポート",
        promise: "3業務の設計から社内定着まで伴走",
      },
    ],
    drafts: {
      x: {
        discover: [
          "ChatGPTを開いても、何を聞けばいいか分からない人へ。\n\n最初に自動化するのは「考える仕事」ではなく、毎週くり返す小さな作業です。\n\n私が最初に削ったのは会議後の要点整理。20分→3分になりました。\n\n明日から試せる5つをリプ欄にまとめます。",
          "生成AIで仕事が速くならない原因は、プロンプト力ではありません。\n\n・依頼の型が毎回違う\n・完成条件が曖昧\n・一度きりで終わる\n\nこの3つを固定すると、AIは「便利なおもちゃ」から「仕事の仕組み」に変わります。",
        ],
        trust: [
          "先週、AIで議事録を作る手順をチームに導入しました。\n\n失敗：いきなり全文を要約\n改善：決定事項／未決事項／担当者の3項目に固定\n\n精度より先に、出力の使い道を決める。これだけで修正時間が半分になりました。",
          "仕事で使えるAIテンプレの条件は3つ。\n\n1. 入力する場所が明確\n2. 完成形の例がある\n3. 人が確認する箇所が決まっている\n\n魔法の一文より、再現できる工程の方が価値があります。",
        ],
        sell: [
          "「毎回プロンプトを考える時間がもったいない」方向けに、実務で使っているAIテンプレ30個を整理しました。\n\nメール、議事録、調査、資料構成まで入力例つきです。\n\n今週だけ導入チェックリストも追加。プロフィールから見られます。",
          "AIを学ぶ教材ではなく、明日の仕事を1つ終わらせるテンプレ集を作りました。\n\n30個すべてに「使う場面・入力例・確認ポイント」つき。最初の1つは無料で試せます。",
        ],
      },
      instagram: {
        discover: [
          "リール構成（22秒）\n\n0–2秒：『ChatGPTを開いて閉じる人へ』\n3–7秒：会議メモに20分かかる画面\n8–15秒：3項目テンプレを入力\n16–20秒：20分→3分の比較\n21–22秒：『保存して明日の会議で試して』",
          "カルーセル（7枚）\n\n1：AIで仕事が速くならない3つの理由\n2：毎回ちがう頼み方\n3：ゴールが曖昧\n4：一度きりで終わる\n5：入力・出力・確認を固定\n6：会議メモの実例\n7：テンプレはプロフィールへ",
        ],
        trust: [
          "カルーセル（8枚）\n\n1：議事録AI化で失敗した話\n2：全文要約では使えなかった\n3：読む人ごとに欲しい情報が違う\n4：決定／未決／担当に固定\n5：修正時間が半減\n6：入力例\n7：確認箇所\n8：保存用チェックリスト",
          "リール構成（28秒）\n\n冒頭：『AIに丸投げするほど遅くなります』\n中盤：人が決める3点を表示\n実演：メール返信テンプレの前後比較\n締め：『型を作ってからAIに渡す』",
        ],
        sell: [
          "ストーリーズ3枚\n\n1：プロンプトを毎回考えていませんか？［はい／いいえ］\n2：実務で使った30テンプレを業務別に整理\n3：入力例と確認ポイントつき／リンク『内容を見る』",
          "リール構成（20秒）\n\n1：PC前で悩むBefore\n2：テンプレ一覧を選ぶ\n3：完成したメール・議事録・資料構成\n4：『AIを学ぶより、仕事の型を持とう』\n5：プロフィールから無料版へ",
        ],
      },
    },
    rows: [
      { theme: "会議メモ20分→3分", role: "発見", impressions: 18420, clicks: 212, sales: 3 },
      { theme: "AI導入の失敗談", role: "信頼", impressions: 9340, clicks: 186, sales: 5 },
      { theme: "テンプレ30個の紹介", role: "販売", impressions: 6280, clicks: 241, sales: 8 },
    ],
  },
  career: {
    label: "キャリア・転職",
    audience: "転職したいが、自分の強みを言葉にできない20〜30代",
    signal:
      "職務経歴書の書き方より「経験の棚卸し」に関する質問が増加。具体例のある投稿からプロフィール遷移が伸びている。",
    source: "公開投稿 962件・あなたの過去投稿 64件から抽出",
    score: 88,
    base: { reach: 9800, visits: 486, leads: 104, sales: 11 },
    offers: [
      {
        title: "転職準備チェックリスト",
        price: 780,
        category: "入門商品",
        format: "PDF",
        promise: "応募前に整える12項目を30分で確認",
      },
      {
        title: "強み発掘ワークブック",
        price: 2980,
        category: "デジタル教材",
        format: "PDF + 記入例",
        promise: "経験を採用側に伝わる実績へ変換",
      },
      {
        title: "職務経歴書レビュー",
        price: 12800,
        category: "個別支援",
        format: "個別添削",
        promise: "60分で応募できる状態まで整理",
      },
      {
        title: "転職伴走ルーム",
        price: 3980,
        category: "月額商品",
        format: "月額コミュニティ",
        promise: "週次レビューで転職活動を止めない",
      },
      {
        title: "面接対策 3回パック",
        price: 29800,
        category: "継続支援",
        format: "個別セッション",
        promise: "想定質問から模擬面接まで段階的に対策",
      },
      {
        title: "若手向けキャリア研修",
        price: 120000,
        category: "法人研修",
        format: "半日ワークショップ",
        promise: "強みの棚卸しと社内キャリア設計を支援",
      },
    ],
    drafts: {
      x: {
        discover: [
          "「自分には大した実績がない」と思う人ほど、数字ではなく変化を探してください。\n\n・何が面倒だったか\n・自分が何を変えたか\n・誰が楽になったか\n\n売上だけが実績ではありません。仕事のBefore→Afterは立派な強みです。",
          "職務経歴書が書けないのは、経験不足ではなく『思い出し方』の問題です。\n\n担当業務から考えず、感謝されたこと・任されたこと・改善したことから逆算すると強みが見つかります。",
        ],
        trust: [
          "相談者の『問い合わせ対応をしていました』を深掘りした結果、\n\n・返信テンプレを20種類整備\n・新人の回答時間を30%短縮\n\nまで言語化できました。普通の仕事の中に、採用側が知りたい実績は隠れています。",
          "強みは性格診断で決めるものではなく、繰り返し出した成果から見つけるもの。\n\n過去3年で「よく頼まれたこと」を10個書くと、再現性のある強みが見えてきます。",
        ],
        sell: [
          "職務経歴書の前で止まる人向けに、経験を実績へ変える質問を42個まとめました。\n\n記入例つきなので順番に埋めるだけ。無料の最初の5問はプロフィールから受け取れます。",
          "転職活動の最初に必要なのは求人検索ではなく、自分の材料集めです。\n\n強み発掘ワークブックを公開しました。今週は職務要約のテンプレも付いています。",
        ],
      },
      instagram: {
        discover: [
          "カルーセル（7枚）\n\n1：実績がない人の強みの見つけ方\n2：感謝されたこと\n3：任されたこと\n4：改善したこと\n5：Before→Afterにする\n6：書き換え実例\n7：あとで書くために保存",
          "リール構成（20秒）\n\n冒頭：『職務経歴書、担当業務だけ書いてない？』\n中盤：弱い例→強い例を3秒ずつ表示\n締め：『変えたことまで書けば実績になる』",
        ],
        trust: [
          "カルーセル（6枚）\n\n1：問い合わせ対応→実績に変えた実例\n2：元の文章\n3：深掘りした3つの質問\n4：数字を発見\n5：完成した文章\n6：あなたの仕事にも必ずある",
          "リール構成（25秒）\n\n相談前の一文→ヒアリング→完成文を画面分割。最後に『仕事の価値は、本人ほど気づきにくい』。",
        ],
        sell: [
          "ストーリーズ3枚\n\n1：自分の強みを3つ言えますか？\n2：経験を掘り起こす42の質問\n3：記入例つきワークブック／リンクスタンプ",
          "リール構成（18秒）\n\n白紙の職務経歴書→質問に回答→完成した実績欄。CTAは『無料5問をプロフィールから』。",
        ],
      },
    },
    rows: [
      { theme: "実績がない人の共通点", role: "発見", impressions: 14280, clicks: 194, sales: 2 },
      { theme: "職歴の書き換え実例", role: "信頼", impressions: 8870, clicks: 221, sales: 4 },
      { theme: "42の質問を公開", role: "販売", impressions: 5940, clicks: 198, sales: 7 },
    ],
  },
  fitness: {
    label: "習慣・フィットネス",
    audience: "運動を始めても3週間以内に止まってしまう在宅ワーカー",
    signal:
      "ハードな運動法より、デスク周りでできる短時間習慣への保存反応が高い。継続記録への購入意欲も確認。",
    source: "公開投稿 1,106件・あなたの過去投稿 72件から抽出",
    score: 84,
    base: { reach: 15200, visits: 612, leads: 146, sales: 16 },
    offers: [
      {
        title: "3日間 デスク運動ミニ動画",
        price: 680,
        category: "入門商品",
        format: "ショート動画",
        promise: "着替えなしで始める3日間のお試し版",
      },
      {
        title: "1日8分 在宅運動プラン",
        price: 2480,
        category: "動画教材",
        format: "動画 + カレンダー",
        promise: "器具なしで21日間続けられる設計",
      },
      {
        title: "習慣設計セッション",
        price: 9800,
        category: "個別支援",
        format: "オンライン相談",
        promise: "生活に合わせた運動トリガーを設計",
      },
      {
        title: "朝8分チャレンジ",
        price: 980,
        category: "月額商品",
        format: "月額グループ",
        promise: "毎朝の配信と記録で一緒に継続",
      },
      {
        title: "8週間 習慣コーチング",
        price: 39800,
        category: "継続支援",
        format: "個別伴走",
        promise: "生活リズムに合わせて運動習慣を定着",
      },
      {
        title: "在宅チーム健康プログラム",
        price: 148000,
        category: "法人プラン",
        format: "8週間・チーム導入",
        promise: "在宅勤務者の運動不足をチームで改善",
      },
    ],
    drafts: {
      x: {
        discover: [
          "運動が続かない人は、意思が弱いのではなく開始条件が重すぎます。\n\n着替える、移動する、30分確保する。この3つをなくして『PCを閉じたら8分』にしたら、3週間続きました。",
          "週末に1時間運動するより、平日に8分を5回。\n\n習慣に必要なのは達成感より『始めるまでの摩擦がないこと』です。マットすら出さないメニューから始めます。",
        ],
        trust: [
          "在宅勤務の方に21日間試してもらった結果、続いた人が決めていたのは回数ではなくタイミングでした。\n\n『夕方』ではなく『最後の会議が終わった直後』。習慣は時刻より出来事に結びつけると続きます。",
          "疲れている日の最低ラインを決めていますか？\n\n通常8分、疲れた日はスクワット5回。ゼロの日を作らない仕組みが、完璧なメニューより効きます。",
        ],
        sell: [
          "運動が3週間続かない在宅ワーカー向けに、1日8分の動画プランを作りました。\n\n器具・着替え不要。疲れた日用の2分版もあります。最初の3日分はプロフィールから無料で試せます。",
          "頑張るメニューではなく、やめにくいメニューを21日分まとめました。\n\nPCを閉じた直後に再生するだけ。カレンダーと2分版つきです。",
        ],
      },
      instagram: {
        discover: [
          "リール構成（18秒）\n\n0–2秒：『運動が続かないのは意志のせいじゃない』\n3–8秒：着替え・移動・30分を消す\n9–15秒：デスク横で8分\n16–18秒：『保存して今日1回』",
          "カルーセル（6枚）\n\n1：運動の開始条件を軽くする\n2：着替えない\n3：移動しない\n4：8分だけ\n5：疲れた日は2分\n6：ゼロの日を作らない",
        ],
        trust: [
          "カルーセル（7枚）\n\n1：21日続いた人が決めていたこと\n2：回数ではなかった\n3：時刻でもなかった\n4：最後の会議の直後\n5：出来事と運動をつなぐ\n6：生活別の例\n7：自分の合図をコメント",
          "リール構成（24秒）\n\n8分版と疲れた日の2分版を並べて実演。『完璧より、ゼロをなくす』で締める。",
        ],
        sell: [
          "ストーリーズ3枚\n\n1：運動、何日で止まりましたか？\n2：在宅ワーカー専用・1日8分×21日\n3：最初の3日無料／リンクスタンプ",
          "リール構成（20秒）\n\nPCを閉じる→8分動画を再生→カレンダーにチェック。CTAは『3日分をプロフィールから』。",
        ],
      },
    },
    rows: [
      { theme: "意志より開始条件", role: "発見", impressions: 20110, clicks: 246, sales: 3 },
      { theme: "21日継続の検証", role: "信頼", impressions: 11820, clicks: 258, sales: 6 },
      { theme: "8分プラン体験版", role: "販売", impressions: 7440, clicks: 284, sales: 9 },
    ],
  },
};

const factors: Record<Scenario, number> = {
  safe: 0.72,
  standard: 1,
  growth: 1.34,
};
const stageLabels: Record<Stage, string> = {
  discover: "発見される",
  trust: "信頼をつくる",
  sell: "販売する",
};
const number = (value: number) => new Intl.NumberFormat("ja-JP").format(value);

export default function Home() {
  const [niche, setNiche] = useState<NicheKey>("ai");
  const [offerIndex, setOfferIndex] = useState(1);
  const [platform, setPlatform] = useState<Platform>("x");
  const [stage, setStage] = useState<Stage>("discover");
  const [scenario, setScenario] = useState<Scenario>("standard");
  const [variant, setVariant] = useState(0);
  const [copied, setCopied] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [scheduled, setScheduled] = useState(false);

  const data = niches[niche];
  const offer = data.offers[offerIndex];
  const factor = factors[scenario];
  const metrics = useMemo(
    () => ({
      reach: Math.round(data.base.reach * factor),
      visits: Math.round(data.base.visits * factor),
      leads: Math.round(data.base.leads * factor),
      sales: Math.round(data.base.sales * factor),
    }),
    [data, factor],
  );
  const revenue = metrics.sales * offer.price;
  const salesDrafts =
    platform === "x"
      ? [
          `${data.audience}向けに「${offer.title}」を作りました。\n\n${offer.promise}。\n${offer.format}で、価格は¥${number(offer.price)}です。\n\n詳しい内容と最初のステップは、プロフィールのリンクから確認できます。`,
          `情報を集めるだけで終わらせず、実際に一歩進めたい方へ。\n\n「${offer.title}」では、${offer.promise}。\n\n${offer.category}として¥${number(offer.price)}で案内しています。自分に合うか、プロフィールから内容を見てみてください。`,
        ]
      : [
          `ストーリーズ3枚\n\n1：${data.audience}へ\n2：「${offer.title}」— ${offer.promise}\n3：${offer.format}／¥${number(offer.price)}／リンク『内容を見る』`,
          `リール構成（20秒）\n\n1：よくある悩みを2秒で提示\n2：解決までの流れを3場面で見せる\n3：「${offer.title}」を表示\n4：${offer.promise}\n5：『プロフィールから詳細へ』`,
        ];
  const drafts = stage === "sell" ? salesDrafts : data.drafts[platform][stage];
  const draft = drafts[variant % drafts.length];

  const changeNiche = (next: NicheKey) => {
    setNiche(next);
    setOfferIndex(1);
    setVariant(0);
    setAdopted(false);
    setScheduled(false);
  };

  const copyDraft = async () => {
    await navigator.clipboard?.writeText(draft);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brandMark">発</span>
          <span>売れる発信ナビ</span>
          <span className="demoBadge">操作デモ</span>
        </div>
        <div className="topActions">
          <span className="sync"><i />サンプルデータを表示中</span>
          <button className="avatar" aria-label="アカウントメニュー">YM</button>
        </div>
      </header>

      <section className="pageHead">
        <div>
          <p className="eyebrow">SNS収益化ダッシュボード</p>
          <h1>SNSを、売上の入口にする。</h1>
          <p className="subtitle">
            誰に何を売るかを決め、投稿づくりから売上分析まで一緒に案内します。
          </p>
        </div>
        <label className="nichePicker">
          <span>分析する発信ジャンル</span>
          <select
            value={niche}
            onChange={(event) => changeNiche(event.target.value as NicheKey)}
          >
            {Object.entries(niches).map(([key, item]) => (
              <option value={key} key={key}>{item.label}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="kpiGrid" aria-label="売上予測">
        <article className="kpiCard kpiAccent">
          <div className="kpiLabel">
            30日売上予測 <span className="trend">↗ 18.4%</span>
          </div>
          <strong>¥{number(revenue)}</strong>
          <div className="spark" aria-hidden="true">
            {[27, 42, 36, 58, 51, 74, 91].map((height, index) => (
              <i key={index} style={{ height: `${height}%` }} />
            ))}
          </div>
        </article>
        <article className="kpiCard">
          <div className="kpiLabel">見込み客</div>
          <strong>{number(metrics.leads)}人</strong>
          <p>プロフィール訪問の24.5%</p>
        </article>
        <article className="kpiCard">
          <div className="kpiLabel">購入予測</div>
          <strong>{number(metrics.sales)}件</strong>
          <p>見込み客から10.9%</p>
        </article>
        <article className="kpiCard">
          <div className="kpiLabel">収益機会スコア</div>
          <strong>{data.score}<small>/100</small></strong>
          <div className="meter"><i style={{ width: `${data.score}%` }} /></div>
        </article>
      </section>

      <section className="mainGrid">
        <div className="leftColumn">
          <article className="panel">
            <PanelHeading step="STEP 1 · DEMAND" title="売れる悩みを見つける">
              <span className="hotPill">需要上昇中</span>
            </PanelHeading>
            <div className="audienceBox">
              <span>WHO</span>
              <strong>{data.audience}</strong>
            </div>
            <p className="signalCopy">{data.signal}</p>
            <div className="sourceLine"><span>◎</span>{data.source}</div>
          </article>

          <article className="panel">
            <PanelHeading step="STEP 2 · OFFER" title="売り方に合う商品を選ぶ">
              <span className="greenPill">6つの収益モデル</span>
            </PanelHeading>
            <div className="offerList">
              {data.offers.map((item, index) => (
                <button
                  className={`offer ${offerIndex === index ? "selected" : ""}`}
                  key={item.title}
                  onClick={() => {
                    setOfferIndex(index);
                    setVariant(0);
                    setAdopted(false);
                  }}
                  aria-pressed={offerIndex === index}
                >
                  <span className="radio" />
                  <span className="offerCopy">
                    <span className="offerCategory">{item.category}</span>
                    <strong>{item.title}</strong>
                    <small>{item.promise}</small>
                  </span>
                  <span className="offerPrice">
                    ¥{number(item.price)}<small>{item.format}</small>
                  </span>
                </button>
              ))}
            </div>
            <button
              className={`primaryButton ${adopted ? "done" : ""}`}
              onClick={() => setAdopted(true)}
            >
              {adopted ? "✓ この商品で導線を作成しました" : "この商品で売上導線を作る"}
            </button>
          </article>

          <article className="panel">
            <PanelHeading step="STEP 3 · FUNNEL" title="30日後の売上をシミュレーション">
              <div className="segmented" role="group" aria-label="予測シナリオ">
                {([
                  ["safe", "保守的"],
                  ["standard", "標準"],
                  ["growth", "強気"],
                ] as [Scenario, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    className={scenario === key ? "active" : ""}
                    onClick={() => setScenario(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </PanelHeading>
            <div className="funnel">
              {[
                ["リーチ", metrics.reach],
                ["プロフィール", metrics.visits],
                ["見込み客", metrics.leads],
                ["購入", metrics.sales],
              ].map(([label, value], index) => (
                <div className="funnelPiece" key={label}>
                  <div className={index === 3 ? "sale" : ""}>
                    <span>{label}</span><strong>{number(Number(value))}</strong>
                  </div>
                  {index < 3 && <b>→</b>}
                </div>
              ))}
            </div>
            <div className="revenueResult">
              <span>想定売上</span>
              <strong>¥{number(revenue)}</strong>
              <small>{metrics.sales}件 × ¥{number(offer.price)}</small>
            </div>
            <p className="disclaimer">
              ※デモ用予測。実運用ではクリック・購入データから毎週補正します。
            </p>
          </article>
        </div>

        <aside className="panel studio">
          <PanelHeading step="STEP 4 · CONTENT" title="売上から逆算した投稿">
            <span className="greenPill">品質 94</span>
          </PanelHeading>
          <div className="platformTabs">
            <button
              className={platform === "x" ? "active" : ""}
              onClick={() => { setPlatform("x"); setVariant(0); }}
            >
              X ポスト
            </button>
            <button
              className={platform === "instagram" ? "active" : ""}
              onClick={() => { setPlatform("instagram"); setVariant(0); }}
            >
              Instagram
            </button>
          </div>
          <p className="fieldLabel">投稿の役割</p>
          <div className="stageTabs">
            {(Object.keys(stageLabels) as Stage[]).map((key) => (
              <button
                key={key}
                className={stage === key ? "active" : ""}
                onClick={() => { setStage(key); setVariant(0); }}
              >
                {stageLabels[key]}
              </button>
            ))}
          </div>
          <div className="draftCard">
            <div className="draftMeta">
              <span>{platform === "x" ? "POST DRAFT" : "CONTENT SCRIPT"} · {stageLabels[stage]}</span>
              <span>{variant % drafts.length + 1}/{drafts.length}</span>
            </div>
            <p>{draft}</p>
          </div>
          <div className="quality">
            <div><span>独自性</span><strong>高</strong></div>
            <div><span>購入意図との一致</span><strong>91%</strong></div>
            <div><span>誇張・煽り</span><strong className="safe">なし</strong></div>
          </div>
          <div className="draftActions">
            <button onClick={() => setVariant((value) => value + 1)}>↻ 別案を生成</button>
            <button onClick={copyDraft}>{copied ? "✓ コピー済み" : "コピー"}</button>
          </div>
          <button
            className={`scheduleButton ${scheduled ? "done" : ""}`}
            onClick={() => setScheduled((value) => !value)}
          >
            {scheduled ? "✓ 7月28日 8:10に予約済み" : "7月28日 8:10に予約する"}
          </button>
          <div className="guard">
            <span>✓</span>
            <div>
              <strong>安心チェック</strong>
              <p>重複・誤情報・規約リスクを投稿前に確認</p>
            </div>
          </div>
        </aside>
      </section>

      <section className="panel attribution">
        <PanelHeading step="LEARNING LOOP" title="どの投稿が、いくら生んだか">
          <button className="periodButton">過去30日 ▾</button>
        </PanelHeading>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>投稿テーマ</th><th>役割</th><th>表示</th>
                <th>クリック</th><th>購入</th><th>売上貢献</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, index) => (
                <tr key={row.theme}>
                  <td><span className={`rowIcon tone${index}`}>{index + 1}</span>{row.theme}</td>
                  <td><span className="rolePill">{row.role}</span></td>
                  <td>{number(row.impressions)}</td>
                  <td>{number(row.clicks)}</td>
                  <td>{row.sales}件</td>
                  <td className="money">¥{number(row.sales * offer.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="learning">
          <span className="brandMark">学</span>
          <p>
            <strong>今週の学習：</strong>
            「失敗→改善→数値」の構成は、ノウハウ単体より購入率が1.8倍。
            次週は信頼投稿を2本増やします。
          </p>
          <button>来週の計画を見る →</button>
        </div>
      </section>

      <footer>
        <span>売れる発信ナビ — 操作デモ</span>
        <span>数値・投稿は体験用のサンプルです</span>
      </footer>
    </main>
  );
}

function PanelHeading({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panelHeading">
      <div><p className="step">{step}</p><h2>{title}</h2></div>
      {children}
    </div>
  );
}
