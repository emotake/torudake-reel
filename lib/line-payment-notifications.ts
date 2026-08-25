import { env } from "cloudflare:workers";
import type { MonthlyPlanKey } from "./billing-policy";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type LinePaymentNotificationEnvironment = {
  LINE_PAYMENT_NOTIFICATION_ENABLED?: string;
  LINE_PAYMENT_NOTIFICATION_ACCESS_TOKEN?: string;
  LINE_PAYMENT_NOTIFICATION_TO?: string;
};

export type LinePaymentNotification = {
  amount: number;
  billingReason: string;
  currency: "jpy";
  occurredAt: number;
  plan: MonthlyPlanKey | "one_time";
};

export type LinePaymentNotificationResult = {
  outcome: "disabled" | "sent" | "duplicate";
  requestId: string | null;
  status: number | null;
};

export class LinePaymentNotificationError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly status: number | null;

  constructor(
    code: string,
    options: { requestId?: string | null; status?: number | null } = {},
  ) {
    super(code);
    this.name = "LinePaymentNotificationError";
    this.code = code;
    this.requestId = options.requestId ?? null;
    this.status = options.status ?? null;
  }
}

export function createOneTimePaymentNotification(
  session: Record<string, unknown>,
  occurredAt: number,
): LinePaymentNotification | null {
  const amount = positiveInteger(session.amount_total);
  const currency = normalizedString(session.currency)?.toLowerCase();
  const paymentStatus = normalizedString(session.payment_status);
  if (!amount || currency !== "jpy" || paymentStatus !== "paid") return null;
  return {
    amount,
    billingReason: "one_time",
    currency: "jpy",
    occurredAt,
    plan: "one_time",
  };
}

export function createPaidInvoiceNotification(
  invoice: Record<string, unknown>,
  plan: MonthlyPlanKey,
  occurredAt: number,
): LinePaymentNotification | null {
  const amount = positiveInteger(invoice.amount_paid);
  const currency = normalizedString(invoice.currency)?.toLowerCase();
  if (!amount || currency !== "jpy") return null;
  return {
    amount,
    billingReason: normalizedString(invoice.billing_reason) ?? "subscription",
    currency: "jpy",
    occurredAt,
    plan,
  };
}

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_RESPONSE_LIMIT_BYTES = 8 * 1024;
const LINE_REQUEST_TIMEOUT_MS = 4_000;
const LINE_RETRY_DELAY_MS = 250;
const MAX_LINE_ATTEMPTS = 2;
const LINE_TARGET_PATTERN = /^[UCR][0-9a-f]{32}$/i;
const PLAN_LABELS: Record<LinePaymentNotification["plan"], string> = {
  starter: "月3動画プラン",
  standard: "月7動画プラン",
  legacy_1480: "旧月8動画プラン",
  one_time: "1動画作成",
};

export function isLinePaymentNotificationEnabled(
  bindings: LinePaymentNotificationEnvironment =
    env as typeof env & LinePaymentNotificationEnvironment,
) {
  return bindings.LINE_PAYMENT_NOTIFICATION_ENABLED?.trim() === "true";
}

