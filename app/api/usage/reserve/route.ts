import {
  reserveUsage,
  UsageLimitError,
} from "../../../../lib/billing-store";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../../lib/current-user";
import { isBillingConfigured } from "../../../../lib/stripe";

export async function POST(request: Request) {
  if (!isBillingConfigured()) {
    return Response.json({ required: false });
  }
  const currentUser = getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  let payload: {
    sourceDurationSeconds?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "動画の長さを確認できませんでした。" }, { status: 400 });
  }

  const duration = Number(payload.sourceDurationSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60 * 60) {
    return Response.json({ error: "動画の長さを確認できませんでした。" }, { status: 400 });
  }
  if (
    typeof payload.idempotencyKey !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(payload.idempotencyKey)
  ) {
    return Response.json({ error: "もう一度動画を選び直してください。" }, { status: 400 });
  }

  try {
    const reservation = await reserveUsage(
      currentUser,
      duration,
      payload.idempotencyKey,
    );
    return Response.json({
      required: true,
      reservationId: reservation.id,
      bucket: reservation.bucket,
    });
  } catch (error) {
    if (error instanceof UsageLimitError) {
      return Response.json(
        { error: error.message, code: "usage_limit_reached" },
        { status: 402 },
      );
    }
    console.error("usage reservation failed", error);
    return Response.json(
      { error: "利用枠を確認できませんでした。" },
      { status: 500 },
    );
  }
}
