import { getDb } from "../../../../db";
import { videoTransfers } from "../../../../db/schema";
import {
  authorizeUsageOperation,
} from "../../../../lib/billing-store";
import { authenticationRequired } from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import {
  cleanupExpiredTransfers,
  contentDisposition,
  createTransferCode,
  getMediaBucket,
  hashTransferCode,
  isSupportedVideo,
  isMediaTransferAvailable,
  jsonError,
  mediaTransferUnavailable,
  MAX_VIDEO_BYTES,
  safeFileName,
  TRANSFER_TTL_MS,
  UPLOAD_CHUNK_BYTES,
} from "../../../../lib/transfers";
import { isManagedUploadEnforcementEnabled } from "../../../../lib/usage-enforcement";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";

const MAX_TRANSFER_INIT_REQUEST_BYTES = 16 * 1024;

export async function POST(request: Request) {
  if (!isMediaTransferAvailable()) return mediaTransferUnavailable();

  let upload:
    | {
        abort(): Promise<void>;
        uploadId: string;
      }
    | undefined;

  try {
    const managedUploadEnforcementEnabled =
      isManagedUploadEnforcementEnabled(request);
    const usagePrincipal = managedUploadEnforcementEnabled
      ? await getUsagePrincipal(request, { allowTrial: true })
      : null;
    if (managedUploadEnforcementEnabled && !usagePrincipal?.currentUser) {
      return authenticationRequired();
    }

    let payload: {
      fileName?: string;
      contentType?: string;
      size?: number;
      usageReservationId?: string;
    };
    try {
      payload = await parseJsonBodyWithLimit<typeof payload>(
        request,
        MAX_TRANSFER_INIT_REQUEST_BYTES,
      );
    } catch (error) {
      return jsonError(
        error instanceof RequestBodyTooLargeError
          ? "アップロード情報が大きすぎます。"
          : "動画ファイルの情報を確認できませんでした。",
        error instanceof RequestBodyTooLargeError ? 413 : 400,
      );
    }
    const fileName = payload.fileName?.trim() ?? "";
    const contentType = payload.contentType?.trim() || "video/mp4";
    const size = Number(payload.size);

    if (
      !fileName ||
      fileName.length > 240 ||
      contentType.length > 100 ||
      !Number.isSafeInteger(size) ||
      size <= 0
    ) {
      return jsonError("動画ファイルの情報が正しくありません。");
    }
    if (!isSupportedVideo(fileName, contentType)) {
      return jsonError("MP4・MOV・M4V・WebMの動画を選んでください。");
    }
    if (size > MAX_VIDEO_BYTES) {
      return jsonError("動画は1GB以下にしてください。", 413);
    }

    await cleanupExpiredTransfers(32);

    let ownerEmail: string | null = null;
    const usageReservationId = payload.usageReservationId?.trim() ?? "";
    if (managedUploadEnforcementEnabled) {
      const currentUser = usagePrincipal?.currentUser ?? null;
      const isOperator = usagePrincipal?.isOperator ?? false;
      if (!currentUser) return authenticationRequired();
      ownerEmail = currentUser.email;

      const authorization = usageReservationId
        ? await authorizeUsageOperation(
            currentUser,
            usageReservationId,
            "transfer_upload",
          )
        : isOperator
          ? { allowed: true as const, reason: null }
          : null;
      if (!authorization?.allowed) {
        return jsonError(
          authorization?.reason === "operator_operation_limit"
            ? "この動画で開始できるアップロード回数を超えました。動画を選び直してください。"
            : "有効な利用枠を確認できませんでした。動画を選び直してください。",
          authorization?.reason === "operator_operation_limit" ? 429 : 402,
        );
      }
    }

    const id = crypto.randomUUID();
    const code = createTransferCode();
    const codeHash = await hashTransferCode(code);
    const now = Date.now();
    const storedName = safeFileName(fileName);
    const date = new Date(now).toISOString().slice(0, 10);
    const objectKey = `incoming/${date}/${id}/${storedName}`;
    upload = await getMediaBucket().createMultipartUpload(objectKey, {
      httpMetadata: {
        contentType,
        contentDisposition: contentDisposition(fileName),
      },
      customMetadata: {
        transferId: id,
        ...(usageReservationId ? { usageReservationId } : {}),
      },
    });

    await getDb().insert(videoTransfers).values({
      id,
      codeHash,
      fileName,
      contentType,
      size,
      objectKey,
      uploadId: upload.uploadId,
      status: "uploading",
      ownerEmail,
      createdAt: now,
      expiresAt: now + TRANSFER_TTL_MS,
    });

    return Response.json(
      {
        id,
        code,
        uploadId: upload.uploadId,
        chunkSize: UPLOAD_CHUNK_BYTES,
        expiresAt: now + TRANSFER_TTL_MS,
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (upload) {
      await upload.abort().catch(() => undefined);
    }
    console.error("transfer init failed", error);
    return jsonError("アップロードの準備に失敗しました。少し待って再度お試しください。", 500);
  }
}
