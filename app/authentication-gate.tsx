"use client";

import {
  startAuthentication,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  claimAuthenticationBusy,
  createLineSameTabNavigationEpoch,
  isActiveAbortableAuthenticationAttempt,
  isActiveLineAuthenticationAttempt,
  isPendingLineSameTabNavigation,
  markLineSameTabNavigationCommitted,
  runAbortableAuthenticationRequest,
  runGuardedAuthenticationSequence,
  scheduleLineAuthenticationRecovery,
  shouldInitializeAuthenticationGate,
} from "../lib/client-line-auth-lifecycle";
import type { LineSameTabNavigationEpoch } from "../lib/client-line-auth-lifecycle";
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
const LINE_SAME_TAB_START_RECOVERY_MS = 10_000;
const LINE_SAME_TAB_UNLOAD_RECOVERY_MS = 1_000;
const AUTHENTICATION_REQUEST_TIMEOUT_MS = 12_000;
const PASSKEY_CEREMONY_TIMEOUT_MS = 5 * 60 * 1_000;
const AUTHENTICATION_REQUEST_TIMEOUT_MESSAGE =
  "認証サーバーから応答がありません。通信状態を確認して、もう一度お試しください。";
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

function currentAuthenticationReturnTo() {
  const target = new URL(window.location.href);
  target.searchParams.delete("auth_error");
  target.searchParams.delete("auth_result");
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

async function runAuthenticationRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) {
  return await runAbortableAuthenticationRequest({
    timeoutMs: AUTHENTICATION_REQUEST_TIMEOUT_MS,
    timeoutMessage: AUTHENTICATION_REQUEST_TIMEOUT_MESSAGE,
    signal,
    run,
  });
}

