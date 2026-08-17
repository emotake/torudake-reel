"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./operations.module.css";

type Metrics = {
  generatedAt: number;
  windowDays: number;
  sourceFreshness: { firstEventAt: number | null; lastEventAt: number | null };
  summary: {
    uniqueActors: number;
    totalEvents: number;
    previewCompleted: number;
    checkoutStarted: number;
    checkoutCreated: number;
    exportCompleted: number;
    failures: number;
  };
  operations: {
    users: number;
    passkeys: number;
    activeOneTimePurchases: number;
    completedSavesInWindow: number;
    activeReservations: number;
    pendingStripeEvents: number;
  };
  providerSummary: ProviderUsageTotals;
  providerUsage: ProviderUsageRow[];
  events: Array<{ eventName: string; events: number; actors: number }>;
  feedback: Array<{ rating: string; context: string; responses: number }>;
  daily: Array<{ day: string; events: number; actors: number }>;
  activePlans: Array<{ plan: string; subscriptions: number }>;
  caveats: string[];
};

type ProviderUsageTotals = {
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  audioSeconds: number;
  inputCharacters: number;
};

type ProviderUsageRow = ProviderUsageTotals & {
  day: string;
  provider: string;
  model: string;
  operation: string;
  updatedAt: number;
};

const EVENT_LABELS: Record<string, string> = {
  demo_started: "見本を再生",
  video_selected: "動画を選択",
  preview_completed: "プレビュー完成",
  preview_failed: "プレビュー失敗",
  pricing_viewed: "料金を表示",
  purchase_options_shown: "購入候補を表示",
  one_time_rescue_revealed: "今回だけ保存を表示",
  checkout_started: "購入を開始",
  checkout_session_created: "Stripe画面を作成",
  checkout_session_failed: "Stripe画面の作成失敗",
  stripe_purchase_completed: "購入完了",
  stripe_purchase_failed: "購入失敗",
  stripe_subscription_updated: "月額状態を更新",
  export_started: "書き出し開始",
  export_completed: "書き出し完了",
  export_failed: "書き出し失敗",
  ai_operation_succeeded: "AI処理成功",
  ai_operation_failed: "AI処理失敗",
  feedback_submitted: "評価送信",
};

