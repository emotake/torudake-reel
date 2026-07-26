"use client";

import { useMemo, useState } from "react";

type View = "answer" | "create" | "results";
type Choice = "A" | "B";
type PollKind = "hook" | "photo" | "price";

type Poll = {
  id: number;
  author: string;
  handle: string;
  avatar: string;
  category: string;
  question: string;
  note: string;
  optionA: string;
  optionB: string;
  votesA: number;
  votesB: number;
  kind: PollKind;
  reward: number;
  time: string;
};

const polls: Poll[] = [
  {
    id: 1,
    author: "mio｜SNS運用",
    handle: "@mio_growth",
    avatar: "m",
    category: "投稿の1枚目",
    question: "思わず続きを読みたくなるのは、どちらですか？",
    note: "Instagramのカルーセル投稿で使う1枚目です",
    optionA: "毎日投稿しても、伸びない理由。",
    optionB: "フォロワーが増えない人、最初の1枚で損しています。",
    votesA: 9,
    votesB: 21,
    kind: "hook",
    reward: 10,
    time: "残り18分",
  },
  {
    id: 2,
    author: "nana handmade",
    handle: "@nana_made",
    avatar: "n",
    category: "商品写真",
    question: "ハンドメイドアクセサリー、欲しくなる写真はどっち？",
    note: "ネットショップの商品一覧に掲載します",
    optionA: "やわらかい自然光・着用イメージ",
    optionB: "白背景・商品のアップ",
    votesA: 18,
    votesB: 12,
    kind: "photo",
    reward: 10,
    time: "残り25分",
  },
  {
    id: 3,
    author: "TAKU｜個人開発",
    handle: "@taku_builds",
    avatar: "t",
    category: "料金表示",
    question: "このサービス、始めやすく感じる料金表示はどちら？",
    note: "新しいサブスクサービスの料金ページです",
    optionA: "月額980円",
    optionB: "1日あたり33円",
    votesA: 11,
    votesB: 19,
    kind: "price",
    reward: 10,
    time: "残り31分",
  },
];

