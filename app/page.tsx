"use client";

import { useMemo, useState } from "react";

type Channel = "Instagram" | "X" | "Threads";
type Status = "候補" | "許諾待ち" | "掲載中";
type View = "inbox" | "rights" | "publish" | "analytics";

type Voice = {
  id: number;
  channel: Channel;
  user: string;
  handle: string;
  avatar: string;
  color: string;
  time: string;
  text: string;
  status: Status;
  score: number;
  tags: string[];
  source: string;
  product: string;
  result: string;
};

const initialVoices: Voice[] = [
  {
    id: 1,
    channel: "Instagram",
    user: "みか｜在宅ワーク",
    handle: "@mika_workstyle",
    avatar: "み",
    color: "#ef8f78",
    time: "12分前",
    text: "この講座のおかげで、ずっと目標だった初案件が取れました！何から始めればいいか迷っていた私でも、順番通りに進めたら本当にできました😭",
    status: "候補",
    score: 96,
    tags: ["購入成果", "具体性あり", "感情表現"],
    source: "リール「未経験から始める3ステップ」へのコメント",
    product: "SNS実践講座",
    result: "初案件を獲得",
  },
  {
    id: 2,
    channel: "Threads",
    user: "さき",
    handle: "@saki_life27",
    avatar: "さ",
    color: "#8a79ca",
    time: "1時間前",
    text: "テンプレ、想像以上に使いやすかったです。毎回2時間かかっていた投稿作りが30分で終わるようになりました…！",
    status: "許諾待ち",
    score: 92,
    tags: ["時間短縮", "数値あり"],
    source: "商品紹介スレッドへの返信",
    product: "投稿テンプレ100",
    result: "制作時間を75%短縮",
  },
  {
    id: 3,
    channel: "X",
    user: "高橋 健",
    handle: "@ken_designnote",
    avatar: "健",
    color: "#4f9a89",
    time: "昨日",
    text: "解説が具体的で、今まで曖昧だった導線設計がやっと腑に落ちた。購入してよかったです。",
    status: "掲載中",
    score: 88,
    tags: ["満足", "商品評価"],
    source: "メンション付きポスト",
    product: "導線設計ガイド",
    result: "導線設計を理解",
  },
  {
    id: 4,
    channel: "Instagram",
    user: "nana｜ハンドメイド",
    handle: "@nana_made.jp",
    avatar: "n",
    color: "#d8a54f",
    time: "昨日",
    text: "相談会のあと、プロフィールを直しただけでお問い合わせが3件も来ました。びっくりです！",
    status: "掲載中",
    score: 95,
    tags: ["成果報告", "数値あり"],
    source: "ストーリーズへの返信",
    product: "プロフィール相談会",
    result: "問い合わせ3件",
  },
  {
    id: 5,
    channel: "Threads",
    user: "ゆうき",
    handle: "@yuki_smallbiz",
    avatar: "ゆ",
    color: "#618bb7",
    time: "2日前",
    text: "無料版だけでも気づきが多かった。特にチェックリストがありがたいです！",
    status: "候補",
    score: 77,
    tags: ["好意的", "無料商品"],
    source: "無料チェックリストへの返信",
    product: "導線チェックリスト",
    result: "課題を発見",
  },
];

const channelMarks: Record<Channel, string> = {
  Instagram: "◎",
  X: "𝕏",
  Threads: "@",
};

const navItems: { key: View; label: string; count?: number }[] = [
  { key: "inbox", label: "口コミ受信箱", count: 12 },
  { key: "rights", label: "掲載許諾", count: 4 },
  { key: "publish", label: "公開ページ" },
  { key: "analytics", label: "効果分析" },
];

