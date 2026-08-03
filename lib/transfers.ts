import { env } from "cloudflare:workers";
import { and, eq, lt, ne } from "drizzle-orm";
import { getDb } from "../db";
import { videoTransfers } from "../db/schema";
import type { UploadedPartReceipt } from "./multipart-upload";
export {
  expectedUploadPartBytes,
  expectedUploadPartCount,
  isValidMultipartCompletion,
  MAX_VIDEO_BYTES,
  UPLOAD_CHUNK_BYTES,
  type UploadedPartReceipt,
} from "./multipart-upload";

export const TRANSFER_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_CLEANUP_BATCH = 64;

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

type D1Statement = {
  bind: (...values: unknown[]) => D1Statement;
  all: <T>() => Promise<{ results?: T[] }>;
  first: <T>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

type D1Database = {
  prepare: (query: string) => D1Statement;
  batch: (statements: D1Statement[]) => Promise<unknown>;
};

let transferPartSchemaReady = false;

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

async function ensureTransferPartSchema() {
  if (transferPartSchemaReady) return;
  const database = (env as unknown as { DB?: D1Database }).DB;
  if (!database?.prepare || !database?.batch) {
    throw new Error("Transfer database binding is unavailable.");
  }
  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS video_transfer_parts (
        id text PRIMARY KEY NOT NULL,
        transfer_id text NOT NULL,
        part_number integer NOT NULL,
        size integer NOT NULL,
        etag text,
        created_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS video_transfer_parts_transfer_id_idx
      ON video_transfer_parts (transfer_id)
    `),
  ]);
  transferPartSchemaReady = true;
}

export async function claimTransferPart(
  transferId: string,
  partNumber: number,
  size: number,
) {
  await ensureTransferPartSchema();
  const database = (env as unknown as { DB: D1Database }).DB;
  const now = Date.now();
  const row = await database
    .prepare(`
      INSERT INTO video_transfer_parts (
        id, transfer_id, part_number, size, etag, created_at
      )
      VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        size = excluded.size,
        created_at = excluded.created_at
      WHERE video_transfer_parts.etag IS NULL
        AND video_transfer_parts.created_at < ?
      RETURNING id
    `)
    .bind(
      `${transferId}:${partNumber}`,
      transferId,
      partNumber,
      size,
      now,
      now - 5 * 60 * 1_000,
    )
    .first<{ id: string }>();
  return Boolean(row?.id);
}

export async function finishTransferPart(
  transferId: string,
  partNumber: number,
  etag: string,
) {
  await ensureTransferPartSchema();
  const database = (env as unknown as { DB: D1Database }).DB;
  const updated = await database
    .prepare(`
      UPDATE video_transfer_parts
      SET etag = ?
      WHERE id = ?
        AND transfer_id = ?
        AND part_number = ?
        AND etag IS NULL
      RETURNING id
    `)
    .bind(etag, `${transferId}:${partNumber}`, transferId, partNumber)
    .first<{ id: string }>();
  if (!updated?.id) {
    throw new Error("Transfer part claim could not be finalized.");
  }
}

export async function getRecordedTransferPart(
  transferId: string,
  partNumber: number,
) {
  await ensureTransferPartSchema();
  const database = (env as unknown as { DB: D1Database }).DB;
  const row = await database
    .prepare(`
      SELECT part_number, etag
      FROM video_transfer_parts
      WHERE id = ?
        AND transfer_id = ?
        AND etag IS NOT NULL
      LIMIT 1
    `)
    .bind(`${transferId}:${partNumber}`, transferId)
    .first<{ part_number: number; etag: string }>();
  return row
    ? ({ partNumber: row.part_number, etag: row.etag } satisfies UploadedPartReceipt)
    : null;
}

export async function releaseTransferPartClaim(
  transferId: string,
  partNumber: number,
) {
  await ensureTransferPartSchema();
  const database = (env as unknown as { DB: D1Database }).DB;
  await database
    .prepare(`
      DELETE FROM video_transfer_parts
      WHERE id = ?
        AND etag IS NULL
    `)
    .bind(`${transferId}:${partNumber}`)
    .run();
}

export async function getRecordedTransferParts(transferId: string) {
  await ensureTransferPartSchema();
  const database = (env as unknown as { DB: D1Database }).DB;
  const result = await database
    .prepare(`
      SELECT part_number, etag
      FROM video_transfer_parts
      WHERE transfer_id = ?
        AND etag IS NOT NULL
      ORDER BY part_number ASC
      LIMIT 128
    `)
    .bind(transferId)
    .all<{ part_number: number; etag: string }>();
  return (result.results ?? []).map((row) => ({
    partNumber: row.part_number,
    etag: row.etag,
  } satisfies UploadedPartReceipt));
}

async function deleteTransferPartRecords(transferId: string) {
  await ensureTransferPartSchema();
  const database = (env as unknown as { DB: D1Database }).DB;
  await database
    .prepare("DELETE FROM video_transfer_parts WHERE transfer_id = ?")
    .bind(transferId)
    .run();
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
  await deleteTransferPartRecords(transfer.id).catch(() => undefined);
}

export async function cleanupExpiredTransfers(limit = 32) {
  const cleanupLimit = Math.max(
    1,
    Math.min(MAX_CLEANUP_BATCH, Math.floor(limit) || 1),
  );
  const expired = await getDb()
    .select()
    .from(videoTransfers)
    .where(
      and(
        lt(videoTransfers.expiresAt, Date.now()),
        ne(videoTransfers.status, "deleted"),
      ),
    )
    .limit(cleanupLimit);

  for (let index = 0; index < expired.length; index += 8) {
    await Promise.allSettled(
      expired.slice(index, index + 8).map((transfer) => removeTransfer(transfer)),
    );
  }
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
