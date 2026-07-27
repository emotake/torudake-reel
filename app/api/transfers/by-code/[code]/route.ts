import {
  contentDisposition,
  findTransferByCode,
  jsonError,
  removeTransfer,
  safeFileName,
} from "../../../../../lib/transfers";
import { getMediaBucket } from "../../../../../lib/transfers";

type RouteContext = {
  params: Promise<{ code: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { code } = await context.params;
    const transfer = await findTransferByCode(code);
    if (!transfer || transfer.status === "deleted") {
      return jsonError("受け渡しコードが見つかりません。", 404);
    }
    if (transfer.status !== "complete") {
      return jsonError("動画のアップロードがまだ完了していません。", 409);
    }
    if (transfer.expiresAt < Date.now()) {
      await removeTransfer(transfer);
      return jsonError("受け渡し期限が切れています。", 410);
    }

    const object = await getMediaBucket().get(transfer.objectKey);
    if (!object) {
      return jsonError("動画データが見つかりません。", 404);
    }

    const fileName = safeFileName(transfer.fileName);
    return new Response(object.body, {
      headers: {
        "Content-Type": transfer.contentType,
        "Content-Length": String(object.size),
        "Content-Disposition": contentDisposition(fileName),
        "Cache-Control": "private, no-store",
        ETag: object.httpEtag,
      },
    });
  } catch (error) {
    console.error("transfer download failed", error);
    return jsonError("動画を取得できませんでした。", 500);
  }
}
