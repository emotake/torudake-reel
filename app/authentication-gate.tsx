"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const settledRef = useRef(false);
  const trialReadyRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      settledRef.current = false;
      trialReadyRef.current = false;
      setMethods(null);
      setError("");
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
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.data === "torudake:authenticated"
      ) {
        refresh();
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("message", onMessage);
    const timer = window.setInterval(refresh, 1_500);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
  }, [open, refreshAuthentication]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy === null) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [busy, onClose, open]);

  if (!open) return null;

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

  const authenticateWithLine = async () => {
    setError("");
    setBusy("line");

    // Open synchronously inside the click event. Opening after the trial
    // request resolves is commonly blocked, especially on mobile browsers.
    const popup = window.open(
      "about:blank",
      "torudake-line-login",
      "popup=yes,width=520,height=720",
    );
    if (!popup) {
      setError(
        "LINEログイン画面を開けませんでした。ブラウザでポップアップを許可して、もう一度お試しください。",
      );
      setBusy(null);
      return;
    }
    popup.opener = null;

    try {
      await ensureAuthenticationContext();
    } catch (cause) {
      popup.close();
      setError(
        cause instanceof Error
          ? cause.message
          : "LINEログインを開始できませんでした。",
      );
      setBusy(null);
      return;
    }

    const startUrl = new URL(
      "/api/account/oauth/line/start",
      window.location.origin,
    );
    startUrl.searchParams.set("popup", "1");
    if (mode === "reauthenticate") {
      startUrl.searchParams.set("reauthenticate", "1");
    }
    try {
      popup.location.replace(startUrl.toString());
    } catch {
      popup.close();
      setError(
        "LINEログイン画面へ移動できませんでした。もう一度お試しください。",
      );
      setBusy(null);
      return;
    }
    window.setTimeout(() => setBusy(null), 1_000);
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

  return (
    <div className="authenticationGateBackdrop" role="presentation">
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
        <small>
          LINEへの投稿やLINE公式アカウントの友だち追加は行いません。ログイン情報は利用枠と購入履歴の管理にだけ使用します。
        </small>
      </div>
    </div>
  );
}
