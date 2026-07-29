"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type BillingStatus = {
  configured: boolean;
  authenticated: boolean;
  plan?: "free" | "light";
  free?: {
    videosUsed: number;
    videoLimit: number;
    secondsUsed: number;
    secondsLimit: number;
  };
  monthly?: {
    active: boolean;
    videosUsed: number;
    videoLimit: number;
    renewsAt: number | null;
    cancelAtPeriodEnd: boolean;
  };
  oneTimeCredits?: number;
  user?: {
    hasStripeCustomer: boolean;
  };
  error?: string;
};

export default function AccountClient({
  displayName,
  email,
  signOutPath,
}: {
  displayName: string;
  email: string;
  signOutPath: string;
}) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"light" | "one_time" | "portal" | null>(
    null,
  );
  const checkoutStarted = useRef(false);

  async function loadStatus() {
    const response = await fetch("/api/billing/status", { cache: "no-store" });
    const payload = (await response.json()) as BillingStatus;
    if (!response.ok) throw new Error(payload.error || "利用状況を読み込めませんでした。");
    setStatus(payload);
    return payload;
  }

  async function startCheckout(plan: "light" | "one_time") {
    setBusy(plan);
    setError("");
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          requestId: crypto.randomUUID(),
        }),
      });
      const payload = (await response.json()) as {
        url?: string;
        error?: string;
      };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "決済画面を開けませんでした。");
      }
      window.location.href = payload.url;
    } catch (checkoutError) {
      setError(
        checkoutError instanceof Error
          ? checkoutError.message
          : "決済画面を開けませんでした。",
      );
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    setError("");
    try {
      const response = await fetch("/api/billing/portal", { method: "POST" });
      const payload = (await response.json()) as {
        url?: string;
        error?: string;
      };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "決済管理画面を開けませんでした。");
      }
      window.location.href = payload.url;
    } catch (portalError) {
      setError(
        portalError instanceof Error
          ? portalError.message
          : "決済管理画面を開けませんでした。",
      );
      setBusy(null);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStatus().catch((loadError) => {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "利用状況を読み込めませんでした。",
        );
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!status || checkoutStarted.current) return;
    const checkout = new URLSearchParams(window.location.search).get(
      "checkout",
    );
    if (checkout === "light" || checkout === "one_time") {
      checkoutStarted.current = true;
      window.history.replaceState({}, "", "/account");
      const timer = window.setTimeout(() => {
        void startCheckout(checkout);
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [status]);

  const freeVideosRemaining = status?.free
    ? Math.max(0, status.free.videoLimit - status.free.videosUsed)
    : 0;
  const freeSecondsRemaining = status?.free
    ? Math.max(0, status.free.secondsLimit - status.free.secondsUsed)
    : 0;

  return (
    <main className="accountPage">
      <header className="accountHeader">
        <Link className="accountBrand" href="/">
          <span>▶</span>
          撮るだけリール
        </Link>
        <a className="accountSignOut" href={signOutPath}>
          ログアウト
        </a>
      </header>

      <section className="accountIntro">
        <div>
          <p className="eyebrow">MY ACCOUNT</p>
          <h1>{displayName}さんの利用状況</h1>
          <p>{email}</p>
        </div>
        <Link className="accountSecondaryAction" href="/">
          動画を作る
        </Link>
      </section>

      {!status && !error && <p className="accountLoading">利用状況を確認中…</p>}

      {status && (
        <>
          {!status.configured && (
            <div className="accountNotice">
              決済コードは実装済みです。Stripeのテスト用設定を接続すると、購入テストを開始できます。
            </div>
          )}

          <section className="accountUsageGrid">
            <article>
              <p>現在のプラン</p>
              <strong>{status.monthly?.active ? "月5本プラン" : "無料体験"}</strong>
              <span>
                {status.monthly?.active
                  ? `${status.monthly.videosUsed} / ${status.monthly.videoLimit}本 使用`
                  : `残り${freeVideosRemaining}本・${Math.floor(freeSecondsRemaining / 60)}分${freeSecondsRemaining % 60}秒`}
              </span>
            </article>
            <article>
              <p>1本購入の残り</p>
              <strong>{status.oneTimeCredits ?? 0}本</strong>
              <span>期限なしで利用できます</span>
            </article>
            <article>
              <p>次回更新</p>
              <strong>
                {status.monthly?.renewsAt
                  ? new Date(status.monthly.renewsAt * 1000).toLocaleDateString(
                      "ja-JP",
                    )
                  : "—"}
              </strong>
              <span>
                {status.monthly?.cancelAtPeriodEnd
                  ? "期間終了後に解約"
                  : "月額プラン利用時に表示"}
              </span>
            </article>
          </section>

          <section className="accountPlans">
            <article className="featured">
              <p>LIGHT</p>
              <h2>月5本プラン</h2>
              <strong>¥1,480 / 月</strong>
              <button
                disabled={busy !== null || status.monthly?.active}
                onClick={() => startCheckout("light")}
              >
                {status.monthly?.active
                  ? "利用中"
                  : busy === "light"
                    ? "準備中…"
                    : "月5本プランを始める"}
              </button>
            </article>
            <article>
              <p>ONE TIME</p>
              <h2>1本だけ</h2>
              <strong>¥480</strong>
              <button
                disabled={busy !== null}
                onClick={() => startCheckout("one_time")}
              >
                {busy === "one_time" ? "準備中…" : "1本購入する"}
              </button>
            </article>
          </section>

          {status.user?.hasStripeCustomer && (
            <button
              className="accountPortalButton"
              disabled={busy !== null}
              onClick={openPortal}
            >
              {busy === "portal" ? "開いています…" : "支払い方法・解約を管理"}
            </button>
          )}
        </>
      )}

      {error && (
        <p className="accountError" role="alert">
          {error}
        </p>
      )}

      <p className="accountSecurity">
        カード番号はStripeが安全に管理し、撮るだけリールのデータベースには保存しません。
      </p>
    </main>
  );
}
