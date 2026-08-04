"use client";

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  LIGHT_MONTHLY_PRICE_JPY,
  LIGHT_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PRICE_JPY,
} from "../../lib/billing-policy";

type BillingStatus = {
  configured: boolean;
  authenticationAvailable: boolean;
  authenticated: boolean;
  billingMode: "live" | "test" | "unconfigured";
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
    email: string | null;
    fullName: string | null;
    hasStripeCustomer: boolean;
  };
  error?: string;
};

type AuthOptions<T> = { options?: T; error?: string; code?: string };

export default function AccountClient() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<
    "register" | "login" | "light" | "one_time" | "portal" | "logout" | null
  >(null);
  const checkoutStarted = useRef(false);

  async function loadStatus() {
    const response = await fetch("/api/billing/status", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json()) as BillingStatus;
    if (!response.ok) {
      throw new Error(payload.error || "利用状況を読み込めませんでした。");
    }
    setStatus(payload);
    return payload;
  }

  async function postJson<T>(path: string, body?: unknown) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string })
      | null;
    if (!response.ok || !payload) {
      throw new Error(payload?.error || "処理を完了できませんでした。");
    }
    return payload;
  }

  async function registerPasskey() {
    if (!window.PublicKeyCredential) {
      setError("このブラウザはパスキーに対応していません。SafariまたはChromeで開いてください。");
      return;
    }
    setBusy("register");
    setError("");
    try {
      await postJson<{ ready: boolean }>("/api/session/trial");
      const prepared = await postJson<
        AuthOptions<PublicKeyCredentialCreationOptionsJSON>
      >("/api/account/passkey/register/options");
      if (!prepared.options) throw new Error("登録情報を準備できませんでした。");
      const credential = await startRegistration({
        optionsJSON: prepared.options,
      });
      await postJson<{ authenticated: boolean }>(
        "/api/account/passkey/register/verify",
        credential,
      );
      setNotice("アカウントを作成しました。この端末の本人確認でログインできます。");
      await loadStatus();
    } catch (authError) {
      setError(authenticationMessage(authError, "アカウントを作成できませんでした。"));
    } finally {
      setBusy(null);
    }
  }

  async function loginPasskey() {
    if (!window.PublicKeyCredential) {
      setError("このブラウザはパスキーに対応していません。SafariまたはChromeで開いてください。");
      return;
    }
    setBusy("login");
    setError("");
    try {
      const prepared = await postJson<
        AuthOptions<PublicKeyCredentialRequestOptionsJSON>
      >("/api/account/passkey/login/options");
      if (!prepared.options) throw new Error("ログイン情報を準備できませんでした。");
      const credential = await startAuthentication({
        optionsJSON: prepared.options,
      });
      await postJson<{ authenticated: boolean }>(
        "/api/account/passkey/login/verify",
        credential,
      );
      setNotice("ログインしました。");
      await loadStatus();
    } catch (authError) {
      setError(authenticationMessage(authError, "ログインできませんでした。"));
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    setBusy("logout");
    setError("");
    try {
      await postJson<{ authenticated: boolean }>("/api/account/logout");
      setNotice("");
      await loadStatus();
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "ログアウトできませんでした。");
    } finally {
      setBusy(null);
    }
  }

  async function startCheckout(plan: "light" | "one_time") {
    setBusy(plan);
    setError("");
    try {
      const payload = await postJson<{ url: string }>("/api/billing/checkout", {
        plan,
        requestId: crypto.randomUUID(),
      });
      window.location.assign(payload.url);
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
      const payload = await postJson<{ url: string }>("/api/billing/portal");
      window.location.assign(payload.url);
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
      const query = new URLSearchParams(window.location.search);
      if (query.get("checkout") === "success") {
        setNotice("お支払いを受け付けました。利用枠への反映に数秒かかる場合があります。");
        window.history.replaceState({}, "", "/account");
      } else if (query.get("checkout") === "cancelled") {
        setNotice("お支払いはキャンセルされました。料金は発生していません。");
        window.history.replaceState({}, "", "/account");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!status?.authenticated || checkoutStarted.current) return;
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    if (checkout === "light" || checkout === "one_time") {
      checkoutStarted.current = true;
      window.history.replaceState({}, "", "/account");
      const timer = window.setTimeout(() => {
        void startCheckout(checkout);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    // Checkout is intentionally started only once after authentication.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (!status && !error) {
    return <main className="accountPage"><p className="accountLoading">利用状況を確認中…</p></main>;
  }

  if (status && !status.authenticated) {
    return (
      <main className="accountPage">
        <section className="accountSignInCard">
          <Link className="accountBrand" href="/"><span>▶</span>撮るだけリール</Link>
          <p className="eyebrow">ACCOUNT</p>
          <h1>本人確認して、利用枠とお支払いを管理</h1>
          <p>
            Face ID・Touch ID・端末の画面ロックを使うパスキー認証です。パスワードを覚える必要はありません。
          </p>
          {!status.authenticationAvailable ? (
            <p className="accountError" role="alert">アカウント認証を現在利用できません。</p>
          ) : (
            <div className="accountAuthActions">
              <button
                className="accountPrimaryAction"
                disabled={busy !== null}
                onClick={registerPasskey}
              >
                {busy === "register" ? "本人確認中…" : "はじめての方：アカウントを作る"}
              </button>
              <button
                className="accountSecondaryAction"
                disabled={busy !== null}
                onClick={loginPasskey}
              >
                {busy === "login" ? "本人確認中…" : "登録済みの方：ログイン"}
              </button>
            </div>
          )}
          {error && <p className="accountError" role="alert">{error}</p>}
          <small>
            パスキーの秘密情報は端末から送信されません。カード情報はStripeが管理します。
          </small>
          <div className="accountLegalLinks">
            <Link href="/terms">利用規約</Link>
            <Link href="/commercial-disclosure">特定商取引法に基づく表記</Link>
          </div>
          <Link className="legalBack" href="/">← 動画編集へ戻る</Link>
        </section>
      </main>
    );
  }

  const freeVideosRemaining = status?.free
    ? Math.max(0, status.free.videoLimit - status.free.videosUsed)
    : 0;
  const freeSecondsRemaining = status?.free
    ? Math.max(0, status.free.secondsLimit - status.free.secondsUsed)
    : 0;
  const displayName = status?.user?.fullName || "あなた";

  return (
    <main className="accountPage">
      <header className="accountHeader">
        <Link className="accountBrand" href="/"><span>▶</span>撮るだけリール</Link>
        <button className="accountSignOut" disabled={busy !== null} onClick={logout}>
          {busy === "logout" ? "ログアウト中…" : "ログアウト"}
        </button>
      </header>

      <section className="accountIntro">
        <div>
          <p className="eyebrow">MY ACCOUNT</p>
          <h1>{displayName}の利用状況</h1>
          {status?.user?.email && <p>{status.user.email}</p>}
        </div>
        <Link className="accountSecondaryAction" href="/">動画を作る</Link>
      </section>

      {notice && <div className="accountNotice" role="status">{notice}</div>}
      {status?.billingMode === "test" && (
        <div className="accountNotice">
          現在はStripeのテスト決済です。実際の請求は発生しません。
        </div>
      )}
      {status && !status.configured && (
        <div className="accountNotice">
          決済設定が未完了のため、現在は購入できません。
        </div>
      )}

      {status && (
        <>
          <section className="accountUsageGrid">
            <article>
              <p>現在のプラン</p>
              <strong>{status.monthly?.active ? `月${LIGHT_MONTHLY_VIDEO_LIMIT}本プラン` : "無料体験"}</strong>
              <span>
                {status.monthly?.active
                  ? `${status.monthly.videosUsed} / ${status.monthly.videoLimit}本 使用`
                  : `残り${freeVideosRemaining}本・${Math.floor(freeSecondsRemaining / 60)}分${freeSecondsRemaining % 60}秒`}
              </span>
            </article>
            <article>
              <p>購入済みの作成枠</p>
              <strong>{status.oneTimeCredits ?? 0}本</strong>
              <span>期限なしで利用できます</span>
            </article>
            <article>
              <p>次回更新</p>
              <strong>
                {status.monthly?.renewsAt
                  ? new Date(status.monthly.renewsAt * 1000).toLocaleDateString("ja-JP")
                  : "—"}
              </strong>
              <span>{status.monthly?.cancelAtPeriodEnd ? "期間終了後に解約" : "月額プラン利用時に表示"}</span>
            </article>
          </section>

          <section className="accountPlans">
            <article className="featured">
              <p>LIGHT</p>
              <h2>月{LIGHT_MONTHLY_VIDEO_LIMIT}本プラン</h2>
              <strong>¥{LIGHT_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")} / 月</strong>
              <button
                disabled={busy !== null || !status.configured || status.monthly?.active}
                onClick={() => startCheckout("light")}
              >
                {status.monthly?.active ? "利用中" : busy === "light" ? "準備中…" : `月${LIGHT_MONTHLY_VIDEO_LIMIT}本プランを始める`}
              </button>
            </article>
            <article>
              <p>ONE TIME</p>
              <h2>1動画作成</h2>
              <strong>¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}</strong>
              <button
                disabled={busy !== null || !status.configured}
                onClick={() => startCheckout("one_time")}
              >
                {busy === "one_time" ? "準備中…" : "1動画作成を購入する"}
              </button>
            </article>
          </section>

          {status.user?.hasStripeCustomer && (
            <button className="accountPortalButton" disabled={busy !== null} onClick={openPortal}>
              {busy === "portal" ? "開いています…" : "支払い方法・解約を管理"}
            </button>
          )}
        </>
      )}

      {error && <p className="accountError" role="alert">{error}</p>}
      <p className="accountSecurity">
        カード番号はStripeが安全に管理し、撮るだけリールのデータベースには保存しません。
      </p>
      <div className="accountLegalLinks">
        <Link href="/terms">利用規約</Link>
        <Link href="/privacy">プライバシーポリシー</Link>
        <Link href="/commercial-disclosure">特定商取引法に基づく表記</Link>
      </div>
    </main>
  );
}

function authenticationMessage(error: unknown, fallback: string) {
  if (error instanceof DOMException && ["NotAllowedError", "AbortError"].includes(error.name)) {
    return "本人確認がキャンセルされました。もう一度お試しください。";
  }
  return error instanceof Error ? error.message : fallback;
}
