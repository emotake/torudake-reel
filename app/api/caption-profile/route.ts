import {
  getCaptionProfile,
  saveCaptionProfile,
} from "../../../lib/caption-profile-store";
import { normalizeCaptionProfile } from "../../../lib/caption-design";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../lib/current-user";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../lib/request-safety";

const MAX_CAPTION_PROFILE_REQUEST_BYTES = 16 * 1024;

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  try {
    return Response.json({
      profile: await getCaptionProfile(currentUser),
    });
  } catch (error) {
    console.error("caption profile read failed", error);
    return Response.json(
      { error: "テロップ設定を読み込めませんでした。" },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  let payload: unknown;
  try {
    payload = await parseJsonBodyWithLimit<unknown>(
      request,
      MAX_CAPTION_PROFILE_REQUEST_BYTES,
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestBodyTooLargeError
            ? "テロップ設定の送信サイズが大きすぎます。"
            : "テロップ設定を確認できませんでした。",
      },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }

  try {
    const profile = normalizeCaptionProfile(
      payload && typeof payload === "object" && "profile" in payload
        ? (payload as { profile: unknown }).profile
        : payload,
    );
    return Response.json({
      profile: await saveCaptionProfile(currentUser, profile),
    });
  } catch (error) {
    console.error("caption profile write failed", error);
    return Response.json(
      { error: "テロップ設定を保存できませんでした。" },
      { status: 500 },
    );
  }
}