async function postJson<T>(
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return await runAuthenticationRequest(async (requestSignal) => {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: requestSignal,
    });
    return await readPayload<T>(
      response,
      "本人確認を完了できませんでした。",
    );
  }, signal);
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
  const lineAttemptGenerationRef = useRef(0);
  const cancelSameTabRecoveryRef = useRef<(() => void) | null>(null);
  const cancelSameTabBeforeUnloadRef = useRef<(() => void) | null>(null);
  const lineSameTabNavigationEpochRef = useRef(0);
  const lineSameTabNavigationRef = useRef<LineSameTabNavigationEpoch | null>(
    null,
  );
  const passkeyAttemptGenerationRef = useRef(0);
  const passkeyAbortControllerRef = useRef<AbortController | null>(null);
  const passkeyAttemptTimeoutRef = useRef<number | null>(null);
  const authenticationInitializationModeRef = useRef<
    AuthenticationMode | null
  >(null);
  const mountedRef = useRef(false);
  const openRef = useRef(open);
  const busyRef = useRef<typeof busy>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onAuthenticatedRef = useRef(onAuthenticated);
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useLayoutEffect(() => {
    onAuthenticatedRef.current = onAuthenticated;
  }, [onAuthenticated]);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const ensureAuthenticationContext = useCallback(async (signal?: AbortSignal) => {
    if (mode === "reauthenticate" || trialReadyRef.current) return;
    await runAuthenticationRequest(async (requestSignal) => {
      const response = await fetch("/api/session/trial", {
        method: "POST",
        credentials: "same-origin",
        signal: requestSignal,
      });
      await readPayload<{ ready: boolean }>(
        response,
        "ログインを開始できませんでした。ページを再読み込みしてお試しください。",
      );
    }, signal);
    if (signal?.aborted) throw signal.reason;
    trialReadyRef.current = true;
  }, [mode]);

  const refreshAuthentication = useCallback(async (
    stillCurrent?: () => boolean,
  ) => {
    const payload = await runAuthenticationRequest(async (requestSignal) => {
      const response = await fetch("/api/account/auth/methods", {
        cache: "no-store",
        credentials: "same-origin",
        signal: requestSignal,
      });
      return await readPayload<AuthenticationMethods>(
        response,
        "ログイン状態を確認できませんでした。",
      );
    });
    if (
      !mountedRef.current ||
      !openRef.current ||
      (stillCurrent && !stillCurrent())
    ) {
      return false;
    }
    setMethods(payload);
    const complete =
      mode === "reauthenticate"
        ? payload.authenticated && payload.recentlyAuthenticated
        : payload.authenticated;
    if (!complete) return false;
    if (settledRef.current) return true;
    settledRef.current = true;
    await onAuthenticatedRef.current();
    return true;
  }, [mode]);

  const resetLinePopup = useCallback((closePopup: boolean) => {
    const popup = linePopupRef.current;
    if (closePopup) closePopupWindow(popup);
    linePopupRef.current = null;
    linePopupFlowRef.current = null;
    linePopupOutcomeRef.current = null;
    linePopupStartedAtRef.current = 0;
    linePopupClosedAtRef.current = null;
  }, []);

  const cancelSameTabRecovery = useCallback(() => {
    cancelSameTabRecoveryRef.current?.();
    cancelSameTabRecoveryRef.current = null;
  }, []);

  const cancelSameTabBeforeUnload = useCallback(() => {
    cancelSameTabBeforeUnloadRef.current?.();
    cancelSameTabBeforeUnloadRef.current = null;
  }, []);

  const invalidateLineAttempt = useCallback(
    (closePopup: boolean) => {
      lineAttemptGenerationRef.current += 1;
      cancelSameTabRecovery();
      cancelSameTabBeforeUnload();
      lineSameTabNavigationRef.current = null;
      resetLinePopup(closePopup);
    },
    [cancelSameTabBeforeUnload, cancelSameTabRecovery, resetLinePopup],
  );

  const isCurrentLineAttempt = useCallback((generation: number) =>
    isActiveLineAuthenticationAttempt(
      {
        mounted: mountedRef.current,
        open: openRef.current,
        generation: lineAttemptGenerationRef.current,
      },
      generation,
    ), []);

  const beginLineAttempt = useCallback(
    (popup: Window | null) => {
      invalidateLineAttempt(true);
      const generation = lineAttemptGenerationRef.current;
      linePopupRef.current = popup;
      linePopupFlowRef.current = null;
      linePopupOutcomeRef.current = null;
      linePopupStartedAtRef.current = Date.now();
      linePopupClosedAtRef.current = null;
      return generation;
    },
    [invalidateLineAttempt],
  );

  const invalidatePasskeyAttempt = useCallback(() => {
    passkeyAttemptGenerationRef.current += 1;
    if (passkeyAttemptTimeoutRef.current !== null) {
      window.clearTimeout(passkeyAttemptTimeoutRef.current);
      passkeyAttemptTimeoutRef.current = null;
    }
    passkeyAbortControllerRef.current?.abort();
    passkeyAbortControllerRef.current = null;
    WebAuthnAbortService.cancelCeremony();
  }, []);

  const beginPasskeyAttempt = useCallback(() => {
    invalidatePasskeyAttempt();
    const controller = new AbortController();
    passkeyAbortControllerRef.current = controller;
    passkeyAttemptTimeoutRef.current = window.setTimeout(() => {
      if (
        passkeyAbortControllerRef.current !== controller ||
        !mountedRef.current ||
        !openRef.current
      ) {
        return;
      }
      invalidatePasskeyAttempt();
      if (!mountedRef.current || !openRef.current) return;
      setError("本人確認の有効時間が切れました。もう一度お試しください。");
      busyRef.current = null;
      setBusy(null);
    }, PASSKEY_CEREMONY_TIMEOUT_MS);
    return {
      controller,
      generation: passkeyAttemptGenerationRef.current,
    };
  }, [invalidatePasskeyAttempt]);

  const cancelPasskeyAttempt = useCallback(() => {
    if (busyRef.current !== "passkey") return;
    invalidatePasskeyAttempt();
    if (!mountedRef.current || !openRef.current) return;
    setError("パスキーによる本人確認を中止しました。");
    busyRef.current = null;
    setBusy(null);
  }, [invalidatePasskeyAttempt]);

  const isCurrentPasskeyAttempt = useCallback(
    (generation: number, controller: AbortController) =>
      passkeyAbortControllerRef.current === controller &&
      isActiveAbortableAuthenticationAttempt(
        {
          mounted: mountedRef.current,
          open: openRef.current,
          generation: passkeyAttemptGenerationRef.current,
        },
        generation,
        controller.signal,
      ),
    [],
  );

  const recoverSameTabAttempt = useCallback(
    (
      generation: number,
      message = "LINEログイン画面へ移動しませんでした。もう一度お試しください。",
    ) => {
      if (!isCurrentLineAttempt(generation)) return;
      invalidateLineAttempt(false);
      if (!mountedRef.current || !openRef.current) return;
      setError(message);
      setLineSameTabFallback(reason === "ai");
      busyRef.current = null;
      setBusy(null);
    },
    [invalidateLineAttempt, isCurrentLineAttempt, reason],
  );

  const armSameTabRecovery = useCallback(
    (navigation: LineSameTabNavigationEpoch, delayMs: number) => {
      cancelSameTabRecovery();
      cancelSameTabRecoveryRef.current = scheduleLineAuthenticationRecovery({
        delayMs,
        isCurrent: () =>
          isCurrentLineAttempt(navigation.generation) &&
          isPendingLineSameTabNavigation(
            lineSameTabNavigationRef.current,
            navigation.epoch,
            navigation.generation,
          ),
        recover: () => recoverSameTabAttempt(navigation.generation),
      });
    },
    [cancelSameTabRecovery, isCurrentLineAttempt, recoverSameTabAttempt],
  );

  const attachSameTabBeforeUnloadRecovery = useCallback(
    (navigation: LineSameTabNavigationEpoch) => {
      cancelSameTabBeforeUnload();
      const onBeforeUnload = () => {
        cancelSameTabBeforeUnloadRef.current = null;
        if (
          !isCurrentLineAttempt(navigation.generation) ||
          navigation.committed
        ) {
          return;
        }
        armSameTabRecovery(
          navigation,
          LINE_SAME_TAB_UNLOAD_RECOVERY_MS,
        );
      };
      window.addEventListener("beforeunload", onBeforeUnload, { once: true });
      cancelSameTabBeforeUnloadRef.current = () => {
        window.removeEventListener("beforeunload", onBeforeUnload);
      };
    },
    [
      armSameTabRecovery,
      cancelSameTabBeforeUnload,
      isCurrentLineAttempt,
    ],
  );

  const handleLinePopupResult = useCallback(
    (result: LinePopupResult) => {
      if (
        !linePopupFlowRef.current ||
        result.flowId !== linePopupFlowRef.current
      ) {
        return;
      }
      const generation = lineAttemptGenerationRef.current;
      if (!isCurrentLineAttempt(generation)) return;
      linePopupOutcomeRef.current = result.outcome;
      if (result.outcome === "succeeded") {
        void refreshAuthentication(() => isCurrentLineAttempt(generation))
          .then((complete) => {
            if (complete && isCurrentLineAttempt(generation)) {
              invalidateLineAttempt(false);
            }
          })
          .catch(() => undefined);
        return;
      }
      invalidateLineAttempt(true);
      setError(
        result.outcome === "cancelled"
          ? "LINEログインをキャンセルしました。料金は発生していません。"
          : "LINEログインを完了できませんでした。もう一度お試しください。",
      );
      busyRef.current = null;
      setBusy(null);
    },
    [
      invalidateLineAttempt,
      isCurrentLineAttempt,
      refreshAuthentication,
    ],
  );

  useEffect(() => {
    if (!open) {
      authenticationInitializationModeRef.current = null;
      return;
    }
    if (
      !shouldInitializeAuthenticationGate(
        authenticationInitializationModeRef.current,
        open,
        mode,
      )
    ) {
      return;
    }
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      authenticationInitializationModeRef.current = mode;
      invalidateLineAttempt(true);
      invalidatePasskeyAttempt();
      settledRef.current = false;
      trialReadyRef.current = false;
      setMethods(null);
      setError("");
      setLineSameTabFallback(false);
      busyRef.current = null;
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
    return () => {
      active = false;
    };
  }, [
    invalidateLineAttempt,
    invalidatePasskeyAttempt,
    mode,
    open,
    refreshAuthentication,
  ]);

  useEffect(() => {
    if (!open) return;
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
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("message", onMessage);
      channel?.removeEventListener("message", onChannelMessage);
      channel?.close();
    };
  }, [handleLinePopupResult, open, refreshAuthentication]);

  useLayoutEffect(() => {
    if (!open) {
      invalidateLineAttempt(true);
      invalidatePasskeyAttempt();
    }
  }, [invalidateLineAttempt, invalidatePasskeyAttempt, open]);

  useLayoutEffect(
    () => () => {
      invalidateLineAttempt(true);
      invalidatePasskeyAttempt();
    },
    [invalidateLineAttempt, invalidatePasskeyAttempt],
  );

  useEffect(() => {
    const onPageHide = () => {
      const navigation = lineSameTabNavigationRef.current;
      if (
        navigation &&
        isCurrentLineAttempt(navigation.generation) &&
        markLineSameTabNavigationCommitted(
          navigation,
          lineSameTabNavigationEpochRef.current,
        )
      ) {
        cancelSameTabRecovery();
        cancelSameTabBeforeUnload();
      }
      if (passkeyAbortControllerRef.current) {
        invalidatePasskeyAttempt();
        busyRef.current = null;
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (busyRef.current === null && mountedRef.current && openRef.current) {
        setBusy(null);
      }
      const navigation = lineSameTabNavigationRef.current;
      if (
        !navigation?.committed ||
        navigation.epoch !== lineSameTabNavigationEpochRef.current ||
        !isCurrentLineAttempt(navigation.generation)
      ) {
        return;
      }
      const generation = navigation.generation;
      lineSameTabNavigationRef.current = null;
      cancelSameTabRecovery();
      void refreshAuthentication(() => isCurrentLineAttempt(generation))
        .then((complete) => {
          if (!isCurrentLineAttempt(generation)) return;
          if (complete) {
            invalidateLineAttempt(false);
            return;
          }
          recoverSameTabAttempt(
            generation,
            "LINEログインが完了していません。もう一度お試しください。",
          );
        })
        .catch(() => {
          recoverSameTabAttempt(
            generation,
            "ログイン状態を確認できませんでした。もう一度お試しください。",
          );
        });
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [
    cancelSameTabBeforeUnload,
    cancelSameTabRecovery,
    invalidateLineAttempt,
    invalidatePasskeyAttempt,
    isCurrentLineAttempt,
    recoverSameTabAttempt,
    refreshAuthentication,
  ]);

  useEffect(() => {
    if (!open || busy !== "line" || !linePopupRef.current) return;
    const generation = lineAttemptGenerationRef.current;
    let active = true;
    let checking = false;
    const checkPopup = async () => {
      if (!active || checking || !isCurrentLineAttempt(generation)) return;
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
          let refreshFailed = false;
          const complete = await refreshAuthentication(
            () => isCurrentLineAttempt(generation),
          ).catch(() => {
            refreshFailed = true;
            return false;
          });
          if (!isCurrentLineAttempt(generation)) return;
          if (complete) {
            invalidateLineAttempt(false);
            return;
          }
          if (refreshFailed) {
            invalidateLineAttempt(true);
            if (!mountedRef.current || !openRef.current) return;
            setError(
              "ログイン状態を確認できませんでした。通信状態を確認して、もう一度お試しください。",
            );
            busyRef.current = null;
            setBusy(null);
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
          invalidateLineAttempt(true);
          setError(
            waitingFor >= LINE_POPUP_MAX_WAIT_MS
              ? "LINEログインの有効時間が切れました。もう一度お試しください。"
              : "LINEログインが完了していません。もう一度お試しください。",
          );
          busyRef.current = null;
          setBusy(null);
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
  }, [
    busy,
    invalidateLineAttempt,
    isCurrentLineAttempt,
    open,
    refreshAuthentication,
  ]);

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
      if (event.key === "Escape") {
        if (busyRef.current === "passkey") {
          event.preventDefault();
          cancelPasskeyAttempt();
          return;
        }
        if (busyRef.current === null) {
          event.preventDefault();
          onCloseRef.current();
          return;
        }
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
  }, [cancelPasskeyAttempt, open, portalTarget]);

  if (!open || !portalTarget) return null;

  const authenticateWithPasskey = async () => {
    if (!claimAuthenticationBusy(busyRef, "passkey")) return;
    setError("");
    setBusy("passkey");
    const { controller, generation } = beginPasskeyAttempt();
    const stillCurrent = () =>
      isCurrentPasskeyAttempt(generation, controller);
    try {
      const path =
        mode === "reauthenticate"
          ? "/api/account/passkey/reauth/options"
          : "/api/account/passkey/login/options";
      await runGuardedAuthenticationSequence({
        isCurrent: stillCurrent,
        ensureContext: () => ensureAuthenticationContext(controller.signal),
        loadOptions: async () => {
          const prepared = await postJson<{
            options?: PublicKeyCredentialRequestOptionsJSON;
          }>(path, undefined, controller.signal);
          if (!prepared.options) {
            throw new Error("本人確認を開始できませんでした。");
          }
          return prepared.options;
        },
        requestCredential: (options) =>
          startAuthentication({ optionsJSON: options }),
        verifyCredential: async (credential) => {
          await postJson<{ authenticated: boolean }>(
            "/api/account/passkey/login/verify",
            credential as unknown as Record<string, unknown>,
            controller.signal,
          );
        },
        refreshAuthentication: () => refreshAuthentication(stillCurrent),
      });
    } catch (cause) {
      if (!stillCurrent()) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "本人確認を完了できませんでした。",
      );
    } finally {
      if (!stillCurrent()) return;
      invalidatePasskeyAttempt();
      busyRef.current = null;
      setBusy(null);
    }
  };

  const authenticateWithLine = async (sameTabOnly = false) => {
    if (!claimAuthenticationBusy(busyRef, "line")) return;
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

    const navigateLineSameTab = async (
      generation = lineAttemptGenerationRef.current,
    ) => {
      const navigation = createLineSameTabNavigationEpoch(
        lineSameTabNavigationEpochRef.current + 1,
        generation,
      );
      lineSameTabNavigationEpochRef.current = navigation.epoch;
      lineSameTabNavigationRef.current = navigation;
      armSameTabRecovery(navigation, LINE_SAME_TAB_START_RECOVERY_MS);
      try {
        await ensureAuthenticationContext();
        if (!isCurrentLineAttempt(generation)) return;
        startUrl.searchParams.delete("popup");
        startUrl.searchParams.delete("popupFlow");
        startUrl.searchParams.set(
          "returnTo",
          currentAuthenticationReturnTo(),
        );
        attachSameTabBeforeUnloadRecovery(navigation);
        try {
          window.location.assign(startUrl.toString());
        } catch {
          recoverSameTabAttempt(generation);
        }
      } catch (cause) {
        if (!isCurrentLineAttempt(generation)) return;
        invalidateLineAttempt(false);
        if (!mountedRef.current || !openRef.current) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "LINEログインを開始できませんでした。",
        );
        setLineSameTabFallback(reason === "ai");
        busyRef.current = null;
        setBusy(null);
      }
    };

    if (sameTabOnly) {
      beginLineAttempt(null);
      await navigateLineSameTab();
      return;
    }

    const offerEditorSameTabFallback = (generation: number) => {
      if (!isCurrentLineAttempt(generation)) return;
      invalidateLineAttempt(true);
      if (!mountedRef.current || !openRef.current) return;
      setError(
        "ポップアップを開けませんでした。このタブで続ける場合、素材の再選択が必要になることがあります。",
      );
      setLineSameTabFallback(true);
      busyRef.current = null;
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
    const generation = beginLineAttempt(popup);
    if (!popup) {
      if (reason === "ai") {
        offerEditorSameTabFallback(generation);
        return;
      }
      await navigateLineSameTab(generation);
      return;
    }
    try {
      popup.opener = null;
    } catch {
      // The result channel and final session check do not rely on opener.
    }

    const flowId = crypto.randomUUID();
    startUrl.searchParams.set("popup", "1");
    startUrl.searchParams.set("popupFlow", flowId);
    linePopupFlowRef.current = flowId;

    try {
      await ensureAuthenticationContext();
    } catch (cause) {
      if (!isCurrentLineAttempt(generation)) return;
      invalidateLineAttempt(true);
      if (!mountedRef.current || !openRef.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "LINEログインを開始できませんでした。",
      );
      busyRef.current = null;
      setBusy(null);
      return;
    }
    if (!isCurrentLineAttempt(generation)) return;
    if (isPopupClosed(popup)) {
      invalidateLineAttempt(false);
      if (!mountedRef.current || !openRef.current) return;
      setError("LINEログイン画面が閉じられました。もう一度お試しください。");
      setLineSameTabFallback(reason === "ai");
      busyRef.current = null;
      setBusy(null);
      return;
    }
    try {
      popup.location.replace(startUrl.toString());
    } catch {
      if (!isCurrentLineAttempt(generation)) return;
      if (reason === "ai") {
        offerEditorSameTabFallback(generation);
        return;
      }
      invalidateLineAttempt(true);
      if (!mountedRef.current || !openRef.current) return;
      busyRef.current = "line";
      setBusy("line");
      const fallbackGeneration = beginLineAttempt(null);
      await navigateLineSameTab(fallbackGeneration);
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
        {busy === "passkey" ? (
          <button
            type="button"
            className="authenticationSameTabFallback"
            onClick={cancelPasskeyAttempt}
          >
            パスキーによる本人確認を中止
          </button>
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