export async function sendLinePaymentNotification(
  notification: LinePaymentNotification,
  stripeEventId: string,
  options: {
    bindings?: LinePaymentNotificationEnvironment;
    fetcher?: FetchLike;
  } = {},
): Promise<LinePaymentNotificationResult> {
  const bindings =
    options.bindings ??
    (env as typeof env & LinePaymentNotificationEnvironment);
  if (!isLinePaymentNotificationEnabled(bindings)) {
    return { outcome: "disabled", requestId: null, status: null };
  }

  const accessToken = boundedCredential(
    bindings.LINE_PAYMENT_NOTIFICATION_ACCESS_TOKEN,
    20,
    4_096,
  );
  const target = bindings.LINE_PAYMENT_NOTIFICATION_TO?.trim() ?? "";
  if (!accessToken || !LINE_TARGET_PATTERN.test(target)) {
    throw new LinePaymentNotificationError(
      "line_payment_notification_not_configured",
    );
  }
  assertNotification(notification);
  if (!/^evt_[A-Za-z0-9_]{4,250}$/.test(stripeEventId)) {
    throw new LinePaymentNotificationError(
      "line_payment_notification_invalid_event_id",
    );
  }

  const retryKey = await deterministicRetryKey(stripeEventId);
  const requestBody = JSON.stringify({
    to: target,
    messages: [
      {
        type: "text",
        text: formatPaymentNotification(notification, stripeEventId),
      },
    ],
  });
  const fetcher = options.fetcher ?? fetch;

  for (let attempt = 0; attempt < MAX_LINE_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(LINE_PUSH_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Line-Retry-Key": retryKey,
        },
        body: requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(LINE_REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt + 1 < MAX_LINE_ATTEMPTS) {
        await delay(LINE_RETRY_DELAY_MS);
        continue;
      }
      throw new LinePaymentNotificationError(
        "line_payment_notification_unavailable",
      );
    }

    const requestId = safeLineRequestId(
      response.headers.get("x-line-request-id"),
    );
    if (response.status === 200 || response.status === 409) {
      await readBoundedResponse(response);
      return {
        outcome: response.status === 200 ? "sent" : "duplicate",
        requestId,
        status: response.status,
      };
    }

    await response.body?.cancel("line_payment_notification_rejected").catch(
      () => undefined,
    );
    if (response.status >= 500 && attempt + 1 < MAX_LINE_ATTEMPTS) {
      await delay(LINE_RETRY_DELAY_MS);
      continue;
    }
    throw new LinePaymentNotificationError(
      response.status >= 500
        ? "line_payment_notification_unavailable"
        : "line_payment_notification_rejected",
      { requestId, status: response.status },
    );
  }

  throw new LinePaymentNotificationError(
    "line_payment_notification_unavailable",
  );
}

export function formatPaymentNotification(
  notification: LinePaymentNotification,
  stripeEventId: string,
) {
  assertNotification(notification);
  const amount = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(notification.amount);
  const occurredAt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(notification.occurredAt * 1_000));
  const reference = stripeEventId.slice(-12);
  return [
    "【撮るだけリール｜決済通知】",
    `内容：${PLAN_LABELS[notification.plan]}`,
    `金額：${amount}`,
    `区分：${billingReasonLabel(notification.billingReason)}`,
    `決済時刻：${occurredAt}`,
    `照合番号：${reference}`,
  ].join("\n");
}

function billingReasonLabel(reason: string) {
  if (reason === "subscription_create") return "月額プラン初回";
  if (reason === "subscription_cycle") return "月額プラン更新";
  if (reason === "subscription_update") return "月額プラン変更";
  if (reason === "one_time") return "都度購入";
  return "月額プラン決済";
}

function assertNotification(notification: LinePaymentNotification) {
  if (
    notification.currency !== "jpy" ||
    !Number.isSafeInteger(notification.amount) ||
    notification.amount <= 0 ||
    !Number.isSafeInteger(notification.occurredAt) ||
    notification.occurredAt <= 0 ||
    !(notification.plan in PLAN_LABELS) ||
    !/^[a-z_]{1,80}$/.test(notification.billingReason)
  ) {
    throw new LinePaymentNotificationError(
      "line_payment_notification_invalid_payload",
    );
  }
}

async function deterministicRetryKey(stripeEventId: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`torudake-payment:${stripeEventId}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

async function readBoundedResponse(response: Response) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > LINE_RESPONSE_LIMIT_BYTES
    ) {
      await response.body?.cancel("line_response_too_large").catch(
        () => undefined,
      );
      throw new LinePaymentNotificationError(
        "line_payment_notification_invalid_response",
        { status: response.status },
      );
    }
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > LINE_RESPONSE_LIMIT_BYTES) {
        await reader.cancel("line_response_too_large").catch(() => undefined);
        throw new LinePaymentNotificationError(
          "line_payment_notification_invalid_response",
          { status: response.status },
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function boundedCredential(
  value: string | undefined,
  minimum: number,
  maximum: number,
) {
  const normalized = value?.trim() ?? "";
  return normalized.length >= minimum &&
    normalized.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function safeLineRequestId(value: string | null) {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : null;
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function normalizedString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 80
    ? value
    : null;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
