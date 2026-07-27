import {
  findTransfer,
  getMediaBucket,
  jsonError,
  UPLOAD_CHUNK_BYTES,
} from "../../../../../lib/transfers";

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
      partNumber > 10000
    ) {
      return jsonError("アップロード情報が正しくありません。");
    }
    if (
      contentLength <= 0 ||
      contentLength > UPLOAD_CHUNK_BYTES + 1024
    ) {
      return jsonError("動画の分割サイズが正しくありません。", 413);
    }

    const transfer = await findTransfer(id, code);
    if (!transfer || transfer.uploadId !== uploadId) {
      return jsonError("受け渡し情報が見つかりません。", 404);
    }
    if (transfer.status !== "uploading" || transfer.expiresAt < Date.now()) {
      return jsonError("このアップロードは終了または期限切れです。", 410);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength !== contentLength) {
      return jsonError("動画データを正しく受信できませんでした。");
    }

    const uploadedPart = await getMediaBucket()
      .resumeMultipartUpload(transfer.objectKey, transfer.uploadId)
      .uploadPart(partNumber, body);

    return Response.json(uploadedPart, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("transfer part failed", error);
    return jsonError("動画の送信中にエラーが発生しました。", 500);
  }
}
