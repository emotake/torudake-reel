const VIDEO_MIX_OUTPUT_DB_NAME = "torudake-reel-video-mix-outputs";
const VIDEO_MIX_OUTPUT_STORE_NAME = "outputs";
const VIDEO_MIX_OUTPUT_DIRECTORY_NAME = "completed-video-mix";
const VIDEO_MIX_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VIDEO_MIX_OUTPUT_RECOVERY_CANDIDATE_LIMIT = 10;

export type VideoMixOutputStatus = "pending-completion" | "completed";

export type DurableVideoMixOutputMetadata = Readonly<{
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: number;
  reservationId: string;
  bucket: string;
  qualityMessage: string;
  status: VideoMixOutputStatus;
}>;

type StoredVideoMixOutput = DurableVideoMixOutputMetadata & {
  storage: "opfs" | "indexeddb";
  blob?: Blob;
};

export type DurableVideoMixOutput = Readonly<{
  metadata: DurableVideoMixOutputMetadata;
  blob: Blob;
}>;

function isStoredVideoMixOutput(value: unknown): value is StoredVideoMixOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredVideoMixOutput>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.filename === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.size === "number" &&
    Number.isFinite(candidate.size) &&
    candidate.size > 0 &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.reservationId === "string" &&
    typeof candidate.bucket === "string" &&
    typeof candidate.qualityMessage === "string" &&
    (candidate.status === "pending-completion" ||
      candidate.status === "completed") &&
    (candidate.storage === "opfs" || candidate.storage === "indexeddb")
  );
}

function toMetadata(record: StoredVideoMixOutput): DurableVideoMixOutputMetadata {
  return {
    id: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    size: record.size,
    createdAt: record.createdAt,
    reservationId: record.reservationId,
    bucket: record.bucket,
    qualityMessage: record.qualityMessage,
    status: record.status,
  };
}

function openOutputDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(VIDEO_MIX_OUTPUT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VIDEO_MIX_OUTPUT_STORE_NAME)) {
        const store = database.createObjectStore(VIDEO_MIX_OUTPUT_STORE_NAME, {
          keyPath: "id",
        });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("status", "status");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withOutputStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openOutputDatabase();
  try {
    const transaction = database.transaction(VIDEO_MIX_OUTPUT_STORE_NAME, mode);
    const request = operation(transaction.objectStore(VIDEO_MIX_OUTPUT_STORE_NAME));
    return await waitForIndexedDbTransaction(transaction, request);
  } finally {
    database.close();
  }
}

/** A successful IDBRequest is not durable until its containing transaction
 * commits. Waiting for `oncomplete` prevents a late quota/disk abort from being
 * mistaken for a safely persisted completed video. */
export function waitForIndexedDbTransaction<T>(
  transaction: IDBTransaction,
  request: IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    let requestSucceeded = false;
    let requestResult: T;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error ?? new Error("The device storage transaction failed."));
    };
    request.onsuccess = () => {
      requestSucceeded = true;
      requestResult = request.result;
    };
    request.onerror = () => fail(request.error);
    transaction.onerror = () => fail(transaction.error);
    transaction.onabort = () => fail(transaction.error);
    transaction.oncomplete = () => {
      if (settled) return;
      if (!requestSucceeded) {
        fail(new Error("The device storage request did not complete."));
        return;
      }
      settled = true;
      resolve(requestResult);
    };
  });
}

function opfsIsAvailable() {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

async function getOutputDirectory(create: boolean) {
  if (!opfsIsAvailable()) return null;
  const root = await navigator.storage.getDirectory();
  try {
    return await root.getDirectoryHandle(VIDEO_MIX_OUTPUT_DIRECTORY_NAME, {
      create,
    });
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === "NotFoundError") {
      return null;
    }
    throw error;
  }
}

