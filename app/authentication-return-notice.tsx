"use client";

import { useEffect, useState } from "react";
import {
  normalizeAuthenticationReturnResult,
  verifyAuthenticationReturn,
} from "../lib/client-authentication-return";

type AuthenticationReturnFeedback = {
  kind: "notice" | "error";
  message: string;
};

const AUTHENTICATION_ERROR_MESSAGES: Record<string, AuthenticationReturnFeedback> = {
  cancelled: {
    kind: "notice",
    message: "LINEログインをキャンセルしました。料金は発生していません。",
  },
  expired: {
    kind: "error",
    message: "LINEログインの有効時間が切れました。もう一度お試しください。",
  },
  failed: {
    kind: "error",
    message: "LINEログインを完了できませんでした。もう一度お試しください。",
  },
  identity_already_linked: {
    kind: "error",
    message: "このLINEアカウントは別のアカウントに連携されています。",
  },
  account_unavailable: {
    kind: "error",
    message: "このアカウントではログインを続けられません。サポートへお問い合わせください。",
  },
  account_changed: {
    kind: "error",
    message: "ログイン中のアカウントが変わりました。最初からやり直してください。",
  },
  already_authenticated: {
    kind: "notice",
    message: "すでにログインしています。",
  },
};

const UNKNOWN_AUTHENTICATION_ERROR: AuthenticationReturnFeedback = {
  kind: "error",
  message: "LINEログインを完了できませんでした。もう一度お試しください。",
};

export default function AuthenticationReturnNotice() {
  const [feedback, setFeedback] =
    useState<AuthenticationReturnFeedback | null>(null);

  useEffect(() => {
    if (window.location.pathname === "/account") return;
    let active = true;
    const controller = new AbortController();
    const currentUrl = new URL(window.location.href);
    const authErrors = currentUrl.searchParams.getAll("auth_error");
    const authError =
      authErrors.length === 1 ? currentUrl.searchParams.get("auth_error") : null;
    const authResult = normalizeAuthenticationReturnResult(
      currentUrl.searchParams.getAll("auth_result"),
    );

    if (
      currentUrl.searchParams.has("auth_error") ||
      currentUrl.searchParams.has("auth_result")
    ) {
      currentUrl.searchParams.delete("auth_error");
      currentUrl.searchParams.delete("auth_result");
      const cleanedSearch = currentUrl.searchParams.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${currentUrl.pathname}${cleanedSearch ? `?${cleanedSearch}` : ""}${currentUrl.hash}`,
      );
    }
    void (async () => {
      let nextFeedback: AuthenticationReturnFeedback | null = null;
      if (authErrors.length > 0) {
        nextFeedback =
          (authError ? AUTHENTICATION_ERROR_MESSAGES[authError] : undefined) ??
          UNKNOWN_AUTHENTICATION_ERROR;
      } else if (
        authResult &&
        await verifyAuthenticationReturn(authResult, {
          signal: controller.signal,
        })
      ) {
        nextFeedback = authResult === "authenticated"
          ? {
              kind: "notice",
              message:
                "LINEログインが完了しました。素材の再選択が必要な場合は、選び直して操作を続けてください。",
            }
          : {
              kind: "notice",
              message: "本人確認が完了しました。操作をもう一度実行してください。",
            };
      }
      if (active) setFeedback(nextFeedback);
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  if (!feedback) return null;
  return (
    <div
      className={`authenticationReturnNotice ${feedback.kind}`}
      role={feedback.kind === "error" ? "alert" : "status"}
    >
      <span>{feedback.message}</span>
      <button
        type="button"
        aria-label="通知を閉じる"
        onClick={() => setFeedback(null)}
      >
        ×
      </button>
    </div>
  );
}