export default function Home() {
  const [view, setView] = useState<View>("answer");
  const [pollIndex, setPollIndex] = useState(0);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [coins, setCoins] = useState(120);
  const [toast, setToast] = useState("");
  const [created, setCreated] = useState(false);
  const [createdQuestion, setCreatedQuestion] = useState(
    "投稿の1枚目、どちらが続きを読みたくなりますか？",
  );
  const [createdA, setCreatedA] = useState("知らないと損する投稿の作り方");
  const [createdB, setCreatedB] = useState("伸びる投稿は、最初の1行が違う。");

  const poll = polls[pollIndex];
  const totalVotes = poll.votesA + poll.votesB + (submitted ? 1 : 0);
  const resultA = Math.round(
    ((poll.votesA + (submitted && choice === "A" ? 1 : 0)) / totalVotes) * 100,
  );
  const resultB = 100 - resultA;

  const remainingPolls = useMemo(
    () => polls.length - pollIndex - (submitted ? 1 : 0),
    [pollIndex, submitted],
  );

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function submitVote() {
    if (!choice) {
      notify("AかBを選んでください");
      return;
    }
    setSubmitted(true);
    setCoins((current) => current + poll.reward);
  }

  function nextPoll() {
    setPollIndex((current) => (current + 1) % polls.length);
    setChoice(null);
    setReason("");
    setSubmitted(false);
  }

  function changeView(next: View) {
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="app">
      <header className="topbar">
        <button className="brand" onClick={() => changeView("answer")}>
          <span className="brandMark">
            <i>A</i>
            <i>B</i>
          </span>
          <span>
            30秒ジャッジ
            <small>30 SEC JUDGE</small>
          </span>
        </button>

        <nav aria-label="メインメニュー">
          <button
            className={view === "answer" ? "active" : ""}
            onClick={() => changeView("answer")}
          >
            暇つぶしに答える
          </button>
          <button
            className={view === "create" ? "active" : ""}
            onClick={() => changeView("create")}
          >
            みんなに聞く
          </button>
          <button
            className={view === "results" ? "active" : ""}
            onClick={() => changeView("results")}
          >
            結果を見る
          </button>
        </nav>

        <div className="headerActions">
          <span className="speedPill">
            <i />
            平均12分で30回答
          </span>
          <button className="coinPill" onClick={() => notify("5問回答すると質問券を獲得できます")}>
            <span>J</span>
            {coins}
          </button>
          <button className="profileButton" aria-label="プロフィール">
            EM
          </button>
        </div>
      </header>

      <div className="mobileNav">
        {([
          ["answer", "答える"],
          ["create", "質問する"],
          ["results", "結果"],
        ] as [View, string][]).map(([key, label]) => (
          <button
            key={key}
            className={view === key ? "active" : ""}
            onClick={() => changeView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "answer" && (
        <AnswerView
          poll={poll}
          choice={choice}
          setChoice={setChoice}
          reason={reason}
          setReason={setReason}
          submitted={submitted}
          submitVote={submitVote}
          nextPoll={nextPoll}
          resultA={resultA}
          resultB={resultB}
          remainingPolls={remainingPolls}
          coins={coins}
          goCreate={() => changeView("create")}
          goResults={() => changeView("results")}
        />
      )}

      {view === "create" && (
        <CreateView
          created={created}
          setCreated={setCreated}
          question={createdQuestion}
          setQuestion={setCreatedQuestion}
          optionA={createdA}
          setOptionA={setCreatedA}
          optionB={createdB}
          setOptionB={setCreatedB}
          goResults={() => changeView("results")}
          notify={notify}
        />
      )}

      {view === "results" && (
        <ResultsView
          goCreate={() => {
            setCreated(false);
            changeView("create");
          }}
          notify={notify}
        />
      )}

      <footer>
        <button className="footerBrand" onClick={() => changeView("answer")}>
          <span className="brandMark mini">
            <i>A</i>
            <i>B</i>
          </span>
          30秒ジャッジ
        </button>
        <p>暇な30秒を、誰かの「決められない」に。</p>
        <span>このサイトはサービスイメージを確認するためのデモです。</span>
      </footer>

      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
    </main>
  );
}

function AnswerView({
  poll,
  choice,
  setChoice,
  reason,
  setReason,
  submitted,
  submitVote,
  nextPoll,
  resultA,
  resultB,
  remainingPolls,
  coins,
  goCreate,
  goResults,
}: {
  poll: Poll;
  choice: Choice | null;
  setChoice: (choice: Choice) => void;
  reason: string;
  setReason: (reason: string) => void;
  submitted: boolean;
  submitVote: () => void;
  nextPoll: () => void;
  resultA: number;
  resultB: number;
  remainingPolls: number;
  coins: number;
  goCreate: () => void;
  goResults: () => void;
}) {
  return (
    <div className="answerPage">
      <section className="answerHero">
        <div>
          <p className="eyebrow">
            <span>LIVE</span>
            暇な30秒で、誰かの迷いを助けよう
          </p>
          <h1>
            あなたなら、
            <em>どっち？</em>
          </h1>
          <p className="heroLead">
            正解はありません。直感で選んで、理由をひとこと。
            <br />
            あなたの回答が、誰かの次の一歩になります。
          </p>
        </div>
        <div className="liveActivity">
          <span className="faceStack">
            <i>ゆ</i>
            <i>k</i>
            <i>な</i>
          </span>
          <p>
            <strong>いま142人</strong>が回答中
            <small>直近1分で38件の回答</small>
          </p>
          <span className="pulseDot" />
        </div>
      </section>

      <section className="judgeLayout">
        <article className="pollCard">
          <div className="pollMeta">
            <div className="author">
              <span className="authorAvatar">{poll.avatar}</span>
              <span>
                <strong>{poll.author}</strong>
                <small>
                  {poll.handle} ・ {poll.time}
                </small>
              </span>
            </div>
            <span className="category">{poll.category}</span>
          </div>

          {!submitted ? (
            <>
              <div className="questionHeading">
                <span>Q</span>
                <div>
                  <h2>{poll.question}</h2>
                  <p>{poll.note}</p>
                </div>
              </div>

              <div className="choiceGrid">
                <ChoiceCard
                  label="A"
                  text={poll.optionA}
                  kind={poll.kind}
                  selected={choice === "A"}
                  onClick={() => setChoice("A")}
                />
                <div className="orBadge">OR</div>
                <ChoiceCard
                  label="B"
                  text={poll.optionB}
                  kind={poll.kind}
                  selected={choice === "B"}
                  onClick={() => setChoice("B")}
                />
              </div>

              <div className={`reasonBox ${choice ? "ready" : ""}`}>
                <label htmlFor="reason">
                  選んだ理由をひとこと
                  <small>任意</small>
                </label>
                <input
                  id="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={
                    choice
                      ? `${choice}を選んだ理由を教えてください`
                      : "先にAかBを選んでください"
                  }
                  disabled={!choice}
                />
              </div>

              <button
                className={`voteButton ${choice ? "enabled" : ""}`}
                onClick={submitVote}
              >
                <span className="rewardCoin">J</span>
                この案に投票する
                <small>回答で＋{poll.reward}コイン</small>
                <b>→</b>
              </button>
            </>
          ) : (
            <div className="instantResult">
              <div className="rewardCelebration">
                <span>J</span>
                <div>
                  <strong>回答ありがとう！</strong>
                  <small>＋{poll.reward}コイン獲得しました</small>
                </div>
                <b>{coins} coin</b>
              </div>

              <p className="resultLabel">みんなの回答</p>
              <h2>{poll.question}</h2>
              <div className="duelResult">
                <div className={resultA > resultB ? "winner" : ""}>
                  <span>A</span>
                  <strong>{resultA}%</strong>
                  <small>{Math.round((resultA / 100) * 31)}人</small>
                  <i style={{ height: `${Math.max(resultA, 16)}%` }} />
                </div>
                <div className={resultB > resultA ? "winner" : ""}>
                  <span>B</span>
                  <strong>{resultB}%</strong>
                  <small>{Math.round((resultB / 100) * 31)}人</small>
                  <i style={{ height: `${Math.max(resultB, 16)}%` }} />
                </div>
              </div>
              <p className="yourVote">
                あなたは <strong>{choice}</strong> を選びました
              </p>
              <div className="reasonChips">
                <span>「続きが気になる」12人</span>
                <span>「自分ごとに感じる」7人</span>
                <span>「具体的」4人</span>
              </div>
              <div className="resultActions">
                <button onClick={goResults}>詳しい分析を見る</button>
                <button className="nextButton" onClick={nextPoll}>
                  次の質問へ <span>→</span>
                </button>
              </div>
            </div>
          )}
        </article>

        <aside className="answerAside">
          <article className="missionCard">
            <div className="missionTop">
              <span>今日のミッション</span>
              <strong>3 / 5</strong>
            </div>
            <div className="progressTrack">
              <i style={{ width: "60%" }} />
            </div>
            <h3>あと2問で、質問券を獲得</h3>
            <p>5問答えると、あなたも無料で10人に質問できます。</p>
            <div className="miniSteps">
              {[1, 2, 3, 4, 5].map((item) => (
                <span className={item <= 3 ? "done" : ""} key={item}>
                  {item <= 3 ? "✓" : item}
                </span>
              ))}
            </div>
          </article>

          <article className="whyCard">
            <span className="miniEyebrow">WHY IT MATTERS</span>
            <h3>
              あなたの30秒で、
              <br />
              この人は投稿を決められる。
            </h3>
            <div className="beforeAfter">
              <span>
                <small>BEFORE</small>
                どっちにしよう…
              </span>
              <b>→</b>
              <span>
                <small>AFTER</small>
                Bで投稿しよう！
              </span>
            </div>
            <button onClick={goCreate}>自分もみんなに聞いてみる →</button>
          </article>

          <div className="remaining">
            <span>●</span>
            あなた向けの質問があと{Math.max(remainingPolls, 1)}件あります
          </div>
        </aside>
      </section>
    </div>
  );
}

function ChoiceCard({
  label,
  text,
  kind,
  selected,
  onClick,
}: {
  label: Choice;
  text: string;
  kind: PollKind;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`choiceCard ${selected ? "selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="choiceLabel">{label}</span>
      <div className={`creativePreview ${kind} option${label}`}>
        {kind === "hook" && (
          <>
            <span className="mockAccount">
              <i />
              mio_growth
            </span>
            <strong>{text}</strong>
            <span className="mockUnderline" />
            <small>SWIPE →</small>
          </>
        )}
        {kind === "photo" && (
          <>
            <span className="earring">
              <i />
              <b />
            </span>
            <strong>{text}</strong>
          </>
        )}
        {kind === "price" && (
          <>
            <span>CREATOR PLAN</span>
            <strong>{text}</strong>
            <small>すべての分析機能が使えます</small>
            <i>今すぐ始める</i>
          </>
        )}
      </div>
      <span className="selectLine">
        <i>{selected ? "✓" : ""}</i>
        {selected ? `${label}を選択中` : `${label}を選ぶ`}
      </span>
    </button>
  );
}

function CreateView({
  created,
  setCreated,
  question,
  setQuestion,
  optionA,
  setOptionA,
  optionB,
  setOptionB,
  goResults,
  notify,
}: {
  created: boolean;
  setCreated: (created: boolean) => void;
  question: string;
  setQuestion: (text: string) => void;
  optionA: string;
  setOptionA: (text: string) => void;
  optionB: string;
  setOptionB: (text: string) => void;
  goResults: () => void;
  notify: (message: string) => void;
}) {
  if (created) {
    return (
      <div className="createdPage">
        <div className="launchSuccess">
          <div className="launchIcon">✓</div>
          <p className="eyebrow">JUDGE STARTED</p>
          <h1>
            みんなへの質問を
            <br />
            <em>開始しました。</em>
          </h1>
          <p>
            回答者への配信が始まりました。画面を閉じても回答は集まり続けます。
          </p>
          <div className="liveGather">
            <div className="gatherRing">
              <strong>6</strong>
              <span>/ 20人</span>
            </div>
            <div>
              <span>
                <i /> 回答を収集中
              </span>
              <h3>開始から1分24秒</h3>
              <p>現在のペースなら、あと約5分で完了します。</p>
            </div>
          </div>
          <div className="createdSummary">
            <span>
              <small>質問</small>
              <strong>{question}</strong>
            </span>
            <span>
              <small>現在の優勢</small>
              <strong>B・67%</strong>
            </span>
            <span>
              <small>完了予測</small>
              <strong>約6分後</strong>
            </span>
          </div>
          <div className="launchActions">
            <button
              onClick={() => notify("Threads共有用の文章をコピーしました")}
            >
              Threadsで回答を募集
            </button>
            <button className="primaryAction" onClick={goResults}>
              途中結果を見る →
            </button>
          </div>
          <button className="backLink" onClick={() => setCreated(false)}>
            ← 質問内容を修正する
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="createPage">
      <section className="subHero">
        <div>
          <p className="eyebrow">CREATE A JUDGE</p>
          <h1>
            迷っている案を、
            <br />
            <em>30人に聞いて決める。</em>
          </h1>
          <p>
            質問と2つの案を登録するだけ。フォロワーが少なくても回答が集まります。
          </p>
        </div>
        <div className="promiseCard">
          <span>回答完了までの目安</span>
          <strong>約12分</strong>
          <small>30人・ターゲット指定なしの場合</small>
        </div>
      </section>

      <section className="createLayout">
        <div className="builderCard">
          <div className="builderHeading">
            <span>01</span>
            <div>
              <h2>質問を入力</h2>
              <p>回答者が迷わない、ひとつの質問にします。</p>
            </div>
            <b>AIチェック済</b>
          </div>
          <label className="field">
            <span>聞きたいこと</span>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <small>{question.length} / 100</small>
          </label>

          <div className="builderDivider" />

          <div className="builderHeading">
            <span>02</span>
            <div>
              <h2>2つの案を登録</h2>
              <p>画像または文章で比較できます。</p>
            </div>
          </div>
          <div className="optionInputs">
            <label>
              <span className="inputLabel a">A</span>
              <div className="uploadMock">
                <i>＋</i>
                <span>画像を追加</span>
                <small>PNG・JPG</small>
              </div>
              <input
                value={optionA}
                onChange={(event) => setOptionA(event.target.value)}
                aria-label="選択肢A"
              />
            </label>
            <span className="vs">VS</span>
            <label>
              <span className="inputLabel b">B</span>
              <div className="uploadMock alt">
                <i>＋</i>
                <span>画像を追加</span>
                <small>PNG・JPG</small>
              </div>
              <input
                value={optionB}
                onChange={(event) => setOptionB(event.target.value)}
                aria-label="選択肢B"
              />
            </label>
          </div>

          <div className="builderDivider" />

          <div className="builderHeading">
            <span>03</span>
            <div>
              <h2>回答者を設定</h2>
              <p>最初は広く聞くのがおすすめです。</p>
            </div>
          </div>
          <div className="targetRow">
            <button className="selected">指定なし</button>
            <button>20〜39歳</button>
            <button>SNS発信者</button>
            <button>ネット通販利用者</button>
            <button>＋ 条件を追加</button>
          </div>
        </div>

        <aside className="orderCard">
          <p className="miniEyebrow">ORDER SUMMARY</p>
          <h2>募集内容</h2>
          <dl>
            <div>
              <dt>回答人数</dt>
              <dd>
                <strong>30</strong>人
              </dd>
            </div>
            <div>
              <dt>予想完了時間</dt>
              <dd>約12分</dd>
            </div>
            <div>
              <dt>回答理由</dt>
              <dd>任意で収集</dd>
            </div>
            <div>
              <dt>AI結果要約</dt>
              <dd className="included">含まれます</dd>
            </div>
          </dl>
          <div className="costRow">
            <span>
              今回の利用
              <small>Creatorプラン残り9回</small>
            </span>
            <strong>1回分</strong>
          </div>
          <button
            className="launchButton"
            onClick={() => setCreated(true)}
            disabled={!question || !optionA || !optionB}
          >
            30人に聞いてみる <span>→</span>
          </button>
          <p className="safeNote">
            このデモでは実際の募集・SNS投稿は行われません。
          </p>
          <div className="planInfo">
            <span>CREATOR PLAN</span>
            <strong>月額980円</strong>
            <small>月10回・各20回答まで</small>
          </div>
        </aside>
      </section>
    </div>
  );
}

function ResultsView({
  goCreate,
  notify,
}: {
  goCreate: () => void;
  notify: (message: string) => void;
}) {
  return (
    <div className="resultsPage">
      <section className="subHero resultsHero">
        <div>
          <p className="eyebrow">JUDGE COMPLETED</p>
          <div className="completeLine">
            <span>✓</span>
            回答が30件集まりました
          </div>
          <h1>
            B案で、
            <em>投稿しましょう。</em>
          </h1>
          <p>感覚ではなく、30人の反応をもとに次の行動を決められます。</p>
        </div>
        <div className="resultSpeed">
          <span>回答完了まで</span>
          <strong>12:18</strong>
          <small>予定より2分42秒早く完了</small>
        </div>
      </section>

      <section className="resultDashboard">
        <article className="winnerPanel">
          <div className="panelHeading">
            <div>
              <p className="miniEyebrow">FINAL RESULT</p>
              <h2>投稿の1枚目、どちらが続きを読みたくなりますか？</h2>
            </div>
            <span className="confidence">
              <i>✦</i>
              判定信頼度 <strong>89%</strong>
            </span>
          </div>

          <div className="resultOptions">
            <div className="resultOption">
              <span className="resultLetter">A</span>
              <div className="miniCreative a">
                <small>知らないと損する</small>
                <strong>投稿の作り方</strong>
              </div>
              <span className="resultNumbers">
                <strong>30%</strong>
                <small>9人</small>
              </span>
              <div className="horizontalBar">
                <i style={{ width: "30%" }} />
              </div>
            </div>
            <div className="resultOption winning">
              <span className="winnerFlag">WINNER</span>
              <span className="resultLetter">B</span>
              <div className="miniCreative b">
                <small>伸びる投稿は、</small>
                <strong>最初の1行が違う。</strong>
              </div>
              <span className="resultNumbers">
                <strong>70%</strong>
                <small>21人</small>
              </span>
              <div className="horizontalBar">
                <i style={{ width: "70%" }} />
              </div>
            </div>
          </div>

          <div className="decisionBanner">
            <span>✓</span>
            <p>
              <strong>結論：B案を採用するのがおすすめです</strong>
              A案より40ポイント高く、すべての年代でB案が優勢でした。
            </p>
            <button onClick={() => notify("結果画像をコピーしました")}>
              結果をシェア
            </button>
          </div>
        </article>

        <aside className="impactPanel">
          <p className="miniEyebrow">CLEAR IMPACT</p>
          <h2>この12分で、決まったこと</h2>
          <div className="impactSteps">
            <div>
              <span className="before">前</span>
              <p>
                <strong>AかBか決められない</strong>
                投稿作成が止まっている
              </p>
            </div>
            <i>↓</i>
            <div>
              <span className="after">今</span>
              <p>
                <strong>Bを採用すると決定</strong>
                すぐ投稿準備へ進める
              </p>
            </div>
          </div>
          <dl className="impactMetrics">
            <div>
              <dt>集まった意見</dt>
              <dd>30件</dd>
            </div>
            <div>
              <dt>判断時間</dt>
              <dd>12分</dd>
            </div>
            <div>
              <dt>迷いの解消</dt>
              <dd>完了</dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className="insightGrid">
        <article className="aiInsight">
          <div className="insightHeading">
            <span>✦</span>
            <div>
              <p className="miniEyebrow">AI INSIGHT</p>
              <h2>選ばれた理由</h2>
            </div>
          </div>
          <blockquote>
            B案は「自分の投稿も損しているかもしれない」という
            <strong>自分ごと化</strong>
            が起きやすく、続きを確認したい気持ちにつながっています。
          </blockquote>
          <div className="reasonBars">
            <div>
              <span>自分に関係があると感じる</span>
              <i>
                <b style={{ width: "82%" }} />
              </i>
              <strong>12人</strong>
            </div>
            <div>
              <span>続きが気になる</span>
              <i>
                <b style={{ width: "68%" }} />
              </i>
              <strong>9人</strong>
            </div>
            <div>
              <span>内容が具体的</span>
              <i>
                <b style={{ width: "38%" }} />
              </i>
              <strong>5人</strong>
            </div>
          </div>
        </article>

        <article className="commentsPanel">
          <div className="panelHeading">
            <div>
              <p className="miniEyebrow">REAL COMMENTS</p>
              <h2>回答者のひとこと</h2>
            </div>
            <span>24件</span>
          </div>
          {[
            ["B", "自分も損しているかも、と思って続きを見たくなります。", "20代・女性"],
            ["B", "「最初の1枚」と言い切っていて、何が分かるか明確。", "30代・男性"],
            ["A", "短くてシンプルなので、ぱっと理解しやすかったです。", "20代・女性"],
          ].map(([vote, comment, person]) => (
            <div className="commentRow" key={comment}>
              <span className={`commentVote ${vote.toLowerCase()}`}>{vote}</span>
              <p>
                <strong>{comment}</strong>
                <small>{person}</small>
              </p>
            </div>
          ))}
        </article>
      </section>

      <section className="nextDecision">
        <div>
          <span className="miniEyebrow">NEXT JUDGE</span>
          <h2>次は、投稿文も決めますか？</h2>
          <p>同じ回答者層に続けて聞くと、投稿全体の精度を上げられます。</p>
        </div>
        <button onClick={goCreate}>次の二択を作る →</button>
      </section>
    </div>
  );
}
