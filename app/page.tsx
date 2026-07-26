"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Stage = "start" | "setup" | "processing" | "result";
type Goal = "follow" | "sales" | "reach";
type Tone = "natural" | "trust" | "punchy";
type PreviewMode = "before" | "after";

type TranscriptLine = {
  id: number;
  text: string;
  removed: boolean;
  accent?: boolean;
};

const goals: { id: Goal; icon: string; title: string; note: string }[] = [
  { id: "follow", icon: "＋", title: "フォローを増やす", note: "結論を先に見せる" },
  { id: "sales", icon: "↗", title: "商品を紹介する", note: "信頼とCTAを重視" },
  { id: "reach", icon: "◎", title: "まず見てもらう", note: "テンポと冒頭を重視" },
];

const tones: { id: Tone; title: string; note: string }[] = [
  { id: "natural", title: "自然", note: "話し方を残す" },
  { id: "trust", title: "信頼感", note: "落ち着いた間" },
  { id: "punchy", title: "テンポ重視", note: "短く小気味よく" },
];

const initialTranscript: TranscriptLine[] = [
  { id: 1, text: "えー、今日はですね、", removed: true },
  { id: 2, text: "続けられる人が最初にやっている", removed: false },
  { id: 3, text: "たったひとつの習慣を紹介します。", removed: false, accent: true },
  { id: 4, text: "私も前までは、あの、", removed: true },
  { id: 5, text: "何を始めても三日坊主でした。", removed: false },
  { id: 6, text: "でも、小さく始めるだけで変わりました。", removed: false, accent: true },
];

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("start");
  const [goal, setGoal] = useState<Goal>("follow");
  const [tone, setTone] = useState<Tone>("natural");
  const [length, setLength] = useState(60);
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [progress, setProgress] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("after");
  const [transcript, setTranscript] =
    useState<TranscriptLine[]>(initialTranscript);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!file) {
      setVideoUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (stage !== "processing") return;
    setProgress(4);
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(current + (current < 55 ? 9 : 6), 100);
        if (next >= 100) {
          window.clearInterval(timer);
          window.setTimeout(() => setStage("result"), 320);
        }
        return next;
      });
    }, 210);
    return () => window.clearInterval(timer);
  }, [stage]);

  const keptLines = useMemo(
    () => transcript.filter((line) => !line.removed),
    [transcript],
  );

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function chooseFile(selected?: File) {
    if (!selected) return;
    if (!selected.type.startsWith("video/")) {
      notify("動画ファイルを選んでください");
      return;
    }
    setFile(selected);
    setStage("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function useSample() {
    setFile(null);
    setStage("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEditing() {
    setProgress(0);
    setTranscript(initialTranscript);
    setStage("processing");
  }

  function reset() {
    setFile(null);
    setStage("start");
    setProgress(0);
    setPreviewMode("after");
    setTranscript(initialTranscript);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="siteShell">
      <header className="topbar">
        <button className="brand" onClick={reset} aria-label="トップへ戻る">
          <span className="brandIcon">
            <span />
            <i>▶</i>
          </span>
          <span className="brandText">
            撮るだけリール
            <small>ひとり喋り動画専用</small>
          </span>
        </button>

        {stage === "start" ? (
          <nav aria-label="メインメニュー">
            <a href="#how">使い方</a>
            <a href="#difference">できること</a>
            <a href="#price">料金</a>
          </nav>
        ) : (
          <div className="workspaceStatus">
            <span className="statusDot" />
            限定プレビュー
          </div>
        )}

        <div className="topActions">
          {stage !== "start" && (
            <button className="quietButton" onClick={reset}>
              新しく作る
            </button>
          )}
          <button
            className="trialButton"
            onClick={() =>
              stage === "start" ? inputRef.current?.click() : notify("保存機能は次の工程で接続します")
            }
          >
            無料で試す
          </button>
        </div>
      </header>

      <input
        ref={inputRef}
        className="visuallyHidden"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/*"
        onChange={(event) => chooseFile(event.target.files?.[0])}
      />

      {stage === "start" && (
        <Landing
          openPicker={() => inputRef.current?.click()}
          useSample={useSample}
        />
      )}

      {stage === "setup" && (
        <SetupWorkspace
          file={file}
          videoUrl={videoUrl}
          goal={goal}
          setGoal={setGoal}
          tone={tone}
          setTone={setTone}
          length={length}
          setLength={setLength}
          chooseAnother={() => inputRef.current?.click()}
          startEditing={startEditing}
        />
      )}

      {stage === "processing" && (
        <Processing file={file} progress={progress} />
      )}

      {stage === "result" && (
        <ResultWorkspace
          file={file}
          videoUrl={videoUrl}
          previewMode={previewMode}
          setPreviewMode={setPreviewMode}
          transcript={transcript}
          setTranscript={setTranscript}
          keptLines={keptLines}
          tone={tone}
          length={length}
          notify={notify}
          reset={reset}
        />
      )}

      <footer>
        <div>
          <strong>撮るだけリール</strong>
          <span>話して送るだけ。カット・テロップ・表紙まで自動。</span>
        </div>
        <div className="footerLinks">
          <a href="#how">使い方</a>
          <a href="#price">料金</a>
          <span>プライバシー</span>
          <span>利用規約</span>
        </div>
        <small>© 2026 撮るだけリール・限定プレビュー</small>
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

function Landing({
  openPicker,
  useSample,
}: {
  openPicker: () => void;
  useSample: () => void;
}) {
  return (
    <>
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow">
            <span>NEW</span>
            日本語のひとり喋り動画専用
          </p>
          <h1>
            話して送るだけ。
            <br />
            <em>編集は、もうしない。</em>
          </h1>
          <p className="heroLead">
            無音カット、言い淀み除去、テロップ、ズーム、表紙まで。
            <br />
            撮りっぱなしの動画を、投稿できるリールに仕上げます。
          </p>
          <div className="heroActions">
            <button className="mainCta" onClick={openPicker}>
              <span>動画を選んで無料で試す</span>
              <i>→</i>
            </button>
            <button className="sampleButton" onClick={useSample}>
              サンプルで体験
            </button>
          </div>
          <div className="trustRow">
            <span>✓ 登録不要</span>
            <span>✓ 体験版では動画を送信しません</span>
            <span>✓ スマホ動画対応</span>
          </div>
        </div>

        <div className="heroVisual" aria-label="編集前と編集後のイメージ">
          <div className="visualBadge">
            <strong>38分</strong>
            <span>かかっていた編集が</span>
          </div>
          <div className="phonePair">
            <div className="phone beforePhone">
              <div className="phoneTop" />
              <span className="phoneLabel">BEFORE</span>
              <CreatorFigure variant="before" />
              <div className="waveform">
                {Array.from({ length: 19 }).map((_, index) => (
                  <i key={index} />
                ))}
              </div>
              <div className="pausePins">
                <span />
                <span />
              </div>
              <small>3:42・言い直しあり</small>
            </div>
            <span className="transformArrow">→</span>
            <div className="phone afterPhone">
              <div className="phoneTop" />
              <span className="phoneLabel">AFTER</span>
              <CreatorFigure variant="after" />
              <div className="captionTop">
                続けられる人が
                <strong>最初にやること</strong>
              </div>
              <div className="captionBottom">
                小さく始めるのが
                <strong>一番の近道です</strong>
              </div>
              <div className="cutRail">
                <i />
                <i />
                <i />
              </div>
              <small>0:58・投稿できる状態</small>
            </div>
          </div>
          <div className="visualResult">
            <span>✓</span>
            <p>
              <strong>確認は3分だけ</strong>
              テロップを読んで、気になる所だけ直す
            </p>
          </div>
        </div>
      </section>

      <section className="painStrip">
        <span>こんな編集、まだ手でやっていませんか？</span>
        <div>
          <p>
            <i>01</i>
            無音部分を探して切る
          </p>
          <p>
            <i>02</i>
            字幕を一文字ずつ直す
          </p>
          <p>
            <i>03</i>
            毎回同じデザインに整える
          </p>
          <p>
            <i>04</i>
            表紙と投稿文を別で作る
          </p>
        </div>
      </section>

      <section className="howSection" id="how">
        <div className="sectionHeading">
          <p className="eyebrow">HOW IT WORKS</p>
          <h2>
            あなたがするのは、
            <br />
            <em>話す・選ぶ・確認する。</em>
          </h2>
          <p>難しい編集画面はありません。</p>
        </div>
        <div className="stepGrid">
          <article>
            <span className="stepNo">01</span>
            <div className="stepIcon uploadIcon">↑</div>
            <h3>撮った動画を送る</h3>
            <p>1〜5分の縦動画をそのままアップロード。</p>
            <small>MP4・MOV・スマホ対応</small>
          </article>
          <article>
            <span className="stepNo">02</span>
            <div className="stepIcon magicIcon">✦</div>
            <h3>AIが全部整える</h3>
            <p>無音、言い淀み、字幕、ズームをまとめて処理。</p>
            <small>日本語の自然な「間」を残す</small>
          </article>
          <article>
            <span className="stepNo">03</span>
            <div className="stepIcon checkIcon">✓</div>
            <h3>文字を読んで確認</h3>
            <p>気になる文だけ、タップで戻す・消す。</p>
            <small>タイムライン操作は不要</small>
          </article>
        </div>
      </section>

      <section className="differenceSection" id="difference">
        <div className="differenceCopy">
          <p className="eyebrow">NOT ANOTHER EDITOR</p>
          <h2>
            編集ソフトではなく、
            <br />
            <em>完成品が返ってくる。</em>
          </h2>
          <p>
            高機能なタイムラインを覚える必要はありません。
            あなたのテロップ、色、テンポを記憶して、2本目からもっと早く仕上げます。
          </p>
          <ul>
            <li>
              <span>✓</span>
              日本語の言い淀みと自然な間を分ける
            </li>
            <li>
              <span>✓</span>
              1行を短く、読みやすい位置で改行する
            </li>
            <li>
              <span>✓</span>
              専門用語と固有名詞をアカウントごとに記憶する
            </li>
          </ul>
        </div>
        <div className="memoryCard">
          <div className="memoryTop">
            <span>MY STYLE</span>
            <i>自動保存</i>
          </div>
          <div className="stylePreview">
            <span className="styleCaption">あなたのテロップ</span>
            <strong>大切な言葉だけ</strong>
            <em>色を変える</em>
          </div>
          <dl>
            <div>
              <dt>カットの速さ</dt>
              <dd>
                <i style={{ width: "66%" }} />
              </dd>
            </div>
            <div>
              <dt>テロップの量</dt>
              <dd>
                <i style={{ width: "82%" }} />
              </dd>
            </div>
            <div>
              <dt>ズームの頻度</dt>
              <dd>
                <i style={{ width: "38%" }} />
              </dd>
            </div>
          </dl>
          <p>2本目からは、設定なしでいつもの仕上がり。</p>
        </div>
      </section>

      <section className="priceSection" id="price">
        <div className="sectionHeading compact">
          <p className="eyebrow">SIMPLE PRICE</p>
          <h2>まず1本、完成を見てから。</h2>
          <p>体験後に、必要な分だけ選べます。</p>
        </div>
        <div className="priceGrid">
          <article>
            <p>FREE PREVIEW</p>
            <h3>無料体験</h3>
            <strong>¥0</strong>
            <span>30秒・透かしあり</span>
            <ul>
              <li>✓ 自動カット</li>
              <li>✓ 自動テロップ</li>
              <li>✓ 低画質プレビュー</li>
            </ul>
            <button onClick={useSample}>サンプルで試す</button>
          </article>
          <article className="featuredPrice">
            <span className="popular">おすすめ</span>
            <p>LIGHT</p>
            <h3>月5本プラン</h3>
            <strong>
              ¥1,480<small>/月</small>
            </strong>
            <span>1本あたり296円</span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>✓ 1080p・透かしなし</li>
              <li>✓ 編集スタイルを記憶</li>
            </ul>
            <button onClick={openPicker}>無料で1本試す</button>
          </article>
          <article>
            <p>ONE TIME</p>
            <h3>1本だけ</h3>
            <strong>¥480</strong>
            <span>サブスクなし</span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>✓ 1080p・透かしなし</li>
              <li>✓ 表紙と投稿文つき</li>
            </ul>
            <button onClick={openPicker}>動画を選ぶ</button>
          </article>
        </div>
      </section>

      <section className="bottomCta">
        <div>
          <p className="eyebrow">YOUR NEXT REEL</p>
          <h2>
            撮りっぱなしの動画を、
            <br />
            今日の投稿に。
          </h2>
        </div>
        <button className="mainCta light" onClick={openPicker}>
          <span>動画を選んで無料で試す</span>
          <i>→</i>
        </button>
      </section>
    </>
  );
}

function SetupWorkspace({
  file,
  videoUrl,
  goal,
  setGoal,
  tone,
  setTone,
  length,
  setLength,
  chooseAnother,
  startEditing,
}: {
  file: File | null;
  videoUrl: string;
  goal: Goal;
  setGoal: (goal: Goal) => void;
  tone: Tone;
  setTone: (tone: Tone) => void;
  length: number;
  setLength: (length: number) => void;
  chooseAnother: () => void;
  startEditing: () => void;
}) {
  return (
    <section className="workspace">
      <div className="workspaceHeading">
        <div>
          <p className="eyebrow">NEW PROJECT</p>
          <h1>どんなリールにしますか？</h1>
          <p>3つ選ぶだけで、カットとテロップの方針が決まります。</p>
        </div>
        <span>STEP 1 / 3</span>
      </div>

      <div className="setupGrid">
        <aside className="sourceCard">
          <div className="sourcePreview">
            {videoUrl ? (
              <video src={videoUrl} controls muted playsInline />
            ) : (
              <div className="sampleSource">
                <CreatorFigure variant="before" />
                <span>サンプル動画</span>
              </div>
            )}
            <i>RAW</i>
          </div>
          <div className="fileRow">
            <span className="fileIcon">▶</span>
            <p>
              <strong>{file?.name ?? "sample_talking_video.mp4"}</strong>
              <small>
                {file ? `${Math.max(file.size / 1024 / 1024, 0.1).toFixed(1)} MB` : "18.4 MB"}・縦動画
              </small>
            </p>
            <button onClick={chooseAnother}>変更</button>
          </div>
          <div className="localNote">
            <span>●</span>
            体験版では動画は端末内だけで表示され、外部へ送信されません。
          </div>
        </aside>

        <div className="setupForm">
          <fieldset>
            <legend>
              <span>01</span>
              この動画の目的
            </legend>
            <div className="optionCards three">
              {goals.map((item) => (
                <button
                  key={item.id}
                  className={goal === item.id ? "selected" : ""}
                  onClick={() => setGoal(item.id)}
                >
                  <i>{item.icon}</i>
                  <strong>{item.title}</strong>
                  <small>{item.note}</small>
                  <b>{goal === item.id ? "✓" : ""}</b>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>
              <span>02</span>
              仕上がりの雰囲気
            </legend>
            <div className="optionCards three toneCards">
              {tones.map((item) => (
                <button
                  key={item.id}
                  className={tone === item.id ? "selected" : ""}
                  onClick={() => setTone(item.id)}
                >
                  <span className={`toneLines ${item.id}`}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <strong>{item.title}</strong>
                  <small>{item.note}</small>
                  <b>{tone === item.id ? "✓" : ""}</b>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>
              <span>03</span>
              完成する長さ
            </legend>
            <div className="lengthOptions">
              {[30, 60, 90].map((item) => (
                <button
                  key={item}
                  className={length === item ? "selected" : ""}
                  onClick={() => setLength(item)}
                >
                  <strong>{item}</strong>秒
                  <small>
                    {item === 30 ? "短く強く" : item === 60 ? "おすすめ" : "しっかり解説"}
                  </small>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="editSummary">
            <div>
              <span>今回の編集方針</span>
              <p>
                <strong>{goals.find((item) => item.id === goal)?.title}</strong>
                ・{tones.find((item) => item.id === tone)?.title}・{length}秒
              </p>
            </div>
            <button className="mainCta" onClick={startEditing}>
              <span>この設定で自動編集する</span>
              <i>✦</i>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Processing({
  file,
  progress,
}: {
  file: File | null;
  progress: number;
}) {
  const steps = [
    { threshold: 18, label: "音声を読み取り中", note: "日本語の単語と時刻を確認" },
    { threshold: 42, label: "不要な間を判定中", note: "自然な間は残します" },
    { threshold: 68, label: "カットを組み立て中", note: "言い直しと重複を整理" },
    { threshold: 88, label: "テロップを作成中", note: "読みやすい位置で改行" },
    { threshold: 100, label: "仕上げ中", note: "表紙と投稿文を準備" },
  ];
  const activeIndex = steps.findIndex((step) => progress <= step.threshold);

  return (
    <section className="processingPage">
      <div className="processingCard">
        <div className="processingVisual">
          <div className="processingPhone">
            <CreatorFigure variant="after" />
            <span className="scanLine" />
            <div className="captionGhost">
              <i />
              <i />
            </div>
          </div>
          <span className="orbit one">✦</span>
          <span className="orbit two">CUT</span>
          <span className="orbit three">字幕</span>
        </div>

        <div className="processingCopy">
          <p className="eyebrow">AI EDITING</p>
          <h1>投稿できる状態に整えています。</h1>
          <p>
            {file?.name ?? "サンプル動画"}を解析中です。この体験版では処理工程を再現しています。
          </p>
          <div className="bigProgress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="progressNumber">
            <strong>{progress}</strong>%
          </div>
          <div className="processingSteps">
            {steps.map((step, index) => (
              <div
                key={step.label}
                className={
                  progress > step.threshold
                    ? "done"
                    : index === activeIndex
                      ? "active"
                      : ""
                }
              >
                <span>{progress > step.threshold ? "✓" : index + 1}</span>
                <p>
                  <strong>{step.label}</strong>
                  <small>{step.note}</small>
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ResultWorkspace({
  file,
  videoUrl,
  previewMode,
  setPreviewMode,
  transcript,
  setTranscript,
  keptLines,
  tone,
  length,
  notify,
  reset,
}: {
  file: File | null;
  videoUrl: string;
  previewMode: PreviewMode;
  setPreviewMode: (mode: PreviewMode) => void;
  transcript: TranscriptLine[];
  setTranscript: (lines: TranscriptLine[]) => void;
  keptLines: TranscriptLine[];
  tone: Tone;
  length: number;
  notify: (message: string) => void;
  reset: () => void;
}) {
  function toggleLine(id: number) {
    setTranscript(
      transcript.map((line) =>
        line.id === id ? { ...line, removed: !line.removed } : line,
      ),
    );
  }

  function updateLine(id: number, text: string) {
    setTranscript(
      transcript.map((line) => (line.id === id ? { ...line, text } : line)),
    );
  }

  return (
    <section className="resultPage">
      <div className="resultHeading">
        <div>
          <p className="completePill">
            <span>✓</span>
            自動編集が完了しました
          </p>
          <h1>あとは、読んで確認するだけ。</h1>
          <p>削除した部分はいつでも戻せます。動画編集の知識は不要です。</p>
        </div>
        <div className="timeSaved">
          <span>今回の短縮時間</span>
          <strong>約35分</strong>
          <small>従来38分 → 確認3分</small>
        </div>
      </div>

      <div className="resultGrid">
        <div className="previewPanel">
          <div className="previewTop">
            <div className="modeSwitch">
              <button
                className={previewMode === "before" ? "active" : ""}
                onClick={() => setPreviewMode("before")}
              >
                編集前
              </button>
              <button
                className={previewMode === "after" ? "active" : ""}
                onClick={() => setPreviewMode("after")}
              >
                編集後
              </button>
            </div>
            <span>仕上がりプレビュー</span>
          </div>

          <div className={`resultVideo ${previewMode}`}>
            {videoUrl ? (
              <video src={videoUrl} controls muted playsInline loop />
            ) : (
              <div className="resultSample">
                <CreatorFigure variant={previewMode} />
              </div>
            )}
            {previewMode === "after" && (
              <>
                <div className="resultHook">
                  続けられる人が
                  <strong>最初にやること</strong>
                </div>
                <div className={`resultCaption ${tone}`}>
                  {keptLines.at(-1)?.text ?? "小さく始めるだけで変わりました。"}
                </div>
                <span className="zoomMark">1.06×</span>
              </>
            )}
            <span className="videoState">
              {previewMode === "after" ? "AFTER" : "RAW"}
            </span>
          </div>

          <div className="timelinePreview">
            <span className="playButton">▶</span>
            <div>
              <i className="kept" />
              <i className="removed" />
              <i className="kept long" />
              <i className="removed short" />
              <i className="kept" />
              <b style={{ left: previewMode === "after" ? "42%" : "18%" }} />
            </div>
            <span>0:22 / 0:{length}</span>
          </div>
        </div>

        <aside className="editPanel">
          <div className="editPanelHeading">
            <div>
              <p className="eyebrow">TEXT EDIT</p>
              <h2>文字でカットを確認</h2>
            </div>
            <span>自動保存</span>
          </div>
          <p className="editHelp">
            薄い文章は削除候補です。左のボタンで戻す・消すを切り替えられます。
          </p>
          <div className="transcriptList">
            {transcript.map((line) => (
              <div
                className={`transcriptLine ${line.removed ? "removed" : ""} ${line.accent ? "accent" : ""}`}
                key={line.id}
              >
                <button
                  onClick={() => toggleLine(line.id)}
                  aria-label={line.removed ? "この文を戻す" : "この文を削除する"}
                >
                  {line.removed ? "↶" : "✓"}
                </button>
                <input
                  value={line.text}
                  onChange={(event) => updateLine(line.id, event.target.value)}
                  disabled={line.removed}
                />
                {line.accent && !line.removed && <span>強調</span>}
              </div>
            ))}
          </div>
          <div className="cutSummary">
            <div>
              <span>無音カット</span>
              <strong>8箇所</strong>
            </div>
            <div>
              <span>言い淀み</span>
              <strong>6箇所</strong>
            </div>
            <div>
              <span>テロップ</span>
              <strong>14枚</strong>
            </div>
          </div>
        </aside>
      </div>

      <div className="deliverables">
        <div>
          <p className="eyebrow">READY TO POST</p>
          <h2>投稿に必要なものを、まとめて用意しました。</h2>
        </div>
        <div className="deliverableCards">
          <button onClick={() => notify("表紙プレビューを選択しました")}>
            <span className="deliverableIcon cover">表</span>
            <p>
              <strong>表紙画像</strong>
              <small>1080 × 1920</small>
            </p>
            <i>→</i>
          </button>
          <button onClick={() => notify("投稿文をコピーしました")}>
            <span className="deliverableIcon copy">文</span>
            <p>
              <strong>投稿文</strong>
              <small>Instagram・Threads</small>
            </p>
            <i>→</i>
          </button>
          <button onClick={() => notify("テロップ原稿をコピーしました")}>
            <span className="deliverableIcon text">字</span>
            <p>
              <strong>テロップ原稿</strong>
              <small>修正済みテキスト</small>
            </p>
            <i>→</i>
          </button>
        </div>
      </div>

      <div className="exportBar">
        <div>
          <span className="exportIcon">▶</span>
          <p>
            <strong>{file?.name?.replace(/\.[^.]+$/, "") ?? "sample_talking_video"}_edited.mp4</strong>
            <small>9:16・1080p・約{length}秒・透かしなし</small>
          </p>
        </div>
        <div className="exportActions">
          <button className="quietButton" onClick={reset}>
            別の動画を作る
          </button>
          <button
            className="mainCta"
            onClick={() =>
              notify("実動画の書き出しは、次の開発工程で接続します")
            }
          >
            <span>1080pで書き出す</span>
            <i>↓</i>
          </button>
        </div>
      </div>
    </section>
  );
}

function CreatorFigure({ variant }: { variant: "before" | "after" }) {
  return (
    <div className={`creatorFigure ${variant}`}>
      <span className="hair" />
      <span className="face">
        <i className="eye left" />
        <i className="eye right" />
        <i className="mouth" />
      </span>
      <span className="body" />
      <span className="hand left" />
      <span className="hand right" />
      {variant === "before" && <i className="hesitation">…</i>}
      {variant === "after" && <i className="idea">!</i>}
    </div>
  );
}
