"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import lineButtonStyles from "./line-login-button.module.css";

type AuthenticationReason = "billing" | "account" | "ai";
type AuthenticationMode = "authenticate" | "reauthenticate";

type AccountAuthenticationMethods = {
  passkey: boolean;
  line: boolean;
  google: boolean;
  email: boolean;
};

type AuthenticationMethods = AccountAuthenticationMethods & {
  authenticated: boolean;
  recentlyAuthenticated: boolean;
  accountMethods: AccountAuthenticationMethods;
};

type AuthPayload<T> = T & { error?: string; code?: string };

type LinePopupOutcome = "succeeded" | "cancelled" | "failed";

type LinePopupResult = {
  type: "torudake:oidc-result";
  flowId: string;
  outcome: LinePopupOutcome;
};

const LINE_POPUP_CHANNEL = "torudake-oidc-results";
const LINE_POPUP_CHECK_INTERVAL_MS = 500;
const LINE_POPUP_CLOSE_GRACE_MS = 2_500;
const LINE_POPUP_MAX_WAIT_MS = 10 * 60 * 1_000;
const AUTHENTICATION_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isLinePopupResult(value: unknown): value is LinePopupResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LinePopupResult>;
  return (
    candidate.type === "torudake:oidc-result" &&
    typeof candidate.flowId === "string" &&
    (candidate.outcome === "succeeded" ||
      candidate.outcome === "cancelled" ||
      candidate.outcome === "failed")
  );
}

function currentAuthenticationReturnTo(mode: AuthenticationMode) {
  const target = new URL(window.location.href);
  target.searchParams.delete("auth_error");
  target.searchParams.delete("auth_result");
  target.searchParams.set(
    "auth_result",
    mode === "reauthenticate" ? "reauthenticated" : "authenticated",
  );
  return `${target.pathname}${target.search}${target.hash}`;
}

function isPopupClosed(popup: Window) {
  try {
    return popup.closed;
  } catch {
    return true;
  }
}

function closePopupWindow(popup: Window | null) {
  if (!popup) return;
  try {
    if (!isPopupClosed(popup)) popup.close();
  } catch {
    // A cross-origin or already-disposed popup is safe to forget.
  }
}

const reasonCopy: Record<
  AuthenticationReason,
  { title: string; lineBody: string; passkeyBody: string }
> = {
  ai: {
    title: "AI機能を使うにはログイン",
    lineBody:
      "素材と編集内容はこの画面に残ります。LINEでログインしてください。",
    passkeyBody:
      "素材と編集内容はこの画面に残ります。LINEまたは登録済みのパスキーでログインしてください。",
  },
  billing: {
    title: "保存方法を選ぶ",
    lineBody:
      "購入履歴や月額契約を安全に管理するため、LINEでログインしてください。",
    passkeyBody:
      "購入履歴や月額契約を安全に管理するため、LINEまたは登録済みパスキーでログインしてください。",
  },
  account: {
    title: "アカウントへログイン",
    lineBody: "LINEでログインすると、利用枠とお支払いを安全に管理できます。",
    passkeyBody:
      "LINEまたは登録済みパスキーで、利用枠とお支払いを安全に管理できます。",
  },
};

async function readPayload<T>(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as
    | AuthPayload<T>
    | null;
  if (!response.ok) throw new Error(payload?.error || fallback);
  return payload as AuthPayload<T>;
}

async function postJson<T>(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return readPayload<T>(response, "本人確認を完了できませんでした。");
}

