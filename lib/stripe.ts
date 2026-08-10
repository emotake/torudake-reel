import { env } from "cloudflare:workers";
import { SITE_ORIGIN } from "./site";
import {
  LEGACY_MONTHLY_PRICE_JPY,
  type MonthlyPlanKey,
  ONE_TIME_PRICE_JPY,
  STANDARD_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_PRICE_JPY,
} from "./billing-policy";

type StripeEnvironment = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER_MONTHLY?: string;
  STRIPE_PRICE_STANDARD_MONTHLY?: string;
  // The former ¥1,480 price is retained only to keep existing subscriptions
  // synchronized. It is never offered by Checkout.
  STRIPE_PRICE_LIGHT_MONTHLY?: string;
  STRIPE_PRICE_ONE_TIME?: string;
  PUBLIC_ORIGIN?: string;
};

export type StripePlan = "starter" | "standard" | "one_time";

type StripePrice = {
  id?: string;
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  type?: string;
  recurring?: {
    interval?: string;
    interval_count?: number;
    usage_type?: string;
  } | null;
};

type StripeAccount = {
  charges_enabled?: boolean;
  details_submitted?: boolean;
};

export type StripeReadiness = {
  ready: boolean;
  mode: "live" | "test" | "unconfigured";
  catalogValid: boolean;
  chargesEnabled: boolean | null;
  detailsSubmitted: boolean | null;
  problem: "not_configured" | "price_mismatch" | "account_not_activated" | "stripe_unreachable" | null;
};

let cachedReadiness:
  | { expiresAt: number; value: StripeReadiness }
  | undefined;

export function getStripeConfig() {
  const stripeEnv = env as typeof env & StripeEnvironment;
  return {
    secretKey: stripeEnv.STRIPE_SECRET_KEY?.trim() ?? "",
    webhookSecret: stripeEnv.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    starterPriceId:
      stripeEnv.STRIPE_PRICE_STARTER_MONTHLY?.trim() ?? "",
    standardPriceId:
      stripeEnv.STRIPE_PRICE_STANDARD_MONTHLY?.trim() ?? "",
    legacyPriceId: stripeEnv.STRIPE_PRICE_LIGHT_MONTHLY?.trim() ?? "",
    oneTimePriceId: stripeEnv.STRIPE_PRICE_ONE_TIME?.trim() ?? "",
  };
}

export function isBillingConfigured() {
  const config = getStripeConfig();
  return Boolean(
    config.secretKey &&
      config.webhookSecret &&
      config.starterPriceId &&
      config.standardPriceId &&
      config.oneTimePriceId,
  );
}

export function stripeBillingMode() {
  const { secretKey } = getStripeConfig();
  if (secretKey.startsWith("sk_live_")) return "live" as const;
  if (secretKey.startsWith("sk_test_")) return "test" as const;
  return "unconfigured" as const;
}

export async function getStripeReadiness(): Promise<StripeReadiness> {
  const mode = stripeBillingMode();
  if (!isBillingConfigured() || mode === "unconfigured") {
    return {
      ready: false,
      mode,
      catalogValid: false,
      chargesEnabled: null,
      detailsSubmitted: null,
      problem: "not_configured",
    };
  }
  const now = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.value;
  }

  let value: StripeReadiness;
  try {
    const config = getStripeConfig();
    const [starterPrice, standardPrice, oneTimePrice, legacyPrice, account] =
      await Promise.all([
        stripeGet<StripePrice>(
          `/v1/prices/${encodeURIComponent(config.starterPriceId)}`,
        ),
        stripeGet<StripePrice>(
          `/v1/prices/${encodeURIComponent(config.standardPriceId)}`,
        ),
        stripeGet<StripePrice>(
          `/v1/prices/${encodeURIComponent(config.oneTimePriceId)}`,
        ),
        config.legacyPriceId
          ? stripeGet<StripePrice>(
              `/v1/prices/${encodeURIComponent(config.legacyPriceId)}`,
            )
          : Promise.resolve(null),
        stripeGet<StripeAccount>("/v1/account"),
      ]);
    const catalogValid =
      validMonthlyPrice(
        starterPrice,
        config.starterPriceId,
        STARTER_MONTHLY_PRICE_JPY,
      ) &&
      validMonthlyPrice(
        standardPrice,
        config.standardPriceId,
        STANDARD_MONTHLY_PRICE_JPY,
      ) &&
      validOneTimePrice(oneTimePrice, config.oneTimePriceId) &&
      (!legacyPrice ||
        validMonthlyPrice(
          legacyPrice,
          config.legacyPriceId,
          LEGACY_MONTHLY_PRICE_JPY,
          false,
        ));
    const chargesEnabled = account.charges_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    const liveAccountReady =
      mode !== "live" || (chargesEnabled && detailsSubmitted);
    value = {
      ready: catalogValid && liveAccountReady,
      mode,
      catalogValid,
      chargesEnabled,
      detailsSubmitted,
      problem: !catalogValid
        ? "price_mismatch"
        : !liveAccountReady
          ? "account_not_activated"
          : null,
    };
  } catch {
    value = {
      ready: false,
      mode,
      catalogValid: false,
      chargesEnabled: null,
      detailsSubmitted: null,
      problem: "stripe_unreachable",
    };
  }
  cachedReadiness = { expiresAt: now + 5 * 60 * 1_000, value };
  return value;
}

