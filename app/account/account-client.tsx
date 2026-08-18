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
import AuthenticationGate from "../authentication-gate";
import {
  MONTHLY_FIRST_OFFER_VERSION,
  MonthlyFirstPurchaseOptions,
  OneTimeRescue,
} from "../monthly-first-purchase";
import { trackClientEvent } from "../../lib/client-analytics";
import {
  FREE_SECONDS_LIMIT,
  FREE_VIDEO_LIMIT,
  monthlyVideoAllowanceLabel,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
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

type AccountAuthenticationMethods = {
  passkey: boolean;
  line: boolean;
  google: boolean;
  email: boolean;
};

type AccountAuthenticationState = AccountAuthenticationMethods & {
  authenticated: boolean;
  recentlyAuthenticated: boolean;
  accountMethods: AccountAuthenticationMethods;
};

type AccountPasskey = {
  id: string;
  displayName: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

type BillingDocument = {
  id: string;
  kind: "receipt" | "invoice";
  label: string;
  createdAt: number;
  amount: number;
  amountRefunded: number;
  currency: string;
  status: string;
  url: string;
};

type AccountDeletion = {
  status: "scheduled" | "processing";
  requestedAt: number;
  executeAfter: number;
};

const ACCOUNT_AUTH_HINT_STORAGE_KEY = "torudake-account-authenticated";
const CHECKOUT_STATUS_POLL_ATTEMPTS = 8;
const CHECKOUT_STATUS_POLL_INTERVAL_MS = 1_500;
const ACCOUNT_AUTH_ERROR_MESSAGES: Record<string, string> = {
  "cancelled": "LINEログインをキャンセルしました。料金は発生していません。",
  "expired": "LINEログインの有効時間が切れました。もう一度お試しください。",
  "failed": "LINEログインを完了できませんでした。もう一度お試しください。",
  "identity_already_linked":
    "このLINEアカウントは別のアカウントに連携されています。",
  "account_unavailable":
    "このアカウントではログインを続けられません。サポートへお問い合わせください。",
  "account_changed":
    "ログイン中のアカウントが変わりました。最初からやり直してください。",
  "already_authenticated": "すでにログインしています。",
};

function checkoutPlanDetails(plan: CheckoutPlan | null) {
  switch (plan) {
    case "starter":
      return {
        name: STARTER_MONTHLY_PLAN_LABEL,
        price: `¥${STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月（税込）`,
        renewal: "解約するまで1か月ごとに自動更新",
      };
    case "standard":
      return {
        name: STANDARD_MONTHLY_PLAN_LABEL,
        price: `¥${STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月（税込）`,
        renewal: "解約するまで1か月ごとに自動更新",
      };
    case "one_time":
      return {
        name: "動画1本プラン",
        price: `¥${ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")} / 1本・税込`,
        renewal: "1回払い・自動更新なし",
      };
    default:
      return null;
  }
}

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
      return STARTER_MONTHLY_PLAN_LABEL;
    case "standard":
      return STANDARD_MONTHLY_PLAN_LABEL;
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
  const [authenticationMethods, setAuthenticationMethods] =
    useState<AccountAuthenticationState | null>(null);
  const [pendingCheckoutPlan, setPendingCheckoutPlan] =
    useState<CheckoutPlan | null>(null);
  const [passkeys, setPasskeys] = useState<AccountPasskey[]>([]);
  const [passkeyNames, setPasskeyNames] = useState<Record<string, string>>({});
  const [newPasskeyName, setNewPasskeyName] = useState("この端末");
  const [billingDocuments, setBillingDocuments] = useState<BillingDocument[]>([]);
  const [accountDeletion, setAccountDeletion] =
    useState<AccountDeletion | null>(null);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryReference, setRecoveryReference] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accountAuthOpen, setAccountAuthOpen] = useState(false);
  const [accountReauthenticationOpen, setAccountReauthenticationOpen] =
    useState(false);
  const [busy, setBusy] = useState<
    | "register"
    | "login"
    | CheckoutPlan
    | "portal"
    | "passkey_update"
    | "passkey_delete"
    | "revoke_sessions"
    | "recovery"
    | "delete_account"
    | "cancel_deletion"
    | "logout"
    | null
  >(null);
  const checkoutStarted = useRef(false);
  const reauthenticationRequest = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

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

  async function loadAuthenticationMethods() {
    const response = await fetch("/api/account/auth/methods", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as
      | (AccountAuthenticationState & { error?: string })
      | null;
    if (!response.ok || !payload) {
      throw new Error(payload?.error || "ログイン方法を確認できませんでした。");
    }
    setAuthenticationMethods(payload);
    return payload;
  }

  async function loadPasskeys() {
    const response = await fetch("/api/account/passkeys", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as
      | { passkeys?: AccountPasskey[]; error?: string }
      | null;
    if (!response.ok || !payload?.passkeys) {
      throw new Error(payload?.error || "パスキーを読み込めませんでした。");
    }
    setPasskeys(payload.passkeys);
    setPasskeyNames(
      Object.fromEntries(
        payload.passkeys.map((passkey) => [passkey.id, passkey.displayName]),
      ),
    );
  }

  async function loadBillingDocuments() {
    const response = await fetch("/api/billing/portal", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as
      | { documents?: BillingDocument[]; error?: string }
      | null;
    if (!response.ok || !payload?.documents) {
      throw new Error(payload?.error || "領収書・請求書を読み込めませんでした。");
    }
    setBillingDocuments(payload.documents);
  }

  async function loadAccountDeletion() {
    const response = await fetch("/api/account/deletion", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = (await response.json().catch(() => null)) as
      | { deletion?: AccountDeletion | null; error?: string }
      | null;
    if (!response.ok || !payload || !("deletion" in payload)) {
      throw new Error(payload?.error || "削除予約の状況を読み込めませんでした。");
    }
    setAccountDeletion(payload.deletion ?? null);
  }

  async function mutationJson<T>(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body?: unknown,
  ) {
    const response = await fetch(path, {
      method,
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

  async function postJson<T>(path: string, body?: unknown) {
    return mutationJson<T>(path, "POST", body);
  }

  async function registerPasskey() {
    if (!window.PublicKeyCredential) {
      setError("このブラウザはパスキーに対応していません。SafariまたはChromeで開いてください。");
      return;
    }
    setBusy("register");
    setError("");
    const addingBackupPasskey = passkeys.length > 0;
    try {
      if (status?.authenticated !== true) {
        throw new Error(
          "パスキーを追加するには、先にLINEでログインしてください。",
        );
      }
      await reauthenticate();
      const prepared = await postJson<
        AuthOptions<PublicKeyCredentialCreationOptionsJSON>
      >("/api/account/passkey/register/options");
      if (!prepared.options) throw new Error("登録情報を準備できませんでした。");
      const credential = await startRegistration({
        optionsJSON: prepared.options,
      });
      await postJson<{ authenticated: boolean }>(
        "/api/account/passkey/register/verify",
        { credential, displayName: newPasskeyName },
      );
      setNotice(
        addingBackupPasskey
          ? "予備のパスキーを追加しました。端末を変更したときのログインにも利用できます。"
          : "パスキーを追加しました。今後の本人確認とログインにも利用できます。",
      );
      await loadStatus();
      await loadPasskeys();
    } catch (authError) {
      setError(
        authenticationMessage(
          authError,
          addingBackupPasskey
            ? "予備のパスキーを追加できませんでした。"
            : "パスキーを追加できませんでした。",
        ),
      );
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

  function reauthenticate() {
    if (reauthenticationRequest.current) {
      return reauthenticationRequest.current.promise;
    }
    let resolveRequest!: () => void;
    let rejectRequest!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    reauthenticationRequest.current = {
      promise,
      resolve: resolveRequest,
      reject: rejectRequest,
    };
    setAccountReauthenticationOpen(true);
    return promise;
  }

  function completeReauthentication() {
    const pending = reauthenticationRequest.current;
    reauthenticationRequest.current = null;
    setAccountReauthenticationOpen(false);
    pending?.resolve();
    void loadStatus().catch(() => undefined);
  }

  function cancelReauthentication() {
    const pending = reauthenticationRequest.current;
    reauthenticationRequest.current = null;
    setAccountReauthenticationOpen(false);
    pending?.reject(new Error("本人確認をキャンセルしました。"));
  }

  async function renamePasskey(passkey: AccountPasskey) {
    const nextName = passkeyNames[passkey.id] ?? passkey.displayName;
    if (nextName === passkey.displayName) return;
    setBusy("passkey_update");
    setError("");
    try {
      await mutationJson<{ updated: boolean }>(
        "/api/account/passkeys",
        "PATCH",
        {
          id: passkey.id,
          displayName: nextName,
        },
      );
      setNotice("パスキーの端末名を更新しました。");
      await loadPasskeys();
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "端末名を更新できませんでした。",
      );
    } finally {
      setBusy(null);
    }
  }

  async function deletePasskey(passkey: AccountPasskey) {
    if (
      !window.confirm(
        `「${passkey.displayName}」を削除しますか？ 削除後、このパスキーではログインできません。`,
      )
    ) {
      return;
    }
    setBusy("passkey_delete");
    setError("");
    try {
      await reauthenticate();
      await mutationJson<{ deleted: boolean }>(
        "/api/account/passkeys",
        "DELETE",
        { id: passkey.id },
      );
      setNotice("パスキーを削除し、ほかの端末のログイン状態を解除しました。");
      await loadPasskeys();
    } catch (deleteError) {
      setError(authenticationMessage(deleteError, "パスキーを削除できませんでした。"));
    } finally {
      setBusy(null);
    }
  }

  async function revokeAllSessions() {
    if (
      !window.confirm(
        "すべての端末をログアウトしますか？ この操作後は、この端末でも再ログインが必要です。",
      )
    ) {
      return;
    }
    setBusy("revoke_sessions");
    setError("");
    try {
      await reauthenticate();
      const response = await fetch("/api/account/sessions", {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "ログイン状態を解除できませんでした。");
      }
      window.localStorage.removeItem(ACCOUNT_AUTH_HINT_STORAGE_KEY);
      setNotice("");
      await loadStatus();
    } catch (sessionError) {
      setError(authenticationMessage(sessionError, "ログイン状態を解除できませんでした。"));
    } finally {
      setBusy(null);
    }
  }

  async function requestRecovery() {
    setBusy("recovery");
    setError("");
    setRecoveryReference("");
    try {
      const payload = await postJson<{ accepted: boolean; reference: string }>(
        "/api/account/recovery",
        { billingEmail: recoveryEmail },
      );
      setRecoveryReference(payload.reference);
    } catch (recoveryError) {
      setError(
        recoveryError instanceof Error
          ? recoveryError.message
          : "復旧相談を受け付けられませんでした。",
      );
    } finally {
      setBusy(null);
    }
  }

  async function scheduleAccountDeletion() {
    const remainingCredits = status?.oneTimeCredits ?? 0;
    if (
      !window.confirm(
        `アカウント削除を予約しますか？ 即時には削除されず、30日間は取り消せます。${remainingCredits > 0 ? `動画1本プランの保存枠が${remainingCredits}本残っており、削除後は利用できません。` : ""}月額プランが有効な場合は先に自動更新の解約が必要です。`,
      )
    ) {
      return;
    }
    setBusy("delete_account");
    setError("");
    try {
      await reauthenticate();
      const payload = await postJson<{
        scheduled: boolean;
        requestedAt: number;
        executeAfter: number;
      }>("/api/account/deletion", {
        confirmDeletion: true,
        confirmUnusedCredits: remainingCredits > 0,
      });
      setAccountDeletion({
        status: "scheduled",
        requestedAt: payload.requestedAt,
        executeAfter: payload.executeAfter,
      });
      setNotice("アカウント削除を予約しました。30日間はこの画面から取り消せます。");
    } catch (deletionError) {
      setError(
        authenticationMessage(
          deletionError,
          "アカウント削除を予約できませんでした。",
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function cancelAccountDeletion() {
    setBusy("cancel_deletion");
    setError("");
    try {
      const response = await fetch("/api/account/deletion", {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "削除予約を取り消せませんでした。");
      }
      setAccountDeletion(null);
      setNotice("アカウント削除の予約を取り消しました。");
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : "削除予約を取り消せませんでした。",
      );
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

  function beginCheckoutFromAccount(plan: CheckoutPlan) {
    trackClientEvent("checkout_started", {
      plan,
      source: "account",
      offer_version: MONTHLY_FIRST_OFFER_VERSION,
    });
    void startCheckout(plan);
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
      const currentUrl = new URL(window.location.href);
      const query = currentUrl.searchParams;
      const authErrorValues = query.getAll("auth_error");
      const authErrorCode =
        authErrorValues.length === 0
          ? null
          : authErrorValues.length === 1
            ? query.get("auth_error")
            : "failed";
      const authErrorMessage = authErrorCode !== null
        ? (ACCOUNT_AUTH_ERROR_MESSAGES[authErrorCode] ??
          "LINEログインを完了できませんでした。もう一度お試しください。")
        : null;
      const authErrorIsNotice =
        authErrorCode === "cancelled" || authErrorCode === "already_authenticated";
      const authResult = query.get("auth_result");
      const authResultMessage =
        authResult === "reauthenticated"
          ? "本人確認が完了しました。安全のため、操作をもう一度実行してください。"
          : authResult === "authenticated"
            ? "LINEログインが完了しました。"
            : null;
      if (query.has("auth_error") || query.has("auth_result")) {
        query.delete("auth_error");
        query.delete("auth_result");
        const cleanedSearch = query.toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${cleanedSearch ? `?${cleanedSearch}` : ""}${window.location.hash}`,
        );
      }
      const showAuthReturnFeedback = () => {
        if (authErrorMessage) {
          if (authErrorIsNotice) setNotice(authErrorMessage);
          else setError(authErrorMessage);
        } else if (authResultMessage) {
          setNotice(authResultMessage);
        }
      };
      const checkout = query.get("checkout");
      const rawPlan = query.get("plan");
      const checkoutPlan =
        rawPlan === "starter" ||
        rawPlan === "standard" ||
        rawPlan === "one_time"
          ? rawPlan
          : null;
      const requestedPlan =
        checkout === "starter" ||
        checkout === "standard" ||
        checkout === "one_time"
          ? checkout
          : null;
      setPendingCheckoutPlan(requestedPlan);
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
          try {
            await loadAuthenticationMethods();
          } catch {
            // Fail closed: unavailable feature flags must not expose a
            // Passkey action that will be rejected by the server.
            setAuthenticationMethods(null);
          }
          if (checkout !== "success") {
            await loadStatus();
            if (!cancelled) showAuthReturnFeedback();
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
    if (!status?.authenticated) return;
    let cancelled = false;
    void (async () => {
      try {
        if (authenticationMethods?.passkey) {
          await loadPasskeys();
        } else {
          setPasskeys([]);
          setPasskeyNames({});
        }
        await loadAccountDeletion();
        if (status.user?.hasStripeCustomer) {
          await loadBillingDocuments();
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "アカウントの安全情報を読み込めませんでした。",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    authenticationMethods?.passkey,
    status?.authenticated,
    status?.user?.hasStripeCustomer,
  ]);

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
    const selectedPlan = checkoutPlanDetails(pendingCheckoutPlan);
    return (
      <main className="accountPage">
        <section className="accountSignInCard">
          <Link className="accountBrand" href="/"><span>▶</span>撮るだけリール</Link>
          <p className="eyebrow">ACCOUNT</p>
          <h1>本人確認して、利用枠とお支払いを管理</h1>
          <p>
            LINEでアカウントを作成またはログインできます。
            {authenticationMethods?.passkey
              ? "登録済みのパスキーでもログインできます。"
              : ""}
            プロフィール入力やパスワード登録は不要です。
          </p>
          {selectedPlan && (
            <article className="accountNotice accountSelectedPlan" aria-label="選択中の料金プラン">
              <p>選択中のプラン</p>
              <h2>{selectedPlan.name}</h2>
              <strong>{selectedPlan.price}</strong>
              <span>{selectedPlan.renewal}</span>
              <small>
                ここではまだ決済されません。ログインしたあと、Stripeの決済画面を開きます。
              </small>
            </article>
          )}
          {!status.authenticationAvailable ? (
            <p className="accountError" role="alert">アカウント認証を現在利用できません。</p>
          ) : (
            <div className="accountAuthActions">
              <button
                className="accountPrimaryAction"
                disabled={busy !== null}
                aria-haspopup="dialog"
                onClick={() => setAccountAuthOpen(true)}
              >
                ログインへ進む
              </button>
              {authenticationMethods?.passkey ? (
                <details className="accountRecoveryHelp">
                  <summary>登録済みパスキーを使う</summary>
                  <button
                    className="accountSecondaryAction"
                    disabled={busy !== null}
                    onClick={loginPasskey}
                  >
                    {busy === "login" ? "本人確認中…" : "登録済みパスキーでログイン"}
                  </button>
                </details>
              ) : null}
            </div>
          )}
          {error && <p className="accountError" role="alert">{error}</p>}
          {notice && <p className="accountNotice" role="status">{notice}</p>}
          <small>
            LINEへの投稿やLINE公式アカウントの友だち追加は行いません。カード情報はStripeが管理します。
          </small>
          <AuthenticationGate
            open={accountAuthOpen}
            reason={pendingCheckoutPlan ? "billing" : "account"}
            onClose={() => setAccountAuthOpen(false)}
            onAuthenticated={async () => {
              setAccountAuthOpen(false);
              await loadStatus();
            }}
          />
          <p className="accountRecoveryHelp">
            有料プランをご利用中で、端末変更・紛失によりログインできない場合は、
            <Link href="/support">
              運営へ復旧・解約を相談
            </Link>
            してください。
          </p>
          {authenticationMethods?.passkey ? (
            <details className="accountRecoveryHelp">
              <summary>パスキーをすべて失い、ログインできない場合</summary>
              <p>
                決済時のメールアドレスから復旧・解約の相談を受け付けます。ここでログイン権限が自動発行されることはありません。
              </p>
              <label className="accountField">
                決済時のメールアドレス
                <input
                  className="accountTextField"
                  type="email"
                  value={recoveryEmail}
                  autoComplete="email"
                  onChange={(event) => setRecoveryEmail(event.target.value)}
                />
              </label>
              <button
                className="accountSecondaryAction"
                disabled={busy !== null || !recoveryEmail.trim()}
                onClick={requestRecovery}
              >
                {busy === "recovery" ? "受付中…" : "復旧・解約の相談を受け付ける"}
              </button>
              {recoveryReference && (
                <p role="status">
                  受付番号：<strong>{recoveryReference}</strong><br />
                  <Link href={`/support?recovery=${encodeURIComponent(recoveryReference)}`}>
                    受付番号を添えて運営へ連絡する
                  </Link>
                </p>
              )}
            </details>
          ) : null}
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
      <AuthenticationGate
        open={accountReauthenticationOpen}
        mode="reauthenticate"
        reason="account"
        onClose={cancelReauthentication}
        onAuthenticated={completeReauthentication}
      />
      <header className="accountHeader">
        <Link className="accountBrand" href="/"><span>▶</span>撮るだけリール</Link>
        <div className="accountHeaderActions">
          <button className="accountSignOut" disabled={busy !== null} onClick={logout}>
            {busy === "logout" ? "ログアウト中…" : "ログアウト"}
          </button>
        </div>
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
          <section className="accountUsageGrid" aria-label="利用状況の概要">
            <article>
              <p>現在のプラン</p>
              <strong>{activeMonthlyPlanLabel(status)}</strong>
              <span>
                {status.monthly?.active
                  ? `今月${status.monthly.videosUsed}本保存済み・あと${Math.max(0, status.monthly.videoLimit - status.monthly.videosUsed)}本保存できます・AI処理は動画1本あたり${SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回`
                  : `無料体験：残り${freeVideosRemaining}本・${Math.floor(freeSecondsRemaining / 60)}分${freeSecondsRemaining % 60}秒（動画${FREE_VIDEO_LIMIT}本・合計${Math.floor(FREE_SECONDS_LIMIT / 60)}分のいずれか先に到達するまで）・AI処理は動画1本あたり3回`}
              </span>
            </article>
            <article>
              <p>買い切りで保存できる残り本数</p>
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
              <span>{status.monthly?.cancelAtPeriodEnd ? "期間終了後に解約" : "月3本・月7本プラン利用時に表示"}</span>
            </article>
          </section>

          {authenticationMethods?.passkey ? (
          <section className="accountPlans" aria-labelledby="accountSecurityTitle">
            <header className="accountPlansIntro">
              <p className="eyebrow">SECURITY</p>
              <h2 id="accountSecurityTitle">ログインする端末を管理</h2>
              <p>
                端末ごとに分かりやすい名前を付けられます。紛失した端末のパスキーは削除し、必要に応じて全端末をログアウトしてください。
              </p>
            </header>
            <article className="accountPlanCard accountCompactCard featured">
              <label className="accountField">
                追加する端末の名前
                <input
                  className="accountTextField"
                  value={newPasskeyName}
                  maxLength={40}
                  autoComplete="off"
                  onChange={(event) => setNewPasskeyName(event.target.value)}
                  placeholder="例：仕事用Mac"
                />
              </label>
              <button
                disabled={busy !== null || !newPasskeyName.trim()}
                onClick={registerPasskey}
              >
                {busy === "register"
                  ? "本人確認中…"
                  : passkeys.length > 0
                    ? "本人確認して予備パスキーを追加"
                    : "この端末にパスキーを追加"}
              </button>
              <small>
                {passkeys.length > 0
                  ? "最大10件。追加時にFace ID・Touch ID・端末の画面ロックで本人確認します。"
                  : "LINEで登録した方も追加できます。以後の本人確認とログインに利用します。"}
              </small>
            </article>
            {passkeys.map((passkey) => (
              <article className="accountPlanCard accountCompactCard" key={passkey.id}>
                <label className="accountField">
                  端末名
                  <input
                    className="accountTextField"
                    value={passkeyNames[passkey.id] ?? passkey.displayName}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(event) =>
                      setPasskeyNames((current) => ({
                        ...current,
                        [passkey.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <span>
                  {passkey.backedUp ? "クラウド同期対応" : "この端末に保存"}
                  {" ・ "}
                  登録日 {new Date(passkey.createdAt * 1000).toLocaleDateString("ja-JP")}
                </span>
                {passkey.lastUsedAt && (
                  <small>
                    最終利用 {new Date(passkey.lastUsedAt * 1000).toLocaleString("ja-JP")}
                  </small>
                )}
                <div className="accountAuthActions">
                  <button
                    className="accountSecondaryAction"
                    disabled={
                      busy !== null ||
                      !(passkeyNames[passkey.id] ?? "").trim() ||
                      (passkeyNames[passkey.id] ?? passkey.displayName) ===
                        passkey.displayName
                    }
                    onClick={() => renamePasskey(passkey)}
                  >
                    名前を保存
                  </button>
                  <button
                    className="accountSecondaryAction"
                    disabled={busy !== null || passkeys.length <= 1}
                    onClick={() => deletePasskey(passkey)}
                  >
                    このパスキーを削除
                  </button>
                </div>
              </article>
            ))}
            <button
              className="accountPortalButton"
              disabled={busy !== null}
              onClick={revokeAllSessions}
            >
              {busy === "revoke_sessions" ? "本人確認中…" : "すべての端末をログアウト"}
            </button>
          </section>
          ) : null}

          <section className="accountPlans" aria-labelledby="accountPlansTitle">
            <header className="accountPlansIntro">
              <p className="eyebrow">SAVE PLAN</p>
              <h2 id="accountPlansTitle">続けて投稿するなら月額がお得</h2>
              <p>
                編集・プレビュー機能は共通です。月3本・500円なら、1本ずつ3回購入するより100円お得です。月額にしない場合は、今回だけ1本の購入も選べます。表示価格はすべて税込です。
              </p>
            </header>
            <MonthlyFirstPurchaseOptions className="accountPurchaseOptions" source="account">
              <article className="accountPlanCard starterPlan featured">
                <span className="accountPlanRecommend">おすすめ</span>
                <span className="accountPlanFit">少ない本数から始めたい方</span>
                <p>1か月ごと</p>
                <h2>1か月に動画{STARTER_MONTHLY_VIDEO_LIMIT}本まで</h2>
                <strong>
                  ¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
                  <small>／1か月（税込）</small>
                </strong>
                <span className="accountPlanUnit">
                  1本あたり約
                  {Math.round(
                    STARTER_MONTHLY_PRICE_JPY / STARTER_MONTHLY_VIDEO_LIMIT,
                  )}
                  円
                </span>
                <ul>
                  <li>{monthlyVideoAllowanceLabel(STARTER_MONTHLY_VIDEO_LIMIT)}</li>
                  <li>
                    AI処理は動画1本あたり
                    {SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回
                  </li>
                  <li>解約するまで1か月ごとに自動更新</li>
                  <li>未使用の保存本数は翌月へ繰り越しなし</li>
                </ul>
                <button
                  disabled={busy !== null || !status.configured || status.monthly?.active}
                  onClick={() => beginCheckoutFromAccount("starter")}
                >
                  {status.monthly?.active
                    ? status.monthly.planKey === "starter"
                      ? "利用中"
                      : "変更は支払い管理から"
                    : busy === "starter"
                      ? "準備中…"
                      : `${STARTER_MONTHLY_PLAN_LABEL}を始める`}
                </button>
              </article>
              <article className="accountPlanCard standardPlan">
                <span className="accountPlanFit">週2本ほど投稿したい方</span>
                <p>1か月ごと</p>
                <h2>1か月に動画{STANDARD_MONTHLY_VIDEO_LIMIT}本まで</h2>
                <strong>
                  ¥{STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
                  <small>／1か月（税込）</small>
                </strong>
                <span className="accountPlanUnit">
                  1本あたり約
                  {Math.round(
                    STANDARD_MONTHLY_PRICE_JPY / STANDARD_MONTHLY_VIDEO_LIMIT,
                  )}
                  円
                </span>
                <ul>
                  <li>{monthlyVideoAllowanceLabel(STANDARD_MONTHLY_VIDEO_LIMIT)}</li>
                  <li>
                    AI処理は動画1本あたり
                    {SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回
                  </li>
                  <li>解約するまで1か月ごとに自動更新</li>
                  <li>未使用の保存本数は翌月へ繰り越しなし</li>
                  <li>
                    月3本プランより1本あたり約
                    {Math.round(
                      STARTER_MONTHLY_PRICE_JPY / STARTER_MONTHLY_VIDEO_LIMIT -
                        STANDARD_MONTHLY_PRICE_JPY /
                          STANDARD_MONTHLY_VIDEO_LIMIT,
                    )}
                    円お得
                  </li>
                </ul>
                <button
                  disabled={busy !== null || !status.configured || status.monthly?.active}
                  onClick={() => beginCheckoutFromAccount("standard")}
                >
                  {status.monthly?.active
                    ? status.monthly.planKey === "standard"
                      ? "利用中"
                      : "変更は支払い管理から"
                    : busy === "standard"
                      ? "準備中…"
                      : `${STANDARD_MONTHLY_PLAN_LABEL}を始める`}
                </button>
              </article>
              <OneTimeRescue source="account" className="accountPlanRescue">
                <div className="accountOneTimeOffer">
                  <span>今回だけ1本</span>
                  <strong>
                    ¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}
                    <small>／1本（税込）</small>
                  </strong>
                  <small>
                    完成動画を1本保存・AI処理はこの動画で
                    {ONE_TIME_AI_OPERATION_SUCCESS_LIMIT}回・1回払い・自動更新なし・有効期限なし
                  </small>
                </div>
                <button
                  disabled={busy !== null || !status.configured}
                  onClick={() => beginCheckoutFromAccount("one_time")}
                >
                  {busy === "one_time" ? "準備中…" : "この1本だけ保存する"}
                </button>
              </OneTimeRescue>
            </MonthlyFirstPurchaseOptions>
          </section>

          {status.user?.hasStripeCustomer && (
            <section className="accountPlans" aria-labelledby="billingDocumentsTitle">
              <header className="accountPlansIntro">
                <p className="eyebrow">PAYMENT HISTORY</p>
                <h2 id="billingDocumentsTitle">領収書・請求書と契約管理</h2>
                <p>
                  領収書・請求書はStripeの安全な画面で表示します。カード番号は撮るだけリールへ保存されません。
                </p>
              </header>
              {billingDocuments.length > 0 ? (
                billingDocuments.map((document) => (
                  <article className="accountPlanCard accountCompactCard" key={document.id}>
                    <p>{new Date(document.createdAt * 1000).toLocaleDateString("ja-JP")}</p>
                    <h2>{document.label}</h2>
                    <strong>{formatBillingAmount(document.amount, document.currency)}</strong>
                    {document.amountRefunded > 0 && (
                      <span>
                        返金済み {formatBillingAmount(document.amountRefunded, document.currency)}
                      </span>
                    )}
                    <a
                      className="accountSecondaryAction"
                      href={document.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Stripeで表示
                    </a>
                  </article>
                ))
              ) : (
                <p className="accountSecurity">表示できる領収書・請求書はまだありません。</p>
              )}
              <button className="accountPortalButton" disabled={busy !== null} onClick={openPortal}>
                {busy === "portal"
                  ? "開いています…"
                  : "支払い方法・自動更新・解約をStripeで管理"}
              </button>
            </section>
          )}

          <section className="accountPlans" aria-labelledby="accountDeletionTitle">
            <header className="accountPlansIntro">
              <p className="eyebrow">ACCOUNT CONTROL</p>
              <h2 id="accountDeletionTitle">アカウントの削除</h2>
              <p>
                月額プランを利用中の場合は、先にStripeで自動更新を解約し、現在の利用期間が終了してから削除を予約できます。誤操作や端末紛失に備え、予約後すぐには削除せず30日間の猶予を設けます。
              </p>
            </header>
            {accountDeletion ? (
              <article className="accountPlanCard accountCompactCard featured">
                <p>{accountDeletion.status === "processing" ? "削除処理を確認中" : "削除予約中"}</p>
                <h2>
                  削除手続き開始予定日 {new Date(accountDeletion.executeAfter * 1000).toLocaleDateString("ja-JP")}
                </h2>
                <span>
                  {accountDeletion.status === "processing"
                    ? "契約・返金・支払い異議と処理中の保存がないことを確認しています。確認中は安全のため予約を取り消せません。問題がある場合は削除を延期します。"
                    : "予定日まではログインでき、この画面から予約を取り消せます。予定日以降、運営の定期処理で契約・返金・支払い異議を再確認してから順次削除します。"}
                </span>
                {accountDeletion.status === "scheduled" ? (
                  <button
                    className="accountSecondaryAction"
                    disabled={busy !== null}
                    onClick={cancelAccountDeletion}
                  >
                    {busy === "cancel_deletion" ? "取消中…" : "削除予約を取り消す"}
                  </button>
                ) : null}
              </article>
            ) : (
              <button
                className="accountSecondaryAction"
                disabled={busy !== null}
                onClick={scheduleAccountDeletion}
              >
                {busy === "delete_account" ? "本人確認中…" : "本人確認して削除を予約"}
              </button>
            )}
            <small>
              返金・支払い異議・法令対応に必要な課金記録は、個人情報を最小化したうえで必要な期間保持する場合があります。
            </small>
            <small>
              LINEの認証権限はログイン確認直後に解除し、継続保持しません。削除確定時には、本サービス内のLINE連携識別情報も削除します。
            </small>
          </section>
        </>
      )}

      {error && <p className="accountError" role="alert">{error}</p>}
      <p className="accountSecurity">
        カード番号はStripeが安全に管理し、撮るだけリールのデータベースには保存しません。
      </p>
      <p className="accountSecurity">
        無料体験は編集結果が完成した時点で1本分を使用します。有料プランでは、動画の書き出しに成功した時点で、保存できる残り本数が1本減ります。
      </p>
      <p className="accountSecurity">
        AI処理には、文字起こし、高精度再解析、AI台本の生成、AI音声の生成が含まれます。初回ナレーションは台本完成時に1回分を使用し、続く初回音声と内部の自動調整では追加回数を使用しません。作成後の再生成などは正常に完了するごとに1回分を使用し、上限は動画1本あたり無料体験3回、動画1本プラン5回、月3本・月7本プラン
        {SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回です。正常に完了したAI処理の回数は、動画を保存せず編集を終了した場合も戻りません。
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

function formatBillingAmount(amount: number, currency: string) {
  const normalizedCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "JPY";
  const majorAmount = normalizedCurrency === "JPY" ? amount : amount / 100;
  try {
    return new Intl.NumberFormat("ja-JP", {
      style: "currency",
      currency: normalizedCurrency,
    }).format(majorAmount);
  } catch {
    return `${majorAmount.toLocaleString("ja-JP")} ${normalizedCurrency}`;
  }
}
