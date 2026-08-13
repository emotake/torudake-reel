import { env } from "cloudflare:workers";
import { getOperatorDevice } from "../../../../lib/operator-access";
import { listProviderUsageDaily } from "../../../../lib/provider-usage";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

type D1Result<T> = { results?: T[] };

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  all: <T>() => Promise<D1Result<T>>;
  first: <T>() => Promise<T | null>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
};

type CountRow = { value: number | null };

export async function GET(request: Request) {
  const operator = await getOperatorDevice(request);
  if (!operator) {
    return metricsJson({ error: "運営端末の登録が必要です。" }, 401);
  }

  try {
    const database = metricsDatabase();
    const now = Math.floor(Date.now() / 1_000);
    const since = now - WINDOW_DAYS * 24 * 60 * 60;
    const sinceDay = new Date(since * 1_000).toISOString().slice(0, 10);

    const [
      eventRows,
      feedbackRows,
      dailyRows,
      planRows,
      totals,
      firstEvent,
      lastEvent,
      providerUsage,
    ] = await Promise.all([
      database
        .prepare(`
          SELECT
            event_name AS eventName,
            COUNT(*) AS events,
            COUNT(DISTINCT actor_hash) AS actors
          FROM product_events
          WHERE created_at >= ?
          GROUP BY event_name
          ORDER BY events DESC, event_name ASC
        `)
        .bind(since)
        .all<{ eventName: string; events: number; actors: number }>(),
      database
        .prepare(`
          SELECT rating, context, COUNT(*) AS responses
          FROM product_feedback
          WHERE created_at >= ?
          GROUP BY rating, context
          ORDER BY responses DESC, rating ASC, context ASC
        `)
        .bind(since)
        .all<{ rating: string; context: string; responses: number }>(),
      database
        .prepare(`
          SELECT
            date(created_at, 'unixepoch') AS day,
            COUNT(*) AS events,
            COUNT(DISTINCT actor_hash) AS actors
          FROM product_events
          WHERE created_at >= ?
          GROUP BY day
          ORDER BY day ASC
        `)
        .bind(since)
        .all<{ day: string; events: number; actors: number }>(),
      database
        .prepare(`
          SELECT plan_key AS plan, COUNT(*) AS subscriptions
          FROM billing_subscriptions
          WHERE status IN ('active', 'trialing')
            AND (
              revoked_period_start IS NULL
              OR revoked_period_start <> current_period_start
            )
            AND current_period_end > ?
          GROUP BY plan_key
          ORDER BY plan_key ASC
        `)
        .bind(now)
        .all<{ plan: string; subscriptions: number }>(),
      Promise.all([
        scalar(database, "SELECT COUNT(*) AS value FROM users"),
        scalar(database, "SELECT COUNT(*) AS value FROM account_passkeys"),
        scalar(
          database,
          "SELECT COUNT(*) AS value FROM billing_purchases WHERE revoked_at IS NULL",
        ),
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM usage_reservations
           WHERE status = 'completed' AND created_at >= ?`,
          since,
        ),
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM usage_reservations
           WHERE status = 'reserved' AND expires_at > ?`,
          now,
        ),
        scalar(
          database,
          "SELECT COUNT(*) AS value FROM stripe_events WHERE processed_at IS NULL",
        ),
        scalar(
          database,
          `SELECT COUNT(*) AS value FROM product_events
           WHERE created_at >= ? AND event_name IN (
             'checkout_session_failed', 'stripe_purchase_failed',
             'stripe_refund_failed', 'ai_operation_failed', 'export_failed'
           )`,
          since,
        ),
        scalar(
          database,
          `SELECT COUNT(DISTINCT actor_hash) AS value FROM product_events
           WHERE created_at >= ? AND actor_hash IS NOT NULL`,
          since,
        ),
      ]),
      scalar(database, "SELECT MIN(created_at) AS value FROM product_events"),
      scalar(database, "SELECT MAX(created_at) AS value FROM product_events"),
      listProviderUsageDaily({ sinceDay, limit: 1_000 }),
    ]);

    const events = eventRows.results ?? [];
    const uniqueActors = totals[7];
    const eventMap = new Map(
      events.map((row) => [row.eventName, safeInteger(row.events)]),
    );
    const providerSummary = providerUsage.reduce(
      (summary, row) => ({
        requestCount: summary.requestCount + safeInteger(row.requestCount),
        successCount: summary.successCount + safeInteger(row.successCount),
        failureCount: summary.failureCount + safeInteger(row.failureCount),
        inputTokens: summary.inputTokens + safeInteger(row.inputTokens),
        outputTokens: summary.outputTokens + safeInteger(row.outputTokens),
        inputAudioTokens:
          summary.inputAudioTokens + safeInteger(row.inputAudioTokens),
        outputAudioTokens:
          summary.outputAudioTokens + safeInteger(row.outputAudioTokens),
        audioSeconds: summary.audioSeconds + safeNumber(row.audioSeconds),
        inputCharacters:
          summary.inputCharacters + safeInteger(row.inputCharacters),
      }),
      {
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        inputAudioTokens: 0,
        outputAudioTokens: 0,
        audioSeconds: 0,
        inputCharacters: 0,
      },
    );

    return metricsJson({
      generatedAt: now,
      windowDays: WINDOW_DAYS,
      sourceFreshness: {
        firstEventAt: firstEvent || null,
        lastEventAt: lastEvent || null,
      },
      summary: {
        uniqueActors,
        totalEvents: events.reduce(
          (sum, row) => sum + safeInteger(row.events),
          0,
        ),
        previewCompleted: eventMap.get("preview_completed") ?? 0,
        checkoutStarted: eventMap.get("checkout_started") ?? 0,
        checkoutCreated: eventMap.get("checkout_session_created") ?? 0,
        exportCompleted: eventMap.get("export_completed") ?? 0,
        failures: totals[6],
      },
      operations: {
        users: totals[0],
        passkeys: totals[1],
        activeOneTimePurchases: totals[2],
        completedSavesInWindow: totals[3],
        activeReservations: totals[4],
        pendingStripeEvents: totals[5],
      },
      events,
      feedback: feedbackRows.results ?? [],
      daily: dailyRows.results ?? [],
      activePlans: planRows.results ?? [],
      providerSummary,
      providerUsage,
      caveats: [
        "匿名の集計値のみです。ファイル名、字幕、台本、メールアドレスは記録しません。",
        "母数が20端末未満の期間は、率ではなく件数を中心に判断してください。",
        "OpenAI使用量は原価確認用の実測値です。料金換算はモデルの最新公式単価で別途行ってください。",
      ],
    });
  } catch (error) {
    console.error("operator metrics failed", error);
    return metricsJson({ error: "運営指標を読み込めませんでした。" }, 500);
  }
}

async function scalar(database: D1Database, query: string, ...bindings: unknown[]) {
  const statement = bindings.length
    ? database.prepare(query).bind(...bindings)
    : database.prepare(query);
  const row = await statement.first<CountRow>();
  return safeInteger(row?.value);
}

function safeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function metricsDatabase() {
  const database = env.DB as unknown as D1Database | undefined;
  if (!database?.prepare) throw new Error("Metrics database unavailable.");
  return database;
}

function metricsJson(body: Record<string, unknown>, status = 200) {
  const response = Response.json(body, { status });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Vary", "Cookie");
  return response;
}