async function writeOutputToOpfs(id: string, blob: Blob) {
  const directory = await getOutputDirectory(true);
  if (!directory) return false;
  const handle = await directory.getFileHandle(`${id}.mp4`, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // Some implementations close the stream as part of the failed write.
    }
    try {
      await directory.removeEntry(`${id}.mp4`);
    } catch {
      // The IndexedDB Blob fallback below remains authoritative.
    }
    throw error;
  }
  return true;
}

async function readOutputFromOpfs(id: string) {
  const directory = await getOutputDirectory(false);
  if (!directory) return null;
  try {
    const handle = await directory.getFileHandle(`${id}.mp4`);
    return await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function deleteOutputFromOpfs(id: string) {
  const directory = await getOutputDirectory(false);
  if (!directory) return;
  try {
    await directory.removeEntry(`${id}.mp4`);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      throw error;
    }
  }
}

async function requestPersistentDeviceStorage() {
  try {
    if (typeof navigator.storage?.persist === "function") {
      await navigator.storage.persist();
    }
  } catch {
    // The recovery copy remains useful even when the browser declines persistence.
  }
}

async function assertLikelyDeviceStorageCapacity(blobSize: number) {
  try {
    if (typeof navigator.storage?.estimate !== "function") return;
    const estimate = await navigator.storage.estimate();
    if (
      !Number.isFinite(estimate.quota) ||
      !Number.isFinite(estimate.usage)
    ) return;
    const available = Math.max(0, estimate.quota! - estimate.usage!);
    // Leave room for browser transaction overhead and metadata/index writes.
    const required = Math.ceil(blobSize * 1.25);
    if (available < required) {
      throw new Error(
        "端末の空き容量が不足しているため、完成動画を安全に一時保存できません。空き容量を増やしてから再試行してください。利用枠はまだ確定していません。",
      );
    }
  } catch (error) {
    // A trustworthy insufficient-capacity estimate is actionable. Missing or
    // privacy-rounded estimates are not; fall through to the real write.
    if (
      error instanceof Error &&
      error.message.includes("端末の空き容量が不足")
    ) throw error;
  }
}

export async function saveDurableVideoMixOutput(options: {
  blob: Blob;
  filename: string;
  reservationId: string;
  bucket: string;
  qualityMessage: string;
  id?: string;
  createdAt?: number;
}) {
  if (typeof indexedDB === "undefined") {
    throw new Error("この端末では完成動画の一時保存を利用できません。");
  }
  if (!(options.blob instanceof Blob) || options.blob.size <= 0) {
    throw new TypeError("A non-empty completed video Blob is required.");
  }
  const id = options.id || crypto.randomUUID();
  const baseRecord: Omit<StoredVideoMixOutput, "storage" | "blob"> = {
    id,
    filename: options.filename,
    mimeType: options.blob.type || "video/mp4",
    size: options.blob.size,
    createdAt: options.createdAt ?? Date.now(),
    reservationId: options.reservationId,
    bucket: options.bucket,
    qualityMessage: options.qualityMessage,
    status: "pending-completion",
  };

  await assertLikelyDeviceStorageCapacity(options.blob.size);
  await requestPersistentDeviceStorage();
  let wroteOpfs = false;
  try {
    wroteOpfs = await writeOutputToOpfs(id, options.blob);
  } catch {
    wroteOpfs = false;
  }
  const record: StoredVideoMixOutput = wroteOpfs
    ? { ...baseRecord, storage: "opfs" }
    : { ...baseRecord, storage: "indexeddb", blob: options.blob };
  try {
    await withOutputStore("readwrite", (store) => store.put(record));
  } catch (error) {
    if (wroteOpfs) await deleteOutputFromOpfs(id).catch(() => undefined);
    throw error;
  }
  return toMetadata(record);
}

export async function markDurableVideoMixOutputCompleted(id: string) {
  const existing = await withOutputStore<unknown>("readonly", (store) =>
    store.get(id),
  );
  if (!isStoredVideoMixOutput(existing)) {
    throw new Error("一時保存した完成動画を確認できませんでした。");
  }
  const completed: StoredVideoMixOutput = { ...existing, status: "completed" };
  await withOutputStore("readwrite", (store) => store.put(completed));
  return toMetadata(completed);
}

export async function loadDurableVideoMixOutput(id: string) {
  if (typeof indexedDB === "undefined") return null;
  const value = await withOutputStore<unknown>("readonly", (store) => store.get(id));
  if (!isStoredVideoMixOutput(value)) return null;
  const blob =
    value.storage === "opfs"
      ? await readOutputFromOpfs(value.id)
      : value.blob instanceof Blob
        ? value.blob
        : null;
  if (!blob || blob.size <= 0) return null;
  return { metadata: toMetadata(value), blob } satisfies DurableVideoMixOutput;
}

export function selectDurableVideoMixOutputRecoveryCandidates(
  values: readonly unknown[],
  now = Date.now(),
  requestedLimit = VIDEO_MIX_OUTPUT_RECOVERY_CANDIDATE_LIMIT,
) {
  const limit = Math.max(
    1,
    Math.min(
      VIDEO_MIX_OUTPUT_RECOVERY_CANDIDATE_LIMIT,
      Math.floor(requestedLimit) || VIDEO_MIX_OUTPUT_RECOVERY_CANDIDATE_LIMIT,
    ),
  );
  return values
    .filter(isStoredVideoMixOutput)
    .filter((value) => now - value.createdAt <= VIDEO_MIX_OUTPUT_MAX_AGE_MS)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit)
    .map(toMetadata);
}

