import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { videoTransfers } from "../../../../../db/schema";
import {
  findTransfer,
  getMediaBucket,
  jsonError,
} from "../../../../../lib/transfers";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const payload = (await request.json()) as {
      code?: string;
      uploadId?: string;
      parts?: { partNumber?: number; etag?: string }[];
    };
    const code = payload.code ?? "";
    const uploadId = payload.uploadId ?? "";
    const parts = (payload.parts ?? [])
      .map((part) => ({
        partNumber: Number(part.partNumber),
        etag: part.etag?.trim() ?? "",
      }))
      .sort((a, b) => a.partNumber - b.partNumber);

    if (
      !code ||
      !uploadId ||
      parts.length === 0 ||
      parts.some(
        (part, index) =>
          !Number.isSafeInteger(part.partNumber) ||
          part.partNumber !== index + 1 ||
          !part.etag,
      )
    ) {
      return jsonError("完了情報が正しくありません。");
    }

    const transfer = await findTransfer(id, code);
    if (!transfer || transfer.uploadId !== uploadId) {
      return jsonError("受け渡し情報が見つかりません。", 404);
    }
    if (transfer.status !== "uploading" || transfer.expiresAt < Date.now()) {
      return jsonError("このアップロードは終了または期限切れです。", 410);
    }

    await getMediaBucket()
      .resumeMultipartUpload(transfer.objectKey, transfer.uploadId)
      .complete(parts);

    const completedAt = Date.now();
    await getDb()
      .update(videoTransfers)
      .set({ status: "complete", completedAt })
      .where(eq(videoTransfers.id, transfer.id));

    return Response.json(
      {
        id: transfer.id,
        code,
        fileName: transfer.fileName,
        expiresAt: transfer.expiresAt,
        completedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("transfer completion failed", error);
    return jsonError("アップロードの確定に失敗しました。", 500);
  }
}
