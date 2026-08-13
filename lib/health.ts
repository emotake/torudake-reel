import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  getStripeReadiness,
  isBillingConfigured,
  stripeBillingMode,
} from "./stripe";

type OperationsEnvironment = {
  OPENAI_API_KEY?: string;
  OPS_HEALTH_SECRET?: string;
};

const MINIMUM_OPERATIONS_SECRET_LENGTH = 32;

function operationsEnvironment() {
  return env as typeof env & OperationsEnvironment;
}

async function digest(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeSecretEqual(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([
    digest(left),
    digest(right),
  ]);
  let difference = leftDigest.byteLength ^ rightDigest.byteLength;
  const length = Math.max(leftDigest.byteLength, rightDigest.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

export function isConstantTimeSecretEqualForTest(
  left: string,
  right: string,
) {
  return constantTimeSecretEqual(left, right);
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]{1,512})$/i.exec(authorization);
  return match?.[1] ?? request.headers.get("x-operations-key")?.trim() ?? "";
}

export function isDetailedHealthConfigured() {
  return (
    operationsEnvironment().OPS_HEALTH_SECRET?.trim().length ?? 0
  ) >= MINIMUM_OPERATIONS_SECRET_LENGTH;
}

export async function authorizeDetailedHealth(request: Request) {
  const configuredSecret =
    operationsEnvironment().OPS_HEALTH_SECRET?.trim() ?? "";
  const suppliedSecret = bearerToken(request);
  if (
    configuredSecret.length < MINIMUM_OPERATIONS_SECRET_LENGTH ||
    !suppliedSecret
  ) {
    return false;
  }
  return constantTimeSecretEqual(suppliedSecret, configuredSecret);
}

export async function checkDatabaseReadiness() {
  const startedAt = Date.now();
  try {
    const rows = await getDb().all<{ ok: number }>(sql`SELECT 1 AS ok`);
    return {
      ok: rows[0]?.ok === 1,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}

export async function detailedOperationalHealth() {
  const [database, stripe] = await Promise.all([
    checkDatabaseReadiness(),
    isBillingConfigured()
      ? getStripeReadiness()
      : Promise.resolve(null),
  ]);
  const openAiConfigured = Boolean(
    operationsEnvironment().OPENAI_API_KEY?.trim(),
  );
  const billingReady = stripe?.ready === true;

  return {
    ready: database.ok && openAiConfigured && billingReady,
    checks: {
      runtime: { ok: true },
      database,
      openai: { configured: openAiConfigured },
      billing: {
        configured: isBillingConfigured(),
        ready: billingReady,
        mode: stripeBillingMode(),
        catalogValid: stripe?.catalogValid ?? false,
        chargesEnabled: stripe?.chargesEnabled ?? null,
        detailsSubmitted: stripe?.detailsSubmitted ?? null,
        problem: stripe?.problem ?? "not_configured",
      },
    },
  };
}