/** Lists metadata only, newest first. The caller must prove reservation
 * ownership before loading Blob bytes, which prevents a shared browser profile
 * from exposing another account's local video while still allowing the current
 * account to recover an older matching result. */
export async function listDurableVideoMixOutputRecoveryCandidates(
  now = Date.now(),
) {
  if (typeof indexedDB === "undefined") return [];
  const values = await withOutputStore<unknown[]>("readonly", (store) =>
    store.getAll(),
  );
  return selectDurableVideoMixOutputRecoveryCandidates(values, now);
}

export async function loadLatestCompletedVideoMixOutput() {
  if (typeof indexedDB === "undefined") return null;
  const values = await withOutputStore<unknown[]>("readonly", (store) =>
    store.getAll(),
  );
  const newest = values
    .filter(isStoredVideoMixOutput)
    .filter((value) => value.status === "completed")
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return newest ? loadDurableVideoMixOutput(newest.id) : null;
}

/** Returns the newest recoverable result, including a result whose atomic
 * usage completion needs to be retried after a reload or an OS tab purge. */
export async function loadLatestDurableVideoMixOutput() {
  if (typeof indexedDB === "undefined") return null;
  const values = await withOutputStore<unknown[]>("readonly", (store) =>
    store.getAll(),
  );
  const newest = values
    .filter(isStoredVideoMixOutput)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return newest ? loadDurableVideoMixOutput(newest.id) : null;
}

export async function deleteDurableVideoMixOutput(id: string) {
  if (typeof indexedDB === "undefined") return;
  const value = await withOutputStore<unknown>("readonly", (store) => store.get(id));
  await withOutputStore("readwrite", (store) => store.delete(id));
  if (isStoredVideoMixOutput(value) && value.storage === "opfs") {
    await deleteOutputFromOpfs(id).catch(() => undefined);
  }
}

export async function cleanupExpiredVideoMixOutputs(now = Date.now()) {
  if (typeof indexedDB === "undefined") return 0;
  const values = await withOutputStore<unknown[]>("readonly", (store) =>
    store.getAll(),
  );
  const expired = values
    .filter(isStoredVideoMixOutput)
    .filter((value) => now - value.createdAt > VIDEO_MIX_OUTPUT_MAX_AGE_MS);
  await Promise.all(expired.map((value) => deleteDurableVideoMixOutput(value.id)));
  return expired.length;
}
