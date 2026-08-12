import {
  claimTransferPart,
  expectedUploadPartBytes,
  findTransfer,
  finishTransferPart,
  getMediaBucket,
  getRecordedTransferPart,
  jsonError,
  releaseTransferPartClaim,
} from "../../../../../lib/transfers";
import { getUsagePrincipal } from "../../../../../lib/operator-access";
import { isManagedUploadEnforcementEnabled } from "../../../../../lib/usage-enforcement";
import {
  readRequestBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../../lib/request-safety";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const code = url.searchParams.get("code") ?? "";
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNumber = Number(url.searchParams.get("partNumber"));
    const contentLength = Number(request.headers.get("content-length") ?? "0");

    if (
      !code ||
      !uploadId ||
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > 10_000
    ) {
      return jsonError("アップロード情報が正しくありません。");
    }

    const transfer = await findTransfer(id, code);
    if (!transfer || transfer.uploadId !== uploadId) {
      return jsonError("受付情報が見つかりません。", 404);
    }
    if (transfer.status !== "uploading" || transfer.expiresAt < Date.now()) {
      return jsonError("このアップロードは終了または期限切れです。", 410);
    }
    if (isManagedUploadEnforcementEnabled(request) && transfer.ownerEmail) {
      const { currentUser } = await getUsagePrincipal(request, {
        allowTrial: true,
      });
      if (
        !currentUser ||
        currentUser.email.toLowerCase() !== transfer.ownerEmail.toLowerCase()
      ) {
        return jsonError("このアップロードを続ける権限がありません。", 403);
      }
    }

    const expectedBytes = expectedUploadPartBytes(transfer.size, partNumber);
    if (expectedBytes === 0 || contentLength !== expectedBytes) {
      return jsonError(
        "動画の分割サイズが一致しません。アップロードをやり直してください。",
        413,
      );
    }

    if (!(await claimTransferPart(transfer.id, partNumber, expectedBytes))) {
      const recordedPart = await getRecordedTransferPart(
        transfer.id,
        partNumber,
      );
      return recordedPart
        ? Response.json(recordedPart, {
            headers: { "Cache-Control": "no-store" },
          })
        : jsonError("同じ分割データを受信処理中です。", 409);
    }

    let body: Uint8Array;
    try {
      body = await readRequestBodyWithLimit(request, expectedBytes);
    } catch (error) {
      await releaseTransferPartClaim(transfer.id, partNumber).catch(
        () => undefined,
      );
      return jsonError(
        error instanceof RequestBodyTooLargeError
          ? "動画の分割サイズが上限を超えました。"
          : "動画データを受信できませんでした。",
        error instanceof RequestBodyTooLargeError ? 413 : 400,
      );
    }
    if (body.byteLength !== expectedBytes) {
      await releaseTransferPartClaim(transfer.id, partNumber).catch(
        () => undefined,
      );
      return jsonError("動画データを正しく受信できませんでした。");
    }

    let uploadedPart: { partNumber: number; etag: string };
    try {
      const uploadBody = new Uint8Array(body.byteLength);
      uploadBody.set(body);
      uploadedPart = await getMediaBucket()
        .resumeMultipartUpload(transfer.objectKey, transfer.uploadId)
        .uploadPart(partNumber, uploadBody.buffer);
      await finishTransferPart(
        transfer.id,
        uploadedPart.partNumber,
        uploadedPart.etag,
      );
    } catch (error) {
      await releaseTransferPartClaim(transfer.id, partNumber).catch(
        () => undefined,
      );
      throw error;
    }

    return Response.json(uploadedPart, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("transfer part failed", error);
    return jsonError("動画の送信中にエラーが発生しました。", 500);
  }
}
