const EDIT_DRAFT_DB_NAME = "torudake-reel-local-drafts";
const EDIT_DRAFT_STORE_NAME = "drafts";
const EDIT_DRAFT_KEY = "active-video-edit";
const EDIT_DRAFT_SESSION_KEY = "torudake-reel:active-video-edit:v1";

export type VideoDraftFingerprint = {
  name: string;
  size: number;
  lastModified: number;
  type: string;
  durationSeconds: number;
};

export type LocalEditDraft = {
  version: 1;
  savedAt: number;
  fingerprint: VideoDraftFingerprint;
  resultReady: boolean;
  goal: "follow" | "sales" | "reach";
  length: number;
  audioMode: "spoken" | "narration";
  spokenCaptionsEnabled: boolean;
  spokenCutMode: "auto" | "manual" | "none";
  /** Optional sanitized product/person/place names used only during ASR. */
  asrDictionary?: string[];
  narrationStyle: "bright" | "calm" | "comedy" | "party";
  narrationOriginalAudio: number;
  narrationBrief: string;
  narrationCaptionsEnabled: boolean;
  narrationAutoCutEnabled: boolean;
  captionProfile: unknown;
  transcript: unknown[];
  narrationScript?: string;
  usedHighAccuracy: boolean;
};

export function createVideoDraftFingerprint(
  file: Pick<File, "name" | "size" | "lastModified" | "type">,
  durationSeconds: number,
): VideoDraftFingerprint {
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
    durationSeconds: Number.isFinite(durationSeconds)
      ? Math.max(0, durationSeconds)
      : 0,
  };
}

export function matchesVideoDraftFingerprint(
  left: VideoDraftFingerprint,
  right: VideoDraftFingerprint,
) {
  return (
    left.name === right.name &&
    left.size === right.size &&
    left.lastModified === right.lastModified &&
    left.type === right.type &&
    Math.abs(left.durationSeconds - right.durationSeconds) <= 0.75
  );
}

export function normalizeLocalEditDraft(value: unknown): LocalEditDraft | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LocalEditDraft>;
  const validGoal = ["follow", "sales", "reach"].includes(candidate.goal ?? "");
  const validAudioMode = ["spoken", "narration"].includes(
    candidate.audioMode ?? "",
  );
  const validSpokenCutMode = ["auto", "manual", "none"].includes(
    candidate.spokenCutMode ?? "",
  );
  const validNarrationStyle = ["bright", "calm", "comedy", "party"].includes(
    candidate.narrationStyle ?? "",
  );
  if (!(
    candidate.version === 1 &&
    typeof candidate.savedAt === "number" &&
    Number.isFinite(candidate.savedAt) &&
    Boolean(candidate.fingerprint) &&
    typeof candidate.fingerprint?.name === "string" &&
    typeof candidate.fingerprint?.size === "number" &&
    typeof candidate.fingerprint?.lastModified === "number" &&
    typeof candidate.fingerprint?.type === "string" &&
    typeof candidate.fingerprint?.durationSeconds === "number" &&
    typeof candidate.resultReady === "boolean" &&
    validGoal &&
    typeof candidate.length === "number" &&
    Number.isFinite(candidate.length) &&
    validAudioMode &&
    validSpokenCutMode &&
    validNarrationStyle &&
    typeof candidate.narrationOriginalAudio === "number" &&
    typeof candidate.narrationBrief === "string" &&
    typeof candidate.narrationAutoCutEnabled === "boolean" &&
    typeof candidate.usedHighAccuracy === "boolean" &&
    (candidate.asrDictionary === undefined ||
      (Array.isArray(candidate.asrDictionary) &&
        candidate.asrDictionary.every((term) => typeof term === "string"))) &&
    Array.isArray(candidate.transcript)
  )) return null;
  return {
    ...(candidate as LocalEditDraft),
    spokenCaptionsEnabled: candidate.spokenCaptionsEnabled === true,
    narrationCaptionsEnabled: candidate.narrationCaptionsEnabled !== false,
  };
}

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(EDIT_DRAFT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(EDIT_DRAFT_STORE_NAME)) {
        database.createObjectStore(EDIT_DRAFT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withDraftStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDraftDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(EDIT_DRAFT_STORE_NAME, mode);
      const request = operation(transaction.objectStore(EDIT_DRAFT_STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function saveLocalEditDraft(draft: LocalEditDraft) {
  if (typeof window === "undefined") return;
  const serialized = JSON.stringify(draft);
  try {
    window.sessionStorage.setItem(EDIT_DRAFT_SESSION_KEY, serialized);
  } catch {
    // A private browsing mode may disable session storage.
  }
  if (typeof indexedDB === "undefined") return;
  try {
    await withDraftStore("readwrite", (store) =>
      store.put(draft, EDIT_DRAFT_KEY),
    );
  } catch {
    // Session storage remains as the short-lived fallback.
  }
}

export async function loadLocalEditDraft() {
  if (typeof window === "undefined") return null;
  if (typeof indexedDB !== "undefined") {
    try {
      const draft = await withDraftStore<unknown>("readonly", (store) =>
        store.get(EDIT_DRAFT_KEY),
      );
      const normalizedDraft = normalizeLocalEditDraft(draft);
      if (normalizedDraft) return normalizedDraft;
    } catch {
      // Continue to the session fallback.
    }
  }
  try {
    const serialized = window.sessionStorage.getItem(EDIT_DRAFT_SESSION_KEY);
    const draft = serialized ? JSON.parse(serialized) : null;
    return normalizeLocalEditDraft(draft);
  } catch {
    return null;
  }
}

export async function clearLocalEditDraft() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(EDIT_DRAFT_SESSION_KEY);
  } catch {
    // IndexedDB cleanup below may still succeed.
  }
  if (typeof indexedDB === "undefined") return;
  try {
    await withDraftStore("readwrite", (store) =>
      store.delete(EDIT_DRAFT_KEY),
    );
  } catch {
    // Clearing a best-effort local recovery copy must not block editing.
  }
}
