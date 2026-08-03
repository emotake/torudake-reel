import { env } from "cloudflare:workers";
import { getTrialSessionId } from "./trial-session";

const TRIAL_SESSION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
const TRIAL_ISSUANCE_SECRET_MIN_LENGTH = 32;
const TRIAL_NETWORK_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const TRIAL_NETWORK_ISSUANCE_LIMIT = 8;
const TRIAL_GLOBAL_WINDOW_SECONDS = 24 * 60 * 60;
const TRIAL_GLOBAL_ISSUANCE_LIMIT = 100;

export type TrialSessionIssueErrorCode =
  | "trial_issuance_not_configured"
  | "trial_request_context_unavailable"
  | "trial_already_issued"
  | "trial_issuance_limited";

export class TrialSessionIssueError extends Error {
  readonly code: TrialSessionIssueErrorCode;
  readonly status: number;
  readonly publicMessage: string;

  constructor(
    code: TrialSessionIssueErrorCode,
    status: number,
    publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "TrialSessionIssueError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

let trialSessionSchemaReady = false;

async function ensureTrialSessionSchema() {
  if (trialSessionSchemaReady) return;
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare || !database?.batch) {
    throw new Error("Trial session database binding is unavailable.");
  }

  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS trial_sessions (
        session_hash text PRIMARY KEY NOT NULL,
        created_at integer NOT NULL,
        last_seen_at integer NOT NULL,
        expires_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS trial_sessions_expires_at_idx
      ON trial_sessions (expires_at)
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS trial_issuance_fingerprints (
        fingerprint_hash text PRIMARY KEY NOT NULL,
        network_hash text NOT NULL,
        session_hash text NOT NULL,
        created_at integer NOT NULL,
        last_seen_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS trial_issuance_session_hash_unique
      ON trial_issuance_fingerprints (session_hash)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS trial_issuance_network_created_idx
      ON trial_issuance_fingerprints (network_hash, created_at)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS trial_issuance_created_at_idx
      ON trial_issuance_fingerprints (created_at)
    `),
  ]);
  trialSessionSchemaReady = true;
}

export async function isRegisteredTrialSession(
  sessionId: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureTrialSessionSchema();
  const database = env.DB as unknown as D1Database;
  const sessionHash = await hashTrialSessionId(sessionId);
  const row = await database
    .prepare(`
      SELECT session_hash
      FROM trial_sessions
      WHERE session_hash = ?
        AND expires_at >= ?
      LIMIT 1
    `)
    .bind(sessionHash, nowSeconds)
    .first<{ session_hash: string }>();
  return Boolean(row?.session_hash);
}

export async function getRegisteredTrialSessionId(request: Request) {
  const sessionId = getTrialSessionId(request);
  if (!sessionId) return null;
  return (await isRegisteredTrialSession(sessionId)) ? sessionId : null;
}

export async function trialSessionPrincipalEmail(sessionId: string) {
  const principalId = (await hashTrialSessionId(sessionId)).slice(0, 48);
  return `trial-${principalId}@anonymous.torudake.invalid`;
}

export async function issueOrRefreshTrialSession(
  request: Request,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  await ensureTrialSessionSchema();
  const database = env.DB as unknown as D1Database;
  const suppliedSessionId = getTrialSessionId(request);
  const existingSessionId =
    suppliedSessionId &&
    (await isRegisteredTrialSession(suppliedSessionId, nowSeconds))
      ? suppliedSessionId
      : null;

  if (existingSessionId) {
    await refreshTrialSession(database, existingSessionId, nowSeconds);
    return existingSessionId;
  }

  const { fingerprintHash, networkHash } =
    await getTrialIssuanceFingerprint(request);
  const sessionId = crypto.randomUUID();
  const sessionHash = await hashTrialSessionId(sessionId);
  const expiresAt = nowSeconds + TRIAL_SESSION_LIFETIME_SECONDS;

  await database.batch([
    database
      .prepare(`
        DELETE FROM trial_sessions
        WHERE session_hash IN (
          SELECT session_hash
          FROM trial_sessions
          WHERE expires_at < ?
          LIMIT 100
        )
      `)
      .bind(nowSeconds),
    database
      .prepare(`
        INSERT INTO trial_issuance_fingerprints (
          fingerprint_hash,
          network_hash,
          session_hash,
          created_at,
          last_seen_at
        )
        SELECT ?, ?, ?, ?, ?
        WHERE (
          SELECT COUNT(*)
          FROM trial_issuance_fingerprints
          WHERE network_hash = ?
            AND created_at >= ?
        ) < ?
          AND (
            SELECT COUNT(*)
            FROM trial_issuance_fingerprints
            WHERE created_at >= ?
          ) < ?
        ON CONFLICT(fingerprint_hash) DO UPDATE SET
          last_seen_at = excluded.last_seen_at
      `)
      .bind(
        fingerprintHash,
        networkHash,
        sessionHash,
        nowSeconds,
        nowSeconds,
        networkHash,
        nowSeconds - TRIAL_NETWORK_WINDOW_SECONDS,
        TRIAL_NETWORK_ISSUANCE_LIMIT,
        nowSeconds - TRIAL_GLOBAL_WINDOW_SECONDS,
        TRIAL_GLOBAL_ISSUANCE_LIMIT,
      ),
    database
      .prepare(`
        INSERT INTO trial_sessions (
          session_hash,
          created_at,
          last_seen_at,
          expires_at
        )
        SELECT ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM trial_issuance_fingerprints
          WHERE fingerprint_hash = ?
            AND session_hash = ?
        )
        ON CONFLICT(session_hash) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at
      `)
      .bind(
        sessionHash,
        nowSeconds,
        nowSeconds,
        expiresAt,
        fingerprintHash,
        sessionHash,
      ),
  ]);

  const issuance = await database
    .prepare(`
      SELECT session_hash
      FROM trial_issuance_fingerprints
      WHERE fingerprint_hash = ?
      LIMIT 1
    `)
    .bind(fingerprintHash)
    .first<{ session_hash: string }>();
  if (issuance?.session_hash !== sessionHash) {
    if (!issuance) {
      throw new TrialSessionIssueError(
        "trial_issuance_limited",
        429,
        "無料体験の新規受付が上限に達しました。時間をおいてから、もう一度お試しください。",
      );
    }
    throw new TrialSessionIssueError(
      "trial_already_issued",
      409,
      "この接続環境では無料体験を開始済みです。以前と同じブラウザで開き直してお試しください。",
    );
  }
  return sessionId;
}

async function refreshTrialSession(
  database: D1Database,
  sessionId: string,
  nowSeconds: number,
) {
  const sessionHash = await hashTrialSessionId(sessionId);
  const expiresAt = nowSeconds + TRIAL_SESSION_LIFETIME_SECONDS;
  await database
    .prepare(`
      INSERT INTO trial_sessions (
        session_hash,
        created_at,
        last_seen_at,
        expires_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_hash) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        expires_at = excluded.expires_at
    `)
    .bind(sessionHash, nowSeconds, nowSeconds, expiresAt)
    .run();
}

async function getTrialIssuanceFingerprint(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const isLocalRequest =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost");
  const configuredSecret =
    typeof env.TRIAL_ISSUANCE_SECRET === "string"
      ? env.TRIAL_ISSUANCE_SECRET.trim()
      : "";
  if (!isLocalRequest && configuredSecret.length < TRIAL_ISSUANCE_SECRET_MIN_LENGTH) {
    throw new TrialSessionIssueError(
      "trial_issuance_not_configured",
      503,
      "無料体験を安全に開始するための設定が完了していません。運営へお問い合わせください。",
    );
  }

  const connectingIp = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!isLocalRequest && !isValidConnectingIp(connectingIp)) {
    throw new TrialSessionIssueError(
      "trial_request_context_unavailable",
      503,
      "接続情報を確認できないため、無料体験を開始できませんでした。通常のブラウザで開き直してお試しください。",
    );
  }

  const secret = configuredSecret || "torudake-local-development-only-secret";
  const fingerprintInput = [
    "torudake-trial-issuance-v1",
    connectingIp || "local-request",
    normalizeFingerprintHeader(request.headers.get("user-agent"), 320),
    normalizeFingerprintHeader(request.headers.get("accept-language"), 80),
    normalizeFingerprintHeader(request.headers.get("sec-ch-ua-platform"), 40),
    normalizeFingerprintHeader(request.headers.get("sec-ch-ua-mobile"), 12),
  ].join("\n");
  const [fingerprintHash, networkHash] = await Promise.all([
    hmacSha256Hex(secret, fingerprintInput),
    hmacSha256Hex(
      secret,
      ["torudake-trial-network-v1", connectingIp || "local-request"].join(
        "\n",
      ),
    ),
  ]);
  return { fingerprintHash, networkHash };
}

function normalizeFingerprintHeader(value: string | null, maxLength: number) {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, maxLength);
}

function isValidConnectingIp(value: string) {
  return value.length >= 3 && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value);
}

async function hmacSha256Hex(secret: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hashTrialSessionId(sessionId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(sessionId),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
