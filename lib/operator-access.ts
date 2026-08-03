import { and, eq, gt, isNull } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { operatorDevices } from "../db/schema";
import {
  getCurrentUser,
  type CurrentUser,
} from "./current-user";
import {
  getOperatorSessionToken,
  normalizeOperatorLabel,
  OPERATOR_ACCESS_DAYS,
  randomOperatorToken,
} from "./operator-session";
import {
  getRegisteredTrialSessionId,
  trialSessionPrincipalEmail,
} from "./trial-session-store";
export {
  clearOperatorSessionCookie,
  getOperatorSessionToken,
  isSameOriginMutation,
  normalizeOperatorLabel,
  OPERATOR_ACCESS_DAYS,
  OPERATOR_COOKIE_NAME,
  operatorSessionCookie,
} from "./operator-session";

export const OPERATOR_SLOT = "primary";

const OPERATOR_INTERNAL_USER: CurrentUser = {
  email: "operator-device@internal.torudake.invalid",
  fullName: "運営端末",
};

type OperatorEnvironment = {
  OPERATOR_ENROLLMENT_CODE?: string;
};

type D1Statement = {
  bind?: (...values: unknown[]) => D1Statement;
};

type D1SchemaDatabase = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

let operatorSchemaReady = false;

async function ensureOperatorSchema() {
  if (operatorSchemaReady) return;
  const database = env.DB as unknown as D1SchemaDatabase | undefined;
  if (!database?.prepare || !database?.batch) {
    throw new Error("Operator device database binding is unavailable.");
  }

  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS operator_devices (
        slot text PRIMARY KEY NOT NULL,
        session_hash text NOT NULL,
        label text NOT NULL,
        activated_at integer NOT NULL,
        expires_at integer NOT NULL,
        revoked_at integer
      )
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS operator_devices_session_hash_unique
      ON operator_devices (session_hash)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS operator_devices_expires_at_idx
      ON operator_devices (expires_at)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS operator_devices_revoked_at_idx
      ON operator_devices (revoked_at)
    `),
  ]);
  operatorSchemaReady = true;
}

export function isOperatorEnrollmentConfigured() {
  const length = operatorEnrollmentCode().length;
  return length >= 20 && length <= 200;
}

export async function operatorEnrollmentCodeMatches(candidate: string) {
  const expected = operatorEnrollmentCode();
  if (
    expected.length < 20 ||
    expected.length > 200 ||
    candidate.length < 1 ||
    candidate.length > 200
  ) {
    return false;
  }
  return constantTimeHashEqual(candidate, expected);
}

export async function activateOperatorDevice(
  label: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureOperatorSchema();
  const token = randomOperatorToken();
  const sessionHash = await sha256(token);
  const expiresAt =
    nowSeconds + OPERATOR_ACCESS_DAYS * 24 * 60 * 60;

  await getDb()
    .insert(operatorDevices)
    .values({
      slot: OPERATOR_SLOT,
      sessionHash,
      label: normalizeOperatorLabel(label),
      activatedAt: nowSeconds,
      expiresAt,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: operatorDevices.slot,
      set: {
        sessionHash,
        label: normalizeOperatorLabel(label),
        activatedAt: nowSeconds,
        expiresAt,
        revokedAt: null,
      },
    });

  return {
    token,
    label: normalizeOperatorLabel(label),
    activatedAt: nowSeconds,
    expiresAt,
  };
}

export async function getOperatorDevice(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const token = getOperatorSessionToken(request);
  if (!token) return null;

  await ensureOperatorSchema();
  const sessionHash = await sha256(token);
  const rows = await getDb()
    .select({
      label: operatorDevices.label,
      activatedAt: operatorDevices.activatedAt,
      expiresAt: operatorDevices.expiresAt,
    })
    .from(operatorDevices)
    .where(
      and(
        eq(operatorDevices.slot, OPERATOR_SLOT),
        eq(operatorDevices.sessionHash, sessionHash),
        isNull(operatorDevices.revokedAt),
        gt(operatorDevices.expiresAt, nowSeconds),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function revokeOperatorDevice(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const token = getOperatorSessionToken(request);
  if (!token) return false;

  await ensureOperatorSchema();
  const sessionHash = await sha256(token);
  const revoked = await getDb()
    .update(operatorDevices)
    .set({ revokedAt: nowSeconds })
    .where(
      and(
        eq(operatorDevices.slot, OPERATOR_SLOT),
        eq(operatorDevices.sessionHash, sessionHash),
        isNull(operatorDevices.revokedAt),
      ),
    )
    .returning({ slot: operatorDevices.slot });
  return revoked.length > 0;
}

export async function getUsagePrincipal(
  request: Request,
  options: { allowTrial?: boolean } = {},
) {
  const operatorDevice = isOperatorEnrollmentConfigured()
    ? await getOperatorDevice(request)
    : null;
  if (operatorDevice) {
    return {
      currentUser: OPERATOR_INTERNAL_USER,
      operatorDevice,
      isOperator: true,
    } as const;
  }
  const authenticatedUser = getCurrentUser(request);
  if (authenticatedUser) {
    return {
      currentUser: authenticatedUser,
      operatorDevice: null,
      isOperator: false,
    } as const;
  }

  const trialSessionId = options.allowTrial
    ? await getRegisteredTrialSessionId(request)
    : null;
  const trialPrincipalEmail = trialSessionId
    ? await trialSessionPrincipalEmail(trialSessionId)
    : null;
  return {
    currentUser: trialPrincipalEmail
      ? {
          // Never persist the bearer cookie value in user or transfer records.
          email: trialPrincipalEmail,
          fullName: null,
        }
      : null,
    operatorDevice: null,
    isOperator: false,
  } as const;
}

function operatorEnrollmentCode() {
  const operatorEnv = env as typeof env & OperatorEnvironment;
  return operatorEnv.OPERATOR_ENROLLMENT_CODE?.trim() ?? "";
}

async function constantTimeHashEqual(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([
    sha256(left),
    sha256(right),
  ]);
  let difference = 0;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
