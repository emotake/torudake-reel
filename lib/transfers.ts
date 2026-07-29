import { env } from "cloudflare:workers";
import { and, eq, lt, ne } from "drizzle-orm";
import { getDb } from "../db";
import { videoTransfers } from "../db/schema";

export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const TRANSFER_TTL_MS = 72 * 60 * 60 * 1000;

type R2UploadedPart = {
  partNumber: number;
  etag: string;
};

type R2MultipartUpload = {
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ArrayBuffer | Blob | ReadableStream,
  ): Promise<R2UploadedPart>;
  complete(uploadedParts: R2UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
};

type R2ObjectBody = {
  body: ReadableStream;
  size: number;
  httpEtag: string;
};

export type MediaBucket = {
  createMultipartUpload(
    key: string,
    options?: {
      httpMetadata?: {
        contentType?: string;
        contentDisposition?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
};

export function getMediaBucket() {
  const bucket = (env as unknown as { MEDIA?: MediaBucket }).MEDIA;
  if (!bucket) {
    throw new Error("動画ストレージを利用できません。管理者に連絡してください。");
  }
  return bucket;
}

export function createTransferCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `tr_${token}`;
}

export async function hashTransferCode(code: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function safeFileName(fileName: string) {
  const normalized = fileName.normalize("NFKC").trim();
  const cleaned = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 140);
  return cleaned || "video.mp4";
}

export function contentDisposition(fileName: string) {
  const safeName = safeFileName(fileName);
  const asciiName =
    safeName.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "_") || "video.mp4";
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

export function isSupportedVideo(fileName: string, contentType: string) {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return (
    contentType.toLowerCase().startsWith("video/") ||
    [".mp4", ".mov", ".m4v", ".webm"].includes(extension)
  );
}

export function isSupportedTranscriptionMedia(
  fileName: string,
  contentType: string,
) {
  const extension = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return (
    isSupportedVideo(fileName, contentType) ||
    contentType.toLowerCase().startsWith("audio/") ||
    [".mp3", ".mpga", ".mpeg", ".m4a", ".wav"].includes(extension)
  );
}

export async function findTransfer(id: string, code: string) {
  const codeHash = await hashTransferCode(code);
  const [transfer] = await getDb()
    .select()
    .from(videoTransfers)
    .where(
      and(eq(videoTransfers.id, id), eq(videoTransfers.codeHash, codeHash)),
    )
    .limit(1);
  return transfer;
}

export async function findTransferByCode(code: string) {
  const codeHash = await hashTransferCode(code);
  const [transfer] = await getDb()
    .select()
    .from(videoTransfers)
    .where(eq(videoTransfers.codeHash, codeHash))
    .limit(1);
  return transfer;
}

export async function removeTransfer(
  transfer: typeof videoTransfers.$inferSelect,
) {
  if (transfer.status === "uploading") {
    try {
      await getMediaBucket()
        .resumeMultipartUpload(transfer.objectKey, transfer.uploadId)
        .abort();
    } catch {
      // The multipart upload may already have expired or been aborted.
    }
  } else if (transfer.status === "complete") {
    await getMediaBucket().delete(transfer.objectKey);
  }

  await getDb()
    .update(videoTransfers)
    .set({ status: "deleted", deletedAt: Date.now() })
    .where(eq(videoTransfers.id, transfer.id));
}

export async function cleanupExpiredTransfers() {
  const expired = await getDb()
    .select()
    .from(videoTransfers)
    .where(
      and(
        lt(videoTransfers.expiresAt, Date.now()),
        ne(videoTransfers.status, "deleted"),
      ),
    )
    .limit(8);

  await Promise.allSettled(expired.map((transfer) => removeTransfer(transfer)));
}

export function jsonError(message: string, status = 400) {
  return Response.json(
    { error: message },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
