"use client";

import Image from "next/image";
import Link from "next/link";
import {
  MONTHLY_FIRST_OFFER_VERSION,
  MonthlyFirstPurchaseOptions,
  OneTimeRescue,
} from "../monthly-first-purchase";
import SiteFooter from "../site-footer";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  disposePhotoAssets,
  drawPhotoReelFrame,
  computePhotoReelImageLayout,
  preparePhotoAssets,
  type PhotoReelSettings,
  type PhotoReelTemplateId,
  type PreparedPhotoAsset,
} from "../../lib/photo-reel";
import {
  assertPhotoReelExportSupported,
  exportPhotoReel,
  preparePhotoReelAudioContext,
} from "../../lib/photo-reel-export";
import {
  analyzePhotoReelAudioFileBeats,
  repeatPhotoReelBeatCandidates,
  type PhotoReelAudioBeatAnalysis,
} from "../../lib/photo-reel-beats";
import {
  canSaveCompletedVideo,
  isBillingBucket,
  ONE_TIME_PLAN_LABEL,
  ONE_TIME_PRICE_JPY,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  type BillingBucket,
} from "../../lib/billing-policy";
import { trackClientEvent } from "../../lib/client-analytics";

const MAX_PHOTOS = 10;
const MIN_PHOTOS = 2;
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 90;
const PHOTO_REEL_DURATIONS = [15, 30] as const;

const TEMPLATE_OPTIONS: Array<{
  id: PhotoReelTemplateId;
  label: string;
  note: string;
  detail: string;
}> = [
  {
    id: "cinematic",
    label: "シネマ",
    note: "風景・旅行",
    detail: "ゆっくり寄る動きと深みのある切り替え",
  },
  {
    id: "upbeat",
    label: "リズム",
    note: "食事・イベント",
    detail: "小気味よいカットと弾むようなズーム",
  },
  {
    id: "editorial",
    label: "エディトリアル",
    note: "商品・お店",
    detail: "雑誌のような余白と洗練された見せ方",
  },
  {
    id: "memories",
    label: "ダイアリー",
    note: "日常・思い出",
    detail: "写真をめくるような柔らかい動き",
  },
  {
    id: "gallery",
    label: "クリーン",
    note: "写真をそのまま",
    detail: "横写真も切らずに、全体をすっきり表示",
  },
];

const TEMPLATE_IDS = TEMPLATE_OPTIONS.map((option) => option.id);

function moveRadioSelection<T>(
  event: KeyboardEvent<HTMLButtonElement>,
  options: readonly T[],
  currentIndex: number,
  onChange: (value: T) => void,
) {
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (currentIndex + 1) % options.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = options.length - 1;
  }
  if (nextIndex === null) return;

  event.preventDefault();
  onChange(options[nextIndex]);
  const targetIndex = nextIndex;
  const radios = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
    '[role="radio"]:not(:disabled)',
  );
  window.requestAnimationFrame(() => radios?.[targetIndex]?.focus());
}

type ResultVideo = {
  blob: Blob;
  url: string;
  filename: string;
  billingBucket: BillingBucket | null;
};

type PendingFinalize = {
  result: ResultVideo;
  reservationId: string;
};

class PhotoReelRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PhotoReelRequestError";
  }
}

function isSupportedPhoto(file: File) {
  return new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]).has(file.type.toLowerCase()) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function readAudioDuration(url: string) {
  return new Promise<number>((resolve, reject) => {
    const audio = document.createElement("audio");
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", finish);
      audio.removeEventListener("error", fail);
      audio.removeAttribute("src");
      audio.load();
    };
    const succeed = (duration: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(duration);
    };
    const finish = () => {
      const duration = audio.duration;
      if (Number.isFinite(duration) && duration > 0) {
        succeed(duration);
      } else {
        fail();
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("音源の長さを確認できませんでした。"));
    };
    const timeout = window.setTimeout(fail, 10_000);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", finish, { once: true });
    audio.addEventListener("error", fail, { once: true });
    audio.src = url;
    audio.load();
  });
}

function buildFilename() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join("");
  return `torudake-photo-reel-${stamp}.mp4`;
}

function prepareResultVideo(
  blob: Blob,
  billingBucket: BillingBucket | null,
): ResultVideo {
  if (blob.size < 1024) throw new Error("完成動画のデータが空でした。");
  return {
    blob,
    url: URL.createObjectURL(blob),
    filename: buildFilename(),
    billingBucket,
  };
}

async function readError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return payload?.error?.trim() || fallback;
}

