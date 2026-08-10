import {
  activateOperatorDevice,
  isOperatorEnrollmentConfigured,
  isSameOriginMutation,
  normalizeOperatorLabel,
  OperatorDeviceLimitError,
  operatorEnrollmentCodeMatches,
  operatorSessionCookie,
} from "../../../../lib/operator-access";
import {
  clearOperatorEnrollmentFailures,
  isOperatorEnrollmentBlocked,
  recordOperatorEnrollmentFailure,
} from "../../../../lib/operator-enrollment-throttle";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson(
      { error: "登録情報を確認できませんでした。" },
      { status: 403 },
    );
  }
  if (!isOperatorEnrollmentConfigured()) {
    return privateJson(
      { error: "運営端末の登録は現在利用できません。" },
      { status: 503 },
    );
  }
  if (await isOperatorEnrollmentBlocked(request)) {
    return privateJson(
      {
        error:
          "登録の確認回数が上限に達しました。15分ほど待ってからもう一度お試しください。",
      },
      { status: 429 },
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    code?: unknown;
    label?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.code !== "string" ||
    payload.code.length > 200 ||
    !(await operatorEnrollmentCodeMatches(payload.code))
  ) {
    const throttle = await recordOperatorEnrollmentFailure(request);
    return privateJson(
      {
        error: throttle.blocked
          ? "登録の確認回数が上限に達しました。15分ほど待ってからもう一度お試しください。"
          : "登録情報を確認できませんでした。",
      },
      { status: throttle.blocked ? 429 : 403 },
    );
  }

  let device: Awaited<ReturnType<typeof activateOperatorDevice>>;
  try {
    device = await activateOperatorDevice(
      normalizeOperatorLabel(payload.label),
    );
  } catch (error) {
    if (error instanceof OperatorDeviceLimitError) {
      await clearOperatorEnrollmentFailures(request);
      return privateJson(
        {
          error:
            `登録できる運営端末は${error.limit}台までです。` +
            "使わない端末で登録を解除してから、もう一度お試しください。",
        },
        { status: 409 },
      );
    }
    throw error;
  }
  const response = privateJson({
    registered: true,
    label: device.label,
    expiresAt: device.expiresAt,
  });
  await clearOperatorEnrollmentFailures(request);
  response.headers.set(
    "Set-Cookie",
    operatorSessionCookie(
      device.token,
      new URL(request.url).protocol === "https:",
    ),
  );
  return response;
}

function privateJson(
  body: Record<string, unknown>,
  init: ResponseInit = {},
) {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  response.headers.set("Vary", "Cookie");
  return response;
}
