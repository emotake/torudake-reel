import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const DEFAULT_BOUNDED_JSON_FILE_BYTES = 1024 * 1024;

function fileIdentity(stats) {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(":");
}

/**
 * Reads a local JSON file through one descriptor while rejecting links,
 * oversized inputs, invalid UTF-8, and path/object replacement during the
 * read. The original bytes are returned so callers can bind provenance to the
 * exact file that was parsed.
 */
export function readBoundedJsonFileSync(
  path,
  { maxBytes = DEFAULT_BOUNDED_JSON_FILE_BYTES } = {},
) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Bounded JSON file path must be absolute.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer.");
  }

  const parentPath = dirname(path);
  let parentStats;
  let realParentPath;
  try {
    parentStats = lstatSync(parentPath, { bigint: true });
    realParentPath = realpathSync(parentPath);
  } catch {
    throw new Error("Bounded JSON input parent must be an existing directory.");
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("Bounded JSON input parent must be a real directory.");
  }

  let pathStats;
  try {
    pathStats = lstatSync(path, { bigint: true });
  } catch {
    throw new Error("Bounded JSON input must be an existing regular file.");
  }
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    pathStats.size > BigInt(maxBytes)
  ) {
    throw new Error("Bounded JSON input must be a bounded regular file.");
  }

  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const chunks = [];
  let byteCount = 0;
  try {
    const openedStats = fstatSync(descriptor, { bigint: true });
    if (
      !openedStats.isFile() ||
      openedStats.isSymbolicLink() ||
      openedStats.size > BigInt(maxBytes) ||
      fileIdentity(openedStats) !== fileIdentity(pathStats)
    ) {
      throw new Error("Bounded JSON input changed before it was read.");
    }

    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    while (true) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      if (byteCount > maxBytes) {
        throw new Error("Bounded JSON input exceeds its byte limit.");
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    const finalStats = fstatSync(descriptor, { bigint: true });
    if (
      fileIdentity(finalStats) !== fileIdentity(pathStats) ||
      byteCount !== Number(pathStats.size)
    ) {
      throw new Error("Bounded JSON input changed while it was read.");
    }
  } finally {
    closeSync(descriptor);
  }

  let finalPathStats;
  try {
    finalPathStats = lstatSync(path, { bigint: true });
  } catch {
    throw new Error("Bounded JSON input path changed while it was read.");
  }
  if (
    !finalPathStats.isFile() ||
    finalPathStats.isSymbolicLink() ||
    fileIdentity(finalPathStats) !== fileIdentity(pathStats)
  ) {
    throw new Error("Bounded JSON input path changed while it was read.");
  }
  const finalParentStats = lstatSync(parentPath, { bigint: true });
  const finalRealParentPath = realpathSync(parentPath);
  if (
    !finalParentStats.isDirectory() ||
    finalParentStats.isSymbolicLink() ||
    fileIdentity(finalParentStats) !== fileIdentity(parentStats) ||
    finalRealParentPath !== realParentPath
  ) {
    throw new Error("Bounded JSON input parent changed while it was read.");
  }

  const bytes = Buffer.concat(chunks, byteCount);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { value: JSON.parse(text), bytes };
}
