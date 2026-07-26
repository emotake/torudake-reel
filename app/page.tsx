"use client";

import { ChangeEvent, useMemo, useState } from "react";

type DealKey = "skincare" | "hotel" | "affiliate";
type ReplyMode = "negotiate" | "accept" | "decline";

type CheckItem = {
  label: string;
  detail: string;
  tone: "warning" | "danger" | "ok" | "info";
};

type Deal = {
  brand: string;
  campaign: string;
  category: string;
  channel: string;
  received: string;
  message: string;
  fee: number;
  workHours: number;
  score: number;
  deliverables: string[];
  dates: { label: string; value: string }[];
  checks: CheckItem[];
  replies: Record<ReplyMode, string>;
  status: string;
  payment: string;
};

const deals: Record<DealKey, Deal> = {
  skincare: {
    brand: "LUMERA",
    campaign: "美容液リニューアル PR",
    category: "美容・スキンケア",
    channel: "Instagram DM",
    received: "今日 10:42",
    message:
      "突然のご連絡失礼いたします。LUMERA PR担当の佐藤です。\n新商品の美容液を、Instagramでご紹介いただけないでしょうか。\n\n・Reel 1本（30秒以上）\n・Stories 2本\n・初稿：8月12日／投稿：8月18日\n・報酬：30,000円（税込）\n\n投稿素材は弊社SNS・広告でも使用させていただく場合がございます。修正にもご対応をお願いいたします。ご検討よろしくお願いいたします。",
    fee: 30000,
    workHours: 8,
    score: 72,
    deliverables: ["Reel 1本・30秒以上", "Stories 2本", "初稿提出あり"],
    dates: [
      { label: "商品到着目安", value: "8月6日" },
      { label: "初稿提出", value: "8月12日" },
      { label: "投稿予定", value: "8月18日" },
    ],
    checks: [
      {
        label: "二次利用の期間・媒体が不明",
        detail: "広告利用を含む場合、利用期間と追加料金を確認しましょう。",
        tone: "danger",
      },
      {
        label: "修正回数が未記載",
        detail: "無制限修正を避けるため、2回まで等の上限を確認しましょう。",
        tone: "warning",
      },
      {
        label: "報酬の支払日が未記載",
        detail: "請求締日と振込予定日を、発注前に書面で確認しましょう。",
        tone: "warning",
      },
      {
        label: "PR表記が必要",
        detail: "タイアップ投稿ラベルと、分かりやすい広告表記を設定します。",
        tone: "info",
      },
      {
        label: "投稿物と期限は明確",
        detail: "Reel・Storiesの本数と初稿、投稿日は読み取れました。",
        tone: "ok",
      },
    ],
    replies: {
      negotiate:
        "佐藤様\n\nこの度はお声がけいただき、ありがとうございます。商品コンセプトにも大変興味があり、ぜひ前向きに検討させていただきたいです。\n\n進行前に、以下3点をご確認させてください。\n\n・投稿素材の二次利用媒体と利用期間\n・修正対応の回数（2回までを想定しております）\n・ご請求の締日とお支払予定日\n\nなお、広告への二次利用を含む場合は、掲載3か月まで＋15,000円でお受けしております。条件をご確認いただけましたら、正式にスケジュールを確保いたします。\n\nどうぞよろしくお願いいたします。",
      accept:
        "佐藤様\n\nこの度はお声がけいただき、ありがとうございます。ご提示いただいた内容で、ぜひお受けしたく存じます。\n\n8月12日の初稿提出、8月18日の投稿予定でスケジュールを確保いたします。商品発送先など、今後の進行方法をご共有いただけますと幸いです。\n\nどうぞよろしくお願いいたします。",
      decline:
        "佐藤様\n\nこの度は素敵なお声がけをいただき、誠にありがとうございます。\n\n大変恐縮ですが、現在のスケジュールと制作内容を検討した結果、今回はお引き受けが難しい状況です。せっかくご連絡いただいたにもかかわらず、申し訳ございません。\n\nまた別の機会がございましたら、ぜひお声がけいただけますと幸いです。",
    },
    status: "条件確認中",
    payment: "支払日未定",
  },
  hotel: {
    brand: "KIRINOMORI",
    campaign: "温泉宿・宿泊体験",
    category: "旅行・ホテル",
    channel: "メール",
    received: "昨日 18:20",
    message:
      "KIRINOMORI広報です。1泊2日の宿泊をご提供しますので、滞在の様子をInstagramで発信いただけないでしょうか。\n\n希望内容：Reel 1本、Stories 3本以上\n宿泊候補日：9月平日\n同行者1名まで無料\n投稿内容は事前確認をお願いいたします。\n\n交通費や投稿の掲載期間については、別途ご相談できればと思います。",
    fee: 0,
    workHours: 12,
    score: 58,
    deliverables: ["Reel 1本", "Stories 3本以上", "宿泊提供・同行1名"],
    dates: [
      { label: "宿泊候補", value: "9月平日" },
      { label: "初稿提出", value: "未定" },
      { label: "投稿予定", value: "未定" },
    ],
    checks: [
      {
        label: "金銭報酬の記載がない",
        detail: "宿泊提供のみか、制作費が支払われるか確認が必要です。",
        tone: "danger",
      },
      {
        label: "交通費の負担が未確定",
        detail: "遠方の場合は収支がマイナスになる可能性があります。",
        tone: "warning",
      },
      {
        label: "投稿期限が未定",
        detail: "宿泊後何日以内か、初稿確認期間も決めましょう。",
        tone: "warning",
      },
      {
        label: "商品提供もPR表記が必要",
        detail: "無償宿泊は価値の提供にあたるため、広告表記を確認します。",
        tone: "info",
      },
      {
        label: "同行条件は明確",
        detail: "同行1名まで無料であることは読み取れました。",
        tone: "ok",
      },
    ],
    replies: {
      negotiate:
        "KIRINOMORI 広報ご担当者様\n\nこの度は素敵なご提案をいただき、ありがとうございます。施設の世界観にも魅力を感じており、前向きに検討しております。\n\n今回の制作内容ですと撮影・編集を含め12時間程度を想定しているため、宿泊ご提供に加えて制作費50,000円でご相談可能でしょうか。\n\nあわせて、交通費のご負担範囲、初稿・投稿日、投稿の掲載希望期間についてもご共有いただけますと幸いです。",
      accept:
        "KIRINOMORI 広報ご担当者様\n\nこの度はご提案をいただき、ありがとうございます。ぜひ宿泊体験と発信をお受けしたく存じます。\n\n候補日と今後の進行、PR表記について詳細をご共有いただけますと幸いです。どうぞよろしくお願いいたします。",
      decline:
        "KIRINOMORI 広報ご担当者様\n\nこの度は魅力的なご提案をいただき、ありがとうございます。\n\n検討いたしましたが、今回の制作条件では十分なクオリティを確保することが難しいため、辞退させていただきます。貴重な機会をいただき、ありがとうございました。",
    },
    status: "返信待ち",
    payment: "商品提供",
  },
  affiliate: {
    brand: "NATURA+",
    campaign: "プロテイン成果報酬",
    category: "フィットネス",
    channel: "Instagram DM",
    received: "7月25日",
    message:
      "NATURA+のアンバサダー募集のご案内です。\n専用リンク経由の購入1件につき2,000円をお支払いします。毎月末に成果を集計し、規定金額を超えた場合にお振込みします。\n\n月2回以上のフィード投稿と、週1回のStories掲載をお願いいたします。まずは3か月間のご参加を想定しています。商品は毎月無償提供いたします。",
    fee: 0,
    workHours: 14,
    score: 64,
    deliverables: ["フィード月2本以上", "Stories 週1本", "契約期間3か月"],
    dates: [
      { label: "開始予定", value: "8月1日" },
      { label: "月次集計", value: "毎月末" },
      { label: "終了予定", value: "10月31日" },
    ],
    checks: [
      {
        label: "最低振込額が不明",
        detail: "「規定金額」の具体額と、未達分の繰越条件を確認しましょう。",
        tone: "danger",
      },
      {
        label: "成果の承認条件が不明",
        detail: "返品・キャンセル時の扱いと成果確認画面が必要です。",
        tone: "warning",
      },
      {
        label: "固定報酬がない",
        detail: "3か月で合計18本以上。制作時間に対する採算を確認しましょう。",
        tone: "warning",
      },
      {
        label: "アフィリエイト表記が必要",
        detail: "タイアップ投稿ラベルと広告である旨を明確にします。",
        tone: "info",
      },
      {
        label: "契約期間は明確",
        detail: "3か月間という期間は読み取れました。",
        tone: "ok",
      },
    ],
    replies: {
      negotiate:
        "NATURA+ ご担当者様\n\nこの度はアンバサダーのご案内をいただき、ありがとうございます。\n\n検討にあたり、最低振込額、未達成果の繰越、返品時の成果取消条件、成果確認画面の有無をご教示ください。\n\nまた、3か月で合計18本以上の制作となるため、月額固定費15,000円＋成果報酬でのご相談は可能でしょうか。条件が合いましたら、前向きに参加を検討いたします。",
      accept:
        "NATURA+ ご担当者様\n\nご案内ありがとうございます。アンバサダープログラムに参加希望です。\n\n開始までの手続き、専用リンク、成果確認方法をご共有いただけますと幸いです。よろしくお願いいたします。",
      decline:
        "NATURA+ ご担当者様\n\nこの度はご案内いただき、ありがとうございます。\n\n現在の投稿計画との兼ね合いから、今回は参加を見送らせていただきます。また条件の合う機会がございましたら、よろしくお願いいたします。",
    },
    status: "検討中",
    payment: "成果報酬",
  },
};

