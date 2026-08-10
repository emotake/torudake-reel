"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";

type OperatorStatus = {
  configured: boolean;
  registered: boolean;
  label: string | null;
  activatedAt: number | null;
  expiresAt: number | null;
};

const EMPTY_STATUS: OperatorStatus = {
  configured: false,
  registered: false,
  label: null,
  activatedAt: null,
  expiresAt: null,
};

export default function OperatorDeviceClient() {
  const [status, setStatus] = useState<OperatorStatus | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("運営端末");
  const [busy, setBusy] = useState<"enroll" | "revoke" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/operator/status", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as OperatorStatus;
        if (!response.ok) throw new Error("登録状態を確認できませんでした。");
        setStatus(payload);
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setStatus(EMPTY_STATUS);
        setError("登録状態を確認できませんでした。");
      });
    return () => controller.abort();
  }, []);

  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy("enroll");
    setError("");
    try {
      const response = await fetch("/api/operator/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          label: label.trim(),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as
        Partial<OperatorStatus> & { error?: string };
      if (!response.ok || !payload.registered) {
        throw new Error(
          payload.error || "登録情報を確認できませんでした。",
        );
      }
      setCode("");
      setStatus({
        configured: true,
        registered: true,
        label: payload.label ?? (label.trim() || "運営端末"),
        activatedAt: Math.floor(Date.now() / 1_000),
        expiresAt: payload.expiresAt ?? null,
      });
    } catch (enrollError) {
      setCode("");
      setError(
        enrollError instanceof Error
          ? enrollError.message
          : "登録情報を確認できませんでした。",
      );
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (busy) return;
    setBusy("revoke");
    setError("");
    try {
      const response = await fetch("/api/operator/revoke", {
        method: "POST",
      });
      if (!response.ok) throw new Error("登録を解除できませんでした。");
      setStatus((current) => ({
        ...(current ?? EMPTY_STATUS),
        registered: false,
        label: null,
        activatedAt: null,
        expiresAt: null,
      }));
    } catch (revokeError) {
      setError(
        revokeError instanceof Error
          ? revokeError.message
          : "登録を解除できませんでした。",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="operatorAccessPage">
      <section className="operatorAccessCard">
        <div className="operatorAccessMark" aria-hidden="true">
          {status?.registered ? "✓" : "•••"}
        </div>
        <p className="operatorAccessEyebrow">DEVICE ACCESS</p>

        {!status && (
          <>
            <h1>端末の状態を確認中</h1>
            <p className="operatorAccessLead">そのまま少しお待ちください。</p>
          </>
        )}

        {status?.registered && (
          <>
            <h1>この端末は登録済みです</h1>
            <p className="operatorAccessLead">
              {status.label || "運営端末"}として、購入手続きなしで動画を作成できます。
            </p>
            <dl className="operatorAccessDetails">
              <div>
                <dt>端末</dt>
                <dd>{status.label || "運営端末"}</dd>
              </div>
              <div>
                <dt>有効期限</dt>
                <dd>{formatDate(status.expiresAt)}</dd>
              </div>
            </dl>
            <Link className="operatorAccessPrimary" href="/">
              動画を作る
            </Link>
            <button
              className="operatorAccessQuiet"
              type="button"
              disabled={busy !== null}
              onClick={revoke}
            >
              {busy === "revoke" ? "解除しています…" : "この端末の登録を解除"}
            </button>
          </>
        )}

        {status && !status.registered && (
          <>
            <h1>運営端末を登録</h1>
            <p className="operatorAccessLead">
              このブラウザを運営用の利用枠へ追加します。登録済みのスマホやPCはそのまま利用でき、最大5台まで登録できます。
            </p>

            {status.configured ? (
              <form className="operatorAccessForm" onSubmit={enroll}>
                <label>
                  端末名
                  <input
                    type="text"
                    value={label}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
                <label>
                  登録コード
                  <input
                    type="password"
                    value={code}
                    maxLength={200}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
                <button
                  className="operatorAccessPrimary"
                  type="submit"
                  disabled={busy !== null || !code.trim()}
                >
                  {busy === "enroll"
                    ? "登録しています…"
                    : "この端末を登録"}
                </button>
              </form>
            ) : (
              <p className="operatorAccessUnavailable">
                登録準備が完了していません。運営者へご確認ください。
              </p>
            )}
          </>
        )}

        {error && (
          <p className="operatorAccessError" role="alert">
            {error}
          </p>
        )}

        <p className="operatorAccessNote">
          登録はブラウザ単位です。Webサイトデータの削除、プライベートブラウズ、別ブラウザでは再登録が必要です。
        </p>
      </section>
    </main>
  );
}

function formatDate(value: number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value * 1_000));
}
