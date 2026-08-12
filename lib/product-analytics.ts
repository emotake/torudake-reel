import { env } from "cloudflare:workers";
import { SITE_ORIGIN } from "./site";
import {
  sanitizeProductProperties,
  type ClientProductEvent,
  type SafeProductProperties,
  type ServerProductEvent,
} from "./product-analytics-schema";

export {
  CLIENT_PRODUCT_EVENTS,
  isClientProductEvent,
  isPlainRecord,
  productDurationBucket,
  productUpstreamErrorCode,
  sanitizeProductProperties,
  SERVER_PRODUCT_EVENTS,
  type ClientProductEvent,
  type ProductEventName,
  type SafeProductProperties,
  type SafePropertyValue,
  type ServerProductEvent,
} from "./product-analytics-schema";

const EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const CLIENT_RATE_WINDOW_SECONDS = 60;
const CLIENT_RATE_LIMIT = 60;
const ANALYTICS_SECRET_MIN_LENGTH = 32;
const LOCAL_ANALYTICS_SALT = "torudake-local-analytics-salt";

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

export function isSameOriginProductEvent(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return origin === url.origin;
  }
  return origin === new URL(SITE_ORIGIN).origin && url.origin === origin;
}

async function actorHash(request: Request) {
  const url = new URL(request.url);
  const localRequest = isLocalAnalyticsRequest(url);
  const configuredSecret =
    typeof env.TRIAL_ISSUANCE_SECRET === "string"
      ? env.TRIAL_ISSUANCE_SECRET.trim()
      : "";
  if (!localRequest && configuredSecret.length < ANALYTICS_SECRET_MIN_LENGTH) {
    throw new Error("Analytics hashing secret is unavailable.");
  }
  const secret = configuredSecret || LOCAL_ANALYTICS_SALT;
  const connectingIp =
    request.headers.get("cf-connecting-ip")?.trim().toLowerCase() ??
    (localRequest ? "127.0.0.1" : "");
  if (
    !connectingIp ||
    connectingIp.length > 64 ||
    !/^[0-9a-f:.]+$/i.test(connectingIp)
  ) {
    throw new Error("Cloudflare connection address is unavailable.");
  }
  const seed = `network:${connectingIp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(seed),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function database() {
  const value = env.DB as unknown as D1Database | undefined;
  if (!value?.prepare || !value?.batch) throw new Error("Analytics database unavailable.");
  return value;
}

export async function recordClientProductEvent(
  request: Request,
  eventName: ClientProductEvent,
  properties: SafeProductProperties,
) {
  const db = database();
  const now = Math.floor(Date.now() / 1_000);
  const hash = await actorHash(request);
  const result = await db
    .prepare(`
      INSERT INTO product_events (
        id, event_name, actor_hash, source, properties, created_at
      )
      SELECT ?, ?, ?, 'browser', ?, ?
      WHERE (
        SELECT COUNT(*)
        FROM product_events
        WHERE actor_hash = ? AND created_at >= ?
      ) < ?
    `)
    .bind(
      crypto.randomUUID(),
      eventName,
      hash,
      JSON.stringify(properties),
      now,
      hash,
      now - CLIENT_RATE_WINDOW_SECONDS,
      CLIENT_RATE_LIMIT,
    )
    .run();
  if (result.meta?.changes === 1) {
    await db
      .prepare(`
        DELETE FROM product_events
        WHERE id IN (
          SELECT id FROM product_events
          WHERE created_at < ? LIMIT 200
        )
      `)
      .bind(now - EVENT_RETENTION_SECONDS)
      .run()
      .catch(() => undefined);
  }
  return result.meta?.changes === 1;
}

export async function recordServerProductEvent(
  request: Request,
  eventName: ServerProductEvent,
  properties: SafeProductProperties = {},
) {
  try {
    const safe = sanitizeProductProperties(properties);
    if (!safe) return false;
    const db = database();
    const now = Math.floor(Date.now() / 1_000);
    const hash = await actorHash(request);
    await db.batch([
      db
        .prepare(`
          INSERT INTO product_events (
            id, event_name, actor_hash, source, properties, created_at
          ) VALUES (?, ?, ?, 'server', ?, ?)
        `)
        .bind(
          crypto.randomUUID(),
          eventName,
          hash,
          JSON.stringify(safe),
          now,
        ),
      db
        .prepare(`
          DELETE FROM product_events
          WHERE id IN (
            SELECT id FROM product_events
            WHERE created_at < ? LIMIT 200
          )
        `)
        .bind(now - EVENT_RETENTION_SECONDS),
    ]);
    return true;
  } catch (error) {
    console.warn("product telemetry unavailable", eventName, error);
    return false;
  }
}

export async function getProductActorHash(request: Request) {
  return actorHash(request);
}

function isLocalAnalyticsRequest(url: URL) {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".test")
  );
}
