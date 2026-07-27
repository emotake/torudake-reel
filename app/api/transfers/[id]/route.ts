import {
  findTransfer,
  jsonError,
  removeTransfer,
} from "../../../../lib/transfers";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const code = new URL(request.url).searchParams.get("code") ?? "";
    const transfer = await findTransfer(id, code);
    if (!transfer || transfer.status === "deleted") {
      return jsonError("受け渡し情報が見つかりません。", 404);
    }

    return Response.json(
      {
        id: transfer.id,
        fileName: transfer.fileName,
        size: transfer.size,
        status: transfer.status,
        expiresAt: transfer.expiresAt,
        completedAt: transfer.completedAt,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("transfer status failed", error);
    return jsonError("受け渡し状態を確認できませんでした。", 500);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const code = new URL(request.url).searchParams.get("code") ?? "";
    const transfer = await findTransfer(id, code);
    if (!transfer || transfer.status === "deleted") {
      return jsonError("受け渡し情報が見つかりません。", 404);
    }

    await removeTransfer(transfer);
    return Response.json(
      { deleted: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("transfer deletion failed", error);
    return jsonError("動画を削除できませんでした。", 500);
  }
}