const money = new Intl.NumberFormat("ja-JP");

export default function Home() {
  const [dealKey, setDealKey] = useState<DealKey>("skincare");
  const [message, setMessage] = useState(deals.skincare.message);
  const [replyMode, setReplyMode] = useState<ReplyMode>("negotiate");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [fileName, setFileName] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState("");

  const deal = deals[dealKey];
  const hourlyRate = deal.fee > 0 ? Math.round(deal.fee / deal.workHours) : 0;
  const issueCount = deal.checks.filter(
    (item) => item.tone === "danger" || item.tone === "warning",
  ).length;

  const scoreLabel = useMemo(() => {
    if (deal.score >= 80) return "条件は良好";
    if (deal.score >= 65) return "要確認";
    return "交渉推奨";
  }, [deal.score]);

  function chooseDeal(key: DealKey) {
    setDealKey(key);
    setMessage(deals[key].message);
    setReplyMode("negotiate");
    setFileName("");
    setSaved(false);
    setCopied(false);
  }

  function analyze() {
    setIsAnalyzing(true);
    setToast("");
    window.setTimeout(() => {
      setIsAnalyzing(false);
      setToast("案件条件を読み取りました");
      window.setTimeout(() => setToast(""), 2200);
    }, 850);
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    analyze();
  }

  async function copyReply() {
    try {
      await navigator.clipboard.writeText(deal.replies[replyMode]);
      setCopied(true);
      setToast("返信文をコピーしました");
      window.setTimeout(() => {
        setCopied(false);
        setToast("");
      }, 1800);
    } catch {
      setToast("返信文を選択してコピーしてください");
    }
  }

  function saveDeal() {
    setSaved(true);
    setToast("進行中の案件に追加しました");
    window.setTimeout(() => setToast(""), 2200);
  }

  return (
    <main>
      <div className="appShell">
        <header className="topbar">
          <a className="brand" href="#top" aria-label="案件レスキュー ホーム">
            <span className="brandMark">案</span>
            <span>案件レスキュー</span>
            <small>DEMO</small>
          </a>
          <nav aria-label="メインナビゲーション">
            <a className="active" href="#diagnosis">
              案件診断
            </a>
            <a href="#pipeline">進行管理</a>
            <a href="#payments">入金管理</a>
          </nav>
          <div className="profile">
            <span className="statusDot" />
            <span className="profileName">山田 美咲</span>
            <button aria-label="アカウントメニュー">YM</button>
          </div>
        </header>

        <section className="hero" id="top">
          <div>
            <p className="eyebrow">CREATOR DEAL ASSISTANT</p>
            <h1>
              そのPR案件、
              <br />
              <em>受けて大丈夫？</em>
            </h1>
            <p className="heroCopy">
              DMや契約書から条件を読み取り、見落とし・交渉ポイント・返信文を10秒で整理。
            </p>
          </div>
          <div className="summaryStrip" aria-label="案件サマリー">
            <div>
              <span>進行中</span>
              <strong>5</strong>
              <small>件</small>
            </div>
            <div>
              <span>今週の締切</span>
              <strong>3</strong>
              <small>件</small>
            </div>
            <div className="attention">
              <span>未入金</span>
              <strong>¥184,000</strong>
              <small>2件</small>
            </div>
          </div>
        </section>

        <section className="workspace" id="diagnosis">
          <aside className="inbox panel">
            <div className="panelTitle">
              <div>
                <span className="step">01</span>
                <h2>案件を読み取る</h2>
              </div>
              <span className="secure">端末内プレビュー</span>
            </div>

            <div className="sampleTabs" aria-label="サンプル案件">
              {(Object.keys(deals) as DealKey[]).map((key) => (
                <button
                  className={dealKey === key ? "active" : ""}
                  key={key}
                  onClick={() => chooseDeal(key)}
                >
                  {deals[key].category}
                </button>
              ))}
            </div>

            <div className="messageMeta">
              <span className="channelIcon">
                {deal.channel === "メール" ? "✉" : "◎"}
              </span>
              <div>
                <strong>{deal.brand}</strong>
                <span>
                  {deal.channel} · {deal.received}
                </span>
              </div>
            </div>

            <label className="messageField">
              <span>依頼内容</span>
              <textarea
                aria-label="依頼内容"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </label>

            <label className="dropzone">
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={handleFile}
                aria-label="スクリーンショットまたはPDFを選択"
              />
              <span className="uploadIcon">＋</span>
              <span>
                {fileName || "スクショ・契約書PDFを追加"}
                <small>クリックして選択</small>
              </span>
            </label>

            <button
              className="analyzeButton"
              onClick={analyze}
              disabled={isAnalyzing}
            >
              {isAnalyzing ? (
                <>
                  <span className="spinner" />
                  条件を読み取っています…
                </>
              ) : (
                <>
                  <span>✦</span>
                  AIで案件条件を診断する
                </>
              )}
            </button>
          </aside>

          <section
            className={`diagnosis panel ${isAnalyzing ? "loading" : ""}`}
            aria-busy={isAnalyzing}
          >
            <div className="panelTitle">
              <div>
                <span className="step">02</span>
                <h2>案件診断</h2>
              </div>
              <span className={`scoreBadge score${deal.score}`}>
                診断済み
              </span>
            </div>

            <div className="scoreBlock">
              <div
                className="scoreRing"
                style={
                  {
                    "--score": `${deal.score * 3.6}deg`,
                  } as React.CSSProperties
                }
              >
                <div>
                  <strong>{deal.score}</strong>
                  <span>/100</span>
                </div>
              </div>
              <div className="scoreCopy">
                <span>案件スコア</span>
                <h3>{scoreLabel}</h3>
                <p>
                  受諾前に<strong>{issueCount}項目</strong>を確認すると安心です。
                </p>
              </div>
              <div className="dealValue">
                <span>提示報酬</span>
                <strong>
                  {deal.fee ? `¥${money.format(deal.fee)}` : "商品・成果報酬"}
                </strong>
                <small>
                  {hourlyRate
                    ? `想定時給 ¥${money.format(hourlyRate)}`
                    : `想定作業 ${deal.workHours}時間`}
                </small>
              </div>
            </div>

            <div className="extractedGrid">
              <div>
                <span>制作内容</span>
                <ul>
                  {deal.deliverables.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span>スケジュール</span>
                <dl>
                  {deal.dates.map((date) => (
                    <div key={date.label}>
                      <dt>{date.label}</dt>
                      <dd>{date.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <div className="checkHeading">
              <h3>確認したいポイント</h3>
              <span>{issueCount}件の要対応</span>
            </div>
            <div className="checkList">
              {deal.checks.map((check) => (
                <article className={`checkItem ${check.tone}`} key={check.label}>
                  <span className="checkSymbol">
                    {check.tone === "ok"
                      ? "✓"
                      : check.tone === "info"
                        ? "i"
                        : "!"}
                  </span>
                  <div>
                    <strong>{check.label}</strong>
                    <p>{check.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="reply panel">
            <div className="panelTitle">
              <div>
                <span className="step">03</span>
                <h2>このまま返信</h2>
              </div>
              <span className="toneTag">丁寧・自然</span>
            </div>

            <div className="replyTabs" role="tablist" aria-label="返信の種類">
              <button
                className={replyMode === "negotiate" ? "active" : ""}
                onClick={() => setReplyMode("negotiate")}
                role="tab"
                aria-selected={replyMode === "negotiate"}
              >
                条件を交渉
              </button>
              <button
                className={replyMode === "accept" ? "active" : ""}
                onClick={() => setReplyMode("accept")}
                role="tab"
                aria-selected={replyMode === "accept"}
              >
                受ける
              </button>
              <button
                className={replyMode === "decline" ? "active" : ""}
                onClick={() => setReplyMode("decline")}
                role="tab"
                aria-selected={replyMode === "decline"}
              >
                丁寧に断る
              </button>
            </div>

            <div className="replyPaper">
              <span className="replyLabel">
                {replyMode === "negotiate"
                  ? "おすすめ返信"
                  : replyMode === "accept"
                    ? "受諾の返信"
                    : "辞退の返信"}
              </span>
              <p>{deal.replies[replyMode]}</p>
            </div>

            <div className="replyActions">
              <button className="copyButton" onClick={copyReply}>
                {copied ? "✓ コピーしました" : "返信文をコピー"}
              </button>
              <button
                className={`saveButton ${saved ? "saved" : ""}`}
                onClick={saveDeal}
              >
                {saved ? "✓ 案件に追加済み" : "進行中の案件に追加"}
              </button>
            </div>
            <p className="legalNote">
              AIは見落とし確認を支援します。契約の最終判断は内容を確認のうえ行ってください。
            </p>
          </section>
        </section>

        <section className="pipelineSection" id="pipeline">
          <div className="sectionHeading">
            <div>
              <p className="eyebrow">DEAL PIPELINE</p>
              <h2>案件の「次にやること」だけ見える</h2>
            </div>
            <button>＋ 案件を追加</button>
          </div>

          <div className="dealTableWrap panel">
            <table>
              <thead>
                <tr>
                  <th>案件</th>
                  <th>次のアクション</th>
                  <th>期限</th>
                  <th>報酬</th>
                  <th>ステータス</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <span className="companyAvatar purple">LU</span>
                    <span>
                      <strong>LUMERA</strong>
                      <small>美容液リニューアル PR</small>
                    </span>
                  </td>
                  <td>不足条件を確認</td>
                  <td className="urgent">今日</td>
                  <td>¥30,000</td>
                  <td>
                    <span className="statusPill warningPill">条件確認中</span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <span className="companyAvatar green">SO</span>
                    <span>
                      <strong>SORA FOODS</strong>
                      <small>新作グラノーラ Reel</small>
                    </span>
                  </td>
                  <td>初稿を提出</td>
                  <td>7月30日</td>
                  <td>¥55,000</td>
                  <td>
                    <span className="statusPill progressPill">制作中</span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <span className="companyAvatar orange">KI</span>
                    <span>
                      <strong>KIRINOMORI</strong>
                      <small>温泉宿・宿泊体験</small>
                    </span>
                  </td>
                  <td>ブランドからの返信待ち</td>
                  <td>8月2日</td>
                  <td>商品提供</td>
                  <td>
                    <span className="statusPill waitPill">返信待ち</span>
                  </td>
                </tr>
                <tr>
                  <td>
                    <span className="companyAvatar blue">NE</span>
                    <span>
                      <strong>NEWWAY</strong>
                      <small>バッグ夏季キャンペーン</small>
                    </span>
                  </td>
                  <td>投稿インサイトを提出</td>
                  <td>8月4日</td>
                  <td>¥80,000</td>
                  <td>
                    <span className="statusPill donePill">投稿済み</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="paymentsSection" id="payments">
          <div className="paymentCard darkCard">
            <span>今月の確定報酬</span>
            <strong>¥312,000</strong>
            <p>6案件 · 前月比 <em>＋18%</em></p>
            <div className="miniBars" aria-hidden="true">
              {[28, 44, 35, 58, 49, 72, 66, 88].map((height, index) => (
                <i key={index} style={{ height: `${height}%` }} />
              ))}
            </div>
          </div>
          <div className="paymentCard" id="payments-card">
            <div className="paymentTitle">
              <span>未入金</span>
              <strong>¥184,000</strong>
            </div>
            <div className="paymentRow">
              <span>
                <b>NEWWAY</b>
                <small>支払予定 7月25日</small>
              </span>
              <strong>¥80,000</strong>
              <button>催促文を作る</button>
            </div>
            <div className="paymentRow">
              <span>
                <b>mellow room</b>
                <small>支払予定 7月31日</small>
              </span>
              <strong>¥104,000</strong>
              <span className="soon">あと4日</span>
            </div>
          </div>
          <div className="paymentCard rightsCard">
            <span>二次利用アラート</span>
            <strong>2件</strong>
            <p>
              広告利用期限が
              <br />
              30日以内に終了します
            </p>
            <button>利用期限を確認 →</button>
          </div>
        </section>

        <footer>
          <div className="brand footerBrand">
            <span className="brandMark">案</span>
            <span>案件レスキュー</span>
          </div>
          <p>PR案件の条件確認から、交渉・入金まで。</p>
          <span>操作デモ · 表示内容はサンプルです</span>
        </footer>
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
    </main>
  );
}