async function reservePhotoUsage(
  duration: 15 | 30,
  idempotencyKey: string,
) {
  const requestBody = JSON.stringify({
    sourceDurationSeconds: duration,
    idempotencyKey,
    creationType: "photo",
  });
  const requestReservation = () =>
    fetch("/api/usage/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

  let response = await requestReservation();
  if (response.status === 401) {
    const trialResponse = await fetch("/api/session/trial", { method: "POST" });
    if (!trialResponse.ok) {
      throw new PhotoReelRequestError(
        await readError(
          trialResponse,
          "無料体験を開始できませんでした。ページを再読み込みしてお試しください。",
        ),
        trialResponse.status,
      );
    }
    response = await requestReservation();
  }

  if (!response.ok) {
    throw new PhotoReelRequestError(
      await readError(response, "利用枠を確認できませんでした。"),
      response.status,
    );
  }

  const payload = (await response.json()) as {
    bucket?: unknown;
    required?: boolean;
    reservationId?: string;
  };
  if (payload.required && !payload.reservationId) {
    throw new PhotoReelRequestError("利用枠を確認できませんでした。", 500);
  }
  const bucket = payload.required
    ? isBillingBucket(payload.bucket)
      ? payload.bucket
      : null
    : null;
  if (payload.required && !bucket) {
    throw new PhotoReelRequestError("利用枠を確認できませんでした。", 500);
  }
  return {
    reservationId: payload.required ? payload.reservationId ?? null : null,
    bucket,
  };
}

async function updatePhotoUsage(
  action: "complete" | "release",
  reservationId: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`/api/usage/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { completed?: boolean; released?: boolean; error?: string }
        | null;
      const confirmed =
        action === "complete" ? payload?.completed : payload?.released;
      if (response.ok && confirmed) return true;
      lastError = new Error(
        payload?.error ||
          (action === "complete"
            ? "利用記録を確定できませんでした。"
            : "利用枠を戻せませんでした。"),
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("利用記録を確認できませんでした。");
}

function getFriendlyExportError(error: unknown) {
  if (error instanceof PhotoReelRequestError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "書き出しを中止しました。利用枠は消費されません。";
  }
  if (error instanceof Error) {
    if (/support|codec|encoder|WebCodecs|VideoEncoder/i.test(error.message)) {
      return "このブラウザではMP4を書き出せません。SafariまたはChromeを最新版にしてお試しください。";
    }
    if (/memory|allocation|canvas|bitmap/i.test(error.message)) {
      return "写真の処理に必要なメモリが足りませんでした。他のアプリを閉じるか、写真の枚数を減らしてお試しください。";
    }
    if (error.message.trim()) return error.message;
  }
  return "動画を書き出せませんでした。写真を減らして、もう一度お試しください。";
}

export default function PhotoReelClient() {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const audioPreviewRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photosRef = useRef<PreparedPhotoAsset[]>([]);
  const animationRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<ResultVideo | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalize | null>(null);
  const audioValidationRef = useRef(0);
  const audioPreparingRef = useRef(false);
  const finalizingUsageRef = useRef(false);
  const purchaseCheckRef = useRef(false);
  const purchaseReturnPendingRef = useRef(false);
  const previewTimeRef = useRef(0);
  const reservationAttemptRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const [photos, setPhotos] = useState<PreparedPhotoAsset[]>([]);
  const [duration, setDuration] = useState<15 | 30>(15);
  const [templateId, setTemplateId] =
    useState<PhotoReelTemplateId>("cinematic");
  const [title, setTitle] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [audioBeatAnalysis, setAudioBeatAnalysis] =
    useState<PhotoReelAudioBeatAnalysis | null>(null);
  const [audioPreparing, setAudioPreparing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareProgress, setPrepareProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [result, setResult] = useState<ResultVideo | null>(null);
  const [pendingFinalize, setPendingFinalize] =
    useState<PendingFinalize | null>(null);
  const [finalizingUsage, setFinalizingUsage] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPurchase, setShowPurchase] = useState(false);
  const [purchaseChecking, setPurchaseChecking] = useState(false);
  const isEditingLocked =
    preparing ||
    exporting ||
    audioPreparing ||
    finalizingUsage ||
    Boolean(pendingFinalize);

  const repeatedBeatCandidates = useMemo(
    () =>
      audioFile && audioBeatAnalysis
        ? repeatPhotoReelBeatCandidates(
            audioBeatAnalysis.beats,
            audioBeatAnalysis.duration,
            duration,
          )
        : undefined,
    [audioBeatAnalysis, audioFile, duration],
  );

  const settings = useMemo<PhotoReelSettings>(
    () => ({
      duration,
      templateId,
      title: title.trim() || undefined,
      ...(repeatedBeatCandidates !== undefined
        ? { beatCandidates: repeatedBeatCandidates }
        : {}),
    }),
    [duration, repeatedBeatCandidates, templateId, title],
  );

  const lowResolutionCount = useMemo(
    () =>
      photos.filter((photo) => {
        const foreground = computePhotoReelImageLayout(
          photo.width,
          photo.height,
        ).foreground;
        return (
          foreground.width > photo.width + 0.5 ||
          foreground.height > photo.height + 0.5
        );
      }).length,
    [photos],
  );

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    pendingFinalizeRef.current = pendingFinalize;
  }, [pendingFinalize]);

  useEffect(() => {
    previewTimeRef.current = previewTime;
  }, [previewTime]);

  useEffect(
    () => () => {
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl);
    },
    [audioPreviewUrl],
  );

  useEffect(() => {
    if (!isPlaying) audioPreviewRef.current?.pause();
  }, [isPlaying]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReducedMotion(query.matches);
      if (query.matches) setIsPlaying(false);
    };
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  const checkPurchaseAfterReturn = useCallback(async () => {
    if (purchaseCheckRef.current) return false;
    purchaseCheckRef.current = true;
    setPurchaseChecking(true);
    setError("");
    setMessage("購入状況を確認しています…");
    try {
      const response = await fetch("/api/billing/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            authenticated?: boolean;
            monthly?: { active?: boolean; accessRevoked?: boolean };
            oneTimeCredits?: number;
            error?: string;
          }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "購入状況を確認できませんでした。");
      }
      const canExport =
        (payload?.monthly?.active === true &&
          payload.monthly.accessRevoked !== true) ||
        (payload?.oneTimeCredits ?? 0) > 0;
      purchaseReturnPendingRef.current = false;
      if (!canExport) {
        setShowPurchase(true);
        setMessage(
          payload?.authenticated === false
            ? "決済に使ったアカウントでログイン後、「購入状況を再確認」を押してください。"
            : "購入済みの利用枠をまだ確認できません。決済完了後、少し待ってから再確認してください。",
        );
        return false;
      }
      setShowPurchase(false);
      setMessage(
        "購入済みの利用枠を確認しました。上の「写真リールを書き出す」を押すと、編集内容を保ったまま再開できます。",
      );
      return true;
    } catch (caught) {
      purchaseReturnPendingRef.current = false;
      setShowPurchase(true);
      setMessage("");
      setError(
        caught instanceof Error
          ? caught.message
          : "購入状況を確認できませんでした。",
      );
      return false;
    } finally {
      purchaseCheckRef.current = false;
      setPurchaseChecking(false);
    }
  }, []);

  useEffect(() => {
    const recheckAfterCheckout = () => {
      if (
        document.visibilityState !== "visible" ||
        !showPurchase ||
        !purchaseReturnPendingRef.current ||
        purchaseCheckRef.current
      ) {
        return;
      }
      void checkPurchaseAfterReturn();
    };
    window.addEventListener("focus", recheckAfterCheckout);
    document.addEventListener("visibilitychange", recheckAfterCheckout);
    return () => {
      window.removeEventListener("focus", recheckAfterCheckout);
      document.removeEventListener("visibilitychange", recheckAfterCheckout);
    };
  }, [checkPurchaseAfterReturn, showPurchase]);

  const markCheckoutStarted = (
    plan: "starter" | "standard" | "one_time",
  ) => {
    trackClientEvent("checkout_started", {
      plan,
      source: "result",
      mode: "photo",
      offer_version: MONTHLY_FIRST_OFFER_VERSION,
    });
    purchaseReturnPendingRef.current = true;
    setMessage(
      "別タブで決済を完了してください。この画面へ戻ると購入状況を自動で確認します。",
    );
  };

  useEffect(() => {
    // React Strict Mode replays effects in development, so reset this on each
    // mount instead of only relying on the ref's initial value.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      audioValidationRef.current += 1;
      audioPreparingRef.current = false;
      finalizingUsageRef.current = false;
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
      abortRef.current?.abort();
      disposePhotoAssets(photosRef.current);
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      const pendingResult = pendingFinalizeRef.current?.result;
      if (pendingResult && pendingResult.url !== resultRef.current?.url) {
        URL.revokeObjectURL(pendingResult.url);
      }
    };
  }, []);

  const clearResult = useCallback(() => {
    setShowPurchase(false);
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      resultRef.current = null;
      return null;
    });
  }, []);

  const setPreviewAudioPosition = useCallback((time: number) => {
    const audio = audioPreviewRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const desired = Math.max(0, time) % audio.duration;
    if (Math.abs(audio.currentTime - desired) > 0.3) {
      audio.currentTime = desired;
    }
  }, []);

  const togglePreviewPlayback = () => {
    if (isPlaying) {
      audioPreviewRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    setPreviewAudioPosition(previewTime >= duration ? 0 : previewTime);
    const audioPlayback = audioPreviewRef.current?.play();
    audioPlayback?.catch(() => {
      setIsPlaying(false);
      setError(
        "BGMを再生できませんでした。音源を選び直すか、端末の消音設定を確認してください。",
      );
    });
    setIsPlaying(true);
  };

  const renderPreviewFrame = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas || photos.length === 0) return;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      drawPhotoReelFrame(context, photos, settings, time);
    },
    [photos, settings],
  );

  useEffect(() => {
    if (photos.length === 0) return;
    renderPreviewFrame(Math.min(previewTime, duration));
  }, [duration, photos.length, previewTime, renderPreviewFrame]);

  useEffect(() => {
    if (!isPlaying || photos.length === 0 || reducedMotion) return;
    let lastFrame = performance.now();
    let lastUiUpdate = lastFrame;
    let currentTime =
      previewTimeRef.current >= duration ? 0 : previewTimeRef.current;

    const tick = (now: number) => {
      if (now - lastFrame >= 1000 / 30) {
        currentTime += (now - lastFrame) / 1000;
        lastFrame = now;
        if (currentTime >= duration) currentTime %= duration;
        renderPreviewFrame(currentTime);
        if (now - lastUiUpdate >= 100) {
          setPreviewAudioPosition(currentTime);
          previewTimeRef.current = currentTime;
          setPreviewTime(currentTime);
          lastUiUpdate = now;
        }
      }
      animationRef.current = requestAnimationFrame(tick);
    };

    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [
    duration,
    isPlaying,
    photos.length,
    reducedMotion,
    renderPreviewFrame,
    setPreviewAudioPosition,
  ]);

  const addPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (chosen.length === 0 || preparing || isEditingLocked) return;

    setError("");
    setShowPurchase(false);
    setMessage("");
    const remaining = MAX_PHOTOS - photos.length;
    if (remaining <= 0) {
      setError("写真は10枚までです。不要な写真を削除してから追加してください。");
      return;
    }

    const invalid = chosen.filter((file) => !isSupportedPhoto(file));
    const oversized = chosen.filter((file) => file.size > MAX_PHOTO_BYTES);
    const accepted = chosen
      .filter(
        (file) => isSupportedPhoto(file) && file.size <= MAX_PHOTO_BYTES,
      )
      .slice(0, remaining);
    const existingBytes = photos.reduce((sum, photo) => sum + photo.file.size, 0);
    const totalBytes = accepted.reduce((sum, file) => sum + file.size, existingBytes);

    if (invalid.length > 0 || oversized.length > 0) {
      setError(
        "読み込めない写真がありました。JPEG・PNG・WebP・HEIC・HEIF、1枚50MB以下でお試しください。",
      );
    }
    if (chosen.length > remaining) {
      setMessage(`上限は10枚のため、先頭から${remaining}枚を追加します。`);
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      setError(
        "写真の合計サイズが250MBを超えています。枚数を減らすか、写真を軽くしてお試しください。",
      );
      return;
    }
    if (accepted.length === 0) return;

    setPreparing(true);
    setPrepareProgress(0);
    setIsPlaying(false);
    clearResult();
    const prepared: PreparedPhotoAsset[] = [];
    const failed: string[] = [];

    for (let index = 0; index < accepted.length; index += 1) {
      if (!mountedRef.current) break;
      const file = accepted[index];
      try {
        const assets = await preparePhotoAssets([file], (fileProgress) => {
          if (mountedRef.current) {
            setPrepareProgress((index + fileProgress) / accepted.length);
          }
        });
        if (!mountedRef.current) {
          disposePhotoAssets(assets);
          break;
        }
        if (assets[0]) prepared.push(assets[0]);
      } catch {
        failed.push(file.name);
      }
    }

    if (!mountedRef.current) {
      disposePhotoAssets(prepared);
      return;
    }

    if (prepared.length > 0) {
      setPhotos((current) => {
        const next = [...current, ...prepared];
        photosRef.current = next;
        return next;
      });
      setPreviewTime(0);
      previewTimeRef.current = 0;
      setMessage(
        `${prepared.length}枚を追加しました。順番と仕上がりを確認できます。`,
      );
    }
    if (failed.length > 0) {
      setError(
        `読み込めない写真が${failed.length}枚ありました。iPhoneで変換が必要な場合は、写真アプリからJPEGとして共有してお試しください。`,
      );
    }
    setPrepareProgress(1);
    setPreparing(false);
  };

  const movePhoto = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= photos.length || isEditingLocked) return;
    setPhotos((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      photosRef.current = next;
      return next;
    });
    setPreviewTime(0);
    previewTimeRef.current = 0;
    setIsPlaying(false);
    clearResult();
  };

  const removePhoto = (index: number) => {
    if (isEditingLocked) return;
    setPhotos((current) => {
      const target = current[index];
      if (target) disposePhotoAssets([target]);
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      photosRef.current = next;
      return next;
    });
    setPreviewTime(0);
    previewTimeRef.current = 0;
    setIsPlaying(false);
    clearResult();
  };

  const handleAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || isEditingLocked) return;
    const validation = audioValidationRef.current + 1;
    audioValidationRef.current = validation;
    if (
      (!file.type.startsWith("audio/") &&
        !/\.(mp3|m4a|wav|aac)$/i.test(file.name)) ||
      file.size > MAX_AUDIO_BYTES
    ) {
      audioPreparingRef.current = false;
      setAudioPreparing(false);
      setError("音源は12MB以下のMP3・M4A・WAVなどを選んでください。");
      return;
    }
    audioPreparingRef.current = true;
    setAudioPreparing(true);
    // Keep preview/export on the established plan while a replacement BGM is
    // being inspected. A failed inspection therefore never leaves stale beats.
    setAudioBeatAnalysis({ duration: 1, beats: [] });
    setError("");
    const nextPreviewUrl = URL.createObjectURL(file);
    let ownsPreviewUrl = true;
    const revokeNextPreview = () => {
      if (!ownsPreviewUrl) return;
      ownsPreviewUrl = false;
      URL.revokeObjectURL(nextPreviewUrl);
    };
    try {
      const audioDuration = await readAudioDuration(nextPreviewUrl);
      if (
        !mountedRef.current ||
        audioValidationRef.current !== validation ||
        pendingFinalizeRef.current
      ) {
        revokeNextPreview();
        return;
      }
      if (audioDuration > MAX_AUDIO_DURATION_SECONDS) {
        revokeNextPreview();
        setError(
          "音源は90秒以内にしてください。長い音源は端末のメモリ不足を防ぐため読み込めません。",
        );
        return;
      }
      const beatAnalysis = await analyzePhotoReelAudioFileBeats(
        file,
        audioDuration,
      );
      if (
        !mountedRef.current ||
        audioValidationRef.current !== validation ||
        pendingFinalizeRef.current
      ) {
        revokeNextPreview();
        return;
      }
      setIsPlaying(false);
      audioPreviewRef.current?.pause();
      setAudioFile(file);
      setAudioBeatAnalysis(
        beatAnalysis ?? { duration: audioDuration, beats: [] },
      );
      setAudioPreviewUrl(nextPreviewUrl);
      ownsPreviewUrl = false;
      setShowPurchase(false);
      clearResult();
    } catch (caught) {
      revokeNextPreview();
      if (
        mountedRef.current &&
        audioValidationRef.current === validation
      ) {
        setError(
          caught instanceof Error
            ? caught.message
            : "音源を読み込めませんでした。",
        );
      }
    } finally {
      if (audioValidationRef.current === validation) {
        audioPreparingRef.current = false;
        if (mountedRef.current) setAudioPreparing(false);
      }
    }
  };

  const finalizeResult = useCallback((nextResult: ResultVideo) => {
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      resultRef.current = nextResult;
      return nextResult;
    });
    pendingFinalizeRef.current = null;
    setPendingFinalize(null);
    setMessage("1080×1920のMP4動画が完成しました。保存または共有できます。");
  }, []);

  const startExport = async () => {
    if (
      photos.length < MIN_PHOTOS ||
      preparing ||
      audioPreparingRef.current ||
      abortRef.current ||
      isEditingLocked
    ) {
      return;
    }
    audioValidationRef.current += 1;
    const preparedAudioContext = audioFile
      ? preparePhotoReelAudioContext()
      : null;
    clearResult();
    setError("");
    setMessage("");
    setShowPurchase(false);
    setExporting(true);
    setExportProgress(0);
    setIsPlaying(false);
    audioPreviewRef.current?.pause();
    const controller = new AbortController();
    abortRef.current = controller;
    let reservationId: string | null = null;
    let preparedResult: ResultVideo | null = null;

    try {
      await assertPhotoReelExportSupported(Boolean(audioFile));
      const reservationAttempt =
        reservationAttemptRef.current ?? crypto.randomUUID();
      reservationAttemptRef.current = reservationAttempt;
      const reservation = await reservePhotoUsage(duration, reservationAttempt);
      reservationId = reservation.reservationId;
      if (!reservationId) reservationAttemptRef.current = null;
      if (!canSaveCompletedVideo(reservation.bucket)) {
        if (reservationId) {
          try {
            await updatePhotoUsage("release", reservationId);
            reservationAttemptRef.current = null;
          } catch {
            setError(
              "無料体験の利用確認を終了できませんでしたが、編集内容はそのまま残っています。",
            );
          }
          reservationId = null;
        }
        setShowPurchase(true);
        setMessage(
          "無料体験では編集とプレビューまで利用できます。完成動画の保存にはプランを選んでください。",
        );
        return;
      }
      const blob = await exportPhotoReel(photos, settings, {
        audioFile: audioFile ?? undefined,
        audioFit: "loop",
        preparedAudioContext,
        signal: controller.signal,
        onProgress: (value) => setExportProgress(value),
      });
      preparedResult = prepareResultVideo(blob, reservation.bucket);
      if (reservationId) {
        try {
          await updatePhotoUsage("complete", reservationId);
        } catch {
          const pending = { result: preparedResult, reservationId };
          pendingFinalizeRef.current = pending;
          setPendingFinalize(pending);
          setError(
            "動画は完成しましたが、利用記録を確認できませんでした。通信を確認して再試行してください。",
          );
          return;
        }
      }
      reservationAttemptRef.current = null;
      finalizeResult(preparedResult);
      setExportProgress(1);
    } catch (caught) {
      if (preparedResult) URL.revokeObjectURL(preparedResult.url);
      setShowPurchase(
        caught instanceof PhotoReelRequestError && caught.status === 402,
      );
      if (reservationId) {
        try {
          await updatePhotoUsage("release", reservationId);
          reservationAttemptRef.current = null;
        } catch {
          setError(
            `${getFriendlyExportError(caught)} 利用枠の戻し処理も通信できませんでした。しばらく待ってから再度お試しください。`,
          );
          return;
        }
      } else if (
        caught instanceof PhotoReelRequestError &&
        caught.status < 500
      ) {
        reservationAttemptRef.current = null;
      }
      setError(getFriendlyExportError(caught));
    } finally {
      abortRef.current = null;
      await preparedAudioContext?.close().catch(() => undefined);
      setExporting(false);
    }
  };

  const retryFinalize = async () => {
    if (
      !pendingFinalize ||
      exporting ||
      finalizingUsage ||
      finalizingUsageRef.current
    ) {
      return;
    }
    finalizingUsageRef.current = true;
    setFinalizingUsage(true);
    setError("");
    try {
      await updatePhotoUsage("complete", pendingFinalize.reservationId);
      reservationAttemptRef.current = null;
      finalizeResult(pendingFinalize.result);
    } catch (caught) {
      setError(getFriendlyExportError(caught));
    } finally {
      finalizingUsageRef.current = false;
      setFinalizingUsage(false);
    }
  };

  const discardPendingFinalize = async () => {
    if (
      !pendingFinalize ||
      exporting ||
      finalizingUsage ||
      finalizingUsageRef.current
    ) {
      return;
    }
    finalizingUsageRef.current = true;
    setFinalizingUsage(true);
    let releaseFailed = false;
    try {
      await updatePhotoUsage("release", pendingFinalize.reservationId);
    } catch {
      releaseFailed = true;
    } finally {
      URL.revokeObjectURL(pendingFinalize.result.url);
      reservationAttemptRef.current = null;
      pendingFinalizeRef.current = null;
      setPendingFinalize(null);
      finalizingUsageRef.current = false;
      setFinalizingUsage(false);
      if (releaseFailed) {
        setError(
          "完成データを破棄しました。利用枠の解放を確認できないため、しばらく待ってから書き出してください。",
        );
      } else {
        setError("");
        setMessage("完成データを破棄し、編集へ戻りました。");
      }
    }
  };

  const saveResult = async () => {
    if (!result) return;
    if (!canSaveCompletedVideo(result.billingBucket)) {
      setShowPurchase(true);
      setMessage(
        "無料体験では編集とプレビューまで利用できます。完成動画の保存にはプランを選んでください。",
      );
      return;
    }
    setError("");
    const file = new File([result.blob], result.filename, { type: "video/mp4" });
    const shareData: ShareData = {
      files: [file],
      title: "撮るだけリールで作成した写真リール",
    };

    try {
      if (
        typeof navigator.share === "function" &&
        (!navigator.canShare || navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        return;
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
    }

    const anchor = document.createElement("a");
    anchor.href = result.url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const updateDuration = (next: 15 | 30) => {
    if (isEditingLocked) return;
    setDuration(next);
    setPreviewTime(0);
    previewTimeRef.current = 0;
    setIsPlaying(false);
    clearResult();
  };

  const updateTemplate = (next: PhotoReelTemplateId) => {
    if (isEditingLocked) return;
    setTemplateId(next);
    setPreviewTime(0);
    previewTimeRef.current = 0;
    setIsPlaying(false);
    clearResult();
  };

  return (
    <>
      <main className="photoReelShell">
      <header className="photoReelTopbar">
        <Link className="photoReelBrand" href="/" aria-label="撮るだけリールのトップへ">
          <span className="photoReelBrandIcon" aria-hidden="true">
            ▶<i />
          </span>
          <span>
            撮るだけリール
            <small>写真から作る</small>
          </span>
        </Link>
        <nav aria-label="写真リールのナビゲーション">
          <Link href="/">動画から作る</Link>
          <Link href="/account">アカウント</Link>
        </nav>
      </header>

      <section className="photoReelIntro">
        <p className="photoReelEyebrow">写真からリールへ・端末内編集</p>
        <h1>
          写真を選ぶだけ。
          <br />
          <em>動きのある1本に。</em>
        </h1>
        <p>
          日常で撮った写真を2〜10枚選び、5つの仕上がりから選ぶだけ。
          <br />
          写真そのものは送信せず、スマホやパソコンの中でリール動画にします。
        </p>
        {photos.length === 0 ? (
          <button
            className="photoReelHeroCta"
            type="button"
            onClick={() => photoInputRef.current?.click()}
            disabled={preparing || isEditingLocked}
          >
            <strong>写真を選んで無料でプレビュー</strong>
            <small>無料体験はサービス共通で合計3分以内・動画2本まで</small>
          </button>
        ) : null}
        <div className="photoReelIntroOffer" aria-label="写真リールの料金">
          <span aria-hidden="true">¥0</span>
          <p>
            <strong>仕上がりプレビューは無料体験の範囲内</strong>
            <small>
              {ONE_TIME_PLAN_LABEL}は1回の購入で動画1本まで・¥
              {ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}。{STARTER_MONTHLY_PLAN_LABEL}は1か月に動画
              {STARTER_MONTHLY_VIDEO_LIMIT}本まで・¥
              {STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}、{STANDARD_MONTHLY_PLAN_LABEL}は1か月に動画
              {STANDARD_MONTHLY_VIDEO_LIMIT}本まで・¥
              {STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}です。表示価格はすべて税込で、購入手続き完了時に決済されます。
            </small>
          </p>
        </div>
        <div className="photoReelTrust">
          <span>プレビュー中の変更は追加料金なし</span>
          <span>1080×1920 MP4</span>
          <span>横写真も切らずに対応</span>
        </div>
      </section>

      <section className="photoReelWorkspace" aria-label="写真リール編集">
        <div className="photoReelPreviewPanel">
          <div className="photoReelPreviewHeading">
            <span>仕上がりプレビュー</span>
            <small>{photos.length > 0 ? `${photos.length}枚・${duration}秒` : "9:16"}</small>
          </div>
          <div className="photoReelPhone">
            {photos.length > 0 ? (
              <canvas
                ref={canvasRef}
                width={1080}
                height={1920}
                aria-label="写真リールの仕上がりプレビュー"
              />
            ) : (
              <div className="photoReelEmptyPreview">
                <span aria-hidden="true">＋</span>
                <strong>写真を選ぶと、ここで動きを確認できます</strong>
                <small>2〜10枚・JPEG・PNG・WebP・HEIC</small>
              </div>
            )}
          </div>

          <div className="photoReelPlayback">
            <button
              type="button"
              onClick={togglePreviewPlayback}
              disabled={photos.length === 0 || reducedMotion}
              aria-label={isPlaying ? "プレビューを一時停止" : "プレビューを再生"}
            >
              {isPlaying ? "Ⅱ" : "▶"}
            </button>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.05}
              value={Math.min(previewTime, duration)}
              disabled={photos.length === 0}
              aria-label="プレビューの再生位置"
              onChange={(event) => {
                audioPreviewRef.current?.pause();
                setIsPlaying(false);
                const nextTime = Number(event.target.value);
                previewTimeRef.current = nextTime;
                setPreviewTime(nextTime);
                setPreviewAudioPosition(nextTime);
              }}
            />
            <span>
              {formatTime(previewTime)} / {formatTime(duration)}
            </span>
          </div>
          {reducedMotion ? (
            <p className="photoReelMotionNote">
              端末の動きを減らす設定に合わせ、自動再生を停止しています。シークバーで確認できます。
            </p>
          ) : null}
          <div className="photoReelOutputFacts">
            <span>
              <strong>1080 × 1920</strong>
              実際の書き出し解像度
            </span>
            <span>
              <strong>MP4</strong>
              Instagram向け
            </span>
          </div>
          {lowResolutionCount > 0 ? (
            <p className="photoReelQualityNote">
              {lowResolutionCount}枚は元写真の解像度が低いため、その部分だけ鮮明さに限界があります。サービス側では1080×1920で書き出します。
            </p>
          ) : null}
        </div>

        <div className="photoReelControls">
          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>01</span>
              <div>
                <h2>写真を選ぶ</h2>
                <p>おすすめは4〜8枚。選んだ順に並びます。</p>
              </div>
              <strong>{photos.length} / 10</strong>
            </div>
            <input
              ref={photoInputRef}
              className="visuallyHidden"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
              multiple
              disabled={isEditingLocked}
              onChange={addPhotos}
            />
            <button
              className="photoReelAddButton"
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={preparing || isEditingLocked || photos.length >= MAX_PHOTOS}
            >
              <span aria-hidden="true">＋</span>
              <span>
                <strong>{photos.length === 0 ? "写真を選ぶ" : "写真を追加する"}</strong>
                <small>iPhoneのHEICにも対応・2〜10枚</small>
              </span>
            </button>
            {preparing ? (
              <div className="photoReelPreparing" aria-live="polite">
                <span style={{ width: `${Math.round(prepareProgress * 100)}%` }} />
                <p>写真を端末内で準備中… {Math.round(prepareProgress * 100)}%</p>
              </div>
            ) : null}

            {photos.length > 0 ? (
              <ol className="photoReelPhotoList" aria-label="写真の再生順">
                {photos.map((photo, index) => (
                  <li key={photo.id}>
                    <span className="photoReelPhotoNumber">{index + 1}</span>
                    <span className="photoReelThumb">
                      <Image
                        src={photo.previewUrl}
                        alt={`${index + 1}枚目: ${photo.name}`}
                        width={76}
                        height={76}
                        unoptimized
                      />
                    </span>
                    <span className="photoReelPhotoInfo">
                      <strong>{photo.name}</strong>
                      <small>
                        {photo.width}×{photo.height}
                      </small>
                    </span>
                    <span className="photoReelPhotoActions">
                      <button
                        type="button"
                        onClick={() => movePhoto(index, -1)}
                        disabled={index === 0 || isEditingLocked}
                        aria-label={`${photo.name}を1つ前へ`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => movePhoto(index, 1)}
                        disabled={index === photos.length - 1 || isEditingLocked}
                        aria-label={`${photo.name}を1つ後ろへ`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="photoReelDelete"
                        onClick={() => removePhoto(index)}
                        disabled={isEditingLocked}
                        aria-label={`${photo.name}を削除`}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>02</span>
              <div>
                <h2>動画の長さ</h2>
                <p>写真の表示時間は自動で均等に整えます。</p>
              </div>
            </div>
            <div className="photoReelSegmented" role="radiogroup" aria-label="動画の長さ">
              {PHOTO_REEL_DURATIONS.map((seconds, index) => (
                <button
                  key={seconds}
                  type="button"
                  role="radio"
                  aria-checked={duration === seconds}
                  tabIndex={duration === seconds ? 0 : -1}
                  className={duration === seconds ? "isActive" : ""}
                  disabled={isEditingLocked}
                  onClick={() => updateDuration(seconds)}
                  onKeyDown={(event) =>
                    moveRadioSelection(
                      event,
                      PHOTO_REEL_DURATIONS,
                      index,
                      updateDuration,
                    )
                  }
                >
                  <strong>{seconds}秒</strong>
                  <small>{seconds === 15 ? "テンポよく" : "ゆったり見せる"}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>03</span>
              <div>
                <h2>自動編集を選ぶ</h2>
                <p>動きもテンポも異なる5パターンです。プレビュー中は何度選び直しても追加料金はかかりません。</p>
              </div>
            </div>
            <div className="photoReelTemplateGrid" role="radiogroup" aria-label="自動編集パターン">
              {TEMPLATE_OPTIONS.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={templateId === option.id}
                  tabIndex={templateId === option.id ? 0 : -1}
                  data-template={option.id}
                  className={templateId === option.id ? "isActive" : ""}
                  disabled={isEditingLocked}
                  onClick={() => updateTemplate(option.id)}
                  onKeyDown={(event) =>
                    moveRadioSelection(
                      event,
                      TEMPLATE_IDS,
                      index,
                      updateTemplate,
                    )
                  }
                >
                  <span className="photoReelTemplateVisual" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.note}</small>
                  </span>
                  <p>{option.detail}</p>
                  {option.id === "cinematic" ? <em>おすすめ</em> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="photoReelControlSection">
            <div className="photoReelSectionHeading">
              <span>04</span>
              <div>
                <h2>文字と音を整える</h2>
                <p>どちらも任意です。プレビュー中に設定を変えても追加料金はかかりません。</p>
              </div>
            </div>
            <label className="photoReelField">
              <span>
                最初に入れるタイトル
                <small>{title.length} / 42</small>
              </span>
              <input
                type="text"
                value={title}
                maxLength={42}
                placeholder="例：週末の小さな旅"
                disabled={isEditingLocked}
                onChange={(event) => {
                  setTitle(event.target.value);
                  previewTimeRef.current = 0;
                  setPreviewTime(0);
                  clearResult();
                }}
              />
            </label>
            <input
              ref={audioInputRef}
              className="visuallyHidden"
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.aac"
              disabled={isEditingLocked}
              onChange={handleAudio}
            />
            <div className="photoReelAudioRow">
              <div>
                <strong>BGM</strong>
                <p>
                  {audioFile ? audioFile.name : "音なし（初期設定）"}
                </p>
                <small>90秒・12MB以内。権利を持つ音源だけをご利用ください。</small>
              </div>
              <button
                type="button"
                onClick={() => audioInputRef.current?.click()}
                disabled={isEditingLocked}
              >
                {audioPreparing
                  ? "音源を確認中…"
                  : audioFile
                    ? "変更"
                    : "音源を選ぶ"}
              </button>
              {audioFile ? (
                <button
                  type="button"
                  className="photoReelAudioRemove"
                  onClick={() => {
                    audioValidationRef.current += 1;
                    setAudioFile(null);
                    setAudioBeatAnalysis(null);
                    setAudioPreviewUrl("");
                    audioPreviewRef.current?.pause();
                    setIsPlaying(false);
                    clearResult();
                  }}
                  disabled={isEditingLocked}
                >
                  音なしに戻す
                </button>
              ) : null}
              {audioPreviewUrl ? (
                <div className="photoReelAudioSyncNote">
                  <audio
                    ref={audioPreviewRef}
                    src={audioPreviewUrl}
                    preload="metadata"
                    loop
                  />
                  <small>左のプレビュー再生ボタンで、映像とBGMを一緒に確認できます。</small>
                </div>
              ) : null}
            </div>
          </section>

          <section className="photoReelExportCard">
            <div>
              <span className="photoReelExportIcon" aria-hidden="true">MP4</span>
              <span>
                <strong>高画質で書き出す</strong>
                <small>1080×1920・保存枠1本分</small>
              </span>
            </div>
            <ul>
              <li>写真と音源は端末外へ送信しません</li>
              <li>無料体験は編集・プレビューまで利用できます</li>
              <li>有料枠は書き出し成功時だけ1本分使用します</li>
              <li>プレビュー中の編集変更に追加料金はかかりません</li>
            </ul>
            <button
              className="photoReelExportButton"
              type="button"
              onClick={startExport}
              disabled={
                photos.length < MIN_PHOTOS ||
                preparing ||
                audioPreparing ||
                exporting ||
                finalizingUsage ||
                Boolean(pendingFinalize)
              }
            >
              {audioPreparing
                ? "音源を確認中…"
                : exporting
                  ? `動画を作成中… ${Math.round(exportProgress * 100)}%`
                  : showPurchase
                    ? "購入を確認して写真リールを書き出す"
                    : "写真リールを書き出す"}
              <span aria-hidden="true">↓</span>
            </button>
            {photos.length === 1 ? (
              <p className="photoReelMinimumNote">あと1枚追加すると書き出せます。</p>
            ) : null}
            {exporting ? (
              <div className="photoReelExportProgress" aria-live="polite">
                <span style={{ width: `${Math.max(2, Math.round(exportProgress * 100))}%` }} />
              </div>
            ) : null}
            {exporting ? (
              <button
                className="photoReelCancelButton"
                type="button"
                onClick={() => abortRef.current?.abort()}
              >
                書き出しを中止
              </button>
            ) : null}
            {pendingFinalize ? (
              <div className="photoReelFinalizeActions">
                <button
                  className="photoReelRetryButton"
                  type="button"
                  onClick={retryFinalize}
                  disabled={exporting || finalizingUsage}
                >
                  {finalizingUsage
                    ? "利用確認中…"
                    : "利用確認を再試行して保存へ進む"}
                </button>
                <button
                  className="photoReelDiscardButton"
                  type="button"
                  onClick={discardPendingFinalize}
                  disabled={exporting || finalizingUsage}
                >
                  完成データを破棄して編集へ戻る
                </button>
              </div>
            ) : null}
          </section>

          <div className="photoReelStatus" aria-live="polite">
            {error ? <p className="photoReelError">{error}</p> : null}
            {showPurchase ? (
              <MonthlyFirstPurchaseOptions
                className="photoReelPurchaseOptions"
                source="result"
                mode="photo"
              >
                <strong>続けて保存するなら月額がお得</strong>
                <small>
                  決済は別タブで開きます。購入後、この編集画面へ戻って上の「購入を確認して写真リールを書き出す」を押してください。
                </small>
                <div className="photoReelPurchaseGrid">
                  <Link
                    className="photoReelPurchaseLink starter primary"
                    href="/account?checkout=starter"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => markCheckoutStarted("starter")}
                  >
                    <span>おすすめ・月に数回使う方</span>
                    <strong>
                      {STARTER_MONTHLY_PLAN_LABEL}・¥
                      {STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月（税込）
                    </strong>
                    <small>
                      1か月に動画{STARTER_MONTHLY_VIDEO_LIMIT}本まで保存・単発3回より¥
                      {(
                        ONE_TIME_PRICE_JPY * STARTER_MONTHLY_VIDEO_LIMIT -
                        STARTER_MONTHLY_PRICE_JPY
                      ).toLocaleString("ja-JP")}
                      お得
                    </small>
                  </Link>
                  <Link
                    className="photoReelPurchaseLink standard"
                    href="/account?checkout=standard"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => markCheckoutStarted("standard")}
                  >
                    <span>1か月ごと</span>
                    <strong>
                      {STANDARD_MONTHLY_PLAN_LABEL}・¥
                      {STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月（税込）
                    </strong>
                    <small>
                      1か月に動画{STANDARD_MONTHLY_VIDEO_LIMIT}本まで・1本あたり約
                      {Math.round(
                        STANDARD_MONTHLY_PRICE_JPY /
                          STANDARD_MONTHLY_VIDEO_LIMIT,
                      )}
                      円・1か月ごとの自動更新
                    </small>
                  </Link>
                </div>
                <OneTimeRescue
                  className="photoReelOneTimeRescue"
                  source="result"
                  mode="photo"
                >
                  <p>
                    継続利用の予定がない場合は、この1本だけを¥
                    {ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}
                    （税込）で保存できます。
                  </p>
                  <Link
                    className="photoReelPurchaseLink oneTime"
                    href="/account?checkout=one_time"
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => markCheckoutStarted("one_time")}
                  >
                    <strong>この1本だけ・¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}（税込）</strong>
                    <small>1回払い・自動更新なし・有効期限なし</small>
                  </Link>
                </OneTimeRescue>
                <button
                  className="photoReelRetryButton"
                  type="button"
                  onClick={() => void checkPurchaseAfterReturn()}
                  disabled={purchaseChecking || exporting || finalizingUsage}
                >
                  {purchaseChecking ? "購入状況を確認中…" : "購入状況を再確認"}
                </button>
              </MonthlyFirstPurchaseOptions>
            ) : null}
            {message ? <p className="photoReelMessage">{message}</p> : null}
          </div>

          {result ? (
            <section className="photoReelResult">
              <div>
                <span aria-hidden="true">✓</span>
                <div>
                  <h2>写真リールが完成しました</h2>
                  <p>1080×1920・MP4・{duration}秒</p>
                </div>
              </div>
              <video src={result.url} controls playsInline preload="metadata" />
              <button type="button" onClick={saveResult}>
                iPhoneへ保存・共有
                <span aria-hidden="true">↓</span>
              </button>
              <small>同じ完成動画は何度保存しても追加消費されません。</small>
            </section>
          ) : null}
        </div>
      </section>

      <section className="photoReelHow">
        <p className="photoReelEyebrow">かんたん3ステップ</p>
        <h2>写真の魅力を残したまま、動画らしい動きを。</h2>
        <div>
          <article>
            <span>01</span>
            <strong>2〜10枚を選ぶ</strong>
            <p>横写真も無理に縦へ切らず、ぼかし背景で全体を残します。</p>
          </article>
          <article>
            <span>02</span>
            <strong>5パターンから選ぶ</strong>
            <p>プレビューで動きを見比べ、写真に合う雰囲気を決めます。</p>
          </article>
          <article>
            <span>03</span>
            <strong>MP4で保存する</strong>
            <p>Instagramへ投稿しやすい縦1080pで端末内書き出しします。</p>
          </article>
        </div>
      </section>

      </main>
      <SiteFooter />
    </>
  );
}