export default function OperationsDashboard() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await fetchMetrics();
      setMetrics(payload);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "運営指標を読み込めませんでした。",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchMetrics(controller.signal)
      .then((payload) => setMetrics(payload))
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "運営指標を読み込めませんでした。",
        );
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const maximumDailyEvents = useMemo(
    () => Math.max(1, ...(metrics?.daily.map((row) => row.events) ?? [1])),
    [metrics],
  );
  const providerUsageByOperation = useMemo(
    () => aggregateProviderUsage(metrics?.providerUsage ?? []),
    [metrics],
  );

  return (
    <main className={styles.page} id="main-content" tabIndex={-1}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>運営専用・匿名集計</p>
          <h1>サービス運営状況</h1>
          <p>直近30日を中心に、利用、品質、課金処理の状態を確認します。</p>
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "更新中…" : "最新に更新"}
          </button>
          <Link href="/internal/device-access-7k9m2p">端末登録へ</Link>
        </div>
      </header>

      {error ? (
        <section className={styles.error} role="alert">
          <strong>表示できませんでした</strong>
          <span>{error}</span>
        </section>
      ) : null}

      {!metrics && loading ? (
        <p className={styles.loading} role="status" aria-live="polite">
          運営指標を読み込んでいます…
        </p>
      ) : null}

      {metrics ? (
        <>
          <section aria-labelledby="summary-title">
            <div className={styles.sectionHeading}>
              <div>
                <h2 id="summary-title">いま確認する数字</h2>
                <p>
                  直近{metrics.windowDays}日。母数が20端末未満の間は、率ではなく件数を中心に判断します。
                </p>
              </div>
              <time dateTime={new Date(metrics.generatedAt * 1000).toISOString()}>
                更新 {formatDateTime(metrics.generatedAt)}
              </time>
            </div>
            <div className={styles.cards}>
              <MetricCard label="匿名利用端末" value={metrics.summary.uniqueActors} suffix="台" />
              <MetricCard label="プレビュー完成" value={metrics.summary.previewCompleted} suffix="件" />
              <MetricCard label="購入開始" value={metrics.summary.checkoutStarted} suffix="件" />
              <MetricCard label="書き出し完了" value={metrics.summary.exportCompleted} suffix="件" />
              <MetricCard
                label="要確認の失敗"
                value={metrics.summary.failures}
                suffix="件"
                warning={metrics.summary.failures > 0}
              />
              <MetricCard
                label="未処理Webhook"
                value={metrics.operations.pendingStripeEvents}
                suffix="件"
                warning={metrics.operations.pendingStripeEvents > 0}
              />
              <MetricCard
                label="OpenAIリクエスト"
                value={metrics.providerSummary.requestCount}
                suffix="件"
              />
              <MetricCard
                label="OpenAI失敗"
                value={metrics.providerSummary.failureCount}
                suffix="件"
                warning={metrics.providerSummary.failureCount > 0}
              />
            </div>
          </section>

          <section className={styles.grid} aria-label="運営詳細">
            <article className={styles.panel}>
              <h2>30日間の動き</h2>
              {metrics.daily.length ? (
                <div className={styles.bars} aria-label="日別イベント件数">
                  {metrics.daily.map((row) => (
                    <div className={styles.barRow} key={row.day}>
                      <time dateTime={row.day}>{shortDay(row.day)}</time>
                      <div className={styles.barTrack}>
                        <span style={{ width: `${Math.max(3, (row.events / maximumDailyEvents) * 100)}%` }} />
                      </div>
                      <strong>{row.events}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>まだ集計できるイベントがありません。</p>
              )}
            </article>

            <article className={styles.panel}>
              <h2>運用の健全性</h2>
              <dl className={styles.definitionList}>
                <MetricRow label="アカウント" value={`${metrics.operations.users}件`} />
                <MetricRow label="登録パスキー" value={`${metrics.operations.passkeys}件`} />
                <MetricRow label="有効な1回払い購入" value={`${metrics.operations.activeOneTimePurchases}件`} />
                <MetricRow label="30日間の保存完了" value={`${metrics.operations.completedSavesInWindow}件`} />
                <MetricRow label="処理中の保存予約" value={`${metrics.operations.activeReservations}件`} />
              </dl>
              <h3>有効な月額契約</h3>
              {metrics.activePlans.length ? (
                <ul className={styles.plans}>
                  {metrics.activePlans.map((row) => (
                    <li key={row.plan}>
                      <span>{planLabel(row.plan)}</span>
                      <strong>{row.subscriptions}件</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>現在、有効な月額契約はありません。</p>
              )}
            </article>
          </section>

          <section aria-labelledby="provider-usage-title">
            <article className={styles.panel}>
              <div className={styles.sectionHeading}>
                <div>
                  <h2 id="provider-usage-title">OpenAI実使用量</h2>
                  <p>
                    日次の匿名集計を処理・モデル別に合算しています。料金は最新の公式単価で確認してください。
                  </p>
                </div>
              </div>
              {providerUsageByOperation.length ? (
                <div className={styles.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th>処理</th>
                        <th>モデル</th>
                        <th>成功 / 失敗</th>
                        <th>文字トークン 入 / 出</th>
                        <th>音声トークン 入 / 出</th>
                        <th>音声秒</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providerUsageByOperation.map((row) => (
                        <tr key={`${row.provider}:${row.model}:${row.operation}`}>
                          <th scope="row">{providerOperationLabel(row.operation)}</th>
                          <td>{row.model}</td>
                          <td>{row.successCount.toLocaleString("ja-JP")} / {row.failureCount.toLocaleString("ja-JP")}</td>
                          <td>{row.inputTokens.toLocaleString("ja-JP")} / {row.outputTokens.toLocaleString("ja-JP")}</td>
                          <td>{row.inputAudioTokens.toLocaleString("ja-JP")} / {row.outputAudioTokens.toLocaleString("ja-JP")}</td>
                          <td>{row.audioSeconds.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className={styles.empty}>まだ集計できるOpenAI使用量がありません。</p>
              )}
            </article>
          </section>

          <section className={styles.grid} aria-label="イベントと評価">
            <article className={styles.panel}>
              <h2>イベント別の件数</h2>
              <div className={styles.tableWrap}>
                <table>
                  <thead><tr><th>操作</th><th>件数</th><th>匿名端末</th></tr></thead>
                  <tbody>
                    {metrics.events.map((row) => (
                      <tr key={row.eventName}>
                        <th scope="row">{EVENT_LABELS[row.eventName] ?? row.eventName}</th>
                        <td>{row.events}</td>
                        <td>{row.actors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article className={styles.panel}>
              <h2>利用者からの評価</h2>
              {metrics.feedback.length ? (
                <ul className={styles.feedback}>
                  {metrics.feedback.map((row) => (
                    <li key={`${row.rating}:${row.context}`}>
                      <span>{feedbackLabel(row.rating)}・{contextLabel(row.context)}</span>
                      <strong>{row.responses}件</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>まだ評価回答はありません。</p>
              )}
              <div className={styles.caveats}>
                <h3>読み方</h3>
                <ul>{metrics.caveats.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}

function MetricCard({ label, value, suffix, warning = false }: { label: string; value: number; suffix: string; warning?: boolean }) {
  return <article className={`${styles.metricCard} ${warning ? styles.warning : ""}`}><span>{label}</span><strong>{value.toLocaleString("ja-JP")}<small>{suffix}</small></strong></article>;
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function aggregateProviderUsage(rows: ProviderUsageRow[]) {
  const grouped = new Map<string, ProviderUsageRow>();
  for (const row of rows) {
    const key = `${row.provider}:${row.model}:${row.operation}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...row });
      continue;
    }
    grouped.set(key, {
      ...current,
      requestCount: current.requestCount + row.requestCount,
      successCount: current.successCount + row.successCount,
      failureCount: current.failureCount + row.failureCount,
      inputTokens: current.inputTokens + row.inputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      inputAudioTokens: current.inputAudioTokens + row.inputAudioTokens,
      outputAudioTokens: current.outputAudioTokens + row.outputAudioTokens,
      audioSeconds: current.audioSeconds + row.audioSeconds,
      inputCharacters: current.inputCharacters + row.inputCharacters,
      updatedAt: Math.max(current.updatedAt, row.updatedAt),
    });
  }
  return [...grouped.values()].sort(
    (left, right) =>
      right.requestCount - left.requestCount ||
      left.operation.localeCompare(right.operation),
  );
}

function providerOperationLabel(operation: string) {
  return ({
    narration_initial: "初回AI台本",
    narration_script: "AI台本",
    narration_speech: "AI音声",
    narration_partial_correction: "AI音声の部分修正",
    transcribe: "文字起こし",
    transcribe_refine: "高精度な再解析",
  } as Record<string, string>)[operation] ?? operation;
}

function formatDateTime(seconds: number) {
  return new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(seconds * 1000));
}

function shortDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function planLabel(plan: string) {
  if (plan === "starter") return "月3本プラン";
  if (plan === "standard") return "月7本プラン";
  return plan;
}

function feedbackLabel(rating: string) {
  return rating === "helpful" ? "役に立った" : "改善が必要";
}

function contextLabel(context: string) {
  return ({ preview: "プレビュー", export: "書き出し", checkout: "購入", general: "全体" } as Record<string, string>)[context] ?? context;
}

async function fetchMetrics(signal?: AbortSignal) {
  const response = await fetch("/api/operator/metrics", {
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as
    | Metrics
    | { error?: string };
  if (!response.ok || !("summary" in payload)) {
    const error = "error" in payload ? payload.error : undefined;
    throw new Error(error || "運営指標を読み込めませんでした。");
  }
  return payload;
}
