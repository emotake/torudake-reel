import { getOrCreateBillingUser } from "../../../../lib/billing-store";
import {
  authenticationRequired,
  authenticationUnavailable,
  getCurrentUser,
  isSitesAuthenticationTrusted,
} from "../../../../lib/current-user";
import { isPasskeyAuthenticationConfigured } from "../../../../lib/account-auth";
import {
  isBillingConfigured,
  isCanonicalBillingRequest,
  publicOrigin,
  stripeGet,
  stripeRequest,
} from "../../../../lib/stripe";
import { isSameOriginMutation } from "../../../../lib/operator-session";
import {
  billingRateLimitedResponse,
  consumeBillingRateLimit,
} from "../../../../lib/billing-rate-limit";

type StripePortalSession = {
  url: string;
};

type StripeChargeList = {
  data?: Array<{
    id?: unknown;
    amount?: unknown;
    amount_refunded?: unknown;
    created?: unknown;
    currency?: unknown;
    invoice?: unknown;
    receipt_url?: unknown;
    status?: unknown;
  }>;
};

type StripeInvoiceList = {
  data?: Array<{
    id?: unknown;
    amount_paid?: unknown;
    created?: unknown;
    currency?: unknown;
    hosted_invoice_url?: unknown;
    invoice_pdf?: unknown;
    number?: unknown;
    status?: unknown;
  }>;
};

export async function POST(request: Request) {
  if (!isCanonicalBillingRequest(request)) {
    return Response.json(
      {
        error: "最新の公開ページから決済管理を開いてください。",
        code: "non_canonical_billing_origin",
      },
      { status: 403 },
    );
  }
  if (
    !isSitesAuthenticationTrusted() &&
    !isPasskeyAuthenticationConfigured()
  ) {
    return authenticationUnavailable();
  }
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  if (!isBillingConfigured()) {
    return Response.json(
      { error: "決済管理は現在準備中です。" },
      { status: 503 },
    );
  }
  if (!isSameOriginMutation(request)) {
    return Response.json(
      {
        error: "決済管理リクエストを確認できませんでした。ページを再読み込みしてください。",
        code: "invalid_request_origin",
      },
      { status: 403 },
    );
  }

  try {
    const user = await getOrCreateBillingUser(currentUser);
    if (!user.stripeCustomerId) {
      return Response.json(
        { error: "まだ決済情報がありません。" },
        { status: 404 },
      );
    }
    const rateLimit = await consumeBillingRateLimit(user.id, "portal");
    if (!rateLimit.allowed) {
      return billingRateLimitedResponse(rateLimit);
    }
    const params = new URLSearchParams();
    params.set("customer", user.stripeCustomerId);
    params.set("return_url", `${publicOrigin(request)}/account`);
    const session = await stripeRequest<StripePortalSession>(
      "/v1/billing_portal/sessions",
      params,
    );
    return Response.json({ url: session.url });
  } catch (error) {
    console.error("billing portal creation failed", error);
    return Response.json(
      { error: "決済管理画面を開けませんでした。" },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  if (!isCanonicalBillingRequest(request)) {
    return privateJson(
      {
        error: "最新の公開ページから領収書を確認してください。",
        code: "non_canonical_billing_origin",
      },
      { status: 403 },
    );
  }
  if (
    !isSitesAuthenticationTrusted() &&
    !isPasskeyAuthenticationConfigured()
  ) {
    return authenticationUnavailable();
  }
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();
  if (!isBillingConfigured()) {
    return privateJson(
      { error: "領収書の確認は現在準備中です。" },
      { status: 503 },
    );
  }

  try {
    const user = await getOrCreateBillingUser(currentUser);
    if (!user.stripeCustomerId) {
      return privateJson({ documents: [] });
    }
    const rateLimit = await consumeBillingRateLimit(
      user.id,
      "billing_documents",
    );
    if (!rateLimit.allowed) {
      return billingRateLimitedResponse(rateLimit);
    }

    const customer = encodeURIComponent(user.stripeCustomerId);
    const [charges, invoices] = await Promise.all([
      stripeGet<StripeChargeList>(`/v1/charges?customer=${customer}&limit=10`),
      stripeGet<StripeInvoiceList>(
        `/v1/invoices?customer=${customer}&status=paid&limit=10`,
      ),
    ]);
    const chargeDocuments = Array.isArray(charges.data)
      ? charges.data.flatMap((charge) => {
          if (charge.invoice != null) return [];
          const url = safeStripeDocumentUrl(charge.receipt_url);
          if (
            !url ||
            typeof charge.id !== "string" ||
            typeof charge.created !== "number" ||
            typeof charge.amount !== "number" ||
            typeof charge.currency !== "string"
          ) {
            return [];
          }
          return [
            {
              id: `charge:${charge.id}`,
              kind: "receipt",
              label: "領収書",
              createdAt: charge.created,
              amount: charge.amount,
              amountRefunded:
                typeof charge.amount_refunded === "number"
                  ? charge.amount_refunded
                  : 0,
              currency: charge.currency.toUpperCase(),
              status:
                typeof charge.status === "string" ? charge.status : "unknown",
              url,
            },
          ];
        })
      : [];
    const invoiceDocuments = Array.isArray(invoices.data)
      ? invoices.data.flatMap((invoice) => {
          const url =
            safeStripeDocumentUrl(invoice.hosted_invoice_url) ??
            safeStripeDocumentUrl(invoice.invoice_pdf);
          if (
            !url ||
            typeof invoice.id !== "string" ||
            typeof invoice.created !== "number" ||
            typeof invoice.amount_paid !== "number" ||
            typeof invoice.currency !== "string"
          ) {
            return [];
          }
          return [
            {
              id: `invoice:${invoice.id}`,
              kind: "invoice",
              label:
                typeof invoice.number === "string"
                  ? `請求書 ${invoice.number}`
                  : "請求書",
              createdAt: invoice.created,
              amount: invoice.amount_paid,
              amountRefunded: 0,
              currency: invoice.currency.toUpperCase(),
              status:
                typeof invoice.status === "string" ? invoice.status : "paid",
              url,
            },
          ];
        })
      : [];
    const documents = [...invoiceDocuments, ...chargeDocuments]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 20);
    return privateJson({ documents });
  } catch (error) {
    console.error("billing documents retrieval failed", error);
    return privateJson(
      { error: "領収書・請求書を読み込めませんでした。" },
      { status: 502 },
    );
  }
}

function safeStripeDocumentUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function privateJson(body: Record<string, unknown>, init: ResponseInit = {}) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}