export default function AuthenticationGate({
  open,
  reason,
  onAuthenticated,
  onClose,
  mode = "authenticate",
}: {
  open: boolean;
  reason: AuthenticationReason;
  onAuthenticated: () => void | Promise<void>;
  onClose: () => void;
  mode?: AuthenticationMode;
}) {
  const [methods, setMethods] = useState<AuthenticationMethods | null>(null);
  const [busy, setBusy] = useState<"passkey" | "line" | null>(null);
  const [error, setError] = useState("");
  const [lineSameTabFallback, setLineSameTabFallback] = useState(false);
  const portalTarget = typeof document === "undefined" ? null : document.body;
  const settledRef = useRef(false);
  const trialReadyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const linePopupRef = useRef<Window | null>(null);
  const linePopupFlowRef = useRef<string | null>(null);
  const linePopupOutcomeRef = useRef<LinePopupOutcome | null>(null);
  const linePopupStartedAtRef = useRef(0);
  const linePopupClosedAtRef = useRef<number | null>(null);
  const busyRef = useRef<typeof busy>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const ensureAuthenticationContext = useCallback(async () => {
    if (mode === "reauthenticate" || trialReadyRef.current) return;
    const response = await fetch("/api/session/trial", {
      method: "POST",
      credentials: "same-origin",
    });
    await readPayload<{ ready: boolean }>(
      response,
      "ログインを開始できませんでした。ページを再読み込みしてお試しください。",
    );
    trialReadyRef.current = true;
  }, [mode]);

  const refreshAuthentication = useCallback(async () => {
    const response = await fetch("/api/account/auth/methods", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = await readPayload<AuthenticationMethods>(
      response,
      "ログイン状態を確認できませんでした。",
    );
    setMethods(payload);
    const complete =
      mode === "reauthenticate"
        ? payload.authenticated && payload.recentlyAuthenticated
        : payload.authenticated;
    if (!complete || settledRef.current) return false;
    settledRef.current = true;
    await onAuthenticated();
    return true;
  }, [mode, onAuthenticated]);

  const resetLinePopup = useCallback((closePopup: boolean) => {
    const popup = linePopupRef.current;
    if (closePopup) closePopupWindow(popup);
    linePopupRef.current = null;
    linePopupFlowRef.current = null;
    linePopupOutcomeRef.current = null;
    linePopupStartedAtRef.current = 0;
    linePopupClosedAtRef.current = null;
  }, []);

  const handleLinePopupResult = useCallback(
    (result: LinePopupResult) => {
      if (
        !linePopupFlowRef.current ||
        result.flowId !== linePopupFlowRef.current
      ) {
        return;
      }
      linePopupOutcomeRef.current = result.outcome;
      if (result.outcome === "succeeded") {
        void refreshAuthentication().catch(() => undefined);
        return;
      }
      setError(
        result.outcome === "cancelled"
          ? "LINEログインをキャンセルしました。料金は発生していません。"
          : "LINEログインを完了できませんでした。もう一度お試しください。",
      );
      setBusy(null);
      resetLinePopup(true);
    },
    [refreshAuthentication, resetLinePopup],
  );

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      settledRef.current = false;
      trialReadyRef.current = false;
      setMethods(null);
      setError("");
      setLineSameTabFallback(false);
      setBusy(null);
      void refreshAuthentication().catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "ログイン方法を確認できませんでした。",
        );
      });
    });
    const refresh = () => {
      void refreshAuthentication().catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data === "torudake:authenticated") refresh();
      if (isLinePopupResult(event.data)) handleLinePopupResult(event.data);
    };
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(LINE_POPUP_CHANNEL);
    const onChannelMessage = (event: MessageEvent) => {
      if (isLinePopupResult(event.data)) handleLinePopupResult(event.data);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("message", onMessage);
    channel?.addEventListener("message", onChannelMessage);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("message", onMessage);
      channel?.removeEventListener("message", onChannelMessage);
      channel?.close();
    };
  }, [handleLinePopupResult, open, refreshAuthentication]);

  useEffect(() => {
    if (!open) resetLinePopup(true);
  }, [open, resetLinePopup]);

  useEffect(
    () => () => {
      resetLinePopup(true);
    },
    [resetLinePopup],
  );

  useEffect(() => {
    if (!open || busy !== "line" || !linePopupRef.current) return;
    let active = true;
    let checking = false;
    const checkPopup = async () => {
      if (!active || checking) return;
      checking = true;
      try {
        const popup = linePopupRef.current;
        if (!popup) return;
        const now = Date.now();
        const closed = isPopupClosed(popup);
        if (closed && linePopupClosedAtRef.current === null) {
          linePopupClosedAtRef.current = now;
        }
        if (closed || linePopupOutcomeRef.current === "succeeded") {
          const complete = await refreshAuthentication().catch(() => false);
          if (complete) {
            resetLinePopup(false);
            return;
          }
        }
        const closedFor = linePopupClosedAtRef.current
          ? now - linePopupClosedAtRef.current
          : 0;
        const waitingFor = now - linePopupStartedAtRef.current;
        if (
          (closed && closedFor >= LINE_POPUP_CLOSE_GRACE_MS) ||
          waitingFor >= LINE_POPUP_MAX_WAIT_MS
        ) {
          setError(
            waitingFor >= LINE_POPUP_MAX_WAIT_MS
              ? "LINEログインの有効時間が切れました。もう一度お試しください。"
              : "LINEログインが完了していません。もう一度お試しください。",
          );
          setBusy(null);
          resetLinePopup(true);
        }
      } finally {
        checking = false;
      }
    };
    void checkPopup();
    const timer = window.setInterval(
      () => void checkPopup(),
      LINE_POPUP_CHECK_INTERVAL_MS,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [busy, open, refreshAuthentication, resetLinePopup]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const backdrop = backdropRef.current;
    if (!dialog || !backdrop || !portalTarget) return;
    const background = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element !== backdrop,
    );
    const priorBackground = background.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    const previousOverflow = document.body.style.overflow;
    dialog.focus({ preventScroll: true });
    for (const element of background) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          AUTHENTICATION_FOCUSABLE_SELECTOR,
        ),
      ).filter((element) => !element.hidden && element.tabIndex !== -1);
    queueMicrotask(() => {
      const elements = focusable();
      (elements.find((element) =>
        element.classList.contains("authenticationProvider"),
      ) ?? elements[0] ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busyRef.current === null) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (current === last || !dialog.contains(current))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, ariaHidden } of priorBackground) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previousFocusRef.current?.focus?.();
      previousFocusRef.current = null;
    };
  }, [open, portalTarget]);

  if (!open || !portalTarget) return null;

  const authenticateWithPasskey = async () => {
    setError("");
    setBusy("passkey");
    try {
      await ensureAuthenticationContext();
      const path =
        mode === "reauthenticate"
          ? "/api/account/passkey/reauth/options"
          : "/api/account/passkey/login/options";
      const prepared = await postJson<{
        options?: PublicKeyCredentialRequestOptionsJSON;
      }>(path);
      if (!prepared.options) {
        throw new Error("本人確認を開始できませんでした。");
      }
      const credential = await startAuthentication({
        optionsJSON: prepared.options,
      });
      await postJson<{ authenticated: boolean }>(
        "/api/account/passkey/login/verify",
        credential as unknown as Record<string, unknown>,
      );
      await refreshAuthentication();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "本人確認を完了できませんでした。",
      );
    } finally {
      setBusy(null);
    }
  };

  const authenticateWithLine = async (sameTabOnly = false) => {
    setError("");
    setLineSameTabFallback(false);
    setBusy("line");
    const startUrl = new URL(
      "/api/account/oauth/line/start",
      window.location.origin,
    );
    if (mode === "reauthenticate") {
      startUrl.searchParams.set("reauthenticate", "1");
    }

    const navigateLineSameTab = async () => {
      try {
        await ensureAuthenticationContext();
        startUrl.searchParams.delete("popup");
        startUrl.searchParams.delete("popupFlow");
        startUrl.searchParams.set(
          "returnTo",
          currentAuthenticationReturnTo(mode),
        );
        window.location.assign(startUrl.toString());
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "LINEログインを開始できませんでした。",
        );
        setBusy(null);
      }
    };

    if (sameTabOnly) {
      await navigateLineSameTab();
      return;
    }

    const offerEditorSameTabFallback = () => {
      setError(
        "ポップアップを開けませんでした。このタブで続ける場合、素材の再選択が必要になることがあります。",
      );
      setLineSameTabFallback(true);
      setBusy(null);
    };

    // Open synchronously on every device so editor File/Blob state stays in
    // this tab. If the browser blocks or cannot navigate the popup, fall back
    // to a same-tab flow instead of stranding the user.
    const popup = window.open(
      "about:blank",
      "torudake-line-login",
      "popup=yes,width=520,height=720",
    );
    if (!popup) {
      if (reason === "ai") {
        offerEditorSameTabFallback();
        return;
      }
      await navigateLineSameTab();
      return;
    }
    try {
      popup.opener = null;
    } catch {
      // The result channel and final session check do not rely on opener.
    }

    try {
      await ensureAuthenticationContext();
    } catch (cause) {
      closePopupWindow(popup);
      setError(
        cause instanceof Error
          ? cause.message
          : "LINEログインを開始できませんでした。",
      );
      setBusy(null);
      return;
    }

    const flowId = crypto.randomUUID();
    startUrl.searchParams.set("popup", "1");
    startUrl.searchParams.set("popupFlow", flowId);
    linePopupRef.current = popup;
    linePopupFlowRef.current = flowId;
    linePopupOutcomeRef.current = null;
    linePopupStartedAtRef.current = Date.now();
    linePopupClosedAtRef.current = null;
    try {
      popup.location.replace(startUrl.toString());
    } catch {
      closePopupWindow(popup);
      resetLinePopup(false);
      if (reason === "ai") {
        offerEditorSameTabFallback();
        return;
      }
      await navigateLineSameTab();
    }
  };

  const lineAvailable =
    methods?.line === true &&
    (mode !== "reauthenticate" || methods.accountMethods.line);
  const passkeyAvailable =
    methods?.passkey === true &&
    (mode !== "reauthenticate" || methods.accountMethods.passkey);
  const selectedReasonCopy = reasonCopy[reason];
  const copy =
    mode === "reauthenticate"
      ? {
          title: "本人確認をやり直す",
          body: "このアカウントに登録済みの方法で本人確認してください。",
        }
      : {
          title: selectedReasonCopy.title,
          body: passkeyAvailable
            ? selectedReasonCopy.passkeyBody
            : selectedReasonCopy.lineBody,
        };

  return createPortal(
    <div
      className="authenticationGateBackdrop"
      role="presentation"
      ref={backdropRef}
    >
      <div
        className="authenticationGate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="authenticationGateTitle"
        tabIndex={-1}
        ref={dialogRef}
      >
        <button
          type="button"
          className="authenticationGateClose"
          aria-label="閉じる"
          onClick={onClose}
          disabled={busy !== null}
        >
          ×
        </button>
        <p className="eyebrow">ACCOUNT</p>
        <h2 id="authenticationGateTitle">{copy.title}</h2>
        <p>{copy.body}</p>

        <div className="authenticationGateActions">
          {lineAvailable ? (
            <button
              type="button"
              className={`authenticationProvider line ${lineButtonStyles.button}`}
              onClick={() => void authenticateWithLine()}
              disabled={busy !== null}
            >
              <span className={lineButtonStyles.content}>
                <span
                  className={lineButtonStyles.icon}
                  aria-hidden="true"
                />
                <span className={lineButtonStyles.label}>
                  {busy === "line"
                    ? "LINEを確認中…"
                    : mode === "reauthenticate"
                      ? "LINEで本人確認"
                      : "LINEでログイン"}
                </span>
                <span className={lineButtonStyles.balance} aria-hidden="true" />
              </span>
            </button>
          ) : null}
          {passkeyAvailable ? (
            <button
              type="button"
              className="authenticationProvider passkey"
              onClick={() => void authenticateWithPasskey()}
              disabled={busy !== null}
            >
              {busy === "passkey"
                ? "本人確認中…"
                : mode === "reauthenticate"
                  ? "パスキーで本人確認"
                  : "登録済みパスキーでログイン"}
            </button>
          ) : null}
        </div>

        {!methods ? (
          <p className="authenticationGateStatus">ログイン方法を確認中…</p>
        ) : null}
        {methods && !lineAvailable && !passkeyAvailable ? (
          <p className="authenticationGateError" role="alert">
            現在利用できるログイン方法がありません。サポートへお問い合わせください。
          </p>
        ) : null}
        {error ? (
          <p className="authenticationGateError" role="alert">{error}</p>
        ) : null}
        {lineSameTabFallback ? (
          <button
            type="button"
            className="authenticationSameTabFallback"
            onClick={() => void authenticateWithLine(true)}
            disabled={busy !== null}
          >
            このタブでLINEログインを続ける
          </button>
        ) : null}
        <small>
          LINEへの投稿やLINE公式アカウントの友だち追加は行いません。ログイン情報は利用枠と購入履歴の管理にだけ使用します。
        </small>
      </div>
    </div>,
    portalTarget,
  );
}
