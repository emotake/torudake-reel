import { env } from "cloudflare:workers";

type StripeEnvironment = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_LIGHT_MONTHLY?: string;
  STRIPE_PRICE_ONE_TIME?: string;
};

export type StripePlan = "light" | "one_time";

export function getStripeConfig() {
  const stripeEnv = env as typeof env & StripeEnvironment;
  return {
    secretKey: stripeEnv.STRIPE_SECRET_KEY?.trim() ?? "",
    webhookSecret: stripeEnv.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    lightPriceId: stripeEnv.STRIPE_PRICE_LIGHT_MONTHLY?.trim() ?? "",
    oneTimePriceId: stripeEnv.STRIPE_PRICE_ONE_TIME?.trim() ?? "",
  };
}

export function isBillingConfigured() {
  const config = getStripeConfig();
  return Boolean(
    config.secretKey &&
      config.webhookSecret &&
      config.lightPriceId &&
      config.oneTimePriceId,
  );
}

export function stripePriceForPlan(plan: StripePlan) {
  const config = getStripeConfig();
  return plan === "light" ? config.lightPriceId : config.oneTimePriceId;
}

export async function stripeRequest<T>(
  path: string,
  values: URLSearchParams,
  idempotencyKey?: string,
): Promise<T> {
  const { secretKey } = getStripeConfig();
  if (!secretKey) {
    throw new Error("Stripe is not configured.");
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: values,
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!response.ok || !payload) {
    throw new Error(
      payload?.error?.message ?? "Stripeへの接続に失敗しました。",
    );
  }
  return payload;
}

export async function stripeGet<T>(path: string): Promise<T> {
  const { secretKey } = getStripeConfig();
  if (!secretKey) throw new Error("Stripe is not configured.");

  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!response.ok || !payload) {
    throw new Error(
      payload?.error?.message ?? "Stripeへの接続に失敗しました。",
    );
  }
  return payload;
}

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const fields = signatureHeader.split(",").map((field) => field.trim());
  const timestamp = Number(
    fields.find((field) => field.startsWith("t="))?.slice(2),
  );
  const signatures = fields
    .filter((field) => field.startsWith("v1="))
    .map((field) => field.slice(3));

  if (
    !Number.isFinite(timestamp) ||
    Math.abs(nowSeconds - timestamp) > 300 ||
    signatures.length === 0
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  const expected = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function publicOrigin(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
  const host =
    forwardedHost && /^[a-z0-9.-]+(?::\d+)?$/i.test(forwardedHost)
      ? forwardedHost
      : requestUrl.host;
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : requestUrl.protocol.replace(":", "");
  return `${protocol}://${host}`;
}
