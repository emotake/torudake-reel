import { env } from "cloudflare:workers";
import {
  getProductActorHash,
  isPlainRecord,
  isSameOriginProductEvent,
} from "../../../lib/product-analytics";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../lib/request-safety";

const MAX_FEEDBACK_BODY_BYTES = 2 * 1024;
const FEEDBACK_DAILY_LIMIT = 10;
const FEEDBACK_RETENTION_SECONDS = 180 * 24 * 60 * 60;
const RATINGS = new Set(["helpful", "needs_work"]);
const CONTEXTS = new Set(["preview", "export", "checkout", "general"]);
const TAGS = new Set(["easy", "quality", "captions", "voice", "cut", "export", "other"]);

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

export async function POST(request: Request) {
  if (!isSameOriginProductEvent(request)) {
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  }
  let rawPayload: unknown;
  try {
    rawPayload = await parseJsonBodyWithLimit<unknown>(
      request,
      MAX_FEEDBACK_BODY_BYTES,
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof RequestBodyTooLargeError ? "too_large" : "invalid_json" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!isPlainRecord(rawPayload)) {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const payload = rawPayload;
  const context = payload.context ?? "general";
  const tags = Array.isArray(payload.tags) ? [...new Set(payload.tags)] : [];
  if (
    typeof payload.rating !== "string" ||
    !RATINGS.has(payload.rating) ||
    typeof context !== "string" ||
    !CONTEXTS.has(context) ||
    tags.length > 5 ||
    !tags.every((tag) => typeof tag === "string" && TAGS.has(tag))
  ) {
    return Response.json({ error: "invalid_feedback" }, { status: 400 });
  }
  try {
    const database = env.DB as unknown as { prepare: (query: string) => D1Statement };
    if (!database?.prepare) throw new Error("Feedback database unavailable.");
    const now = Math.floor(Date.now() / 1_000);
    const actorHash = await getProductActorHash(request);
    const result = await database
      .prepare(`
        INSERT INTO product_feedback (
          id, actor_hash, rating, context, tags, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?
        WHERE (
          SELECT COUNT(*) FROM product_feedback
          WHERE actor_hash = ? AND created_at >= ?
        ) < ?
      `)
      .bind(
        crypto.randomUUID(), actorHash, payload.rating, context,
        JSON.stringify(tags), now, actorHash, now - 86_400, FEEDBACK_DAILY_LIMIT,
      )
      .run();
    if (result.meta?.changes !== 1) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    await database
      .prepare(`
        DELETE FROM product_feedback
        WHERE id IN (
          SELECT id FROM product_feedback
          WHERE created_at < ? LIMIT 100
        )
      `)
      .bind(now - FEEDBACK_RETENTION_SECONDS)
      .run()
      .catch(() => undefined);
    return Response.json({ ok: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("feedback was not recorded", error);
    return Response.json({ ok: false }, { status: 503 });
  }
}
