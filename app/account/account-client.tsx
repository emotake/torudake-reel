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
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PRICE_JPY,
  type MonthlyPlanKey,
} from "../../lib/billing-policy";

type CheckoutPlan = "starter" | "standard" | "one_time";

type BillingStatus = {
  configured: boolean;
  authenticationAvailable: boolean;
  authenticated: boolean;
  billingMode: "live" | "test" | "unconfigured";
  plan?: "free" | MonthlyPlanKey;
  free?: {
    videosUsed: number;
    videoLimit: number;
    secondsUsed: number;
    secondsLimit: number;
  };
  monthly?: {
    active: boolean;
    accessRevoked: boolean;
    planKey: MonthlyPlanKey | null;
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

const ACCOUNT_AUTH_HINT_STORAGE_KEY = "torudake-account-authenticated";
const CHECKOUT_STATUS_POLL_ATTEMPTS = 8;
const CHECKOUT_STATUS_POLL_INTERVAL_MS = 1_500;

function checkoutReflected(
  status: BillingStatus,
  plan: CheckoutPlan | null,
  oneTimeCreditsBefore: number | null,
) {
  if (plan === "starter" || plan === "standard") {
    return (
      status.monthly?.active === true && status.monthly.planKey === plan
    );
  }
  if (plan === "one_time") {
    return (
      (status.oneTimeCredits ?? 0) >
      (oneTimeCreditsBefore ?? 0)
    );
  }
  return false;
}

function activeMonthlyPlanLabel(status: BillingStatus) {
  const planKey = status.monthly?.planKey ?? status.plan;
  switch (planKey) {
    case "starter":
      return `Starter・月${STARTER_MONTHLY_VIDEO_LIMIT}本`;
    case "standard":
      return `Standard・月${STANDARD_MONTHLY_VIDEO_LIMIT}本`;
    case "legacy_1480":
      return "旧月8本プラン（既存契約）";
    default:
      return status.monthly?.active
        ? `月${status.monthly.videoLimit}本プラン`
        : "無料体験";
  }
}

export default function AccountClient() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<
    | "register"
    | "login"
    | CheckoutPlan
    | "portal"
    | "logout"
    | null
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
    if (payload.authenticated) {
      window.localStorage.setItem(ACCOUNT_AUTH_HINT_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(ACCOUNT_AUTH_HINT_STORAGE_KEY);
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

  async function startCheckout(plan: CheckoutPlan) {
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
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams(window.location.search);
      const checkout = query.get("checkout");
      const rawPlan = query.get("plan");
      const checkoutPlan =
        rawPlan === "starter" ||
        rawPlan === "standard" ||
        rawPlan === "one_time"
          ? rawPlan
          : null;
      const rawCreditsBefore = query.get("credits_before");
      const parsedCreditsBefore = Number(rawCreditsBefore);
      const oneTimeCreditsBefore =
        rawCreditsBefore !== null &&
        Number.isInteger(parsedCreditsBefore) &&
        parsedCreditsBefore >= 0
          ? parsedCreditsBefore
          : null;
      if (checkout === "success") {
        setNotice("お支払いを受け付けました。利用枠への反映を確認しています…");
        window.history.replaceState({}, "", "/account");
      } else if (checkout === "cancelled") {
        setNotice("お支払いはキャンセルされました。料金は発生していません。");
        window.history.replaceState({}, "", "/account");
      }

      void (async () => {
        try {
          if (checkout !== "success") {
            await loadStatus();
            return;
          }
          let reflected = false;
          for (
            let attempt = 0;
            attempt < CHECKOUT_STATUS_POLL_ATTEMPTS;
            attempt += 1
          ) {
            const latest = await loadStatus();
            reflected = checkoutReflected(
              latest,
              checkoutPlan,
              oneTimeCreditsBefore,
            );
            if ((attempt >= 1 && reflected) || cancelled) break;
            await new Promise((resolve) =>
              window.setTimeout(resolve, CHECKOUT_STATUS_POLL_INTERVAL_MS),
            );
          }
          if (!cancelled) {
            setNotice(
              reflected
                ? "お支払いが利用枠へ反映されました。"
                : "お支払いを受け付けました。反映に時間がかかっている場合は、少し待って再読み込みしてください。",
            );
          }
        } catch (loadError) {
          if (!cancelled) {
            setError(
              loadError instanceof Error
                ? loadError.message
                : "利用状況を読み込めませんでした。",
            );
          }
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!status?.authenticated || checkoutStarted.current) return;
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    if (
      checkout === "starter" ||
      checkout === "standard" ||
      checkout === "one_time"
    ) {
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
          <p className="accountRecoveryHelp">
            有料プランをご利用中で、端末変更・紛失によりログインできない場合は、
            <a
              href={`mailto:torudake.reel@gmail.com?subject=${encodeURIComponent("撮るだけリール アカウント復旧・解約の相談")}`}
            >
              運営へ復旧・解約を相談
            </a>
            してください。
          </p>
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
      {status?.monthly?.accessRevoked && (
        <div className="accountNotice" role="alert">
          返金または支払い異議により今月の利用枠は停止中です。「支払い方法・解約を管理」から契約状況をご確認ください。
        </div>
      )}

      {status && (
        <>
          <section className="accountUsageGrid">
            <article>
              <p>現在のプラン</p>
              <strong>{activeMonthlyPlanLabel(status)}</strong>
              <span>
                {status.monthly?.active
                  ? `${status.monthly.videosUsed} / ${status.monthly.videoLimit}本 使用・AI処理は1動画あたり10回`
                  : `残り${freeVideosRemaining}本・${Math.floor(freeSecondsRemaining / 60)}分${freeSecondsRemaining % 60}秒・AI処理は1動画あたり3回`}
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

          <section className="accountPlans" aria-labelledby="accountPlansTitle">
            <header className="accountPlansIntro">
              <p className="eyebrow">SAVE PLAN</p>
              <h2 id="accountPlansTitle">保存するペースで選ぶ</h2>
              <p>どのプランも編集とプレビューは同じ。違いは毎月保存できる本数です。</p>
            </header>
            <article className="accountPlanCard standardPlan featured">
              <span className="accountPlanRecommend">おすすめ</span>
              <span className="accountPlanFit">継続して投稿したい方</span>
              <p>STANDARD</p>
              <h2>スタンダード</h2>
              <strong>
                ¥{STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
                <small> / 月</small>
              </strong>
              <span className="accountPlanUnit">1本あたり125円</span>
              <ul>
                <li>毎月{STANDARD_MONTHLY_VIDEO_LIMIT}本まで保存</li>
                <li>AI処理は1動画あたり10回</li>
                <li>Starterより1本あたり約42円お得</li>
              </ul>
              <button
                disabled={busy !== null || !status.configured || status.monthly?.active}
                onClick={() => startCheckout("standard")}
              >
                {status.monthly?.active
                  ? status.monthly.planKey === "standard"
                    ? "利用中"
                    : "変更は支払い管理から"
                  : busy === "standard"
                    ? "準備中…"
                    : "Standardを始める"}
              </button>
            </article>
            <article className="accountPlanCard starterPlan">
              <span className="accountPlanFit">月3本から始めたい方</span>
              <p>STARTER</p>
              <h2>スターター</h2>
              <strong>
                ¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
                <small> / 月</small>
              </strong>
              <span className="accountPlanUnit">1本あたり約167円</span>
              <ul>
                <li>毎月{STARTER_MONTHLY_VIDEO_LIMIT}本まで保存</li>
                <li>AI処理は1動画あたり10回</li>
                <li>いつでも解約可能</li>
              </ul>
              <button
                disabled={busy !== null || !status.configured || status.monthly?.active}
                onClick={() => startCheckout("starter")}
              >
                {status.monthly?.active
                  ? status.monthly.planKey === "starter"
                    ? "利用中"
                    : "変更は支払い管理から"
                  : busy === "starter"
                    ? "準備中…"
                    : "Starterを始める"}
              </button>
            </article>
            <article className="accountPlanCard oneTimePlan">
              <span className="accountPlanFit">必要なときだけ保存</span>
              <p>ONE TIME</p>
              <h2>1動画作成</h2>
              <strong>¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}</strong>
              <span className="accountPlanUnit">月額料金なし・有効期限なし</span>
              <ul>
                <li>完成動画を1本保存</li>
                <li>AI処理はこの動画で5回</li>
                <li>自動更新なし</li>
              </ul>
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
      <p className="accountSecurity">
        動画・AIナレーションは編集結果が完成した時点、写真リールは書き出し成功時点で1本分を使用します。
      </p>
      <p className="accountSecurity">
        AI処理には、文字起こし、高精度再解析、AI台本の生成、AI音声の生成が含まれます。初回ナレーションは台本完成時に1回分を使用し、続く初回音声と内部の自動調整では追加回数を使用しません。作成後の再生成などは正常に完了するごとに1回分を使用し、上限は1動画あたり無料体験3回、1動画作成5回、月額プラン10回です。
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