export function stripePriceForPlan(plan: StripePlan) {
  const config = getStripeConfig();
  if (plan === "starter") return config.starterPriceId;
  if (plan === "standard") return config.standardPriceId;
  return config.oneTimePriceId;
}

export function stripeMonthlyPlanForPrice(
  priceId: string,
): MonthlyPlanKey | null {
  const config = getStripeConfig();
  if (priceId === config.starterPriceId && config.starterPriceId) {
    return "starter";
  }
  if (priceId === config.standardPriceId && config.standardPriceId) {
    return "standard";
  }
  if (priceId === config.legacyPriceId && config.legacyPriceId) {
    return "legacy_1480";
  }
  return null;
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
  if (!webhookSecret || signatureHeader.length > 16_384) return false;

  const fields = signatureHeader.split(",").map((field) => field.trim());
  const timestampValue = fields
    .find((field) => field.startsWith("t="))
    ?.slice(2);
  const timestamp = /^\d{1,12}$/.test(timestampValue ?? "")
    ? Number(timestampValue)
    : Number.NaN;
  const signatures = fields
    .filter((field) => field.startsWith("v1="))
    .map((field) => field.slice(3))
    .filter((signature) => /^[0-9a-f]{64}$/.test(signature));

  if (
    !Number.isInteger(timestamp) ||
    timestamp <= 0 ||
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
  const stripeEnv = env as typeof env & StripeEnvironment;
  const configuredOrigin = stripeEnv.PUBLIC_ORIGIN?.trim();
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (
        url.origin === configuredOrigin.replace(/\/$/, "") &&
        (url.protocol === "https:" || isLocalDevelopmentHost(url.hostname))
      ) {
        return url.origin;
      }
    } catch {
      // Fall back to the request's canonical origin.
    }
  }
  if (isLocalDevelopmentHost(requestUrl.hostname)) return requestUrl.origin;
  return new URL(SITE_ORIGIN).origin;
}

export function isCanonicalBillingRequest(request: Request) {
  const requestUrl = new URL(request.url);
  return (
    isLocalDevelopmentHost(requestUrl.hostname) ||
    requestUrl.origin === publicOrigin(request)
  );
}

export function isStripeWebhookConfigured() {
  const config = getStripeConfig();
  return Boolean(
    config.secretKey &&
      config.webhookSecret &&
      (config.starterPriceId ||
        config.standardPriceId ||
        config.legacyPriceId ||
        config.oneTimePriceId),
  );
}

function isLocalDevelopmentHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function validMonthlyPrice(
  price: StripePrice,
  expectedId: string,
  expectedAmount: number,
  requireActive = true,
) {
  return (
    price.id === expectedId &&
    (!requireActive || typeof price.active === "boolean") &&
    (!requireActive || price.active === true) &&
    price.currency?.toLowerCase() === "jpy" &&
    price.unit_amount === expectedAmount &&
    price.type === "recurring" &&
    price.recurring?.interval === "month" &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === "licensed"
  );
}

function validOneTimePrice(price: StripePrice, expectedId: string) {
  return (
    price.id === expectedId &&
    price.active === true &&
    price.currency?.toLowerCase() === "jpy" &&
    price.unit_amount === ONE_TIME_PRICE_JPY &&
    price.type === "one_time" &&
    !price.recurring
  );
}
