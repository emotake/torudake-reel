import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { videoTransfers } from "../../../../../db/schema";
import { getUsagePrincipal } from "../../../../../lib/operator-access";
import {
  cleanupExpiredTransfers,
  expectedUploadPartCount,
  findTransfer,
  getMediaBucket,
  getRecordedTransferParts,
  isValidMultipartCompletion,
  jsonError,
  type UploadedPartReceipt,
} from "../../../../../lib/transfers";
import { isManagedUploadEnforcementEnabled } from "../../../../../lib/usage-enforcement";

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
    const rawParts = Array.isArray(payload.parts) ? payload.parts : [];
    if (!code || !uploadId || rawParts.length === 0 || rawParts.length > 128) {
      return jsonError("完了情報が正しくありません。");
    }
    const parts: UploadedPartReceipt[] = rawParts
      .map((part) => ({
        partNumber: Number(part.partNumber),
        etag: part.etag?.trim() ?? "",
      }))
      .sort((left, right) => left.partNumber - right.partNumber);

    const transfer = await findTransfer(id, code);
    if (!transfer || transfer.uploadId !== uploadId) {
      return jsonError("受付情報が見つかりません。", 404);
    }
    if (transfer.status !== "uploading" || transfer.expiresAt < Date.now()) {
      return jsonError("このアップロードは終了または期限切れです。", 410);
    }
    if (isManagedUploadEnforcementEnabled() && transfer.ownerEmail) {
      const { currentUser } = await getUsagePrincipal(request, {
        allowTrial: true,
      });
      if (
        !currentUser ||
        currentUser.email.toLowerCase() !== transfer.ownerEmail.toLowerCase()
      ) {
        return jsonError("このアップロードを完了する権限がありません。", 403);
      }
    }

    const expectedCount = expectedUploadPartCount(transfer.size);
    if (
      parts.length !== expectedCount ||
      !isValidMultipartCompletion(transfer.size, parts)
    ) {
      return jsonError(
        "動画の分割数または合計サイズが一致しません。アップロードをやり直してください。",
        422,
      );
    }
    const recordedParts = await getRecordedTransferParts(transfer.id);
    if (
      !isValidMultipartCompletion(transfer.size, recordedParts) ||
      recordedParts.some(
        (part, index) =>
          part.partNumber !== parts[index]?.partNumber ||
          part.etag !== parts[index]?.etag,
      )
    ) {
      return jsonError(
        "サーバーで確認できた分割データと完了情報が一致しません。",
        422,
      );
    }

    const bucket = getMediaBucket();
    await bucket
      .resumeMultipartUpload(transfer.objectKey, transfer.uploadId)
      .complete(recordedParts);

    const storedObject = await bucket.get(transfer.objectKey);
    await storedObject?.body.cancel().catch(() => undefined);
    if (!storedObject || storedObject.size !== transfer.size) {
      await bucket.delete(transfer.objectKey).catch(() => undefined);
      await getDb()
        .update(videoTransfers)
        .set({ status: "deleted", deletedAt: Date.now() })
        .where(eq(videoTransfers.id, transfer.id));
      return jsonError(
        "受信した動画の合計サイズが一致しません。アップロードをやり直してください。",
        422,
      );
    }

    const completedAt = Date.now();
    await getDb()
      .update(videoTransfers)
      .set({ status: "complete", completedAt })
      .where(eq(videoTransfers.id, transfer.id));

    await cleanupExpiredTransfers(8);

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
