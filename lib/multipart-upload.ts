export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export type UploadedPartReceipt = {
  partNumber: number;
  etag: string;
};

export function expectedUploadPartCount(
  totalBytes: number,
  chunkBytes = UPLOAD_CHUNK_BYTES,
) {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    totalBytes > MAX_VIDEO_BYTES ||
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes <= 0
  ) {
    return 0;
  }
  return Math.ceil(totalBytes / chunkBytes);
}

export function expectedUploadPartBytes(
  totalBytes: number,
  partNumber: number,
  chunkBytes = UPLOAD_CHUNK_BYTES,
) {
  const partCount = expectedUploadPartCount(totalBytes, chunkBytes);
  if (
    partCount === 0 ||
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > partCount
  ) {
    return 0;
  }
  if (partNumber < partCount) return chunkBytes;
  return totalBytes - chunkBytes * (partCount - 1);
}

export function isValidMultipartCompletion(
  totalBytes: number,
  parts: UploadedPartReceipt[],
  chunkBytes = UPLOAD_CHUNK_BYTES,
) {
  const expectedCount = expectedUploadPartCount(totalBytes, chunkBytes);
  if (expectedCount === 0 || parts.length !== expectedCount) return false;

  let aggregateBytes = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (
      part.partNumber !== index + 1 ||
      typeof part.etag !== "string" ||
      part.etag.length < 1 ||
      part.etag.length > 256 ||
      /\s/.test(part.etag)
    ) {
      return false;
    }
    aggregateBytes += expectedUploadPartBytes(
      totalBytes,
      part.partNumber,
      chunkBytes,
    );
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > totalBytes) {
      return false;
    }
  }
  return aggregateBytes === totalBytes;
}