export default function Home() {
  const [voices, setVoices] = useState(initialVoices);
  const [selectedId, setSelectedId] = useState(1);
  const [view, setView] = useState<View>("inbox");
  const [filter, setFilter] = useState<"すべて" | Channel>("すべて");
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [layout, setLayout] = useState<"cards" | "spotlight">("cards");

  const selected = voices.find((voice) => voice.id === selectedId) ?? voices[0];
  const filtered = useMemo(
    () =>
      filter === "すべて"
        ? voices
        : voices.filter((voice) => voice.channel === filter),
    [filter, voices],
  );
  const published = voices.filter((voice) => voice.status === "掲載中");

  const permissionMessage = `${selected.user}さん\n\nうれしいご感想をありがとうございます！いただいたコメントを、当サービスの「お客さまの声」として掲載させていただいてもよろしいでしょうか？\n\n掲載内容：お名前（SNS表示名）・コメント・SNSアイコン\n掲載先：商品ページ／SNS\n\n下のボタンから公開範囲をご確認いただけます。`;

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function requestPermission() {
    setVoices((current) =>
      current.map((voice) =>
        voice.id === selected.id ? { ...voice, status: "許諾待ち" } : voice,
      ),
    );
    setModalOpen(false);
    notify("掲載許諾の依頼を作成しました");
  }

  function publishVoice() {
    setVoices((current) =>
      current.map((voice) =>
        voice.id === selected.id ? { ...voice, status: "掲載中" } : voice,
      ),
    );
    notify("公開ページに追加しました");
  }

  async function copyEmbed() {
    try {
      await navigator.clipboard.writeText(
        '<div data-koestock-widget="customer-voices"></div>',
      );
      notify("埋め込みコードをコピーしました");
    } catch {
      notify("デモ用コードを選択してください");
    }
  }

  return (
    <main className="site">
      <aside className="sidebar">
        <button className="logo" onClick={() => setView("inbox")}>
          <span className="logoMark">声</span>
          <span>
            声ストック
            <small>KOE STOCK</small>
          </span>
        </button>

        <nav aria-label="メインメニュー">
          <p>WORKSPACE</p>
          {navItems.map((item) => (
            <button
              className={view === item.key ? "active" : ""}
              key={item.key}
              onClick={() => setView(item.key)}
            >
              <span className={`navIcon ${item.key}`} aria-hidden="true">
                {item.key === "inbox" && "⌁"}
                {item.key === "rights" && "✓"}
                {item.key === "publish" && "↗"}
                {item.key === "analytics" && "⌇"}
              </span>
              {item.label}
              {item.count && <b>{item.count}</b>}
            </button>
          ))}
        </nav>

        <div className="connected">
          <p>接続中のSNS</p>
          <div className="socialRow">
            <span className="socialIcon instagram">◎</span>
            <span>Instagram</span>
            <i />
          </div>
          <div className="socialRow">
            <span className="socialIcon threads">@</span>
            <span>Threads</span>
            <i />
          </div>
          <div className="socialRow muted">
            <span className="socialIcon x">𝕏</span>
            <span>Xを追加</span>
            <em>＋</em>
          </div>
        </div>

        <div className="account">
          <span>EM</span>
          <div>
            <strong>Emi Marketing</strong>
            <small>Proプラン</small>
          </div>
          <button aria-label="アカウントメニュー">•••</button>
        </div>
      </aside>

      <section className="mainArea">
        <header className="mobileHeader">
          <button className="logo" onClick={() => setView("inbox")}>
            <span className="logoMark">声</span>
            <span>声ストック</span>
          </button>
          <select
            aria-label="画面を選択"
            value={view}
            onChange={(event) => setView(event.target.value as View)}
          >
            {navItems.map((item) => (
              <option value={item.key} key={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </header>

        {view === "inbox" && (
          <>
            <div className="pageHeader">
              <div>
                <p className="eyebrow">VOICE INBOX</p>
                <h1>
                  SNSの“うれしい声”を、
                  <br />
                  <em>売れる証拠</em>に。
                </h1>
                <p className="lead">
                  コメントやメンションから、掲載価値の高い口コミをAIが見つけました。
                </p>
              </div>
              <button className="primaryButton" onClick={() => notify("SNSとの同期が完了しました")}>
                <span>↻</span> 最新の声を取り込む
              </button>
            </div>

            <section className="metricGrid" aria-label="今月の概要">
              <article>
                <span className="metricIcon coral">✦</span>
                <div>
                  <p>新しい口コミ候補</p>
                  <strong>12<small>件</small></strong>
                  <em>今週 ＋5件</em>
                </div>
              </article>
              <article>
                <span className="metricIcon yellow">◷</span>
                <div>
                  <p>許諾の返答待ち</p>
                  <strong>4<small>件</small></strong>
                  <em>平均1.8日で回答</em>
                </div>
              </article>
              <article>
                <span className="metricIcon green">✓</span>
                <div>
                  <p>公開中の口コミ</p>
                  <strong>28<small>件</small></strong>
                  <em>公開率 73%</em>
                </div>
              </article>
              <article className="impactMetric">
                <span className="metricIcon dark">↗</span>
                <div>
                  <p>購入ボタン到達率</p>
                  <strong>＋14.8<small>%</small></strong>
                  <em>口コミ表示後の変化</em>
                </div>
              </article>
            </section>

            <section className="inboxWorkspace">
              <div className="voiceList">
                <div className="listHeader">
                  <div>
                    <h2>見つかった声</h2>
                    <span>AIおすすめ順</span>
                  </div>
                  <button aria-label="絞り込み設定">≡</button>
                </div>
                <div className="filters">
                  {(["すべて", "Instagram", "Threads", "X"] as const).map(
                    (item) => (
                      <button
                        key={item}
                        className={filter === item ? "active" : ""}
                        onClick={() => setFilter(item)}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <div className="voices">
                  {filtered.map((voice) => (
                    <button
                      className={`voiceItem ${selected.id === voice.id ? "selected" : ""}`}
                      key={voice.id}
                      onClick={() => setSelectedId(voice.id)}
                    >
                      <span className="avatar" style={{ background: voice.color }}>
                        {voice.avatar}
                        <i className={voice.channel.toLowerCase()}>
                          {channelMarks[voice.channel]}
                        </i>
                      </span>
                      <span className="voiceSummary">
                        <span className="userLine">
                          <strong>{voice.user}</strong>
                          <small>{voice.time}</small>
                        </span>
                        <span className="excerpt">{voice.text}</span>
                        <span className={`status ${voice.status}`}>
                          {voice.status}
                        </span>
                      </span>
                      <b className="aiScore">{voice.score}</b>
                    </button>
                  ))}
                </div>
              </div>

              <article className="voiceDetail">
                <div className="detailTop">
                  <div className="sourceUser">
                    <span className="avatar large" style={{ background: selected.color }}>
                      {selected.avatar}
                    </span>
                    <div>
                      <strong>{selected.user}</strong>
                      <span>{selected.handle}</span>
                    </div>
                  </div>
                  <span className={`channelBadge ${selected.channel.toLowerCase()}`}>
                    {channelMarks[selected.channel]} {selected.channel}
                  </span>
                </div>

                <div className="quote">
                  <span className="quoteMark">“</span>
                  <p>{selected.text}</p>
                </div>

                <a className="sourceLink" href="#source" onClick={(e) => e.preventDefault()}>
                  <span>↗</span>
                  <span>
                    元の投稿
                    <small>{selected.source}</small>
                  </span>
                  <b>開く</b>
                </a>

                <div className="aiReview">
                  <div className="reviewHeading">
                    <span className="spark">✦</span>
                    <div>
                      <strong>掲載価値が高い口コミです</strong>
                      <small>AI信頼スコア {selected.score}%</small>
                    </div>
                    <b>{selected.score}</b>
                  </div>
                  <div className="reviewFacts">
                    <div>
                      <span>紹介商品</span>
                      <strong>{selected.product}</strong>
                    </div>
                    <div>
                      <span>伝わる成果</span>
                      <strong>{selected.result}</strong>
                    </div>
                  </div>
                  <div className="tags">
                    {selected.tags.map((tag) => (
                      <span key={tag}>✓ {tag}</span>
                    ))}
                  </div>
                </div>

                <div className="detailActions">
                  {selected.status === "候補" && (
                    <>
                      <button className="secondaryButton" onClick={() => notify("今回は見送りにしました")}>
                        今回は見送る
                      </button>
                      <button className="primaryButton" onClick={() => setModalOpen(true)}>
                        掲載許可をお願いする <span>→</span>
                      </button>
                    </>
                  )}
                  {selected.status === "許諾待ち" && (
                    <>
                      <button className="secondaryButton" onClick={() => setModalOpen(true)}>
                        依頼文を確認
                      </button>
                      <button className="primaryButton success" onClick={publishVoice}>
                        許諾済みにして掲載する <span>→</span>
                      </button>
                    </>
                  )}
                  {selected.status === "掲載中" && (
                    <>
                      <button className="secondaryButton" onClick={() => notify("表示内容を編集できます")}>
                        表示を編集
                      </button>
                      <button className="primaryButton darkButton" onClick={() => setView("publish")}>
                        公開ページで見る <span>↗</span>
                      </button>
                    </>
                  )}
                </div>
              </article>
            </section>
          </>
        )}

        {view === "rights" && (
          <RightsView voices={voices} onSelect={(id) => { setSelectedId(id); setView("inbox"); }} />
        )}

        {view === "publish" && (
          <PublishView
            voices={published.length ? published : voices.slice(0, 3)}
            layout={layout}
            setLayout={setLayout}
            copyEmbed={copyEmbed}
          />
        )}

        {view === "analytics" && <AnalyticsView />}

        <footer>
          <span>これは「声ストック」のサービスイメージを確認するためのデモです。</span>
          <button onClick={() => setView("publish")}>購入者からの見え方を確認 →</button>
        </footer>
      </section>

      {modalOpen && (
        <div className="modalBackdrop" role="presentation" onMouseDown={() => setModalOpen(false)}>
          <section
            className="permissionModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="permission-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="closeButton" onClick={() => setModalOpen(false)} aria-label="閉じる">
              ×
            </button>
            <span className="modalIcon">✓</span>
            <p className="eyebrow">PERMISSION REQUEST</p>
            <h2 id="permission-title">掲載許可をお願いする</h2>
            <p className="modalLead">AIが相手に失礼のない依頼文を作成しました。</p>
            <div className="messagePreview">
              <div>
                <span className="avatar small" style={{ background: selected.color }}>
                  {selected.avatar}
                </span>
                <strong>{selected.user}</strong>
                <small>{selected.channel} DM</small>
              </div>
              <textarea value={permissionMessage} readOnly aria-label="掲載許諾の依頼文" />
            </div>
            <label className="consentLine">
              <input type="checkbox" defaultChecked />
              公開範囲と利用目的を明記した許諾ページを添付する
            </label>
            <button className="primaryButton modalSubmit" onClick={requestPermission}>
              依頼を作成する <span>→</span>
            </button>
            <small className="modalNote">
              デモのため実際のDMは送信されません。正式版では送信前に必ず確認できます。
            </small>
          </section>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span>✓</span> {toast}
        </div>
      )}
    </main>
  );
}

function RightsView({
  voices,
  onSelect,
}: {
  voices: Voice[];
  onSelect: (id: number) => void;
}) {
  return (
    <div className="subPage">
      <div className="subPageHeader">
        <div>
          <p className="eyebrow">PERMISSION LOG</p>
          <h1>掲載許諾を、<em>きちんと残す。</em></h1>
          <p className="lead">誰が・何に・どこまで許可したかを一か所で管理します。</p>
        </div>
        <button className="primaryButton">許諾リンクを作成</button>
      </div>
      <div className="rightsSummary">
        <article><span>今月の依頼</span><strong>9</strong><small>件</small></article>
        <article><span>許諾済み</span><strong>7</strong><small>件</small></article>
        <article><span>返答待ち</span><strong>2</strong><small>件</small></article>
        <article><span>平均回答時間</span><strong>1.8</strong><small>日</small></article>
      </div>
      <section className="rightsTable">
        <div className="tableTitle">
          <h2>許諾履歴</h2>
          <button>すべてのステータス⌄</button>
        </div>
        <div className="tableHead">
          <span>投稿者</span><span>口コミ・商品</span><span>利用範囲</span><span>ステータス</span><span />
        </div>
        {voices.map((voice) => (
          <button className="tableRow" key={voice.id} onClick={() => onSelect(voice.id)}>
            <span className="tableUser">
              <span className="avatar small" style={{ background: voice.color }}>{voice.avatar}</span>
              <span><strong>{voice.user}</strong><small>{voice.handle}</small></span>
            </span>
            <span><strong>{voice.product}</strong><small>{voice.text.slice(0, 26)}…</small></span>
            <span><strong>{voice.status === "候補" ? "未設定" : "商品ページ・SNS"}</strong><small>{voice.status === "掲載中" ? "期限なし" : "確認中"}</small></span>
            <span><b className={`status ${voice.status}`}>{voice.status}</b></span>
            <span className="rowArrow">→</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function PublishView({
  voices,
  layout,
  setLayout,
  copyEmbed,
}: {
  voices: Voice[];
  layout: "cards" | "spotlight";
  setLayout: (layout: "cards" | "spotlight") => void;
  copyEmbed: () => void;
}) {
  return (
    <div className="subPage publishPage">
      <div className="subPageHeader compact">
        <div>
          <p className="eyebrow">PUBLIC PAGE</p>
          <h1>購入者には、<em>こう見えます。</em></h1>
          <p className="lead">販売ページに埋め込む口コミパーツのプレビューです。</p>
        </div>
        <div className="publishActions">
          <div className="layoutSwitch">
            <button className={layout === "cards" ? "active" : ""} onClick={() => setLayout("cards")}>▦ カード</button>
            <button className={layout === "spotlight" ? "active" : ""} onClick={() => setLayout("spotlight")}>▤ 大きく</button>
          </div>
          <button className="primaryButton" onClick={copyEmbed}>埋め込みコードを取得</button>
        </div>
      </div>

      <div className="browserFrame">
        <div className="browserBar">
          <span className="browserDots"><i /><i /><i /></span>
          <span className="address">https://emimarketing.jp/course</span>
          <b>プレビュー</b>
        </div>
        <div className="customerPage">
          <div className="productIntro">
            <span>SNS PRACTICAL COURSE</span>
            <h2>「何を発信すればいい？」を<br />今日で終わりにする。</h2>
            <p>ゼロから自分の商品が売れる導線をつくる、8週間の実践プログラム。</p>
            <button>講座の内容を見る →</button>
          </div>
          <section className="testimonialSection">
            <p className="miniEyebrow">REAL VOICES</p>
            <h3>受講した方から届いた声</h3>
            <p className="testimonialLead">SNSで実際にいただいたご感想を、ご本人の許可を得て掲載しています。</p>
            <div className={`testimonialGrid ${layout}`}>
              {voices.slice(0, layout === "cards" ? 3 : 1).map((voice) => (
                <article className="testimonialCard" key={voice.id}>
                  <div className="stars">★★★★★</div>
                  <blockquote>「{voice.text}」</blockquote>
                  <div>
                    <span className="avatar small" style={{ background: voice.color }}>{voice.avatar}</span>
                    <span>
                      <strong>{voice.user}</strong>
                      <small><b>{channelMarks[voice.channel]}</b> {voice.channel}でのご感想</small>
                    </span>
                    <i>許諾済</i>
                  </div>
                </article>
              ))}
            </div>
            <div className="proofLine">
              <span className="proofAvatars">
                {voices.slice(0, 3).map((voice) => (
                  <i key={voice.id} style={{ background: voice.color }}>{voice.avatar}</i>
                ))}
              </span>
              <span><strong>28名</strong>の掲載許諾済みレビュー</span>
              <span className="verified">✓ 声ストックで確認</span>
            </div>
          </section>
        </div>
      </div>
      <div className="publishHint">
        <span>💡</span>
        <p><strong>ここが月額サービスになるポイント</strong>新しい口コミが許諾されるたびに、この販売ページへ自動で追加されます。</p>
      </div>
    </div>
  );
}

function AnalyticsView() {
  const bars = [42, 55, 49, 68, 62, 76, 71, 89, 84, 103, 96, 118];
  return (
    <div className="subPage analyticsPage">
      <div className="subPageHeader">
        <div>
          <p className="eyebrow">VOICE ANALYTICS</p>
          <h1>口コミが、<em>売上に効いたか。</em></h1>
          <p className="lead">いいね数ではなく、販売ページでの行動まで確認します。</p>
        </div>
        <button className="dateButton">過去30日間⌄</button>
      </div>
      <div className="analyticsMetrics">
        <article><span>口コミの表示回数</span><strong>8,426</strong><em>↗ 23.4%</em></article>
        <article><span>口コミから商品詳細へ</span><strong>1,247</strong><em>↗ 14.8%</em></article>
        <article><span>購入ボタン到達</span><strong>386</strong><em>↗ 9.2%</em></article>
        <article><span>推定売上貢献</span><strong>¥486,000</strong><em>↗ 18.1%</em></article>
      </div>
      <div className="analyticsGrid">
        <article className="chartCard">
          <div className="chartHeader">
            <div><h2>口コミ経由のアクセス</h2><span>表示回数と商品詳細への遷移</span></div>
            <span className="legend"><i /> 表示 <i /> 商品詳細</span>
          </div>
          <div className="chart">
            {bars.map((bar, index) => (
              <div className="barGroup" key={index}>
                <span style={{ height: `${bar}px` }} />
                <i style={{ height: `${Math.max(18, bar * 0.42)}px` }} />
                <small>{index % 2 === 0 ? `${index + 1}日` : ""}</small>
              </div>
            ))}
          </div>
        </article>
        <article className="rankingCard">
          <div className="chartHeader"><div><h2>成果につながった声</h2><span>商品クリック順</span></div></div>
          {[
            ["みか｜在宅ワーク", "初案件を獲得", "186"],
            ["nana｜ハンドメイド", "問い合わせ3件", "142"],
            ["さき", "制作時間を75%短縮", "98"],
          ].map((item, index) => (
            <div className="rankRow" key={item[0]}>
              <b>0{index + 1}</b>
              <span><strong>{item[0]}</strong><small>{item[1]}</small></span>
              <em>{item[2]} clicks</em>
            </div>
          ))}
        </article>
      </div>
    </div>
  );
}
