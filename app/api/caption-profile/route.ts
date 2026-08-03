import {
  getCaptionProfile,
  saveCaptionProfile,
} from "../../../lib/caption-profile-store";
import { normalizeCaptionProfile } from "../../../lib/caption-design";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../lib/current-user";

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
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "テロップ設定を確認できませんでした。" },
      { status: 400 },
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
