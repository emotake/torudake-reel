"use client";

/* eslint-disable react-hooks/preserve-manual-memoization -- This media editor deliberately keeps stable callbacks around long-running browser media and reservation lifecycles. */

import Link from "next/link";
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
  canSaveCompletedVideo,
  isBillingBucket,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  ONE_TIME_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
  type BillingBucket,
} from "../../lib/billing-policy";
import {
  VIDEO_COMPOSITION_MAX_AGGREGATE_SOURCE_DURATION_SECONDS,
  VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS,
  VIDEO_COMPOSITION_MAX_SOURCES,
  VIDEO_COMPOSITION_MAX_TOTAL_SOURCE_BYTES,
  buildVideoCompositionFrameSchedule,
  createVideoCompositionPlan,
  videoCompositionTransitionUsesOverlap,
  type VideoCompositionClip,
  type VideoCompositionFrameScheduleEntry,
  type VideoCompositionPlan,
  type VideoCompositionTransitionType,
} from "../../lib/video-composition";
import {
  buildVideoMixNarrationDuckingMetadata,
  computeVideoMixFrameLayout,
  exportVideoMixMp4,
  getVideoMixDuckingGainAtTime,
  getVideoMixTransitionAudioGains,
  measureVideoMixSourceAudioNormalization,
  type VideoMixAudioExportMetadata,
} from "../../lib/video-mix-export";
import {
  NARRATION_DISCLOSURE_TEXT,
  NARRATION_STYLES,
  NARRATION_TERMS_VERSION,
  buildDisclosedPostCaption,
  type NarrationPlan,
  type NarrationStyle,
} from "../../lib/narration";
import {
  DEFAULT_VIDEO_MIX_CAPTION_STYLE,
  VIDEO_MIX_CAPTION_STYLE_OPTIONS,
  drawVideoMixNarrationCaption,
  extractVideoMixNarrationFrames,
  prepareVideoMixNarration,
  type VideoMixCaptionStyle,
} from "../../lib/video-mix-narration";
import type { CaptionGoal } from "../../lib/caption-design";
import { getCaptionDisplayRange, type CaptionSegment } from "../../lib/captions";
import {
  getVideoMixBoundaryPreferenceKeys,
  pruneVideoMixBoundaryTransitionPreferences,
  resolveVideoMixBoundaryTransitions,
  type VideoMixBoundaryTransitionPreferences,
} from "../../lib/video-mix-boundary-preferences";
import {
  clampVideoMixDraftClips,
  defaultVideoMixFraming,
  findVideoMixDraftSource,
  readVideoMixClientDraft,
  saveVideoMixClientDraft,
  type VideoMixClientDraft,
  type VideoMixSourceFraming,
} from "../../lib/client-video-mix-draft";
import {
  cleanupExpiredVideoMixOutputs,
  deleteDurableVideoMixOutput,
  listDurableVideoMixOutputRecoveryCandidates,
  loadDurableVideoMixOutput,
  markDurableVideoMixOutputCompleted,
  saveDurableVideoMixOutput,
} from "../../lib/client-video-mix-output";
import { trackClientEvent } from "../../lib/client-analytics";
import { productDurationBucket } from "../../lib/product-analytics-schema";
import {
  analyzeClientVideoMixSourceScenes,
  type ClientVideoMixSceneAnalysis,
} from "../../lib/client-video-mix-scene-analysis";
import {
  createVideoMixNarrationSceneTimeline,
  type VideoMixNarrationScene,
} from "../../lib/video-mix-scene-timeline";

const ACCEPTED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/webm",
]);
const ACCEPTED_VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm)$/i;
const MINIMUM_CLIP_SECONDS = 0.35;

type MixSource = {
  id: string;
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
  clips: VideoCompositionClip[];
  framing: VideoMixSourceFraming;
  thumbnails: readonly string[];
  audioNormalizationGain: number;
  audioNormalizationAnalysisKey: string | null;
  sceneSelectionStatus: "analyzing" | "recommended" | "manual" | "restored" | "fallback";
  sceneSelectionRevision: number;
};

type RemovedMixSource = Readonly<{
  source: MixSource;
  index: number;
  boundaryTransitions: VideoMixBoundaryTransitionPreferences;
}>;

type MixResult = {
  blob: Blob;
  url: string;
  filename: string;
  bucket: BillingBucket;
  qualityMessage: string;
  durableId?: string;
};

type PendingFinalize = {
  result: MixResult;
  reservationId: string;
};

type UsageReservation = {
  reservationId: string | null;
  bucket: BillingBucket | null;
  status: "reserved" | "completed" | "released" | "expired" | "release_pending" | null;
  expiresAt: number | null;
  releasePending: boolean;
  reused: boolean;
  aiOperationLimit: number;
  aiOperationsRemaining: number;
};

type BillingStatusSnapshot = Readonly<{
  authenticated?: boolean;
  monthly?: {
    active?: boolean;
    accessRevoked?: boolean;
    videosUsed?: number;
    videoLimit?: number;
  };
  oneTimeCredits?: number;
  error?: string;
}>;

type MixNarration = Readonly<{
  plan: NarrationPlan;
  audio: Blob;
  url: string;
  captions: CaptionSegment[];
  activity: Awaited<ReturnType<typeof prepareVideoMixNarration>>["activity"];
  normalizationGain: number;
  audioDuration: number;
  style: NarrationStyle;
}>;

type NarrationSourceAudioMode = "mute" | "ambient";

type ActiveTrimTarget = Readonly<{
  sourceId: string;
  clipIndex: number;
}>;

type ActiveTrimDraft = Readonly<ActiveTrimTarget & {
  start: number;
  end: number;
}>;

const VIDEO_MIX_AMBIENT_AUDIO_GAIN = 0.12;

class VideoMixRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VideoMixRequestError";
  }
}

const TRANSITION_OPTIONS: ReadonlyArray<{
  id: VideoCompositionTransitionType;
  label: string;
  note: string;
}> = [
  { id: "crossfade", label: "自然なフェード", note: "前の場面を薄く残して、やわらかく切り替え" },
  { id: "cut", label: "そのまま切替", note: "間を置かず、テンポよく次の場面へ" },
  { id: "fade-black", label: "黒へフェード", note: "場面の区切りを落ち着いて見せる" },
  { id: "fade-white", label: "白へフェード", note: "明るく軽い印象で場面をつなぐ" },
  { id: "flash", label: "光で切替", note: "一瞬の光で、印象的に次の場面へ" },
  { id: "wipe-left", label: "横ワイプ", note: "次の場面が横から自然に現れる" },
  { id: "slide-left", label: "横スライド", note: "画面全体を送ってテンポよく切り替え" },
  { id: "zoom-dissolve", label: "ズームフェード", note: "少し寄りながら、滑らかに場面転換" },
];

const DEFAULT_AI_OPERATION_LIMIT = 3;
const USAGE_RELEASE_RETRY_DELAYS_MS = [0, 350, 1_100] as const;

function ensureVideoMixActionActive(signal: AbortSignal, mounted = true) {
  if (signal.aborted || !mounted) {
    throw new DOMException("処理を中止しました。", "AbortError");
  }
}

function waitForUsageRetry(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

function narrationLengthForDuration(duration: number) {
  if (duration <= 30) return 30;
  if (duration <= 60) return 60;
  return 90;
}

function formatSeconds(value: number) {
  const safe = Math.max(0, value);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0MB";
  return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(1)}MB`;
}

function ensureMixExportActive(signal: AbortSignal, mounted: boolean) {
  if (signal.aborted || !mounted) {
    throw new DOMException("動画の書き出しを中止しました。", "AbortError");
  }
}

function isSupportedVideo(file: File) {
  return ACCEPTED_VIDEO_TYPES.has(file.type.toLowerCase()) ||
    ACCEPTED_VIDEO_EXTENSION.test(file.name);
}

function fileFingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function sourceAudioNormalizationAnalysisKey(
  file: File,
  clips: readonly VideoCompositionClip[],
) {
  const ranges = clips
    .map((clip) => `${clip.start.toFixed(3)}-${clip.end.toFixed(3)}`)
    .join(",");
  return `${fileFingerprint(file)}:${ranges}`;
}

function sourceSceneAnalysisKey(source: Pick<MixSource, "file" | "duration" | "width" | "height">) {
  return `scene-v1:${fileFingerprint(source.file)}:${source.duration.toFixed(3)}:${source.width}x${source.height}`;
}

function createSourceId(file: File) {
  return `${fileFingerprint(file)}:${crypto.randomUUID()}`;
}

function getCompositionErrorMessage(error: unknown) {
  const detail = error instanceof Error ? error.message : "";
  if (/edited video must be 90 seconds/i.test(detail)) {
    return "完成動画は90秒以内にしてください。各カットを少し短くすると書き出せます。";
  }
  if (/combined source duration must be 300 seconds/i.test(detail)) {
    return "選ぶ元動画の長さは、合計5分以内にしてください。";
  }
  if (/combined source files must be 500MB/i.test(detail)) {
    return "選ぶ元動画の容量は、合計500MB以内にしてください。";
  }
  if (/chronological and non-overlapping/i.test(detail)) {
    return "同じ動画の2つのカットは、時間が前後したり重なったりしないようにしてください。";
  }
  if (/between 1 and 2 clips/i.test(detail)) {
    return "各動画から使う場面は、1カットまたは2カットにしてください。";
  }
  if (/beyond its source duration/i.test(detail)) {
    return "カットの終了位置が、元動画の長さを超えています。";
  }
  return "カット範囲を確認してください。";
}

function createInitialClip(duration: number) {
  // Keep every newly-added source within an equal fifth of the 90-second
  // output budget. This guarantees that adding sources later never turns an
  // otherwise valid draft into an over-length composition.
  const budget = Math.min(
    duration,
    VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS / VIDEO_COMPOSITION_MAX_SOURCES,
  );
  if (duration <= budget + 0.01) return { start: 0, end: duration };
  const start = Math.max(0, (duration - budget) / 2);
  return { start, end: start + budget };
}

function splitIntoTwoClips(duration: number, current: VideoCompositionClip) {
  const available = current.end - current.start;
  if (available >= MINIMUM_CLIP_SECONDS * 2.5) {
    const gap = Math.min(0.4, available * 0.1);
    const middle = (current.start + current.end) / 2;
    return [
      { start: current.start, end: middle - gap / 2 },
      { start: middle + gap / 2, end: current.end },
    ];
  }
  const firstEnd = Math.min(duration, Math.max(MINIMUM_CLIP_SECONDS, duration * 0.45));
  const secondStart = Math.min(duration - MINIMUM_CLIP_SECONDS, Math.max(firstEnd, duration * 0.55));
  return [
    { start: 0, end: firstEnd },
    { start: secondStart, end: duration },
  ];
}

function readVideoMetadata(file: File) {
  return new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`「${file.name}」の長さを確認できませんでした。`));
    };
    const timeout = window.setTimeout(fail, 12_000);
    video.preload = "metadata";
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      resolve({ duration, width, height });
    };
    video.onerror = fail;
    video.src = url;
  });
}

function buildFilename() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `torudake-video-mix-${stamp}.mp4`;
}

async function readApiError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error?.trim() || fallback;
}

async function reserveMixUsage(
  duration: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<UsageReservation> {
  const request = () => fetch("/api/usage/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceDurationSeconds: duration, idempotencyKey, creationType: "video_mix" }),
    signal,
  });
  let response = await request();
  if (response.status === 401) {
    const trial = await fetch("/api/session/trial", { method: "POST", signal });
    if (!trial.ok) {
      throw new VideoMixRequestError(
        await readApiError(trial, "無料体験を開始できませんでした。"),
        trial.status,
      );
    }
    response = await request();
  }
  if (!response.ok) {
    throw new VideoMixRequestError(
      await readApiError(response, "利用枠を確認できませんでした。"),
      response.status,
    );
  }
  const payload = (await response.json()) as {
    required?: boolean;
    reservationId?: string;
    bucket?: unknown;
    status?: unknown;
    expiresAt?: unknown;
    releasePending?: unknown;
    reused?: unknown;
  };
  if (!payload.required) {
    return {
      reservationId: null,
      bucket: null,
      status: null,
      expiresAt: null,
      releasePending: false,
      reused: false,
      aiOperationLimit: DEFAULT_AI_OPERATION_LIMIT,
      aiOperationsRemaining: DEFAULT_AI_OPERATION_LIMIT,
    };
  }
  if (!payload.reservationId || !isBillingBucket(payload.bucket)) {
    throw new Error("利用枠を確認できませんでした。");
  }
  const quotaPayload = payload as typeof payload & {
    aiOperationLimit?: unknown;
    aiOperationsRemaining?: unknown;
  };
  const aiOperationLimit =
    Number.isInteger(quotaPayload.aiOperationLimit) &&
    Number(quotaPayload.aiOperationLimit) > 0
      ? Number(quotaPayload.aiOperationLimit)
      : DEFAULT_AI_OPERATION_LIMIT;
  const aiOperationsRemaining =
    Number.isInteger(quotaPayload.aiOperationsRemaining) &&
    Number(quotaPayload.aiOperationsRemaining) >= 0
      ? Math.min(aiOperationLimit, Number(quotaPayload.aiOperationsRemaining))
      : aiOperationLimit;
  return {
    reservationId: payload.reservationId,
    bucket: payload.bucket,
    status:
      payload.status === "reserved" ||
      payload.status === "completed" ||
      payload.status === "released" ||
      payload.status === "expired" ||
      payload.status === "release_pending"
        ? payload.status
        : "reserved",
    expiresAt: Number.isFinite(payload.expiresAt) ? Number(payload.expiresAt) : null,
    releasePending: payload.releasePending === true,
    reused: payload.reused === true,
    aiOperationLimit,
    aiOperationsRemaining,
  };
}

async function renewMixUsage(
  reservationId: string,
  idempotencyKey: string | null,
  duration: number | undefined,
  signal?: AbortSignal,
): Promise<UsageReservation> {
  const response = await fetch("/api/usage/renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reservationId,
      idempotencyKey,
      ...(duration && duration > 0 ? { sourceDurationSeconds: duration } : {}),
    }),
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        required?: boolean;
        reservationId?: string;
        bucket?: unknown;
        status?: unknown;
        expiresAt?: unknown;
        releasePending?: unknown;
        reused?: unknown;
        aiOperationLimit?: unknown;
        aiOperationsRemaining?: unknown;
        error?: string;
      }
    | null;
  if (!response.ok || !payload) {
    throw new VideoMixRequestError(
      payload?.error || "利用枠の有効期限を更新できませんでした。通信を確認して、もう一度お試しください。",
      response.status,
    );
  }
  if (!payload.required) {
    return {
      reservationId: null,
      bucket: null,
      status: null,
      expiresAt: null,
      releasePending: false,
      reused: true,
      aiOperationLimit: DEFAULT_AI_OPERATION_LIMIT,
      aiOperationsRemaining: DEFAULT_AI_OPERATION_LIMIT,
    };
  }
  if (!payload.reservationId || !isBillingBucket(payload.bucket)) {
    throw new Error("更新した利用枠を確認できませんでした。");
  }
  const aiOperationLimit =
    Number.isInteger(payload.aiOperationLimit) && Number(payload.aiOperationLimit) > 0
      ? Number(payload.aiOperationLimit)
      : DEFAULT_AI_OPERATION_LIMIT;
  return {
    reservationId: payload.reservationId,
    bucket: payload.bucket,
    status:
      payload.status === "reserved" ||
      payload.status === "completed" ||
      payload.status === "released" ||
      payload.status === "expired" ||
      payload.status === "release_pending"
        ? payload.status
        : "reserved",
    expiresAt: Number.isFinite(payload.expiresAt) ? Number(payload.expiresAt) : null,
    releasePending: payload.releasePending === true,
    reused: payload.reused !== false,
    aiOperationLimit,
    aiOperationsRemaining:
      Number.isInteger(payload.aiOperationsRemaining) && Number(payload.aiOperationsRemaining) >= 0
        ? Math.min(aiOperationLimit, Number(payload.aiOperationsRemaining))
        : aiOperationLimit,
  };
}

function readAiQuota(response: Response) {
  const limit = Number(response.headers.get("X-AI-Operation-Limit"));
  const remaining = Number(response.headers.get("X-AI-Operations-Remaining"));
  return {
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    remaining: Number.isInteger(remaining) && remaining >= 0 ? remaining : null,
  };
}

async function requestMixNarrationPlan(options: Readonly<{
  frames: readonly string[];
  sceneTimeline: readonly VideoMixNarrationScene[];
  brief: string;
  goal: CaptionGoal;
  style: NarrationStyle;
  duration: number;
  reservationId: string | null;
  operationId: string;
  narrationBundleToken?: string;
  previousScript?: string;
  timingScale?: number;
  signal: AbortSignal;
}>) {
  const response = await fetch("/api/narration/script", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Usage-Reservation-Id": options.reservationId ?? "",
      "X-AI-Operation-Id": options.operationId,
    },
    body: JSON.stringify({
      frames: options.frames,
      sceneTimeline: options.sceneTimeline,
      brief: options.brief,
      goal: options.goal,
      length: narrationLengthForDuration(options.duration),
      style: options.style,
      sourceDuration: options.duration,
      usageReservationId: options.reservationId,
      aiOperationId: options.operationId,
      initialNarration: true,
      narrationBundleToken: options.narrationBundleToken,
      previousScript: options.previousScript,
      timingScale: options.timingScale,
    }),
    signal: options.signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | (NarrationPlan & { narrationBundleToken?: string; error?: string })
    | null;
  if (!response.ok || !payload?.script || !payload.narrationBundleToken) {
    throw new VideoMixRequestError(
      payload?.error || "AIナレーションの台本を作成できませんでした。",
      response.status,
    );
  }
  return { plan: payload, quota: readAiQuota(response) };
}

async function requestMixNarrationSpeech(options: Readonly<{
  plan: NarrationPlan;
  bundleToken: string;
  style: NarrationStyle;
  duration: number;
  reservationId: string | null;
  operationId: string;
  signal: AbortSignal;
}>) {
  const response = await fetch("/api/narration/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: options.plan.script,
      style: options.style,
      usageReservationId: options.reservationId,
      targetDurationSeconds: options.duration,
      aiOperationId: options.operationId,
      initialNarration: true,
      narrationBundleToken: options.bundleToken,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new VideoMixRequestError(
      await readApiError(response, "AI音声を生成できませんでした。"),
      response.status,
    );
  }
  const audio = await response.blob();
  if (!audio.size) throw new Error("AI音声を生成できませんでした。");
  return { audio, quota: readAiQuota(response) };
}

async function recordMixNarrationDisclosure(
  reservationId: string | null,
  signal?: AbortSignal,
) {
  let clientSessionId = window.localStorage.getItem("torudake-client-session-id");
  if (!clientSessionId) {
    clientSessionId = crypto.randomUUID();
    window.localStorage.setItem("torudake-client-session-id", clientSessionId);
  }
  const response = await fetch("/api/narration/disclosure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirmationId: crypto.randomUUID(),
      clientSessionId,
      termsVersion: NARRATION_TERMS_VERSION,
      confirmed: true,
      usageReservationId: reservationId,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      await readApiError(response, "AIナレーションの投稿表示を確認できませんでした。"),
    );
  }
}

async function updateUsage(
  action: "complete" | "release",
  reservationId: string,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/usage/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId }),
    signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | { completed?: boolean; released?: boolean; error?: string }
    | null;
  const confirmed = action === "complete" ? payload?.completed : payload?.released;
  if (!response.ok || !confirmed) {
    throw new Error(payload?.error || "利用記録を確認できませんでした。");
  }
}

async function releaseUsageWithRetry(reservationId: string) {
  let lastError: unknown = null;
  for (const delayMs of USAGE_RELEASE_RETRY_DELAYS_MS) {
    if (delayMs > 0) await waitForUsageRetry(delayMs);
    try {
      await updateUsage("release", reservationId);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("利用枠を戻せませんでした。もう一度お試しください。");
}

async function readMixBillingStatus() {
  const response = await fetch("/api/billing/status", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = (await response.json().catch(() => null)) as
    | BillingStatusSnapshot
    | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || "購入状況を確認できませんでした。");
  }
  return payload;
}

async function verifyDurableVideoMixOutputOwnership(reservationId: string) {
  const response = await fetch("/api/usage/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId }),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { required?: boolean; reservationId?: unknown; status?: unknown }
    | null;
  return Boolean(
    response.ok &&
      payload?.required === true &&
      payload.reservationId === reservationId &&
      (payload.status === "reserved" ||
        payload.status === "release_pending" ||
        payload.status === "expired" ||
        payload.status === "released" ||
        payload.status === "completed"),
  );
}

function sendMixUsageReleaseBeacon(
  reservationId: string | null,
  idempotencyKey: string | null,
) {
  if (!reservationId && !idempotencyKey) return false;
  const body = JSON.stringify({ reservationId, idempotencyKey });
  try {
    return Boolean(
      typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon(
          "/api/usage/release",
          new Blob([body], { type: "application/json" }),
        ),
    );
  } catch {
    return false;
  }
}

async function inspectMixOutput(
  blob: Blob,
  plan: VideoCompositionPlan,
  audioMetadata: VideoMixAudioExportMetadata,
  narrationCaptions: readonly CaptionSegment[] = [],
  captionsEnabled = false,
) {
  const { assessExportedVideoQuality, inspectExportedVideoQuality } = await import("../../lib/video-export-quality");
  const sourceWithMissingAudio = audioMetadata.sources.find(
    (source) =>
      source.hasAudioTrack && source.hasSelectedAudioSamples === false,
  );
  if (sourceWithMissingAudio) {
    throw new Error(
      `${sourceWithMissingAudio.sourceIndex + 1}番目の動画の元音声を選んだ場面から読み取れませんでした。カット範囲を確認して、もう一度書き出してください。`,
    );
  }
  if (audioMetadata.requireAudio && !audioMetadata.outputHasAudioTrack) {
    throw new Error("選んだ場面の元音声を完成動画へ入れられませんでした。もう一度書き出してください。");
  }
  const expectedNarrationRanges = audioMetadata.narration.requested
    ? narrationCaptions.flatMap((caption) => {
        const range = getCaptionDisplayRange(caption);
        const start = Math.max(0, Math.min(plan.duration, range.start));
        const end = Math.max(start, Math.min(plan.duration, range.end));
        return end - start >= 0.02 ? [{ start, end }] : [];
      })
    : [];
  const captionRanges = captionsEnabled ? expectedNarrationRanges : [];
  const inspection = await inspectExportedVideoQuality(blob, {
    packetSampleCount: 360,
    inspectAudioActivity: audioMetadata.inspectAudioActivity,
    expectedNarrationRanges,
    videoContentInspection: {
      boundarySeconds: plan.boundaries.map((boundary) => boundary.editedTime),
      allowBlackAtBoundarySeconds: plan.boundaries
        .filter((boundary) => boundary.transition.type === "fade-black")
        .map((boundary) => boundary.editedTime),
    },
  });
  const assessment = assessExportedVideoQuality(inspection, { width: 1080, height: 1920 }, {
    expectedDurationSeconds: plan.duration,
    durationToleranceSeconds: 0.16,
    requireH264: true,
    requireAudio: audioMetadata.requireAudio,
    requireCompatibleAudio: audioMetadata.requireAudio,
    // A source may intentionally contain a silent encoded track. Require the
    // track, duration and compatible codec without rejecting that valid case.
    minimumAudibleRms: audioMetadata.narration.requested ? 0.0025 : 0,
    expectedNarrationRanges,
    captionRanges,
    expectedWidth: 1080,
    expectedHeight: 1920,
  });
  if (inspection.status !== "ok") {
    throw new Error("完成動画の品質を確認できなかったため、保存できません。もう一度書き出してください。");
  }
  const blocking = assessment.issues.find((issue) => issue.severity === "error");
  if (blocking || assessment.meetsTargetResolution === false) {
    throw new Error(blocking?.message || "完成動画が1080×1920になっていません。もう一度書き出してください。");
  }
  return `完成動画（実測）：${inspection.metrics.width}×${inspection.metrics.height}・${inspection.metrics.durationSeconds?.toFixed(1) ?? plan.duration.toFixed(1)}秒。品質確認済みです。`;
}

function clipAtTime(plan: VideoCompositionPlan, time: number) {
  for (let index = plan.clips.length - 1; index >= 0; index -= 1) {
    const clip = plan.clips[index];
    if (
      time >= clip.editedStart &&
      (time < clip.editedEnd || index === plan.clips.length - 1)
    ) {
      return clip;
    }
  }
  return plan.clips.at(-1)!;
}

export default function VideoMixClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceFeedbackRef = useRef<HTMLParagraphElement>(null);
  const trimPanelRef = useRef<HTMLElement>(null);
  const activeTrimDraftRef = useRef<ActiveTrimDraft | null>(null);
  const previewPrimaryRef = useRef<HTMLVideoElement>(null);
  const previewSecondaryRef = useRef<HTMLVideoElement>(null);
  const previewPrimaryLayerRef = useRef<HTMLSpanElement>(null);
  const previewSecondaryLayerRef = useRef<HTMLSpanElement>(null);
  const previewPrimaryBlurRef = useRef<HTMLCanvasElement>(null);
  const previewSecondaryBlurRef = useRef<HTMLCanvasElement>(null);
  const transitionOverlayRef = useRef<HTMLSpanElement>(null);
  const previewCaptionRef = useRef<HTMLCanvasElement>(null);
  const narrationAudioRef = useRef<HTMLAudioElement>(null);
  const sourcePlayerRefs = useRef(new Map<string, HTMLVideoElement>());
  const previewAudioContextRef = useRef<AudioContext | null>(null);
  const previewPrimaryGainRef = useRef<GainNode | null>(null);
  const previewSecondaryGainRef = useRef<GainNode | null>(null);
  const previewNarrationGainRef = useRef<GainNode | null>(null);
  const previewPendingPlayRef = useRef(new Set<HTMLVideoElement>());
  const previewPlayPromiseRef = useRef(new Map<HTMLVideoElement, {
    generation: number;
    sourceId: string;
    promise: Promise<boolean>;
  }>());
  const previewDeferredGainRef = useRef(new Map<HTMLVideoElement, number>());
  const previewMutedFallbackRef = useRef(new Set<HTMLVideoElement>());
  const previewFallbackNoticeRef = useRef(false);
  const previewPlaybackGenerationRef = useRef(0);
  const previewMetadataWaitRef = useRef(new Map<HTMLVideoElement, {
    key: string;
    listener: () => void;
    errorListener: () => void;
    timeoutId: ReturnType<typeof setTimeout>;
    run: () => void;
    fail: () => void;
  }>());
  const previewActiveSwitchRef = useRef<{
    generation: number;
    sourceId: string;
    globalClipIndex: number;
    editedTime: number;
  } | null>(null);
  const previewSelectionClipRef = useRef<{
    sourceId: string;
    clipIndex: number;
    start: number;
    end: number;
    editedStart: number;
    editedEnd: number;
  } | null>(null);
  const transitionButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const finishModeButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const animationRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const previewLoopRef = useRef<{ start: number; end: number } | null>(null);
  const lastPreviewUiUpdateRef = useRef(0);
  const lastPreviewBackgroundUpdateRef = useRef<[string, string]>(["", ""]);
  const previewStartedAtRef = useRef(0);
  const previewStartTimeRef = useRef(0);
  const previewTimeRef = useRef(0);
  const activeLayerRef = useRef<0 | 1>(0);
  const activeClipRef = useRef(-1);
  const exportAbortRef = useRef<AbortController | null>(null);
  const narrationAbortRef = useRef<AbortController | null>(null);
  const thumbnailAbortRef = useRef<AbortController | null>(null);
  const audioNormalizationAbortRef = useRef<AbortController | null>(null);
  const audioNormalizationCacheRef = useRef(new Map<string, number>());
  const sceneAnalysisCacheRef = useRef(new Map<string, ClientVideoMixSceneAnalysis>());
  const resultRef = useRef<MixResult | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalize | null>(null);
  const sourcesRef = useRef<MixSource[]>([]);
  const preparingRef = useRef(false);
  const narrationGeneratingRef = useRef(false);
  const exportRunningRef = useRef(false);
  const finalizingUsageRef = useRef(false);
  const finalizeActionRef = useRef(false);
  const activeReservationRef = useRef<string | null>(null);
  const activeReservationBucketRef = useRef<BillingBucket | null>(null);
  const activeReservationStatusRef = useRef<UsageReservation["status"]>(null);
  const activeReservationExpiresAtRef = useRef<number | null>(null);
  const reservationKeyRef = useRef<string | null>(null);
  const reservationDurationRef = useRef<number | null>(null);
  const reservationInvalidatedRef = useRef(false);
  const reservationReleasePromiseRef = useRef<Promise<void> | null>(null);
  const reservationMutexRef = useRef<Promise<void>>(Promise.resolve());
  const sourceGenerationRef = useRef(0);
  const billingSyncRef = useRef<Promise<void> | null>(null);
  const lastBillingSyncAtRef = useRef(0);
  const narrationRef = useRef<MixNarration | null>(null);
  const previousNarrationRef = useRef<MixNarration | null>(null);
  const removedSourceRef = useRef<RemovedMixSource | null>(null);
  const pageHidingRef = useRef(false);
  const mountedRef = useRef(true);
  const aiOperationLimitRef = useRef(DEFAULT_AI_OPERATION_LIMIT);
  const aiOperationsRemainingRef = useRef(DEFAULT_AI_OPERATION_LIMIT);
  const paidSaveAvailableRef = useRef(false);

  const [sources, setSources] = useState<MixSource[]>([]);
  const [transition, setTransition] = useState<VideoCompositionTransitionType>("crossfade");
  const [boundaryTransitionPreferences, setBoundaryTransitionPreferences] =
    useState<VideoMixBoundaryTransitionPreferences>({});
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [narrationCaptionsEnabled, setNarrationCaptionsEnabled] = useState(true);
  const [narrationCaptionStyle, setNarrationCaptionStyle] =
    useState<VideoMixCaptionStyle>(DEFAULT_VIDEO_MIX_CAPTION_STYLE);
  const [narrationStyle, setNarrationStyle] = useState<NarrationStyle>("bright");
  const [narrationGoal, setNarrationGoal] = useState<CaptionGoal>("follow");
  const [narrationBrief, setNarrationBrief] = useState("");
  const [narrationSourceAudioMode, setNarrationSourceAudioMode] =
    useState<NarrationSourceAudioMode>("mute");
  const [narration, setNarration] = useState<MixNarration | null>(null);
  const [previousNarration, setPreviousNarration] = useState<MixNarration | null>(null);
  const [narrationStale, setNarrationStale] = useState(false);
  const [narrationGenerating, setNarrationGenerating] = useState(false);
  const [aiOperationLimit, setAiOperationLimit] = useState(DEFAULT_AI_OPERATION_LIMIT);
  const [aiOperationsRemaining, setAiOperationsRemaining] = useState(DEFAULT_AI_OPERATION_LIMIT);
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [finalizingUsage, setFinalizingUsage] = useState(false);
  const [discardingPending, setDiscardingPending] = useState(false);
  const [deletingDurableCopy, setDeletingDurableCopy] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [result, setResult] = useState<MixResult | null>(null);
  const [pendingFinalize, setPendingFinalize] = useState<PendingFinalize | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sourceFeedback, setSourceFeedback] = useState<{
    kind: "error" | "message";
    text: string;
  } | null>(null);
  const [showPurchase, setShowPurchase] = useState(false);
  const [removedSource, setRemovedSource] = useState<RemovedMixSource | null>(null);
  const [mobileStep, setMobileStep] = useState<1 | 2 | 3>(1);
  const [showAllTransitions, setShowAllTransitions] = useState(false);
  const [expandedSourcePlayerId, setExpandedSourcePlayerId] = useState<string | null>(null);
  const [activeTrimTarget, setActiveTrimTarget] = useState<ActiveTrimTarget | null>(null);
  const [activeTrimDraft, setActiveTrimDraft] = useState<ActiveTrimDraft | null>(null);
  const [trimFeedback, setTrimFeedback] = useState("");
  const [loadedDraft] = useState<VideoMixClientDraft | null>(() =>
    typeof window === "undefined" ? null : readVideoMixClientDraft(window.localStorage),
  );
  const [draftSettingsApplied, setDraftSettingsApplied] = useState(false);

  const boundaryPreferenceKeys = useMemo(
    () => getVideoMixBoundaryPreferenceKeys(sources),
    [sources],
  );
  const activeBoundaryTransitionPreferences = useMemo(
    () =>
      pruneVideoMixBoundaryTransitionPreferences(
        sources,
        boundaryTransitionPreferences,
      ),
    [boundaryTransitionPreferences, sources],
  );
  const resolvedBoundaryTransitions = useMemo(
    () =>
      resolveVideoMixBoundaryTransitions(
        sources,
        activeBoundaryTransitionPreferences,
        transition,
      ),
    [activeBoundaryTransitionPreferences, sources, transition],
  );

  const planResult = useMemo(() => {
    if (sources.length === 0) return { plan: null, error: "" };
    try {
      return {
        plan: createVideoCompositionPlan({
          sources: sources.map((source) => ({
            id: source.id,
            fileSize: source.file.size,
            duration: source.duration,
            clips: source.clips,
          })),
          transition,
          boundaryTransitions: resolvedBoundaryTransitions,
        }),
        error: "",
      };
    } catch (caught) {
      return { plan: null, error: getCompositionErrorMessage(caught) };
    }
  }, [resolvedBoundaryTransitions, sources, transition]);
  const plan = planResult.plan;
  const schedule = useMemo(() => plan ? buildVideoCompositionFrameSchedule(plan) : [], [plan]);
  const totalBytes = sources.reduce((sum, source) => sum + source.file.size, 0);
  const aggregateDuration = sources.reduce((sum, source) => sum + source.duration, 0);
  const audioNormalizationRequestKey = useMemo(
    () =>
      sources
        .map((source) =>
          sourceAudioNormalizationAnalysisKey(source.file, source.clips),
        )
        .join("|"),
    [sources],
  );
  const hasIndividualTransitions =
    Object.keys(activeBoundaryTransitionPreferences).length > 0;
  const sceneSelectionBusy = sources.some(
    (source) => source.sceneSelectionStatus === "analyzing",
  );
  const activeTrimSourceIndex = activeTrimTarget
    ? sources.findIndex((source) => source.id === activeTrimTarget.sourceId)
    : -1;
  const activeTrimSource = activeTrimSourceIndex >= 0
    ? sources[activeTrimSourceIndex]
    : null;
  const activeTrimClip = activeTrimSource && activeTrimTarget
    ? activeTrimSource.clips[activeTrimTarget.clipIndex] ?? null
    : null;
  const displayedTrimDraft = activeTrimDraft && activeTrimTarget &&
    activeTrimDraft.sourceId === activeTrimTarget.sourceId &&
    activeTrimDraft.clipIndex === activeTrimTarget.clipIndex
    ? activeTrimDraft
    : null;
  const editingLocked =
    preparing || exporting || narrationGenerating || discardingPending || Boolean(pendingFinalize);
  const narrationSourceAudioGain =
    narrationEnabled
      ? narrationSourceAudioMode === "mute"
        ? 0
        : VIDEO_MIX_AMBIENT_AUDIO_GAIN
      : 1;
  const previewDuckingMetadata = useMemo(() =>
    plan
      ? buildVideoMixNarrationDuckingMetadata({
          activity: narration?.activity ?? [],
          baseGain: narrationSourceAudioGain,
          duration: plan.duration,
          enabled:
            narrationEnabled &&
            narrationSourceAudioMode === "ambient" &&
            Boolean(narration),
        })
      : null,
    [
      narration,
      narrationEnabled,
      narrationSourceAudioGain,
      narrationSourceAudioMode,
      plan,
    ],
  );

  const analyticsSnapshot = useCallback(() => ({
    mode: "video_mix" as const,
    source_count: sourcesRef.current.length,
    clip_count: sourcesRef.current.reduce((sum, source) => sum + source.clips.length, 0),
    duration_bucket: productDurationBucket(plan?.duration ?? 0),
    narration: narrationEnabled ? "enabled" : "disabled",
    transition:
      Object.keys(activeBoundaryTransitionPreferences).length > 0
        ? "mixed"
        : transition,
  }), [activeBoundaryTransitionPreferences, narrationEnabled, plan?.duration, transition]);

  const announceSourceFeedback = useCallback(
    (kind: "error" | "message", text: string) => {
      setSourceFeedback({ kind, text });
      if (kind === "error") {
        window.queueMicrotask(() => sourceFeedbackRef.current?.focus());
      }
    },
    [],
  );

  const stopPreview = useCallback(() => {
    previewPlaybackGenerationRef.current += 1;
    for (const [video, pending] of previewMetadataWaitRef.current) {
      video.removeEventListener("loadedmetadata", pending.listener);
      video.removeEventListener("error", pending.errorListener);
      clearTimeout(pending.timeoutId);
    }
    previewMetadataWaitRef.current.clear();
    previewActiveSwitchRef.current = null;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    previewLoopRef.current = null;
    for (const video of [previewPrimaryRef.current, previewSecondaryRef.current]) {
      video?.pause();
      if (video) video.muted = true;
    }
    if (previewPrimaryGainRef.current) previewPrimaryGainRef.current.gain.value = 0;
    if (previewSecondaryGainRef.current) previewSecondaryGainRef.current.gain.value = 0;
    previewPendingPlayRef.current.clear();
    previewPlayPromiseRef.current.clear();
    previewDeferredGainRef.current.clear();
    previewMutedFallbackRef.current.clear();
    narrationAudioRef.current?.pause();
    if (previewNarrationGainRef.current) previewNarrationGainRef.current.gain.value = 0;
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  const releasePreviewMediaElements = useCallback(() => {
    for (const video of [previewPrimaryRef.current, previewSecondaryRef.current]) {
      if (!video) continue;
      video.pause();
      previewPendingPlayRef.current.delete(video);
      previewPlayPromiseRef.current.delete(video);
      previewDeferredGainRef.current.delete(video);
      previewMutedFallbackRef.current.delete(video);
      video.removeAttribute("src");
      delete video.dataset.sourceId;
      video.load();
    }
    activeClipRef.current = -1;
  }, []);

  const releaseSourcePlayer = useCallback((player: HTMLVideoElement) => {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }, []);

  const pauseSourcePlayers = useCallback((exceptSourceId?: string) => {
    for (const [sourceId, player] of sourcePlayerRefs.current) {
      if (sourceId !== exceptSourceId) player.pause();
    }
  }, []);

  const toggleSourcePlayer = useCallback((sourceId: string) => {
    const openPlayer = sourcePlayerRefs.current.get(sourceId);
    if (openPlayer) {
      releaseSourcePlayer(openPlayer);
      sourcePlayerRefs.current.delete(sourceId);
      setExpandedSourcePlayerId(null);
      return;
    }
    stopPreview();
    releasePreviewMediaElements();
    for (const player of sourcePlayerRefs.current.values()) {
      releaseSourcePlayer(player);
    }
    sourcePlayerRefs.current.clear();
    setExpandedSourcePlayerId(sourceId);
  }, [releasePreviewMediaElements, releaseSourcePlayer, stopPreview]);

  const handleSourcePlayerPlay = useCallback((sourceId: string) => {
    stopPreview();
    releasePreviewMediaElements();
    pauseSourcePlayers(sourceId);
  }, [pauseSourcePlayers, releasePreviewMediaElements, stopPreview]);

  const closeSourcePlayers = useCallback(() => {
    for (const player of sourcePlayerRefs.current.values()) {
      releaseSourcePlayer(player);
    }
    sourcePlayerRefs.current.clear();
    setExpandedSourcePlayerId(null);
  }, [releaseSourcePlayer]);

  const runWhenPreviewMetadataReady = useCallback((
    video: HTMLVideoElement,
    sourceId: string,
    generation: number,
    actionKey: string,
    run: () => void,
    fail: () => void = () => undefined,
  ) => {
    if (
      video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      video.dataset.sourceId === sourceId
    ) {
      const previous = previewMetadataWaitRef.current.get(video);
      if (previous) {
        video.removeEventListener("loadedmetadata", previous.listener);
        video.removeEventListener("error", previous.errorListener);
        clearTimeout(previous.timeoutId);
        previewMetadataWaitRef.current.delete(video);
      }
      run();
      return true;
    }
    const key = `${generation}:${sourceId}:${actionKey}`;
    const previous = previewMetadataWaitRef.current.get(video);
    if (previous?.key === key) {
      // The editing clock is frozen while an active layer loads. Keep only its
      // latest desired seek instead of adding one listener on every rAF frame.
      previous.run = run;
      previous.fail = fail;
      return false;
    }
    if (previous) {
      video.removeEventListener("loadedmetadata", previous.listener);
      video.removeEventListener("error", previous.errorListener);
      clearTimeout(previous.timeoutId);
    }
    const clearPending = (pending: {
      listener: () => void;
      errorListener: () => void;
      timeoutId: ReturnType<typeof setTimeout>;
    }) => {
      video.removeEventListener("loadedmetadata", pending.listener);
      video.removeEventListener("error", pending.errorListener);
      clearTimeout(pending.timeoutId);
      if (previewMetadataWaitRef.current.get(video) === pending) {
        previewMetadataWaitRef.current.delete(video);
      }
    };
    const pending: {
      key: string;
      listener: () => void;
      errorListener: () => void;
      timeoutId: ReturnType<typeof setTimeout>;
      run: () => void;
      fail: () => void;
    } = {
      key,
      run,
      fail,
      listener: () => {
        const latest = previewMetadataWaitRef.current.get(video);
        if (latest?.listener !== pending.listener) return;
        clearPending(pending);
        if (
          !mountedRef.current ||
          previewPlaybackGenerationRef.current !== generation ||
          video.dataset.sourceId !== sourceId
        ) return;
        latest.run();
      },
      errorListener: () => {
        const latest = previewMetadataWaitRef.current.get(video);
        if (latest?.errorListener !== pending.errorListener) return;
        clearPending(pending);
        if (
          !mountedRef.current ||
          previewPlaybackGenerationRef.current !== generation ||
          video.dataset.sourceId !== sourceId
        ) return;
        latest.fail();
      },
      timeoutId: setTimeout(() => undefined, 0),
    };
    clearTimeout(pending.timeoutId);
    pending.timeoutId = setTimeout(pending.errorListener, 8_000);
    previewMetadataWaitRef.current.set(video, pending);
    video.addEventListener("loadedmetadata", pending.listener, { once: true });
    video.addEventListener("error", pending.errorListener, { once: true });
    return false;
  }, []);

  const ensurePreviewAudioGraph = useCallback(() => {
    if (previewAudioContextRef.current) {
      void previewAudioContextRef.current.resume().catch(() => undefined);
      return true;
    }
    const primary = previewPrimaryRef.current;
    const secondary = previewSecondaryRef.current;
    const narrationPlayer = narrationAudioRef.current;
    if (!primary || !secondary || !narrationPlayer) return false;
    const AudioContextConstructor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (window as typeof window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AudioContextConstructor) return false;
    try {
      const context = new AudioContextConstructor();
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.08;
      limiter.connect(context.destination);
      const primaryGain = context.createGain();
      const secondaryGain = context.createGain();
      const narrationGain = context.createGain();
      primaryGain.gain.value = 0;
      secondaryGain.gain.value = 0;
      narrationGain.gain.value = 0;
      context.createMediaElementSource(primary).connect(primaryGain);
      context.createMediaElementSource(secondary).connect(secondaryGain);
      context.createMediaElementSource(narrationPlayer).connect(narrationGain);
      primaryGain.connect(limiter);
      secondaryGain.connect(limiter);
      narrationGain.connect(limiter);
      previewAudioContextRef.current = context;
      previewPrimaryGainRef.current = primaryGain;
      previewSecondaryGainRef.current = secondaryGain;
      previewNarrationGainRef.current = narrationGain;
      void context.resume().catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }, []);

  const setPreviewMediaGain = useCallback((
    video: HTMLVideoElement,
    gain: number,
  ) => {
    const safeGain = Math.max(0, Math.min(2, gain));
    const node = video === previewPrimaryRef.current
      ? previewPrimaryGainRef.current
      : previewSecondaryGainRef.current;
    if (previewMutedFallbackRef.current.has(video)) {
      video.muted = true;
      video.volume = 0;
      if (node) node.gain.value = 0;
      return;
    }
    // Keep successfully authorized elements unmuted for their entire playback
    // session. If a browser rejects a later source swap, that one layer is
    // moved to the muted visual fallback above instead of stopping everything.
    // WebKit pauses a video that is unmuted outside a trusted user gesture, so
    // silence/transition mixing must be expressed through GainNode (or volume
    // in the no-WebAudio fallback), never by toggling HTMLMediaElement.muted.
    video.muted = false;
    if (previewPendingPlayRef.current.has(video)) {
      previewDeferredGainRef.current.set(video, safeGain);
      if (node) {
        video.volume = 1;
        node.gain.value = 0;
      } else {
        video.volume = 0;
      }
      return;
    }
    previewDeferredGainRef.current.delete(video);
    if (node) {
      video.volume = 1;
      node.gain.value = safeGain;
    } else {
      video.volume = Math.min(1, safeGain);
    }
  }, []);

  const setPreviewNarrationGain = useCallback((
    player: HTMLAudioElement,
    gain: number,
  ) => {
    const safeGain = Math.max(0, Math.min(1.35, gain));
    // Keep the audio element authorized from the original click. Silence its
    // pre-roll through GainNode/volume; async unmute pauses playback on WebKit.
    player.muted = false;
    if (previewNarrationGainRef.current) {
      player.volume = 1;
      previewNarrationGainRef.current.gain.value = safeGain;
    } else {
      player.volume = Math.min(1, safeGain);
    }
  }, []);

  const playPreviewMedia = useCallback((
    media: HTMLMediaElement,
    generation: number,
  ) => {
    return media.play().then(() => {
      return mountedRef.current &&
        isPlayingRef.current &&
        previewPlaybackGenerationRef.current === generation;
    }).catch((error: unknown) => {
      if (
        !mountedRef.current ||
        !isPlayingRef.current ||
        previewPlaybackGenerationRef.current !== generation
      ) return false;
      console.warn("[video-mix-preview] media play failed", {
        name: error instanceof DOMException ? error.name : "UnknownError",
        kind: media instanceof HTMLAudioElement ? "narration" : "video",
        readyState: media.readyState,
        networkState: media.networkState,
      });
      return false;
    });
  }, []);

  const setPreviewMutedFallback = useCallback((video: HTMLVideoElement) => {
    previewMutedFallbackRef.current.add(video);
    previewDeferredGainRef.current.delete(video);
    const node = video === previewPrimaryRef.current
      ? previewPrimaryGainRef.current
      : previewSecondaryGainRef.current;
    video.muted = true;
    video.volume = 0;
    if (node) node.gain.value = 0;
  }, []);

  const rememberPreviewPlayAttempt = useCallback((
    video: HTMLVideoElement,
    generation: number,
    sourceId: string,
    promise: Promise<boolean>,
  ) => {
    const tracked = { generation, sourceId, promise };
    previewPlayPromiseRef.current.set(video, tracked);
    void promise.finally(() => {
      if (previewPlayPromiseRef.current.get(video) === tracked) {
        previewPlayPromiseRef.current.delete(video);
      }
    });
    return promise;
  }, []);

  const settlePreviewPlayAttempt = useCallback(async (
    video: HTMLVideoElement,
    initialAttempt: Promise<void>,
    desiredGain: number,
    role: "active" | "standby" | "boundary",
    generation: number,
    sourceId: string,
    allowMutedFallback: boolean,
  ) => {
    const isCurrentAttempt = () =>
      mountedRef.current &&
      isPlayingRef.current &&
      previewPlaybackGenerationRef.current === generation &&
      video.dataset.sourceId === sourceId;
    try {
      await initialAttempt;
      if (!isCurrentAttempt()) return false;
      previewPendingPlayRef.current.delete(video);
      const latestGain = isPlayingRef.current
        ? previewDeferredGainRef.current.get(video) ?? desiredGain
        : 0;
      previewDeferredGainRef.current.delete(video);
      setPreviewMediaGain(video, latestGain);
      return true;
    } catch (initialError) {
      if (!isCurrentAttempt()) return false;
      previewPendingPlayRef.current.delete(video);
      previewDeferredGainRef.current.delete(video);
      console.warn("[video-mix-preview] unmuted video play failed", {
        name: initialError instanceof DOMException ? initialError.name : "UnknownError",
        role,
        readyState: video.readyState,
        networkState: video.networkState,
      });
      if (!allowMutedFallback) return false;
      setPreviewMutedFallback(video);
      try {
        await video.play();
        if (!isCurrentAttempt()) return false;
        if (!previewFallbackNoticeRef.current && mountedRef.current) {
          previewFallbackNoticeRef.current = true;
          setMessage("端末の再生制限により、一部素材はプレビューで映像のみ再生します。完成動画の音声には影響しません。");
        }
        return true;
      } catch (fallbackError) {
        console.warn("[video-mix-preview] muted video play failed", {
          name: fallbackError instanceof DOMException ? fallbackError.name : "UnknownError",
          role,
          readyState: video.readyState,
          networkState: video.networkState,
          mediaErrorCode: video.error?.code ?? null,
        });
        return false;
      }
    }
  }, [setPreviewMediaGain, setPreviewMutedFallback]);

  const startPreviewMediaPair = useCallback((
    primary: HTMLVideoElement,
    secondary: HTMLVideoElement,
    generation: number,
    allowActiveMutedFallback: boolean,
  ) => {
    // Invoke both play() calls synchronously before awaiting either promise so
    // they share the same trusted click activation. The active result controls
    // the clock; standby failure degrades to muted visuals instead of stopping
    // a primary layer that is already playable.
    const media = [primary, secondary] as const;
    media.forEach((video) => {
      previewPendingPlayRef.current.add(video);
      previewDeferredGainRef.current.set(video, 0);
    });
    const attempts = [primary.play(), secondary.play()];
    const primarySourceId = primary.dataset.sourceId ?? "";
    const secondarySourceId = secondary.dataset.sourceId ?? "";
    return {
      activeReady: rememberPreviewPlayAttempt(primary, generation, primarySourceId, settlePreviewPlayAttempt(
        primary,
        attempts[0],
        0,
        "active",
        generation,
        primarySourceId,
        allowActiveMutedFallback,
      )),
      standbyReady: rememberPreviewPlayAttempt(secondary, generation, secondarySourceId, settlePreviewPlayAttempt(
        secondary,
        attempts[1],
        0,
        "standby",
        generation,
        secondarySourceId,
        true,
      )),
    };
  }, [rememberPreviewPlayAttempt, settlePreviewPlayAttempt]);

  const resumePreviewMediaWithFallback = useCallback((
    video: HTMLVideoElement,
    desiredGain: number,
  ) => {
    const generation = previewPlaybackGenerationRef.current;
    const sourceId = video.dataset.sourceId ?? "";
    const existing = previewPlayPromiseRef.current.get(video);
    if (
      existing?.generation === generation &&
      existing.sourceId === sourceId
    ) {
      setPreviewMediaGain(video, desiredGain);
      return existing.promise;
    }
    previewPlayPromiseRef.current.delete(video);
    previewPendingPlayRef.current.delete(video);
    previewPendingPlayRef.current.add(video);
    setPreviewMediaGain(video, desiredGain);
    return rememberPreviewPlayAttempt(video, generation, sourceId, settlePreviewPlayAttempt(
      video,
      video.play(),
      desiredGain,
      "boundary",
      generation,
      sourceId,
      true,
    ));
  }, [rememberPreviewPlayAttempt, setPreviewMediaGain, settlePreviewPlayAttempt]);

  const previewSourceGainAt = useCallback((time: number) =>
    previewDuckingMetadata
      ? getVideoMixDuckingGainAtTime(previewDuckingMetadata, time)
      : 1,
    [previewDuckingMetadata],
  );

  const previewSourceNormalizationGain = useCallback((source: MixSource) => {
    const key = sourceAudioNormalizationAnalysisKey(source.file, source.clips);
    return audioNormalizationCacheRef.current.get(key) ??
      (source.audioNormalizationAnalysisKey === key
        ? source.audioNormalizationGain
        : 1);
  }, []);

  const clearResult = useCallback(() => {
    const current = resultRef.current;
    resultRef.current = null;
    setResult(null);
    if (current) URL.revokeObjectURL(current.url);
    setMessage("");
    setShowPurchase(false);
  }, []);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    void (async () => {
      await cleanupExpiredVideoMixOutputs().catch(() => undefined);
      const candidates = await listDurableVideoMixOutputRecoveryCandidates();
      for (const metadata of candidates) {
        if (!mountedRef.current || resultRef.current) return;
        const recoveredBucket = metadata.bucket;
        if (!isBillingBucket(recoveredBucket)) continue;
        // A browser profile can be shared by several signed-in people. Check
        // metadata-only candidates newest-first and load Blob bytes only after
        // the reservation is proven to belong to the current principal.
        const owned = await verifyDurableVideoMixOutputOwnership(
          metadata.reservationId,
        );
        if (!owned) continue;
        const saved = await loadDurableVideoMixOutput(metadata.id);
        if (
          !saved ||
          saved.metadata.reservationId !== metadata.reservationId ||
          saved.metadata.bucket !== recoveredBucket ||
          !mountedRef.current ||
          resultRef.current
        ) continue;
        const recovered: MixResult = {
          blob: saved.blob,
          url: URL.createObjectURL(saved.blob),
          filename: saved.metadata.filename,
          bucket: recoveredBucket,
          qualityMessage: saved.metadata.qualityMessage,
          durableId: saved.metadata.id,
        };
        if (saved.metadata.status === "pending-completion") {
          const pending = {
            result: recovered,
            reservationId: saved.metadata.reservationId,
          };
          pendingFinalizeRef.current = pending;
          activeReservationRef.current = saved.metadata.reservationId;
          activeReservationBucketRef.current = recovered.bucket;
          activeReservationStatusRef.current = "reserved";
          setPendingFinalize(pending);
          setError("完成動画を復元しました。利用確認を再試行すると保存へ進めます。");
        } else {
          resultRef.current = recovered;
          setResult(recovered);
          setMessage("端末に一時保存していた完成動画を復元しました。保存または共有できます。");
        }
        trackClientEvent("draft_recovered", {
          mode: "video_mix",
          outcome: "restored",
        });
        return;
      }
    })().catch(() => undefined);
  }, []);

  useEffect(() => {
    pendingFinalizeRef.current = pendingFinalize;
  }, [pendingFinalize]);

  useEffect(() => {
    narrationRef.current = narration;
  }, [narration]);

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    audioNormalizationAbortRef.current?.abort();
    if (!audioNormalizationRequestKey || sceneSelectionBusy) return;
    const controller = new AbortController();
    audioNormalizationAbortRef.current = controller;
    const requestedSources = sourcesRef.current.map((source) => ({
      id: source.id,
      file: source.file,
      clips: source.clips.map((clip) => ({ ...clip })),
      key: sourceAudioNormalizationAnalysisKey(source.file, source.clips),
    }));
    const applyGain = (sourceId: string, key: string, gain: number) => {
      if (controller.signal.aborted || !mountedRef.current) return;
      const current = sourcesRef.current;
      const next = current.map((source) => {
        if (
          source.id !== sourceId ||
          sourceAudioNormalizationAnalysisKey(source.file, source.clips) !== key ||
          (source.audioNormalizationAnalysisKey === key &&
            source.audioNormalizationGain === gain)
        ) {
          return source;
        }
        return {
          ...source,
          audioNormalizationGain: gain,
          audioNormalizationAnalysisKey: key,
        };
      });
      if (next.every((source, index) => source === current[index])) return;
      sourcesRef.current = next;
      setSources(next);
    };
    // Make adding videos responsive first; audio analysis is local, serial and
    // bounded to short selected-clip windows, then cached for preview/export.
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const source of requestedSources) {
          if (controller.signal.aborted) return;
          const cached = audioNormalizationCacheRef.current.get(source.key);
          if (cached !== undefined) {
            applyGain(source.id, source.key, cached);
            continue;
          }
          try {
            const gain = await measureVideoMixSourceAudioNormalization(
              source.file,
              source.clips,
              controller.signal,
            );
            if (controller.signal.aborted) return;
            audioNormalizationCacheRef.current.set(source.key, gain);
            applyGain(source.id, source.key, gain);
          } catch {
            if (controller.signal.aborted) return;
            // Unsupported tracks remain at unity; export can use its decoded
            // selected-clip fallback without blocking local editing.
          }
        }
      })();
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (audioNormalizationAbortRef.current === controller) {
        audioNormalizationAbortRef.current = null;
      }
    };
  }, [audioNormalizationRequestKey, sceneSelectionBusy]);

  useEffect(() => {
    if (
      sources.length === 0 ||
      sources.some((source) => source.sceneSelectionStatus === "analyzing")
    ) return;
    const timer = window.setTimeout(() => {
      saveVideoMixClientDraft(window.localStorage, {
        version: 1,
        savedAt: Date.now(),
        sources: sources.map((source) => ({
          id: source.id,
          fingerprint: fileFingerprint(source.file),
          name: source.file.name,
          duration: source.duration,
          width: source.width,
          height: source.height,
          clips: source.clips,
          framing: source.framing,
        })),
        transition,
        boundaryTransitions: activeBoundaryTransitionPreferences,
        narrationEnabled,
        narrationSourceAudioMode,
        narrationCaptionsEnabled,
        narrationCaptionStyle,
        narrationStyle,
        narrationGoal,
        narrationBrief,
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    activeBoundaryTransitionPreferences,
    narrationBrief,
    narrationCaptionStyle,
    narrationCaptionsEnabled,
    narrationEnabled,
    narrationGoal,
    narrationSourceAudioMode,
    narrationStyle,
    sources,
    transition,
  ]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (sourcesRef.current.length === 0 || resultRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, []);

  const withReservationLock = useCallback(<T,>(operation: () => Promise<T>) => {
    const result = reservationMutexRef.current.then(operation, operation);
    reservationMutexRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const releaseActiveReservationLocked = useCallback(async () => {
    const reservationId = activeReservationRef.current;
    if (!reservationId) {
      const recoveryKey = reservationKeyRef.current;
      if (recoveryKey) {
        const recovered = await reserveMixUsage(
          reservationDurationRef.current ?? 0,
          recoveryKey,
        );
        if (recovered.reservationId) {
          await releaseUsageWithRetry(recovered.reservationId);
        }
        if (reservationKeyRef.current === recoveryKey) {
          reservationKeyRef.current = null;
          reservationDurationRef.current = null;
        }
      }
      if (!reservationKeyRef.current) reservationInvalidatedRef.current = false;
      return;
    }
    await releaseUsageWithRetry(reservationId);
    if (activeReservationRef.current !== reservationId) return;
    activeReservationRef.current = null;
    activeReservationBucketRef.current = null;
    activeReservationStatusRef.current = null;
    activeReservationExpiresAtRef.current = null;
    reservationKeyRef.current = null;
    reservationDurationRef.current = null;
    reservationInvalidatedRef.current = false;
  }, []);

  const releaseActiveReservationForeground = useCallback(async () => {
    reservationInvalidatedRef.current = true;
    if (reservationReleasePromiseRef.current) {
      return reservationReleasePromiseRef.current;
    }
    const releasePromise = withReservationLock(releaseActiveReservationLocked)
      .finally(() => {
        if (reservationReleasePromiseRef.current === releasePromise) {
          reservationReleasePromiseRef.current = null;
        }
      });
    reservationReleasePromiseRef.current = releasePromise;
    return releasePromise;
  }, [releaseActiveReservationLocked, withReservationLock]);

  const releaseActiveReservationOnPageHide = useCallback(() => {
    const reservationId = activeReservationRef.current;
    // The reserve response itself may be lost after the server committed it.
    // Releasing by the already-created idempotency key closes that pagehide
    // race even before a reservation ID reaches the client.
    sendMixUsageReleaseBeacon(reservationId, reservationKeyRef.current);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    pageHidingRef.current = false;
    const primaryVideo = previewPrimaryRef.current;
    const secondaryVideo = previewSecondaryRef.current;
    const narrationAudio = narrationAudioRef.current;
    const sourcePlayers = sourcePlayerRefs.current;
    const previewMetadataWaits = previewMetadataWaitRef.current;
    const previewPendingPlays = previewPendingPlayRef.current;
    const previewPlayPromises = previewPlayPromiseRef.current;
    const previewDeferredGains = previewDeferredGainRef.current;
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        pageHidingRef.current = true;
        reservationInvalidatedRef.current = true;
        releaseActiveReservationOnPageHide();
      }
    };
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      mountedRef.current = false;
      previewPlaybackGenerationRef.current += 1;
      isPlayingRef.current = false;
      previewActiveSwitchRef.current = null;
      for (const [video, pending] of previewMetadataWaits) {
        video.removeEventListener("loadedmetadata", pending.listener);
        video.removeEventListener("error", pending.errorListener);
        clearTimeout(pending.timeoutId);
      }
      previewMetadataWaits.clear();
      previewPendingPlays.clear();
      previewPlayPromises.clear();
      previewDeferredGains.clear();
      window.removeEventListener("pagehide", releaseOnPageHide);
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      primaryVideo?.pause();
      secondaryVideo?.pause();
      narrationAudio?.pause();
      sourcePlayers.forEach((player) => {
        player.pause();
        player.removeAttribute("src");
        player.load();
      });
      sourcePlayers.clear();
      void previewAudioContextRef.current?.close().catch(() => undefined);
      previewAudioContextRef.current = null;
      previewPrimaryGainRef.current = null;
      previewSecondaryGainRef.current = null;
      previewNarrationGainRef.current = null;
      exportAbortRef.current?.abort();
      narrationAbortRef.current?.abort();
      thumbnailAbortRef.current?.abort();
      audioNormalizationAbortRef.current?.abort();
      if (!pageHidingRef.current) {
        void releaseActiveReservationForeground().catch(() => undefined);
      }
      sourcesRef.current.forEach((source) => URL.revokeObjectURL(source.url));
      if (removedSourceRef.current) {
        URL.revokeObjectURL(removedSourceRef.current.source.url);
      }
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      if (
        pendingFinalizeRef.current &&
        pendingFinalizeRef.current.result.url !== resultRef.current?.url
      ) {
        URL.revokeObjectURL(pendingFinalizeRef.current.result.url);
      }
      if (narrationRef.current) URL.revokeObjectURL(narrationRef.current.url);
      if (previousNarrationRef.current) URL.revokeObjectURL(previousNarrationRef.current.url);
    };
  }, [releaseActiveReservationForeground, releaseActiveReservationOnPageHide]);

  const rememberAiQuota = useCallback(
    (limit: number | null, remaining: number | null) => {
      if (limit !== null) {
        aiOperationLimitRef.current = limit;
        setAiOperationLimit(limit);
      }
      if (remaining !== null) {
        aiOperationsRemainingRef.current = remaining;
        setAiOperationsRemaining(remaining);
      }
    },
    [],
  );

  const releaseReturnedReservationLocked = useCallback(
    async (reservation: UsageReservation, idempotencyKey: string) => {
      if (reservation.reservationId) {
        await releaseUsageWithRetry(reservation.reservationId);
      }
      if (activeReservationRef.current === reservation.reservationId) {
        activeReservationRef.current = null;
        activeReservationBucketRef.current = null;
        activeReservationStatusRef.current = null;
        activeReservationExpiresAtRef.current = null;
      }
      if (reservationKeyRef.current === idempotencyKey) {
        reservationKeyRef.current = null;
        reservationDurationRef.current = null;
      }
      reservationInvalidatedRef.current = false;
    },
    [],
  );

  const ensureMixUsageReservation = useCallback(
    (signal?: AbortSignal, renewBeforeExport = false) =>
      withReservationLock(async () => {
        if (signal) ensureVideoMixActionActive(signal, mountedRef.current);
        const currentDuration = () =>
          sourcesRef.current.reduce((sum, source) => sum + source.duration, 0);

        if (reservationInvalidatedRef.current) {
          // A reserve response can be lost after the server commits it. Reuse
          // its key only to recover and release that exact reservation. This
          // locked primitive must not call the public release wrapper because
          // that wrapper acquires this same mutex.
          if (!activeReservationRef.current && reservationKeyRef.current) {
            const recoveryKey = reservationKeyRef.current;
            const recovered = await reserveMixUsage(
              reservationDurationRef.current ?? currentDuration(),
              recoveryKey,
              signal,
            );
            await releaseReturnedReservationLocked(recovered, recoveryKey);
          }
          if (activeReservationRef.current) {
            await releaseActiveReservationLocked();
          } else if (!reservationKeyRef.current) {
            reservationInvalidatedRef.current = false;
          }
        }

        if (signal) ensureVideoMixActionActive(signal, mountedRef.current);
        if (
          renewBeforeExport &&
          paidSaveAvailableRef.current &&
          activeReservationBucketRef.current === "free"
        ) {
          reservationInvalidatedRef.current = true;
          await releaseActiveReservationLocked();
        }
        if (activeReservationRef.current) {
          if (renewBeforeExport) {
            const refreshed = await renewMixUsage(
              activeReservationRef.current,
              reservationKeyRef.current,
              currentDuration(),
              signal,
            );
            if (refreshed.status === "completed") {
              // A completed reservation is terminal and must never be reused
              // for a second saved video.
              activeReservationRef.current = null;
              activeReservationBucketRef.current = null;
              activeReservationStatusRef.current = null;
              activeReservationExpiresAtRef.current = null;
              reservationKeyRef.current = null;
              reservationDurationRef.current = null;
            } else {
              if (refreshed.status !== null && refreshed.status !== "reserved") {
                throw new Error("利用枠を安全に更新できませんでした。もう一度お試しください。");
              }
              activeReservationRef.current = refreshed.reservationId;
              activeReservationBucketRef.current = refreshed.bucket;
              activeReservationStatusRef.current = refreshed.status;
              activeReservationExpiresAtRef.current = refreshed.expiresAt;
              rememberAiQuota(refreshed.aiOperationLimit, refreshed.aiOperationsRemaining);
              return refreshed;
            }
          } else {
            return {
              reservationId: activeReservationRef.current,
              bucket: activeReservationBucketRef.current,
              status: activeReservationStatusRef.current,
              expiresAt: activeReservationExpiresAtRef.current,
              releasePending: activeReservationStatusRef.current === "release_pending",
              reused: true,
              aiOperationLimit: aiOperationLimitRef.current,
              aiOperationsRemaining: aiOperationsRemainingRef.current,
            } satisfies UsageReservation;
          }
        }

        const requestGeneration = sourceGenerationRef.current;
        let idempotencyKey = reservationKeyRef.current ?? crypto.randomUUID();
        reservationKeyRef.current = idempotencyKey;
        const requestedDuration = reservationDurationRef.current ?? currentDuration();
        reservationDurationRef.current = requestedDuration;
        let reservation: UsageReservation;
        try {
          reservation = await reserveMixUsage(
            requestedDuration,
            idempotencyKey,
            signal,
          );
          if (reservation.status === "completed") {
            idempotencyKey = crypto.randomUUID();
            reservationKeyRef.current = idempotencyKey;
            reservation = await reserveMixUsage(
              requestedDuration,
              idempotencyKey,
              signal,
            );
          }
        } catch (caught) {
          // The response may have been lost after the server committed. Keep
          // the key so the next locked operation can recover it exactly once.
          reservationInvalidatedRef.current = true;
          throw caught;
        }

        if (
          sourceGenerationRef.current !== requestGeneration ||
          reservationInvalidatedRef.current ||
          signal?.aborted
        ) {
          await releaseReturnedReservationLocked(reservation, idempotencyKey);
          throw new DOMException("編集内容が変わったため利用枠を取り直します。", "AbortError");
        }

        activeReservationRef.current = reservation.reservationId;
        activeReservationBucketRef.current = reservation.bucket;
        activeReservationStatusRef.current = reservation.status;
        activeReservationExpiresAtRef.current = reservation.expiresAt;
        reservationInvalidatedRef.current = false;
        rememberAiQuota(
          reservation.aiOperationLimit,
          reservation.aiOperationsRemaining,
        );
        if (!reservation.reservationId) {
          reservationKeyRef.current = null;
          reservationDurationRef.current = null;
        }
        return reservation;
      }),
    [
      releaseActiveReservationLocked,
      releaseReturnedReservationLocked,
      rememberAiQuota,
      withReservationLock,
    ],
  );

  const synchronizeBillingAndQuota = useCallback(
    async (force = false) => {
      if (
        preparingRef.current ||
        narrationGeneratingRef.current ||
        exportRunningRef.current ||
        finalizeActionRef.current
      ) {
        return;
      }
      if (billingSyncRef.current) return billingSyncRef.current;
      const now = Date.now();
      if (!force && now - lastBillingSyncAtRef.current < 1_000) return;
      lastBillingSyncAtRef.current = now;

      const syncPromise = (async () => {
        const billing = await readMixBillingStatus();
        const monthlyHasRoom =
          billing.monthly?.active === true &&
          billing.monthly.accessRevoked !== true &&
          Number.isFinite(billing.monthly.videosUsed) &&
          Number.isFinite(billing.monthly.videoLimit) &&
          Number(billing.monthly.videosUsed) < Number(billing.monthly.videoLimit);
        const hasPaidSave =
          monthlyHasRoom ||
          (billing.oneTimeCredits ?? 0) > 0;
        // Focus/visibility synchronization is intentionally read-only. A paid
        // credit is reserved only after the user explicitly asks for AI or export.
        paidSaveAvailableRef.current = hasPaidSave;

        if (hasPaidSave) {
          // A just-purchased entitlement must be actionable even when the
          // preceding free reservation has no AI actions left. This is only a
          // provisional display value; the explicit AI action below replaces
          // it with the atomic reservation response from the server.
          if (
            !activeReservationRef.current ||
            activeReservationBucketRef.current === "free"
          ) {
            const paidLimit = monthlyHasRoom
              ? SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT
              : ONE_TIME_AI_OPERATION_SUCCESS_LIMIT;
            rememberAiQuota(paidLimit, paidLimit);
          }
          setShowPurchase(false);
          setMessage(
            "購入済みの利用枠を確認しました。編集内容を保ったまま続けられます。",
          );
        }
      })();
      billingSyncRef.current = syncPromise;
      try {
        await syncPromise;
      } finally {
        if (billingSyncRef.current === syncPromise) {
          billingSyncRef.current = null;
        }
      }
    },
    [rememberAiQuota],
  );

  const completeReservationUsage = useCallback(
    (reservationId: string, bucket: BillingBucket) => {
      if (
        activeReservationRef.current &&
        activeReservationRef.current !== reservationId
      ) {
        return Promise.reject(
          new Error("別の利用枠を確認中です。もう一度お試しください。"),
        );
      }
      const previousBucket =
        activeReservationRef.current === reservationId
          ? activeReservationBucketRef.current
          : bucket;
      // Detach synchronously, before waiting for the mutex, so pagehide cannot
      // release the same lease while completion is queued or in flight.
      activeReservationRef.current = null;
      activeReservationBucketRef.current = null;
      activeReservationStatusRef.current = null;
      activeReservationExpiresAtRef.current = null;
      return withReservationLock(async () => {
        try {
          await updateUsage("complete", reservationId);
        } catch (caught) {
          // Restore only on failure so the user can explicitly retry or discard.
          if (!activeReservationRef.current) {
            activeReservationRef.current = reservationId;
            activeReservationBucketRef.current = previousBucket ?? bucket;
            activeReservationStatusRef.current = "reserved";
          }
          throw caught;
        }
        reservationKeyRef.current = null;
        reservationDurationRef.current = null;
        reservationInvalidatedRef.current = false;
      });
    },
    [withReservationLock],
  );

  const releaseReservationUsage = useCallback(
    (reservationId: string) =>
      withReservationLock(async () => {
        await releaseUsageWithRetry(reservationId);
        if (activeReservationRef.current === reservationId) {
          activeReservationRef.current = null;
          activeReservationBucketRef.current = null;
          activeReservationStatusRef.current = null;
          activeReservationExpiresAtRef.current = null;
          reservationKeyRef.current = null;
          reservationDurationRef.current = null;
          reservationInvalidatedRef.current = false;
        }
      }),
    [withReservationLock],
  );

  useEffect(() => {
    const synchronizeAfterReturn = () => {
      if (document.visibilityState !== "visible") return;
      void synchronizeBillingAndQuota().catch(() => undefined);
    };
    const synchronizeAfterPageShow = (event: PageTransitionEvent) => {
      pageHidingRef.current = false;
      if (event.persisted && activeReservationRef.current) {
        reservationInvalidatedRef.current = true;
        void releaseActiveReservationForeground()
          .catch(() => undefined)
          .finally(() => {
            void synchronizeBillingAndQuota(true).catch(() => undefined);
          });
        return;
      }
      void synchronizeBillingAndQuota(true).catch(() => undefined);
    };
    window.addEventListener("focus", synchronizeAfterReturn);
    window.addEventListener("pageshow", synchronizeAfterPageShow);
    document.addEventListener("visibilitychange", synchronizeAfterReturn);
    return () => {
      window.removeEventListener("focus", synchronizeAfterReturn);
      window.removeEventListener("pageshow", synchronizeAfterPageShow);
      document.removeEventListener("visibilitychange", synchronizeAfterReturn);
    };
  }, [releaseActiveReservationForeground, synchronizeBillingAndQuota]);

  const clearNarrationDraft = useCallback(
    (releaseReservation = true) => {
      narrationAudioRef.current?.pause();
      const current = narrationRef.current;
      narrationRef.current = null;
      setNarration(null);
      if (current) URL.revokeObjectURL(current.url);
      const previous = previousNarrationRef.current;
      previousNarrationRef.current = null;
      setPreviousNarration(null);
      if (previous) URL.revokeObjectURL(previous.url);
      setNarrationStale(false);
      setDisclosureConfirmed(false);
      const canvas = previewCaptionRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      if (releaseReservation) {
        reservationInvalidatedRef.current = true;
        void releaseActiveReservationForeground().catch(() => {
          if (mountedRef.current) {
            setError(
              "前の利用枠をまだ戻せませんでした。通信を確認して、もう一度操作してください。",
            );
          }
        });
      }
    },
    [releaseActiveReservationForeground],
  );

  const invalidateGeneratedNarration = useCallback(() => {
    if (!narrationRef.current && !activeReservationRef.current) return;
    stopPreview();
    clearResult();
    reservationInvalidatedRef.current = true;
    void releaseActiveReservationForeground().catch(() => undefined);
    if (narrationRef.current) {
      setNarrationStale(true);
      setDisclosureConfirmed(false);
      setMessage("設定が変わりました。前のAI音声は残しています。作り直すと新しい音声へ差し替わります。");
      return;
    }
  }, [clearResult, releaseActiveReservationForeground, stopPreview]);

  const selectGlobalTransition = useCallback(
    (nextTransition: VideoCompositionTransitionType) => {
      if (editingLocked) return;
      stopPreview();
      clearResult();
      invalidateGeneratedNarration();
      setTransition(nextTransition);
      setBoundaryTransitionPreferences({});
      trackClientEvent("video_mix_transition_changed", {
        mode: "video_mix",
        transition: nextTransition,
      });
    },
    [clearResult, editingLocked, invalidateGeneratedNarration, stopPreview],
  );

  const handleTransitionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % TRANSITION_OPTIONS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex =
        (currentIndex - 1 + TRANSITION_OPTIONS.length) % TRANSITION_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TRANSITION_OPTIONS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    if (nextIndex >= 3) setShowAllTransitions(true);
    selectGlobalTransition(TRANSITION_OPTIONS[nextIndex].id);
    window.requestAnimationFrame(() => transitionButtonRefs.current[nextIndex]?.focus());
  };

  const selectFinishMode = useCallback((useNarration: boolean) => {
    if (editingLocked || narrationEnabled === useNarration) return;
    stopPreview();
    clearResult();
    setNarrationEnabled(useNarration);
    if (useNarration) {
      setNarrationSourceAudioMode("mute");
    } else {
      clearNarrationDraft();
      setNarrationStale(false);
    }
  }, [clearNarrationDraft, clearResult, editingLocked, narrationEnabled, stopPreview]);

  const handleFinishModeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % 2;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex + 1) % 2;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectFinishMode(nextIndex === 1);
    finishModeButtonRefs.current[nextIndex]?.focus();
  };

  const updateNarrationOverlay = useCallback(
    (time: number, style: VideoMixCaptionStyle = narrationCaptionStyle) => {
      const canvas = previewCaptionRef.current;
      if (!canvas) return;
      if (canvas.width !== 1080) canvas.width = 1080;
      if (canvas.height !== 1920) canvas.height = 1920;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (narrationEnabled && narrationCaptionsEnabled && narration) {
        drawVideoMixNarrationCaption(
          context,
          canvas.width,
          canvas.height,
          time,
          narration.captions,
          style,
        );
      }
    },
    [narration, narrationCaptionStyle, narrationCaptionsEnabled, narrationEnabled],
  );

  const previewBackgroundForVideo = useCallback((video: HTMLVideoElement) =>
    video === previewPrimaryRef.current
      ? previewPrimaryBlurRef.current
      : previewSecondaryBlurRef.current,
  []);

  const previewWrapperForVideo = useCallback((video: HTMLVideoElement) =>
    video === previewPrimaryRef.current
      ? previewPrimaryLayerRef.current
      : previewSecondaryLayerRef.current,
  []);

  const stylePreviewLayer = useCallback((
    video: HTMLVideoElement,
    baseZIndex: number,
    opacity: number,
    transform = "none",
    clipPath = "none",
  ) => {
    const wrapper = previewWrapperForVideo(video);
    if (!wrapper) return;
    // Background and foreground are one composited source frame. Applying
    // opacity to each child separately would double-apply alpha and make a
    // nominal 50/50 crossfade too dark.
    wrapper.style.zIndex = String(baseZIndex);
    wrapper.style.opacity = String(opacity);
    wrapper.style.transform = transform;
    wrapper.style.clipPath = clipPath;
  }, [previewWrapperForVideo]);

  const updatePreviewLayerBackground = useCallback((
    video: HTMLVideoElement,
    source: MixSource,
    sourceTime: number,
  ) => {
    const canvas = previewBackgroundForVideo(video);
    if (!canvas) return;
    const layerIndex = video === previewPrimaryRef.current ? 0 : 1;
    const frameBucket = Math.floor(sourceTime * 10);
    const cacheKey = [
      source.id,
      source.framing.mode,
      source.framing.focusX.toFixed(3),
      source.framing.focusY.toFixed(3),
      frameBucket,
    ].join(":");
    if (lastPreviewBackgroundUpdateRef.current[layerIndex] === cacheKey) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const layout = computeVideoMixFrameLayout(
      source.width,
      source.height,
      canvas.width,
      canvas.height,
      source.framing,
    );
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.filter = "none";
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (layout.background.kind !== "blurred-video") {
      lastPreviewBackgroundUpdateRef.current[layerIndex] = cacheKey;
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    try {
      const background = layout.background;
      const overscan = 1.08;
      const extraWidth = background.rect.width * (overscan - 1);
      const extraHeight = background.rect.height * (overscan - 1);
      context.filter = `blur(${background.blurPixels}px) saturate(0.88)`;
      context.drawImage(
        video,
        background.rect.x - extraWidth / 2,
        background.rect.y - extraHeight / 2,
        background.rect.width + extraWidth,
        background.rect.height + extraHeight,
      );
      context.filter = "none";
      context.fillStyle = "rgba(0,0,0,0.18)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      lastPreviewBackgroundUpdateRef.current[layerIndex] = cacheKey;
    } catch {
      // A decoded frame can briefly disappear while iOS changes media sources.
    }
  }, [previewBackgroundForVideo]);

  const configurePreviewAt = useCallback((time: number, play: boolean) => {
    if (!plan || sources.length === 0) return false;
    const safeTime = Math.max(0, Math.min(plan.duration, time));
    const clip = clipAtTime(plan, safeTime);
    const source = sources[clip.sourceIndex];
    const primary = previewPrimaryRef.current;
    const secondary = previewSecondaryRef.current;
    if (!primary || !secondary || !source) return false;
    const generation = previewPlaybackGenerationRef.current;
    const current = activeLayerRef.current === 0 ? primary : secondary;
    const inactive = activeLayerRef.current === 0 ? secondary : primary;
    const sourcePreviewGain =
      previewSourceGainAt(safeTime) * previewSourceNormalizationGain(source);
    const frameLayout = computeVideoMixFrameLayout(
      source.width,
      source.height,
      plan.width,
      plan.height,
      source.framing,
    );
    const applySourceFraming = (video: HTMLVideoElement) => {
      video.style.objectFit = frameLayout.framing.mode === "cover" ? "cover" : "contain";
      video.style.objectPosition = frameLayout.framing.mode === "cover"
        ? `${frameLayout.framing.focusX * 100}% ${frameLayout.framing.focusY * 100}%`
        : "center";
    };
    if (activeClipRef.current !== clip.globalClipIndex || current.dataset.sourceId !== source.id) {
      const incomingIndex: 0 | 1 = activeLayerRef.current === 0 ? 1 : 0;
      const incoming = inactive;
      const outgoing = current;
      const targetTime = Math.min(
        clip.end,
        clip.start + Math.max(0, safeTime - clip.editedStart),
      );
      const pendingSwitch = previewActiveSwitchRef.current;
      if (
        pendingSwitch?.generation === generation &&
        pendingSwitch.sourceId === source.id &&
        pendingSwitch.globalClipIndex === clip.globalClipIndex
      ) return false;
      previewActiveSwitchRef.current = {
        generation,
        sourceId: source.id,
        globalClipIndex: clip.globalClipIndex,
        editedTime: safeTime,
      };
      stylePreviewLayer(outgoing, 0, 1);
      const sourceChanged = incoming.dataset.sourceId !== source.id;
      if (sourceChanged) {
        previewPendingPlayRef.current.delete(incoming);
        previewPlayPromiseRef.current.delete(incoming);
        previewDeferredGainRef.current.delete(incoming);
        previewMutedFallbackRef.current.delete(incoming);
        incoming.src = source.url;
        incoming.dataset.sourceId = source.id;
        if (narrationEnabled && narration && narrationSourceAudioMode === "mute") {
          previewMutedFallbackRef.current.add(incoming);
        }
      }
      setPreviewMediaGain(incoming, 0);
      stylePreviewLayer(incoming, 2, 0);
      applySourceFraming(incoming);
      let activatedSynchronously = false;
      const isCurrentSwitch = () => {
        const pending = previewActiveSwitchRef.current;
        return mountedRef.current &&
          isPlayingRef.current === play &&
          previewPlaybackGenerationRef.current === generation &&
          incoming.dataset.sourceId === source.id &&
          pending?.generation === generation &&
          pending.sourceId === source.id &&
          pending.globalClipIndex === clip.globalClipIndex;
      };
      const failActiveSwitch = () => {
        if (!isCurrentSwitch()) return;
        previewActiveSwitchRef.current = null;
        stopPreview();
        setError(
          incoming.error?.code === 4
            ? "この端末では、この素材の形式をプレビュー再生できません。別の動画を選ぶか、H.264互換で書き出してからお試しください。"
            : "次の素材の再生を開始できませんでした。もう一度「プレビューを再生」を押すと、続きから確認できます。",
        );
      };
      const activateIncoming = () => {
        if (!isCurrentSwitch()) return;
        activeLayerRef.current = incomingIndex;
        activeClipRef.current = clip.globalClipIndex;
        previewActiveSwitchRef.current = null;
        previewStartTimeRef.current = safeTime;
        previewStartedAtRef.current = performance.now();
        previewTimeRef.current = safeTime;
        setPreviewTime(safeTime);
        setPreviewMediaGain(incoming, sourcePreviewGain);
        stylePreviewLayer(incoming, 2, 1);
        activatedSynchronously = true;
      };
      const seekAndMaybePlay = () => {
        if (!isCurrentSwitch()) return;
        const trackedPlay = previewPlayPromiseRef.current.get(incoming);
        const waitsForTrackedPlay = trackedPlay?.generation === generation &&
          trackedPlay.sourceId === source.id;
        const seekIncoming = () => {
          if (!isCurrentSwitch()) return;
          incoming.currentTime = targetTime;
          updatePreviewLayerBackground(incoming, source, targetTime);
        };
        if (play && waitsForTrackedPlay) {
          outgoing.pause();
          void resumePreviewMediaWithFallback(incoming, sourcePreviewGain).then((ready) => {
            if (ready) {
              seekIncoming();
              activateIncoming();
            } else {
              failActiveSwitch();
            }
          });
        } else if (play && incoming.paused) {
          // Loading a new URL may implicitly pause a pre-started layer. Resume
          // it without exposing audio while play() is pending; if unmuted
          // playback is rejected, the helper retries as a muted visual layer.
          seekIncoming();
          outgoing.pause();
          void resumePreviewMediaWithFallback(incoming, sourcePreviewGain).then((ready) => {
            if (ready) activateIncoming();
            else failActiveSwitch();
          });
        } else {
          seekIncoming();
          activateIncoming();
        }
      };
      const metadataReady = runWhenPreviewMetadataReady(
        incoming,
        source.id,
        generation,
        `active-${clip.globalClipIndex}`,
        seekAndMaybePlay,
        failActiveSwitch,
      );
      if (!metadataReady) {
        outgoing.pause();
        setPreviewMediaGain(outgoing, 0);
      }
      return activatedSynchronously;
    } else {
      const targetTime = Math.min(clip.end, clip.start + Math.max(0, safeTime - clip.editedStart));
      const seekCurrentAndMaybePlay = () => {
        if (
          !mountedRef.current ||
          previewPlaybackGenerationRef.current !== generation ||
          current.dataset.sourceId !== source.id
        ) return;
        setPreviewMediaGain(current, sourcePreviewGain);
        stylePreviewLayer(current, 2, 1);
        applySourceFraming(current);
        const trackedPlay = previewPlayPromiseRef.current.get(current);
        const waitsForTrackedPlay = trackedPlay?.generation === generation &&
          trackedPlay.sourceId === source.id;
        const seekCurrent = () => {
          if (
            previewPlaybackGenerationRef.current !== generation ||
            current.dataset.sourceId !== source.id
          ) return;
          if (Math.abs(current.currentTime - targetTime) > 0.3) {
            current.currentTime = targetTime;
          }
          updatePreviewLayerBackground(current, source, targetTime);
        };
        if (play && waitsForTrackedPlay) {
          previewActiveSwitchRef.current = {
            generation,
            sourceId: source.id,
            globalClipIndex: clip.globalClipIndex,
            editedTime: safeTime,
          };
          void resumePreviewMediaWithFallback(current, sourcePreviewGain).then((ready) => {
            const pending = previewActiveSwitchRef.current;
            if (
              previewPlaybackGenerationRef.current !== generation ||
              pending?.sourceId !== source.id ||
              pending.globalClipIndex !== clip.globalClipIndex
            ) return;
            previewActiveSwitchRef.current = null;
            if (!ready) {
              stopPreview();
              setError("プレビューを開始できませんでした。もう一度「プレビューを再生」を押してください。");
              return;
            }
            seekCurrent();
            previewStartTimeRef.current = safeTime;
            previewStartedAtRef.current = performance.now();
          });
        } else {
          seekCurrent();
        }
        if (play && current.paused && !waitsForTrackedPlay) {
          previewActiveSwitchRef.current = {
            generation,
            sourceId: source.id,
            globalClipIndex: clip.globalClipIndex,
            editedTime: safeTime,
          };
          void resumePreviewMediaWithFallback(current, sourcePreviewGain).then((ready) => {
            const pending = previewActiveSwitchRef.current;
            if (
              previewPlaybackGenerationRef.current !== generation ||
              pending?.sourceId !== source.id ||
              pending.globalClipIndex !== clip.globalClipIndex
            ) return;
            previewActiveSwitchRef.current = null;
            if (!ready) {
              stopPreview();
              setError(
                current.error?.code === 4
                  ? "この端末では、この素材の形式をプレビュー再生できません。別の動画を選ぶか、H.264互換で書き出してからお試しください。"
                  : "プレビューを再開できませんでした。もう一度「プレビューを再生」を押してください。",
              );
              return;
            }
            previewStartTimeRef.current = safeTime;
            previewStartedAtRef.current = performance.now();
          });
        }
      };
      const metadataReady = runWhenPreviewMetadataReady(
        current,
        source.id,
        generation,
        `current-${clip.globalClipIndex}`,
        seekCurrentAndMaybePlay,
        () => {
          if (
            previewPlaybackGenerationRef.current !== generation ||
            current.dataset.sourceId !== source.id
          ) return;
          if (play) stopPreview();
          setError(
            current.error?.code === 4
              ? "この端末では、この素材の形式をプレビュー再生できません。別の動画を選ぶか、H.264互換で書き出してからお試しください。"
              : "プレビュー用の動画を読み込めませんでした。素材を選び直してお試しください。",
          );
        },
      );
      return metadataReady && previewActiveSwitchRef.current === null;
    }
  }, [
    plan,
    narration,
    narrationEnabled,
    narrationSourceAudioMode,
    previewSourceGainAt,
    previewSourceNormalizationGain,
    resumePreviewMediaWithFallback,
    runWhenPreviewMetadataReady,
    setPreviewMediaGain,
    sources,
    stopPreview,
    stylePreviewLayer,
    updatePreviewLayerBackground,
  ]);

  const updatePreviewTransition = useCallback((time: number) => {
    if (!plan || schedule.length === 0) return;
    const frameIndex = Math.min(schedule.length - 1, Math.max(0, Math.floor(time * plan.frameRate)));
    const frame: VideoCompositionFrameScheduleEntry = schedule[frameIndex];
    const transitionFrame = frame?.transition;
    const active = activeLayerRef.current === 0 ? previewPrimaryRef.current : previewSecondaryRef.current;
    const other = activeLayerRef.current === 0 ? previewSecondaryRef.current : previewPrimaryRef.current;
    if (!active || !other) return;
    if (transitionFrame) {
      const usesOutgoingLayer = videoCompositionTransitionUsesOverlap(
        transitionFrame.type,
      );
      const outgoingSource = sources[transitionFrame.from.sourceIndex];
      if (usesOutgoingLayer && outgoingSource) {
        const generation = previewPlaybackGenerationRef.current;
        const seekOutgoingFrame = () => {
          if (
            !mountedRef.current ||
            previewPlaybackGenerationRef.current !== generation ||
            other.dataset.sourceId !== outgoingSource.id
          ) return;
          if (Math.abs(other.currentTime - transitionFrame.from.sourceTime) > 0.3) {
            other.currentTime = transitionFrame.from.sourceTime;
          }
          updatePreviewLayerBackground(
            other,
            outgoingSource,
            transitionFrame.from.sourceTime,
          );
        };
        setPreviewMediaGain(other, 0);
        if (other.dataset.sourceId !== outgoingSource.id) {
          previewPendingPlayRef.current.delete(other);
          previewPlayPromiseRef.current.delete(other);
          previewDeferredGainRef.current.delete(other);
          previewMutedFallbackRef.current.delete(other);
          other.src = outgoingSource.url;
          other.dataset.sourceId = outgoingSource.id;
          if (narrationEnabled && narration && narrationSourceAudioMode === "mute") {
            previewMutedFallbackRef.current.add(other);
          }
        }
        runWhenPreviewMetadataReady(
          other,
          outgoingSource.id,
          generation,
          `transition-${transitionFrame.boundaryIndex}-${transitionFrame.from.clipIndex}`,
          seekOutgoingFrame,
        );
      }
      const visual = transitionFrame.visual;
      stylePreviewLayer(
        active,
        2,
        visual.incomingOpacity,
        `translateX(${visual.incomingOffsetX * 100}%) scale(${visual.incomingScale})`,
        visual.incomingReveal < 0.999
          ? `inset(0 0 0 ${(1 - visual.incomingReveal) * 100}%)`
          : "none",
      );
      stylePreviewLayer(
        other,
        0,
        usesOutgoingLayer ? visual.outgoingOpacity : 0,
        `translateX(${visual.outgoingOffsetX * 100}%) scale(${visual.outgoingScale})`,
      );
      const transitionAudio = getVideoMixTransitionAudioGains(plan, time);
      const incomingSource = sources[frame.sourceIndex];
      const incomingBaseGain =
        previewSourceGainAt(time) *
        (incomingSource ? previewSourceNormalizationGain(incomingSource) : 1);
      const outgoingBaseGain =
        previewSourceGainAt(time) *
        (outgoingSource ? previewSourceNormalizationGain(outgoingSource) : 1);
      setPreviewMediaGain(
        active,
        incomingBaseGain * (transitionAudio?.incoming ?? 1),
      );
      setPreviewMediaGain(
        other,
        outgoingBaseGain * (transitionAudio?.outgoing ?? 0),
      );
      if (transitionOverlayRef.current) {
        transitionOverlayRef.current.style.opacity = String(visual.overlayOpacity);
        transitionOverlayRef.current.style.background = visual.overlayColor ?? "transparent";
      }
      return;
    }
    stylePreviewLayer(active, 2, 1);
    stylePreviewLayer(other, 0, 0);
    const activeSource = sources[frame.sourceIndex];
    const sourcePreviewGain =
      previewSourceGainAt(time) *
      (activeSource ? previewSourceNormalizationGain(activeSource) : 1);
    setPreviewMediaGain(active, sourcePreviewGain);
    setPreviewMediaGain(other, 0);
    if (transitionOverlayRef.current) {
      transitionOverlayRef.current.style.opacity = "0";
      transitionOverlayRef.current.style.background = "transparent";
    }
  }, [
    plan,
    narration,
    narrationEnabled,
    narrationSourceAudioMode,
    previewSourceGainAt,
    previewSourceNormalizationGain,
    runWhenPreviewMetadataReady,
    schedule,
    setPreviewMediaGain,
    sources,
    stylePreviewLayer,
    updatePreviewLayerBackground,
  ]);

  const startPreview = (
    loopRange?: { start: number; end: number },
    selectionTarget?: {
      sourceId: string;
      clipIndex: number;
      start: number;
      end: number;
      editedStart: number;
      editedEnd: number;
    },
  ) => {
    if (!plan || sceneSelectionBusy || exporting || narrationGenerating) return;
    if (isPlayingRef.current) {
      stopPreview();
      return;
    }
    closeSourcePlayers();
    previewSelectionClipRef.current = null;
    previewFallbackNoticeRef.current = false;
    previewMutedFallbackRef.current.clear();
    setError("");
    const startAt = loopRange?.start ?? (previewTime >= plan.duration - 0.04 ? 0 : previewTime);
    previewLoopRef.current = loopRange ?? null;
    ensurePreviewAudioGraph();
    const primary = previewPrimaryRef.current;
    const secondary = previewSecondaryRef.current;
    const startClip = clipAtTime(plan, startAt);
    const startSource = sources[startClip.sourceIndex];
    const startFrame = schedule[Math.min(
      schedule.length - 1,
      Math.max(0, Math.floor(startAt * plan.frameRate)),
    )];
    const nextClip = plan.clips[startClip.globalClipIndex + 1] ?? startClip;
    const standbySource = startFrame?.transition &&
      videoCompositionTransitionUsesOverlap(startFrame.transition.type)
        ? sources[startFrame.transition.from.sourceIndex]
        : sources[nextClip.sourceIndex] ?? startSource;
    if (!primary || !secondary || !startSource || !standbySource) {
      setError("プレビューを準備できませんでした。動画を選び直してお試しください。");
      return;
    }
    const generation = previewPlaybackGenerationRef.current + 1;
    previewPlaybackGenerationRef.current = generation;
    // Set playback intent before issuing play() so a synchronously resolved
    // promise can restore the deferred gain for the active layer.
    isPlayingRef.current = true;
    setIsPlaying(true);
    let playbackReadiness: ReturnType<typeof startPreviewMediaPair>;
    {
      // Start both visual elements in this explicit click. Later
      // `loadedmetadata` and rAF callbacks are not trusted activations on iOS.
      // Source-audio previews stay unmuted behind zero GainNodes; narration-only
      // previews intentionally keep the videos muted so narration is the sole
      // audible stream. The standby remains ready for a transition.
      if (primary.dataset.sourceId !== startSource.id) {
        previewPendingPlayRef.current.delete(primary);
        previewPlayPromiseRef.current.delete(primary);
        previewDeferredGainRef.current.delete(primary);
        previewMutedFallbackRef.current.delete(primary);
        primary.src = startSource.url;
        primary.dataset.sourceId = startSource.id;
      }
      if (secondary.dataset.sourceId !== standbySource.id) {
        previewPendingPlayRef.current.delete(secondary);
        previewPlayPromiseRef.current.delete(secondary);
        previewDeferredGainRef.current.delete(secondary);
        previewMutedFallbackRef.current.delete(secondary);
        secondary.src = standbySource.url;
        secondary.dataset.sourceId = standbySource.id;
      }
      // When AI narration replaces the source audio, keep both visual layers
      // muted from the original click. This leaves the single audible media
      // stream to narration on iOS instead of asking WebKit to authorize three.
      if (
        narrationEnabled &&
        narration &&
        narrationSourceAudioMode === "mute"
      ) {
        previewMutedFallbackRef.current.add(primary);
        previewMutedFallbackRef.current.add(secondary);
      }
      setPreviewMediaGain(primary, 0);
      setPreviewMediaGain(secondary, 0);
      activeLayerRef.current = 0;
      activeClipRef.current = startClip.globalClipIndex;
      playbackReadiness = startPreviewMediaPair(
        primary,
        secondary,
        generation,
        narrationEnabled && Boolean(narration) && narrationSourceAudioMode === "mute",
      );
    }
    previewTimeRef.current = startAt;
    setPreviewTime(startAt);
    previewStartTimeRef.current = startAt;
    previewStartedAtRef.current = 0;
    const narrationPlayer = narrationAudioRef.current;
    let narrationReady = Promise.resolve(true);
    if (narrationEnabled && narration && narrationPlayer) {
      narrationPlayer.currentTime = Math.min(startAt, narration.audioDuration);
      setPreviewNarrationGain(narrationPlayer, 0);
      narrationReady = playPreviewMedia(narrationPlayer, generation);
    }
    const tick = (now: number) => {
      const pendingSwitch = previewActiveSwitchRef.current;
      if (pendingSwitch?.generation === generation) {
        previewStartTimeRef.current = pendingSwitch.editedTime;
        previewStartedAtRef.current = now;
        previewTimeRef.current = pendingSwitch.editedTime;
        if (narrationPlayer && narration) {
          setPreviewNarrationGain(narrationPlayer, 0);
          narrationPlayer.currentTime = Math.min(
            pendingSwitch.editedTime,
            narration.audioDuration,
          );
        }
        animationRef.current = requestAnimationFrame(tick);
        return;
      }
      if (previewStartedAtRef.current === 0) previewStartedAtRef.current = now;
      const next = previewStartTimeRef.current + (now - previewStartedAtRef.current) / 1000;
      const loop = previewLoopRef.current;
      if (loop && next >= loop.end) {
        previewStartTimeRef.current = loop.start;
        previewStartedAtRef.current = now;
        previewTimeRef.current = loop.start;
        setPreviewTime(loop.start);
        const loopReady = configurePreviewAt(loop.start, true);
        if (!loopReady && previewActiveSwitchRef.current) {
          if (narrationPlayer && narration) {
            setPreviewNarrationGain(narrationPlayer, 0);
          }
          animationRef.current = requestAnimationFrame(tick);
          return;
        }
        updatePreviewTransition(loop.start);
        updateNarrationOverlay(loop.start);
        if (narrationPlayer && narration) {
          narrationPlayer.currentTime = Math.min(loop.start, narration.audioDuration);
          setPreviewNarrationGain(narrationPlayer, narration.normalizationGain);
        }
        animationRef.current = requestAnimationFrame(tick);
        return;
      }
      if (!mountedRef.current || next >= plan.duration) {
        previewTimeRef.current = plan.duration;
        setPreviewTime(plan.duration);
        configurePreviewAt(plan.duration - 0.001, false);
        updatePreviewTransition(plan.duration - 0.001);
        updateNarrationOverlay(plan.duration - 0.001);
        stopPreview();
        return;
      }
      if (now - lastPreviewUiUpdateRef.current >= 80) {
        lastPreviewUiUpdateRef.current = now;
        previewTimeRef.current = next;
        setPreviewTime(next);
      }
      const frameReady = configurePreviewAt(next, true);
      if (!frameReady && previewActiveSwitchRef.current) {
        previewStartTimeRef.current = next;
        previewStartedAtRef.current = now;
        previewTimeRef.current = next;
        setPreviewTime(next);
        if (narrationPlayer && narration) {
          setPreviewNarrationGain(narrationPlayer, 0);
          narrationPlayer.currentTime = Math.min(next, narration.audioDuration);
        }
        animationRef.current = requestAnimationFrame(tick);
        return;
      }
      updatePreviewTransition(next);
      updateNarrationOverlay(next);
      if (
        narrationEnabled &&
        narration &&
        narrationPlayer &&
        next < narration.audioDuration &&
        Math.abs(narrationPlayer.currentTime - next) > 0.16
      ) {
        narrationPlayer.currentTime = next;
      }
      if (narrationEnabled && narration && narrationPlayer) {
        setPreviewNarrationGain(narrationPlayer, narration.normalizationGain);
      }
      animationRef.current = requestAnimationFrame(tick);
    };
    // The editing clock must follow actual media playback. Starting rAF while
    // a Blob video is still waiting for metadata makes the UI race ahead and
    // can also abort Safari's pending play() promise.
    void Promise.all([playbackReadiness.activeReady, narrationReady]).then(([
      activeReady,
      narrationIsReady,
    ]) => {
      if (previewPlaybackGenerationRef.current !== generation) return;
      if (!activeReady || !narrationIsReady) {
        stopPreview();
        setError(
          !narrationIsReady
            ? "AIナレーションの再生を開始できませんでした。もう一度「プレビューを再生」を押してください。"
            : primary.error?.code === 4
            ? "この端末では、この素材の形式をプレビュー再生できません。別の動画を選ぶか、H.264互換で書き出してからお試しください。"
            : "プレビューを開始できませんでした。もう一度「プレビューを再生」を押してください。",
        );
        return;
      }
      // Seek only after the trusted play promise has fulfilled. Seeking a fresh
      // Blob URL from loadedmetadata while play() is still pending aborts that
      // promise on Safari/WebKit.
      configurePreviewAt(startAt, true);
      updatePreviewTransition(startAt);
      updateNarrationOverlay(startAt);
      previewStartedAtRef.current = 0;
      if (loopRange && selectionTarget) {
        previewSelectionClipRef.current = {
          ...selectionTarget,
        };
      }
      if (narrationPlayer && narration) {
        narrationPlayer.currentTime = Math.min(startAt, narration.audioDuration);
        setPreviewNarrationGain(narrationPlayer, narration.normalizationGain);
      }
      animationRef.current = requestAnimationFrame(tick);
    });
    // Standby failure is non-fatal. Its helper first retries muted, and a later
    // boundary reports an error only if that visual fallback also cannot play.
    void playbackReadiness.standbyReady;
  };

  const previewSingleClip = (sourceId: string, clipIndex: number) => {
    if (!plan || sceneSelectionBusy) return;
    const clip = plan.clips.find((item) => item.sourceId === sourceId && item.clipIndex === clipIndex);
    if (!clip) return;
    stopPreview();
    // Keep play() in the button's trusted click handler. Deferring startPreview
    // to requestAnimationFrame loses user activation on iOS (including for the
    // optional narration audio).
    startPreview(
      { start: clip.editedStart, end: clip.editedEnd },
      {
        sourceId: clip.sourceId,
        clipIndex: clip.clipIndex,
        start: clip.start,
        end: clip.end,
        editedStart: clip.editedStart,
        editedEnd: clip.editedEnd,
      },
    );
  };

  const addVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (
      picked.length === 0 ||
      preparingRef.current ||
      sceneSelectionBusy ||
      exportRunningRef.current ||
      finalizeActionRef.current ||
      pendingFinalizeRef.current
    ) return;
    closeSourcePlayers();
    preparingRef.current = true;
    setPreparing(true);
    setError("");
    setSourceFeedback(null);
    const currentSources = sourcesRef.current;
    const availableSlots = VIDEO_COMPOSITION_MAX_SOURCES - currentSources.length;
    const limited = picked.slice(0, Math.max(0, availableSlots));
    if (availableSlots <= 0) {
      announceSourceFeedback("error", "動画は最大5本です。追加済みの動画を削除してから選んでください。");
      preparingRef.current = false;
      setPreparing(false);
      return;
    }
    const existingFingerprints = new Set(currentSources.map((source) => fileFingerprint(source.file)));
    const added: MixSource[] = [];
    const skipped: string[] = [];
    let nextBytes = totalBytes;
    let nextDuration = aggregateDuration;
    for (const file of limited) {
      if (!isSupportedVideo(file)) {
        skipped.push(`${file.name}（形式非対応）`);
        continue;
      }
      if (existingFingerprints.has(fileFingerprint(file))) {
        skipped.push(`${file.name}（追加済み）`);
        continue;
      }
      if (nextBytes + file.size > VIDEO_COMPOSITION_MAX_TOTAL_SOURCE_BYTES) {
        skipped.push(`${file.name}（合計500MB超過）`);
        continue;
      }
      try {
        const metadata = await readVideoMetadata(file);
        if (!mountedRef.current) {
          added.forEach((source) => URL.revokeObjectURL(source.url));
          return;
        }
        if (nextDuration + metadata.duration > VIDEO_COMPOSITION_MAX_AGGREGATE_SOURCE_DURATION_SECONDS + 0.01) {
          skipped.push(`${file.name}（合計5分超過）`);
          continue;
        }
        const fingerprint = fileFingerprint(file);
        const savedSource = findVideoMixDraftSource(loadedDraft, fingerprint);
        const restoredClips = savedSource
          ? clampVideoMixDraftClips(savedSource.clips, metadata.duration)
          : null;
        const id = savedSource?.id ?? createSourceId(file);
        added.push({
          id,
          file,
          url: URL.createObjectURL(file),
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          clips: restoredClips ?? [],
          framing: savedSource?.framing ?? defaultVideoMixFraming(metadata.width, metadata.height),
          thumbnails: [],
          // Keep upload responsive. A bounded selected-clip analysis updates
          // this unity fallback shortly after the source appears in the UI.
          audioNormalizationGain: 1,
          audioNormalizationAnalysisKey: null,
          sceneSelectionStatus: restoredClips ? "restored" : "analyzing",
          sceneSelectionRevision: restoredClips ? 1 : 0,
        });
        existingFingerprints.add(fileFingerprint(file));
        nextBytes += file.size;
        nextDuration += metadata.duration;
      } catch (caught) {
        skipped.push(caught instanceof Error ? caught.message : `${file.name}（読込失敗）`);
      }
    }
    if (!mountedRef.current) {
      added.forEach((source) => URL.revokeObjectURL(source.url));
      return;
    }
    if (added.length > 0) {
      sourceGenerationRef.current += 1;
      stopPreview();
      clearResult();
      invalidateGeneratedNarration();
      const combined = [...currentSources, ...added].map((source) => ({
        ...source,
        clips: source.clips.length > 0 ? source.clips : [createInitialClip(source.duration)],
      }));
      sourcesRef.current = combined;
      setSources(combined);
      setBoundaryTransitionPreferences((current) =>
        pruneVideoMixBoundaryTransitionPreferences(combined, current),
      );
      if (!draftSettingsApplied && loadedDraft && added.some((source) =>
        Boolean(findVideoMixDraftSource(loadedDraft, fileFingerprint(source.file))))) {
        setTransition(loadedDraft.transition);
        setBoundaryTransitionPreferences(
          pruneVideoMixBoundaryTransitionPreferences(
            combined,
            loadedDraft.boundaryTransitions,
          ),
        );
        setNarrationEnabled(loadedDraft.narrationEnabled);
        setNarrationSourceAudioMode(loadedDraft.narrationSourceAudioMode);
        setNarrationCaptionsEnabled(loadedDraft.narrationCaptionsEnabled);
        setNarrationCaptionStyle(loadedDraft.narrationCaptionStyle);
        setNarrationStyle(loadedDraft.narrationStyle);
        setNarrationGoal(loadedDraft.narrationGoal);
        setNarrationBrief(loadedDraft.narrationBrief);
        setDraftSettingsApplied(true);
        setMessage("前回のカット範囲と設定を復元しました。動画ファイル本体は端末の外へ送信していません。");
        trackClientEvent("draft_recovered", {
          mode: "video_mix",
          source_count: combined.length,
          clip_count: combined.reduce((sum, source) => sum + source.clips.length, 0),
          duration_bucket: productDurationBucket(combined.reduce((sum, source) => sum + source.duration, 0)),
        });
      }
      thumbnailAbortRef.current?.abort();
      const thumbnailController = new AbortController();
      thumbnailAbortRef.current = thumbnailController;
      void (async () => {
        for (const source of added) {
          if (thumbnailController.signal.aborted || exportRunningRef.current) return;
          try {
            const cacheKey = sourceSceneAnalysisKey(source);
            let analysis = sceneAnalysisCacheRef.current.get(cacheKey);
            if (!analysis) {
              analysis = await analyzeClientVideoMixSourceScenes(
                source.url,
                source.duration,
                thumbnailController.signal,
              );
              if (thumbnailController.signal.aborted) return;
              sceneAnalysisCacheRef.current.set(cacheKey, analysis);
              while (sceneAnalysisCacheRef.current.size > 8) {
                const oldestKey = sceneAnalysisCacheRef.current.keys().next().value;
                if (typeof oldestKey !== "string") break;
                sceneAnalysisCacheRef.current.delete(oldestKey);
              }
            }
            if (thumbnailController.signal.aborted || !mountedRef.current) return;
            let recommendationApplied = false;
            const analyzedSources = sourcesRef.current.map((current) => {
              if (current.id !== source.id) return current;
              const mayApplyRecommendation =
                current.sceneSelectionStatus === "analyzing" &&
                current.sceneSelectionRevision === source.sceneSelectionRevision;
              const recommendedClips = analysis.recommendation.clips.map((clip) => ({
                start: clip.start,
                end: clip.end,
              }));
              recommendationApplied =
                mayApplyRecommendation && recommendedClips.length > 0;
              return {
                ...current,
                thumbnails: analysis.thumbnails,
                clips:
                  mayApplyRecommendation && recommendedClips.length > 0
                    ? recommendedClips
                    : current.clips,
                sceneSelectionStatus: mayApplyRecommendation
                  ? recommendedClips.length > 0
                    ? "recommended" as const
                    : "fallback" as const
                  : current.sceneSelectionStatus,
              };
            });
            sourcesRef.current = analyzedSources;
            setSources(analyzedSources);
            if (recommendationApplied) sourceGenerationRef.current += 1;
            setBoundaryTransitionPreferences((currentPreferences) =>
              pruneVideoMixBoundaryTransitionPreferences(
                analyzedSources,
                currentPreferences,
              ),
            );
          } catch {
            if (thumbnailController.signal.aborted) return;
            const fallbackSources = sourcesRef.current.map((current) =>
              current.id === source.id && current.sceneSelectionStatus === "analyzing"
                ? { ...current, sceneSelectionStatus: "fallback" as const }
                : current,
            );
            sourcesRef.current = fallbackSources;
            setSources(fallbackSources);
          }
        }
        if (!thumbnailController.signal.aborted && mountedRef.current) {
          announceSourceFeedback(
            "message",
            "端末内で見やすい場面を選びました。再生しながら開始・終了を調整できます。",
          );
        }
      })();
    }
    if (picked.length > limited.length) skipped.push(`6本目以降（最大5本）`);
    if (skipped.length > 0) {
      announceSourceFeedback("error", `追加しなかった動画：${skipped.join("、")}`);
      trackClientEvent("video_mix_add_failed", {
        mode: "video_mix",
        context: "general",
        outcome: "blocked",
        source_count: sourcesRef.current.length,
      });
    } else {
      announceSourceFeedback("message", `${added.length}本を追加しました。選んだ順につなぎます。`);
    }
    preparingRef.current = false;
    setPreparing(false);
  };

  const removeSource = (sourceId: string) => {
    if (
      sceneSelectionBusy ||
      preparingRef.current ||
      narrationGeneratingRef.current ||
      exportRunningRef.current ||
      finalizeActionRef.current ||
      pendingFinalizeRef.current
    ) return;
    const current = sourcesRef.current;
    const target = current.find((source) => source.id === sourceId);
    if (!target) return;
    sourcePlayerRefs.current.get(sourceId)?.pause();
    setExpandedSourcePlayerId((currentId) => currentId === sourceId ? null : currentId);
    const index = current.indexOf(target);
    if (removedSourceRef.current) {
      URL.revokeObjectURL(removedSourceRef.current.source.url);
    }
    const undoEntry: RemovedMixSource = {
      source: target,
      index,
      boundaryTransitions: activeBoundaryTransitionPreferences,
    };
    removedSourceRef.current = undoEntry;
    setRemovedSource(undoEntry);
    sourceGenerationRef.current += 1;
    stopPreview();
    if (activeTrimTarget?.sourceId === sourceId) {
      activeTrimDraftRef.current = null;
      setActiveTrimTarget(null);
      setActiveTrimDraft(null);
      setTrimFeedback("");
    }
    clearResult();
    invalidateGeneratedNarration();
    const next = current.filter((source) => source.id !== sourceId);
    sourcesRef.current = next;
    setSources(next);
    setBoundaryTransitionPreferences((currentPreferences) =>
      pruneVideoMixBoundaryTransitionPreferences(next, currentPreferences),
    );
    activeClipRef.current = -1;
    previewTimeRef.current = 0;
    setPreviewTime(0);
  };

  const undoRemoveSource = () => {
    const entry = removedSourceRef.current;
    if (!entry || editingLocked || sceneSelectionBusy) return;
    sourceGenerationRef.current += 1;
    const next = [...sourcesRef.current];
    next.splice(Math.min(entry.index, next.length), 0, entry.source);
    sourcesRef.current = next;
    setSources(next);
    setBoundaryTransitionPreferences(
      pruneVideoMixBoundaryTransitionPreferences(next, entry.boundaryTransitions),
    );
    removedSourceRef.current = null;
    setRemovedSource(null);
    setSourceFeedback({ kind: "message", text: "削除した動画を元の位置へ戻しました。" });
  };

  const setClipCount = (sourceId: string, count: 1 | 2) => {
    if (
      preparingRef.current ||
      narrationGeneratingRef.current ||
      exportRunningRef.current ||
      finalizeActionRef.current ||
      pendingFinalizeRef.current
    ) return;
    const current = sourcesRef.current;
    const next = current.map((source) => {
      if (source.id !== sourceId) return source;
      if (source.sceneSelectionStatus === "analyzing") return source;
      if (source.clips.length === count) return source;
      if (count === 1) {
        return {
          ...source,
          clips: [{ start: source.clips[0].start, end: source.clips.at(-1)!.end }],
          audioNormalizationGain: 1,
          audioNormalizationAnalysisKey: null,
          sceneSelectionStatus: "manual" as const,
          sceneSelectionRevision: source.sceneSelectionRevision + 1,
        };
      }
      if (source.duration < MINIMUM_CLIP_SECONDS * 2) return source;
      return {
        ...source,
        clips: splitIntoTwoClips(source.duration, source.clips[0]),
        audioNormalizationGain: 1,
        audioNormalizationAnalysisKey: null,
        sceneSelectionStatus: "manual" as const,
        sceneSelectionRevision: source.sceneSelectionRevision + 1,
      };
    });
    if (next.every((source, index) => source === current[index])) return;
    sourceGenerationRef.current += 1;
    stopPreview();
    if (activeTrimTarget?.sourceId === sourceId) {
      activeTrimDraftRef.current = null;
      setActiveTrimTarget(null);
      setActiveTrimDraft(null);
      setTrimFeedback("");
    }
    clearResult();
    invalidateGeneratedNarration();
    sourcesRef.current = next;
    setSources(next);
    setBoundaryTransitionPreferences((currentPreferences) =>
      pruneVideoMixBoundaryTransitionPreferences(next, currentPreferences),
    );
  };

  const updateSourceFraming = (
    sourceId: string,
    patch: Partial<VideoMixSourceFraming>,
  ) => {
    if (editingLocked) return;
    const current = sourcesRef.current;
    const next = current.map((source) =>
      source.id === sourceId
        ? { ...source, framing: { ...source.framing, ...patch } }
        : source,
    );
    if (next.every((source, index) => source === current[index])) return;
    stopPreview();
    clearResult();
    sourcesRef.current = next;
    setSources(next);
    activeClipRef.current = -1;
  };

  const updateClipRange = (
    sourceId: string,
    clipIndex: number,
    rawStart: number,
    rawEnd: number,
  ): { start: number; end: number } | null => {
    if (
      preparingRef.current ||
      narrationGeneratingRef.current ||
      exportRunningRef.current ||
      finalizeActionRef.current ||
      pendingFinalizeRef.current
    ) return null;
    const current = sourcesRef.current;
    let appliedRange: { start: number; end: number } | null = null;
    const next = current.map((source) => {
      if (source.id !== sourceId) return source;
      if (source.sceneSelectionStatus === "analyzing") return source;
      const clips = source.clips.map((clip) => ({ ...clip }));
      const clip = clips[clipIndex];
      if (!clip) return source;
      const minimum = clipIndex === 0 ? 0 : clips[clipIndex - 1].end;
      const maximum = clipIndex === clips.length - 1
        ? source.duration
        : clips[clipIndex + 1].start;
      const requestedStart = Number.isFinite(rawStart) ? rawStart : clip.start;
      const requestedEnd = Number.isFinite(rawEnd) ? rawEnd : clip.end;
      clip.start = Math.max(
        minimum,
        Math.min(maximum - MINIMUM_CLIP_SECONDS, requestedStart),
      );
      clip.end = Math.min(
        maximum,
        Math.max(clip.start + MINIMUM_CLIP_SECONDS, requestedEnd),
      );
      appliedRange = { start: clip.start, end: clip.end };
      if (
        clip.start === source.clips[clipIndex].start &&
        clip.end === source.clips[clipIndex].end
      ) {
        return source;
      }
      return {
        ...source,
        clips,
        audioNormalizationGain: 1,
        audioNormalizationAnalysisKey: null,
        sceneSelectionStatus: "manual" as const,
        sceneSelectionRevision: source.sceneSelectionRevision + 1,
      };
    });
    if (next.every((source, index) => source === current[index])) return appliedRange;
    sourceGenerationRef.current += 1;
    stopPreview();
    clearResult();
    invalidateGeneratedNarration();
    sourcesRef.current = next;
    setSources(next);
    return appliedRange;
  };

  const constrainActiveTrimDraft = (
    draft: ActiveTrimDraft,
    field: "start" | "end",
    raw: number,
  ): ActiveTrimDraft => {
    const source = sourcesRef.current.find((item) => item.id === draft.sourceId);
    const clip = source?.clips[draft.clipIndex];
    if (!source || !clip || !Number.isFinite(raw)) return draft;
    const minimum = draft.clipIndex === 0
      ? 0
      : source.clips[draft.clipIndex - 1].end;
    const maximum = draft.clipIndex === source.clips.length - 1
      ? source.duration
      : source.clips[draft.clipIndex + 1].start;
    if (field === "start") {
      return {
        ...draft,
        start: Math.max(
          minimum,
          Math.min(draft.end - MINIMUM_CLIP_SECONDS, raw),
        ),
      };
    }
    return {
      ...draft,
      end: Math.min(
        maximum,
        Math.max(draft.start + MINIMUM_CLIP_SECONDS, raw),
      ),
    };
  };

  const setActiveTrimDraftEdge = (
    field: "start" | "end",
    raw: number,
  ) => {
    const current = activeTrimDraftRef.current;
    if (!current) return null;
    const next = constrainActiveTrimDraft(current, field, raw);
    activeTrimDraftRef.current = next;
    setActiveTrimDraft(next);
    setTrimFeedback("");
    return next;
  };

  const commitActiveTrimDraft = (draftOverride?: ActiveTrimDraft | null) => {
    const draft = draftOverride ?? activeTrimDraftRef.current;
    if (!draft) return;
    const applied = updateClipRange(
      draft.sourceId,
      draft.clipIndex,
      draft.start,
      draft.end,
    );
    if (!applied) return;
    const next = { ...draft, ...applied };
    activeTrimDraftRef.current = next;
    setActiveTrimDraft(next);
    setTrimFeedback(
      `使う範囲を${formatSeconds(applied.start)}から${formatSeconds(applied.end)}まで（${formatSeconds(applied.end - applied.start)}）に更新しました。`,
    );
  };

  const adjustActiveTrimDraft = (
    field: "start" | "end",
    amount: number,
  ) => {
    const current = activeTrimDraftRef.current;
    if (!current) return;
    const next = constrainActiveTrimDraft(
      current,
      field,
      current[field] + amount,
    );
    activeTrimDraftRef.current = next;
    setActiveTrimDraft(next);
    commitActiveTrimDraft(next);
  };

  const openClipTrimEditor = (
    sourceId: string,
    clipIndex: number,
  ) => {
    const source = sourcesRef.current.find((item) => item.id === sourceId);
    const clip = source?.clips[clipIndex];
    if (!source || !clip || source.sceneSelectionStatus === "analyzing") return;
    const nextDraft = {
      sourceId,
      clipIndex,
      start: clip.start,
      end: clip.end,
    };
    activeTrimDraftRef.current = nextDraft;
    setActiveTrimTarget({ sourceId, clipIndex });
    setActiveTrimDraft(nextDraft);
    setTrimFeedback("");
    previewSingleClip(sourceId, clipIndex);
    requestAnimationFrame(() => {
      trimPanelRef.current?.scrollIntoView({ block: "nearest" });
      trimPanelRef.current?.focus({ preventScroll: true });
    });
  };

  const closeClipTrimEditor = () => {
    const target = activeTrimTarget;
    stopPreview();
    activeTrimDraftRef.current = null;
    setActiveTrimTarget(null);
    setActiveTrimDraft(null);
    setTrimFeedback("");
    if (!target) return;
    requestAnimationFrame(() => {
      const button = document.getElementById(
        `video-mix-trim-button-${target.sourceId}-${target.clipIndex}`,
      );
      button?.scrollIntoView({ block: "nearest" });
      button?.focus({ preventScroll: true });
    });
  };

  const generateMixNarration = async () => {
    if (
      !plan ||
      !narrationEnabled ||
      sceneSelectionBusy ||
      narrationGeneratingRef.current ||
      exportRunningRef.current ||
      finalizeActionRef.current ||
      pendingFinalizeRef.current
    ) {
      return;
    }
    if (plan.duration < 1) {
      setError("AIナレーションを入れるには、完成動画を1秒以上にしてください。");
      return;
    }
    closeSourcePlayers();
    stopPreview();
    clearResult();
    setError("");
    setMessage("動画の場面を端末内で選んでいます…");
    trackClientEvent("video_mix_narration_started", analyticsSnapshot());
    narrationGeneratingRef.current = true;
    setNarrationGenerating(true);
    const controller = new AbortController();
    narrationAbortRef.current = controller;
    try {
      // `true` also replaces an exhausted free reservation with the paid
      // entitlement confirmed after returning from Checkout.
      const reservation = await ensureMixUsageReservation(controller.signal, true);
      ensureVideoMixActionActive(controller.signal, mountedRef.current);
      const operationId = crypto.randomUUID();
      const sceneTimeline = createVideoMixNarrationSceneTimeline(plan);
      const frames = await extractVideoMixNarrationFrames(
        sources.map((source) => ({ file: source.file, clips: source.clips })),
        6,
        controller.signal,
      );
      if (frames.length === 0) {
        throw new Error("AIナレーションに使う場面を読み取れませんでした。");
      }
      if (frames.some((frame) => frame.length > 700_000)) {
        throw new Error("AIナレーションに使う場面画像が大きすぎます。カットを調整して、もう一度お試しください。");
      }
      setMessage("映像の順番に合わせて台本を作っています…");
      let scriptResult = await requestMixNarrationPlan({
        frames,
        sceneTimeline,
        brief: narrationBrief.trim(),
        goal: narrationGoal,
        style: narrationStyle,
        duration: plan.duration,
        reservationId: reservation.reservationId,
        operationId,
        signal: controller.signal,
      });
      rememberAiQuota(scriptResult.quota.limit, scriptResult.quota.remaining);
      setMessage("自然な間をつけて音声を作っています…");
      let speechResult = await requestMixNarrationSpeech({
        plan: scriptResult.plan,
        bundleToken: scriptResult.plan.narrationBundleToken!,
        style: narrationStyle,
        duration: plan.duration,
        reservationId: reservation.reservationId,
        operationId,
        signal: controller.signal,
      });
      rememberAiQuota(speechResult.quota.limit, speechResult.quota.remaining);
      let prepared = await prepareVideoMixNarration(
        speechResult.audio,
        scriptResult.plan,
        plan.duration,
        controller.signal,
        sceneTimeline,
      );
      ensureVideoMixActionActive(controller.signal, mountedRef.current);
      if (prepared.decodedDuration > plan.duration + 0.08) {
        const timingScale = Math.max(
          0.55,
          Math.min(0.98, (plan.duration / prepared.decodedDuration) * 0.96),
        );
        setMessage("音声が動画に自然に収まるよう、台本を短く整えています…");
        scriptResult = await requestMixNarrationPlan({
          frames,
          sceneTimeline,
          brief: narrationBrief.trim(),
          goal: narrationGoal,
          style: narrationStyle,
          duration: plan.duration,
          reservationId: reservation.reservationId,
          operationId,
          narrationBundleToken: scriptResult.plan.narrationBundleToken,
          previousScript: scriptResult.plan.script,
          timingScale,
          signal: controller.signal,
        });
        speechResult = await requestMixNarrationSpeech({
          plan: scriptResult.plan,
          bundleToken: scriptResult.plan.narrationBundleToken!,
          style: narrationStyle,
          duration: plan.duration,
          reservationId: reservation.reservationId,
          operationId,
          signal: controller.signal,
        });
        rememberAiQuota(speechResult.quota.limit, speechResult.quota.remaining);
        prepared = await prepareVideoMixNarration(
          speechResult.audio,
          scriptResult.plan,
          plan.duration,
          controller.signal,
          sceneTimeline,
        );
        ensureVideoMixActionActive(controller.signal, mountedRef.current);
      }
      if (prepared.decodedDuration > plan.duration + 0.08) {
        throw new Error(
          "AI音声が完成動画に収まりませんでした。カットを少し長くして、もう一度作成してください。",
        );
      }
      if (prepared.audioDuration < 0.4) {
        throw new Error("AI音声が短すぎるため、もう一度作成してください。");
      }
      const next: MixNarration = {
        plan: scriptResult.plan,
        audio: speechResult.audio,
        url: URL.createObjectURL(speechResult.audio),
        captions: prepared.captions,
        activity: prepared.activity,
        normalizationGain: prepared.normalizationGain,
        audioDuration: prepared.audioDuration,
        style: narrationStyle,
      };
      const previous = narrationRef.current;
      narrationRef.current = next;
      setNarration(next);
      setNarrationStale(false);
      if (previousNarrationRef.current) {
        URL.revokeObjectURL(previousNarrationRef.current.url);
      }
      previousNarrationRef.current = previous;
      setPreviousNarration(previous);
      setDisclosureConfirmed(false);
      updateNarrationOverlay(0);
      setMessage(
        `${narrationCaptionsEnabled ? "AIナレーションとテロップ" : "AIナレーション"}を作成しました。AI処理はあと${speechResult.quota.remaining ?? aiOperationsRemaining}回です。`,
      );
      trackClientEvent("video_mix_narration_completed", analyticsSnapshot());
    } catch (caught) {
      reservationInvalidatedRef.current = true;
      void releaseActiveReservationForeground().catch(() => undefined);
      setShowPurchase(
        caught instanceof VideoMixRequestError && caught.status === 402,
      );
      setError(
        caught instanceof Error
          ? caught.message
          : "AIナレーションを作成できませんでした。",
      );
      setMessage("");
      trackClientEvent("video_mix_narration_failed", analyticsSnapshot());
    } finally {
      if (narrationAbortRef.current === controller) {
        narrationAbortRef.current = null;
      }
      narrationGeneratingRef.current = false;
      setNarrationGenerating(false);
    }
  };

  const finalizeResult = useCallback((next: MixResult) => {
    if (!mountedRef.current) {
      URL.revokeObjectURL(next.url);
      return;
    }
    const previous = resultRef.current;
    resultRef.current = next;
    setResult(next);
    if (previous && previous.url !== next.url) {
      URL.revokeObjectURL(previous.url);
    }
    pendingFinalizeRef.current = null;
    setPendingFinalize(null);
    setMessage(`${next.qualityMessage} 保存または共有できます。`);
  }, []);

  const startExport = async () => {
    if (
      !plan ||
      sceneSelectionBusy ||
      narrationGeneratingRef.current ||
      exportRunningRef.current ||
      finalizeActionRef.current ||
      pendingFinalizeRef.current
    ) return;
    if (narrationEnabled && !narration) {
      setError("AIナレーションを作成してから書き出してください。");
      return;
    }
    if (narrationEnabled && narrationStale) {
      setError("設定が変わっています。前のAI音声は残っていますが、現在の映像に合わせて作り直してください。");
      return;
    }
    if (narrationEnabled && !disclosureConfirmed) {
      setError("AIナレーションを使う場合は、投稿時の表示を確認してください。");
      return;
    }
    thumbnailAbortRef.current?.abort();
    closeSourcePlayers();
    stopPreview();
    clearResult();
    setError("");
    setMessage("");
    setShowPurchase(false);
    exportRunningRef.current = true;
    setExporting(true);
    setExportProgress(0);
    trackClientEvent("export_started", analyticsSnapshot());
    const controller = new AbortController();
    exportAbortRef.current = controller;
    let reservationId: string | null = null;
    let preparedResult: MixResult | null = null;
    try {
      // Usage policy is based on the combined source duration, while the
      // resulting file still counts as one completed video.
      // Encoding can take several minutes on an iPhone, so extend or safely
      // reactivate the lease immediately before the expensive export begins.
      const reservation = await ensureMixUsageReservation(controller.signal, true);
      ensureVideoMixActionActive(controller.signal, mountedRef.current);
      reservationId = reservation.reservationId;
      if (!canSaveCompletedVideo(reservation.bucket)) {
        if (reservationId) {
          await releaseReservationUsage(reservationId);
        }
        setShowPurchase(true);
        setMessage("編集とプレビューは無料です。完成動画を保存するにはプランを選んでください。");
        trackClientEvent("video_mix_paywall_shown", analyticsSnapshot());
        return;
      }
      if (!reservation.bucket) throw new Error("保存できる利用枠を確認できませんでした。");
      if (narrationEnabled) {
        await recordMixNarrationDisclosure(reservationId, controller.signal);
      }
      let audioMetadata: VideoMixAudioExportMetadata | null = null;
      let exportedPlan: VideoCompositionPlan | null = null;
      const blob = await exportVideoMixMp4({
        sources: sources.map((source) => ({
          id: source.id,
          file: source.file,
          clips: source.clips,
          framing: source.framing,
          // Use the same cached value as the live preview. If a user exports
          // during the short analysis window, both intentionally use unity.
          audioNormalizationGain: previewSourceNormalizationGain(source),
        })),
        transition,
        boundaryTransitions: resolvedBoundaryTransitions,
        audioGain: narrationSourceAudioGain,
        narrationAudio: narrationEnabled ? narration?.audio : undefined,
        narrationNormalizationGain:
          narrationEnabled ? narration?.normalizationGain : undefined,
        duckSourceAudioDuringNarration:
          narrationEnabled && narrationSourceAudioMode === "ambient",
        signal: controller.signal,
        onProgress: setExportProgress,
        onAudioMetadata: (metadata) => {
          audioMetadata = metadata;
        },
        onPlan: (actualPlan) => {
          exportedPlan = actualPlan;
        },
        drawOverlay:
          narrationEnabled && narrationCaptionsEnabled && narration
            ? ({ context, canvas, editedTime }) => {
                drawVideoMixNarrationCaption(
                  context,
                  canvas.width,
                  canvas.height,
                  editedTime,
                  narration.captions,
                  narrationCaptionStyle,
                );
              }
            : undefined,
      });
      ensureMixExportActive(controller.signal, mountedRef.current);
      if (!audioMetadata) {
        throw new Error("完成動画の音声構成を確認できませんでした。もう一度書き出してください。");
      }
      if (!exportedPlan) {
        throw new Error("完成動画の実際の長さを確認できませんでした。もう一度書き出してください。");
      }
      const qualityMessage = await inspectMixOutput(
        blob,
        exportedPlan,
        audioMetadata,
        narrationEnabled ? narration?.captions : [],
        narrationEnabled && narrationCaptionsEnabled,
      );
      ensureMixExportActive(controller.signal, mountedRef.current);
      preparedResult = {
        blob,
        url: URL.createObjectURL(blob),
        filename: buildFilename(),
        bucket: reservation.bucket,
        qualityMessage,
      };
      if (reservationId) {
        let durable;
        try {
          durable = await saveDurableVideoMixOutput({
            blob,
            filename: preparedResult.filename,
            reservationId,
            bucket: reservation.bucket,
            qualityMessage,
          });
        } catch {
          const stagedPending = { result: preparedResult, reservationId };
          pendingFinalizeRef.current = stagedPending;
          setPendingFinalize(stagedPending);
          activeReservationRef.current = reservationId;
          activeReservationStatusRef.current = "reserved";
          setError("完成動画を端末へ安全に一時保存できなかったため、利用枠は確定していません。空き容量を確認して再試行してください。");
          return;
        }
        preparedResult.durableId = durable.id;
      }
      if (reservationId) {
        const stagedPending = { result: preparedResult, reservationId };
        pendingFinalizeRef.current = stagedPending;
        try {
          ensureMixExportActive(controller.signal, mountedRef.current);
          // Encoding and fail-closed inspection are complete. From this point,
          // let the atomic completion request settle without racing pagehide's
          // best-effort release.
          finalizingUsageRef.current = true;
          setFinalizingUsage(true);
          await completeReservationUsage(reservationId, reservation.bucket);
          if (preparedResult.durableId) {
            await markDurableVideoMixOutputCompleted(preparedResult.durableId);
          }
        } catch (caught) {
          if (controller.signal.aborted || !mountedRef.current) throw caught;
          activeReservationRef.current = reservationId;
          activeReservationBucketRef.current = reservation.bucket;
          activeReservationStatusRef.current = "reserved";
          setPendingFinalize(stagedPending);
          setError("動画は完成しましたが、利用記録を確認できませんでした。通信を確認して再試行してください。");
          return;
        }
      }
      reservationKeyRef.current = null;
      finalizeResult(preparedResult);
      trackClientEvent("export_completed", {
        ...analyticsSnapshot(),
        bucket: reservation.bucket,
      });
    } catch (caught) {
      if (pendingFinalizeRef.current?.result === preparedResult) {
        pendingFinalizeRef.current = null;
      }
      const completionWasIrreversible = finalizingUsageRef.current;
      setShowPurchase(
        caught instanceof VideoMixRequestError && caught.status === 402,
      );
      if (completionWasIrreversible && preparedResult) {
        // Once completion starts we cannot prove that the server did not
        // commit after a lost response. Preserve the verified Blob and let the
        // idempotent completion retry reconcile it instead of discarding it.
        if (reservationId) {
          const stagedPending: PendingFinalize = {
            result: preparedResult,
            reservationId,
          };
          pendingFinalizeRef.current = stagedPending;
          activeReservationRef.current = reservationId;
          activeReservationStatusRef.current = "reserved";
          setPendingFinalize(stagedPending);
          setError(
            "動画は完成しましたが、保存枠の確定結果を確認できませんでした。再試行してください。",
          );
          return;
        }
      }
      if (preparedResult) URL.revokeObjectURL(preparedResult.url);
      if (reservationId) {
        try {
          await releaseReservationUsage(reservationId);
        } catch {
          setError("書き出しに失敗し、利用枠の戻し処理も確認できませんでした。しばらく待ってからお試しください。");
          return;
        }
      }
      setError(caught instanceof Error ? caught.message : "動画を書き出せませんでした。");
      trackClientEvent("export_failed", analyticsSnapshot());
    } finally {
      exportAbortRef.current = null;
      exportRunningRef.current = false;
      finalizingUsageRef.current = false;
      setFinalizingUsage(false);
      setExporting(false);
    }
  };

  const retryFinalize = async () => {
    if (!pendingFinalize || finalizeActionRef.current || exportRunningRef.current) return;
    finalizeActionRef.current = true;
    finalizingUsageRef.current = true;
    setFinalizingUsage(true);
    setExporting(true);
    setError("");
    try {
      let pendingResult = pendingFinalize.result;
      let durableId = pendingResult.durableId;
      if (!durableId) {
        const durable = await saveDurableVideoMixOutput({
          blob: pendingResult.blob,
          filename: pendingResult.filename,
          reservationId: pendingFinalize.reservationId,
          bucket: pendingResult.bucket,
          qualityMessage: pendingResult.qualityMessage,
        });
        durableId = durable.id;
        pendingResult = { ...pendingResult, durableId };
        const updatedPending = { ...pendingFinalize, result: pendingResult };
        pendingFinalizeRef.current = updatedPending;
        setPendingFinalize(updatedPending);
      }
      const retryDuration = sourcesRef.current.reduce((sum, source) => sum + source.duration, 0);
      const refreshed = await renewMixUsage(
        pendingFinalize.reservationId,
        reservationKeyRef.current,
        retryDuration > 0 ? retryDuration : undefined,
      );
      if (refreshed.status !== "completed") {
        if (refreshed.status !== "reserved") {
          throw new Error("利用枠を再開できませんでした。通信を確認して、もう一度お試しください。");
        }
        if (!refreshed.bucket || !canSaveCompletedVideo(refreshed.bucket)) {
          setShowPurchase(true);
          throw new VideoMixRequestError(
            "現在のアカウントでは保存できる利用枠を確認できませんでした。完成動画は端末内に保持しています。プランを確認してから再試行してください。",
            402,
          );
        }
        pendingResult = { ...pendingResult, bucket: refreshed.bucket };
        const updatedPending = { ...pendingFinalize, result: pendingResult };
        pendingFinalizeRef.current = updatedPending;
        setPendingFinalize(updatedPending);
        activeReservationRef.current = refreshed.reservationId;
        activeReservationBucketRef.current = refreshed.bucket;
        activeReservationStatusRef.current = refreshed.status;
        activeReservationExpiresAtRef.current = refreshed.expiresAt;
        await completeReservationUsage(
          pendingFinalize.reservationId,
          refreshed.bucket,
        );
      }
      await markDurableVideoMixOutputCompleted(durableId);
      finalizeResult(pendingResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "利用記録を確認できませんでした。");
    } finally {
      finalizingUsageRef.current = false;
      finalizeActionRef.current = false;
      setFinalizingUsage(false);
      setExporting(false);
    }
  };

  const discardPending = async () => {
    if (!pendingFinalize || finalizeActionRef.current || exportRunningRef.current) return;
    finalizeActionRef.current = true;
    setDiscardingPending(true);
    try {
      await releaseReservationUsage(pendingFinalize.reservationId);
      URL.revokeObjectURL(pendingFinalize.result.url);
      if (pendingFinalize.result.durableId) {
        await deleteDurableVideoMixOutput(pendingFinalize.result.durableId);
      }
      pendingFinalizeRef.current = null;
      setPendingFinalize(null);
      reservationKeyRef.current = null;
      setMessage("完成データを破棄し、編集へ戻りました。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "利用枠を戻せませんでした。");
    } finally {
      finalizeActionRef.current = false;
      setDiscardingPending(false);
    }
  };

  const saveResult = async () => {
    if (!result) return;
    const file = new File([result.blob], result.filename, { type: "video/mp4" });
    const shareData: ShareData = { files: [file], title: "撮るだけリールでつないだ動画" };
    try {
      if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(shareData))) {
        await navigator.share(shareData);
        if (result.durableId) {
          const durableId = result.durableId;
          await deleteDurableVideoMixOutput(durableId).catch(() => undefined);
          if (resultRef.current?.durableId === durableId) {
            const sharedResult = { ...resultRef.current, durableId: undefined };
            resultRef.current = sharedResult;
            setResult(sharedResult);
          }
        }
        return;
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
    }
    const link = document.createElement("a");
    link.href = result.url;
    link.download = result.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const deleteResultDurableCopy = async () => {
    const current = resultRef.current;
    if (!current?.durableId || deletingDurableCopy) return;
    const durableId = current.durableId;
    setDeletingDurableCopy(true);
    setError("");
    try {
      await deleteDurableVideoMixOutput(durableId);
      if (resultRef.current?.durableId === durableId) {
        const retainedPlayback = {
          ...resultRef.current,
          durableId: undefined,
        };
        // Keep the in-memory URL alive so playback and an immediate download
        // still work; only the device-persistent recovery copy is removed.
        resultRef.current = retainedPlayback;
        setResult(retainedPlayback);
      }
      setMessage("端末内の一時コピーを削除しました。現在の画面では引き続き保存できます。");
    } catch {
      setError("端末内の一時コピーを削除できませんでした。もう一度お試しください。");
    } finally {
      setDeletingDurableCopy(false);
    }
  };

  return (
    <main className="videoMixShell" data-mobile-step={mobileStep}>
      <header className="videoMixHeader">
        <Link href="/" className="videoMixBrand" target="_blank" rel="noreferrer">撮るだけリール</Link>
        <div>
          <span>複数動画編集</span>
          <strong>複数動画をつなぐ</strong>
        </div>
        <Link href="/account" target="_blank" rel="noreferrer">アカウント</Link>
      </header>

      <section className="videoMixHero">
        <div>
          <p className="videoMixEyebrow">最大5本の動画から、流れのある1本へ</p>
          <h1>順番を守って、<br /><em>いい場面だけをつなぐ。</em></h1>
          <p>各動画から1〜2カットを選び、素材を選んだ順につなぎます。途中で前の動画へ戻る編集や、逆再生は行いません。会話・解説を活かすか、AIナレーションを主役にするかも選べます。</p>
          {sources.length === 0 ? (
            <button
              className="videoMixHeroCta"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={editingLocked}
            >
              <strong>動画を選んで無料でプレビュー</strong>
              <small>無料体験はサービス共通で合計3分以内・最大2動画まで</small>
            </button>
          ) : null}
        </div>
        <aside>
          <strong>つなぎ方の変更は追加料金なし</strong>
          <span>カット範囲と8種類の場面転換は端末内で処理。AI音声を作る場合だけ、AI処理を1回使用します。</span>
          <small>プラン購入時に決済・書き出し成功時に完成動画1本分の利用枠を使用</small>
        </aside>
      </section>

      <section className="videoMixWorkspace" aria-label="複数動画の編集">
        <div className={`videoMixPreviewPanel${displayedTrimDraft ? " isTrimming" : ""}`} id="video-mix-finished-preview">
          <div className="videoMixPreviewHeading">
            <h2>仕上がりプレビュー</h2>
            <small>{plan ? `${sources.length}動画・${plan.clips.length}カット・${plan.duration.toFixed(1)}秒` : "9:16"}</small>
          </div>
          <div className="videoMixPhone">
            {sources.length > 0 ? (
              <>
                <span ref={previewPrimaryLayerRef} className="videoMixMediaLayer" aria-hidden="true">
                  <canvas ref={previewPrimaryBlurRef} className="videoMixBlurCanvas" width={540} height={960} />
                  <video ref={previewPrimaryRef} muted={false} playsInline preload="metadata" />
                </span>
                <span ref={previewSecondaryLayerRef} className="videoMixMediaLayer" aria-hidden="true">
                  <canvas ref={previewSecondaryBlurRef} className="videoMixBlurCanvas" width={540} height={960} />
                  <video ref={previewSecondaryRef} muted={false} playsInline preload="metadata" />
                </span>
                <span ref={transitionOverlayRef} className="videoMixTransitionOverlay" />
                <canvas
                  ref={previewCaptionRef}
                  className="videoMixCaptionCanvas"
                  width={1080}
                  height={1920}
                  aria-hidden="true"
                />
                <audio ref={narrationAudioRef} src={narration?.url} preload="auto" />
              </>
            ) : (
              <div className="videoMixEmpty">
                <span aria-hidden="true">＋</span>
                <strong>動画を選ぶと、ここで順番とつなぎ目を確認できます</strong>
                <small>MP4 / MOV / M4V / WebM</small>
              </div>
            )}
          </div>
          <div className="videoMixPlayback">
            <button type="button" onClick={() => startPreview()} disabled={!plan || sceneSelectionBusy || exporting || narrationGenerating} aria-label={isPlaying ? "プレビューを停止" : "プレビューを再生"}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <input
              type="range"
              min={0}
              max={plan?.duration ?? 1}
              step={0.03}
              value={Math.min(previewTime, plan?.duration ?? 0)}
              disabled={!plan || sceneSelectionBusy || exporting || narrationGenerating}
              aria-label="プレビューの再生位置"
              aria-valuetext={`${formatSeconds(previewTime)} / ${formatSeconds(plan?.duration ?? 0)}`}
              onChange={(event) => {
                 stopPreview();
                 const next = Number(event.target.value);
                 previewTimeRef.current = next;
                 setPreviewTime(next);
                configurePreviewAt(next, false);
                updatePreviewTransition(next);
                updateNarrationOverlay(next);
                if (narrationAudioRef.current && narration) {
                  narrationAudioRef.current.currentTime = Math.min(
                    next,
                    narration.audioDuration,
                  );
                }
              }}
            />
            <span>{formatSeconds(previewTime)} / {formatSeconds(plan?.duration ?? 0)}</span>
          </div>
          {activeTrimSource && activeTrimClip && activeTrimTarget && displayedTrimDraft ? (
            <section
              ref={trimPanelRef}
              id="video-mix-trim-panel"
              className="videoMixTrimPanel"
              aria-labelledby="video-mix-trim-heading"
              tabIndex={-1}
            >
              <div className="videoMixTrimHeading">
                <div>
                  <span>動画{activeTrimSourceIndex + 1}を調整中</span>
                  <h3 id="video-mix-trim-heading">使う場面 {activeTrimTarget.clipIndex + 1}</h3>
                </div>
                <button type="button" onClick={closeClipTrimEditor}>調整を終える</button>
              </div>
              <p className="videoMixTrimSummary">
                <span><small>元動画</small><strong>{formatSeconds(displayedTrimDraft.start)}〜{formatSeconds(displayedTrimDraft.end)}</strong></span>
                <span><small>使う長さ</small><strong>{formatSeconds(displayedTrimDraft.end - displayedTrimDraft.start)}</strong></span>
              </p>
              <div className="videoMixFilmstrip videoMixTrimFilmstrip" aria-hidden="true">
                {activeTrimSource.thumbnails.map((thumbnail, frameIndex) => (
                  // Generated locally and intentionally left as a data URL.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={`${activeTrimSource.id}-trim-frame-${frameIndex}`} src={thumbnail} alt="" />
                ))}
                <span
                  style={{
                    left: `${(displayedTrimDraft.start / activeTrimSource.duration) * 100}%`,
                    width: `${((displayedTrimDraft.end - displayedTrimDraft.start) / activeTrimSource.duration) * 100}%`,
                  }}
                />
              </div>
              {(["start", "end"] as const).map((field) => {
                const isStart = field === "start";
                const label = isStart ? "使い始め" : "使い終わり";
                const value = displayedTrimDraft[field];
                const minimum = isStart
                  ? activeTrimTarget.clipIndex === 0
                    ? 0
                    : activeTrimSource.clips[activeTrimTarget.clipIndex - 1].end
                  : displayedTrimDraft.start + MINIMUM_CLIP_SECONDS;
                const maximum = isStart
                  ? displayedTrimDraft.end - MINIMUM_CLIP_SECONDS
                  : activeTrimTarget.clipIndex === activeTrimSource.clips.length - 1
                    ? activeTrimSource.duration
                    : activeTrimSource.clips[activeTrimTarget.clipIndex + 1].start;
                return (
                  <label className="videoMixTrimEdge" key={field}>
                    <span><strong>{label}</strong><output>{formatSeconds(value)}</output></span>
                    <input
                      type="range"
                      min={minimum}
                      max={maximum}
                      step="any"
                      value={value}
                      aria-valuetext={`${label} ${formatSeconds(value)}`}
                      disabled={editingLocked || activeTrimSource.sceneSelectionStatus === "analyzing"}
                      onChange={(event) => setActiveTrimDraftEdge(field, Number(event.target.value))}
                      onPointerUp={() => commitActiveTrimDraft()}
                      onKeyUp={() => commitActiveTrimDraft()}
                      onBlur={() => commitActiveTrimDraft()}
                    />
                  </label>
                );
              })}
              <button
                type="button"
                className="videoMixTrimPreviewButton"
                onClick={() => previewSingleClip(activeTrimTarget.sourceId, activeTrimTarget.clipIndex)}
                disabled={!plan || editingLocked || sceneSelectionBusy}
              >
                <span aria-hidden="true">▶</span> 選んだ範囲を再生
              </button>
              <details className="videoMixTrimFineTune">
                <summary>0.1秒単位で細かく調整</summary>
                {(["start", "end"] as const).map((field) => {
                  const label = field === "start" ? "使い始め" : "使い終わり";
                  return (
                    <div key={field}>
                      <strong>{label}</strong>
                      {([-1, -0.1, 0.1, 1] as const).map((amount) => (
                        <button
                          type="button"
                          key={amount}
                          onClick={() => adjustActiveTrimDraft(field, amount)}
                          disabled={editingLocked || activeTrimSource.sceneSelectionStatus === "analyzing"}
                          aria-label={`${label}を${Math.abs(amount)}秒${amount < 0 ? "早める" : "遅らせる"}`}
                        >
                          {amount > 0 ? "+" : "−"}{Math.abs(amount)}秒
                        </button>
                      ))}
                    </div>
                  );
                })}
              </details>
              {trimFeedback ? <p className="videoMixTrimFeedback" role="status" aria-live="polite">{trimFeedback}</p> : null}
            </section>
          ) : null}
          <div className="videoMixFacts">
            <span><strong>1080 × 1920</strong>完成動画</span>
            <span><strong>素材順を固定</strong>前後・逆再生なし</span>
          </div>
          <p className="videoMixPreviewNote">プレビューでは映像とつなぎ目を確認でき、AIナレーションを選んだ場合は音声とテロップも確認できます。素材ごとの音量は選んだ場面を端末内で短く解析し、プレビューと書き出しへ同じ調整を反映します。解析中に再生した場合は、完了後に自動で音量が整います。</p>
        </div>

        <div className="videoMixControls">
          <section className="videoMixSection videoMixStep videoMixStep1">
            <div className="videoMixSectionTitle">
              <span>01</span>
              <div><h2>動画を選ぶ</h2><p>選んだ順が、そのまま完成動画の順番です。</p></div>
              <strong>{sources.length} / {VIDEO_COMPOSITION_MAX_SOURCES}</strong>
            </div>
            <input
              ref={inputRef}
              className="visuallyHidden"
              type="file"
              tabIndex={-1}
              aria-hidden="true"
              multiple
              accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
              disabled={editingLocked || sceneSelectionBusy || sources.length >= VIDEO_COMPOSITION_MAX_SOURCES}
              onChange={addVideos}
            />
            <button className="videoMixAddButton" type="button" onClick={() => inputRef.current?.click()} disabled={editingLocked || sceneSelectionBusy || sources.length >= VIDEO_COMPOSITION_MAX_SOURCES}>
              <span aria-hidden="true">＋</span>
              <span><strong>{sources.length === 0 ? "動画を選ぶ" : "動画を追加する"}</strong><small>最大5本・合計500MB・合計5分まで</small></span>
            </button>
            {sourceFeedback ? (
              <p
                ref={sourceFeedbackRef}
                className={sourceFeedback.kind === "error" ? "videoMixError videoMixSourceFeedback" : "videoMixMessage videoMixSourceFeedback"}
                role={sourceFeedback.kind === "error" ? "alert" : "status"}
                aria-live={sourceFeedback.kind === "error" ? "assertive" : "polite"}
                tabIndex={sourceFeedback.kind === "error" ? -1 : undefined}
              >
                {sourceFeedback.text}
              </p>
            ) : null}
            {removedSource ? (
              <div className="videoMixUndo" role="status">
                <span>「{removedSource.source.file.name}」を削除しました。</span>
                <button type="button" onClick={undoRemoveSource} disabled={editingLocked || sceneSelectionBusy}>元に戻す</button>
              </div>
            ) : null}
            {preparing ? <p className="videoMixPreparing" aria-live="polite">動画の長さと向きを端末内で確認しています…</p> : null}
            {!preparing && sceneSelectionBusy ? (
              <p className="videoMixPreparing" aria-live="polite">
                見やすさと場面の変化を端末内で解析し、おすすめの使用範囲を選んでいます…
              </p>
            ) : null}
            <div className="videoMixLimits" aria-label="素材の使用量">
              <span>容量 {formatBytes(totalBytes)} / 500MB</span>
              <span>元動画 {formatSeconds(aggregateDuration)} / 5:00</span>
              <span>完成 {formatSeconds(plan?.duration ?? 0)} / 1:30</span>
            </div>
            {sources.length > 0 ? (
              <ol className="videoMixSourceList" aria-label="完成動画の素材順">
                {sources.map((source, sourceIndex) => (
                  <li key={source.id}>
                    <div className="videoMixSourceSummary">
                      <span>{String(sourceIndex + 1).padStart(2, "0")}</span>
                      {source.thumbnails[0] ? (
                        // Generated locally and intentionally kept as a data URL.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={source.thumbnails[0]} alt="" />
                      ) : (
                        <span className="videoMixSourceThumbnailPlaceholder" aria-hidden="true">動画</span>
                      )}
                      <div>
                        <strong>{source.file.name}</strong>
                        <small>{source.width}×{source.height}・{formatSeconds(source.duration)}・{formatBytes(source.file.size)}</small>
                        <em>
                          {source.sceneSelectionStatus === "analyzing"
                            ? "おすすめ場面を端末内で選別中…"
                            : source.sceneSelectionStatus === "recommended"
                              ? `おすすめの${source.clips.length}場面を選びました`
                              : source.sceneSelectionStatus === "restored"
                                ? `前回の${source.clips.length}場面を復元しました`
                                : source.sceneSelectionStatus === "fallback"
                                  ? `${source.clips.length}場面・中央付近を仮選択`
                                  : `${source.clips.length}場面・手動で調整済み`}
                        </em>
                        <button
                          type="button"
                          className="videoMixSourcePreviewToggle"
                          aria-expanded={expandedSourcePlayerId === source.id}
                          aria-controls={`video-mix-source-player-${source.id}`}
                          onClick={() => toggleSourcePlayer(source.id)}
                          disabled={editingLocked || source.sceneSelectionStatus === "analyzing"}
                        >
                          {expandedSourcePlayerId === source.id ? "元動画を閉じる" : "元動画を確認"}
                        </button>
                      </div>
                      <button type="button" onClick={() => removeSource(source.id)} disabled={editingLocked || sceneSelectionBusy} aria-label={`${sourceIndex + 1}番目の動画 ${source.file.name}を削除`}>削除</button>
                    </div>
                    {expandedSourcePlayerId === source.id ? (
                      <div className="videoMixSourcePlayback" id={`video-mix-source-player-${source.id}`}>
                        <video
                          ref={(element) => {
                            if (element) sourcePlayerRefs.current.set(source.id, element);
                            else sourcePlayerRefs.current.delete(source.id);
                          }}
                          src={source.url}
                          controls
                          playsInline
                          preload="metadata"
                          onPlay={() => handleSourcePlayerPlay(source.id)}
                          aria-label={`${sourceIndex + 1}番目の素材 ${source.file.name} の全体再生`}
                        />
                        <p>確認専用です。音声付きで再生できます。使う範囲は「使う場面」から調整します。</p>
                      </div>
                    ) : null}
                    <fieldset className="videoMixClipCount">
                      <legend>この動画から使う場面</legend>
                      <button type="button" className={source.clips.length === 1 ? "isActive" : ""} aria-pressed={source.clips.length === 1} onClick={() => setClipCount(source.id, 1)} disabled={editingLocked || source.sceneSelectionStatus === "analyzing"}>1か所</button>
                      <button type="button" className={source.clips.length === 2 ? "isActive" : ""} aria-pressed={source.clips.length === 2} onClick={() => setClipCount(source.id, 2)} disabled={editingLocked || source.sceneSelectionStatus === "analyzing" || source.duration < MINIMUM_CLIP_SECONDS * 2}>2か所</button>
                    </fieldset>
                    <div className="videoMixClipList">
                      {source.clips.map((clip, clipIndex) => {
                        const isActive = activeTrimTarget?.sourceId === source.id &&
                          activeTrimTarget.clipIndex === clipIndex;
                        return (
                        <fieldset className={isActive ? "isActive" : ""} key={`${source.id}-${clipIndex}`}>
                          <legend><span>使う場面 {clipIndex + 1}</span><strong>{formatSeconds(clip.end - clip.start)}</strong></legend>
                          <p className="videoMixClipRangeText">元動画の {formatSeconds(clip.start)}〜{formatSeconds(clip.end)} を使います</p>
                          <div className="videoMixFilmstrip" aria-hidden="true">
                            {source.thumbnails.map((thumbnail, frameIndex) => (
                              // Generated locally and intentionally left as a data URL.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={`${source.id}-frame-${frameIndex}`} src={thumbnail} alt="" />
                            ))}
                            <span style={{ left: `${(clip.start / source.duration) * 100}%`, width: `${((clip.end - clip.start) / source.duration) * 100}%` }} />
                          </div>
                          <button
                            id={`video-mix-trim-button-${source.id}-${clipIndex}`}
                            type="button"
                            className="videoMixClipEditButton"
                            onClick={() => openClipTrimEditor(source.id, clipIndex)}
                            disabled={!plan || editingLocked || sceneSelectionBusy || source.sceneSelectionStatus === "analyzing"}
                            aria-controls="video-mix-trim-panel"
                            aria-pressed={isActive}
                            aria-label={`${sourceIndex + 1}番目の動画・使う場面${clipIndex + 1}を仕上がりプレビューで確認して調整`}
                          >
                            <span aria-hidden="true">{isActive ? "✓" : "▶"}</span>
                            {isActive ? "この場面を調整中" : "この場面を確認・調整"}
                          </button>
                        </fieldset>
                        );
                      })}
                    </div>
                    <details className="videoMixFramingDisclosure">
                      <summary>縦画面での見え方を調整</summary>
                      <fieldset className="videoMixFraming">
                        <legend>縦画面への収め方</legend>
                        {([
                          ["blur", "ぼかし背景"],
                          ["cover", "画面いっぱい"],
                          ["contain", "全体を表示"],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            className={source.framing.mode === mode ? "isActive" : ""}
                            aria-pressed={source.framing.mode === mode}
                            disabled={editingLocked}
                            onClick={() => updateSourceFraming(source.id, { mode })}
                          >
                            {label}
                          </button>
                        ))}
                        {source.framing.mode !== "contain" ? (
                          <>
                            <label>
                              <span>主役の横位置</span>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={source.framing.focusX}
                                aria-valuetext={`左から${Math.round(source.framing.focusX * 100)}%`}
                                disabled={editingLocked}
                                onChange={(event) => updateSourceFraming(source.id, { focusX: Number(event.target.value) })}
                              />
                            </label>
                            <label>
                              <span>主役の縦位置</span>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={source.framing.focusY}
                                aria-valuetext={`上から${Math.round(source.framing.focusY * 100)}%`}
                                disabled={editingLocked}
                                onChange={(event) => updateSourceFraming(source.id, { focusY: Number(event.target.value) })}
                              />
                            </label>
                          </>
                        ) : null}
                      </fieldset>
                    </details>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          <section className="videoMixSection videoMixStep videoMixStep2">
            <div className="videoMixSectionTitle"><span>02</span><div><h2>つなぎ方を選ぶ</h2><p>つなぎ方の変更自体は無料です。AI音声を作った後に完成尺が変わる場合、音声の作り直しにはAI処理を1回使います。</p></div></div>
            <div className="videoMixTransitionSummary">
              <strong>すべての切り目へ一括設定</strong>
              <small>
                {hasIndividualTransitions
                  ? `個別設定 ${Object.keys(activeBoundaryTransitionPreferences).length}か所。ここで選び直すと、すべて同じ効果になります。`
                  : "あとから、切り目ごとに別の効果へ変更できます。"}
              </small>
            </div>
            <div className="videoMixTransitionGrid" role="radiogroup" aria-label="すべての切り目のつなぎ方">
              {TRANSITION_OPTIONS.map((option, optionIndex) =>
                showAllTransitions || optionIndex < 3 || option.id === transition ? (
                <button
                  key={option.id}
                  ref={(element) => { transitionButtonRefs.current[optionIndex] = element; }}
                  type="button"
                  role="radio"
                  aria-checked={transition === option.id}
                  tabIndex={transition === option.id ? 0 : -1}
                  className={transition === option.id ? "isActive" : ""}
                  disabled={editingLocked}
                  onKeyDown={(event) => handleTransitionKeyDown(event, optionIndex)}
                  onClick={() => selectGlobalTransition(option.id)}
                >
                  <span className={`videoMixTransitionIcon ${option.id}`} aria-hidden="true"><i /><i /></span>
                  <strong>{option.label}</strong><small>{option.note}</small>
                  {option.id === "crossfade" ? <em>おすすめ</em> : null}
                </button>
              ) : null)}
            </div>
            <button
              type="button"
              className="videoMixTransitionMore"
              aria-expanded={showAllTransitions}
              onClick={() => setShowAllTransitions((current) => !current)}
            >
              {showAllTransitions ? "おすすめ3種類だけ表示" : "ほかの5種類も見る"}
            </button>
            {plan && plan.boundaries.length > 0 ? (
              <div className="videoMixBoundarySettings">
                <div className="videoMixBoundaryHeading">
                  <strong>切り目ごとに変更</strong>
                  <small>動画とカットの順番は固定したまま、場面転換だけを選べます。</small>
                </div>
                <ol className="videoMixBoundaryList" aria-label="切り目ごとのつなぎ方">
                  {plan.boundaries.map((boundary) => {
                    const outgoing = plan.clips[boundary.outgoingClipIndex];
                    const incoming = plan.clips[boundary.incomingClipIndex];
                    const outgoingSource = sources[outgoing.sourceIndex];
                    const incomingSource = sources[incoming.sourceIndex];
                    const preferenceKey = boundaryPreferenceKeys[boundary.index];
                    const selectedType =
                      activeBoundaryTransitionPreferences[preferenceKey] ?? transition;
                    return (
                      <li key={preferenceKey}>
                        <div className="videoMixBoundaryFlow">
                          <span>{boundary.index + 1}</span>
                          <span className="videoMixBoundaryClip">
                            <strong>{outgoingSource?.file.name ?? `動画${outgoing.sourceIndex + 1}`}</strong>
                            <small>{outgoing.clipIndex + 1}つ目のカット</small>
                          </span>
                          <i aria-hidden="true">→</i>
                          <span className="videoMixBoundaryClip">
                            <strong>{incomingSource?.file.name ?? `動画${incoming.sourceIndex + 1}`}</strong>
                            <small>{incoming.clipIndex + 1}つ目のカット</small>
                          </span>
                        </div>
                        <label className="videoMixBoundaryChoice">
                          <span>{boundary.index + 1}番目の切り目</span>
                          <select
                            value={selectedType}
                            disabled={editingLocked}
                            aria-label={`${boundary.index + 1}番目の切り目のつなぎ方`}
                            onChange={(event) => {
                              if (editingLocked) return;
                              const nextType = event.target.value as VideoCompositionTransitionType;
                              trackClientEvent("video_mix_transition_changed", {
                                mode: "video_mix",
                                transition: nextType,
                              });
                              stopPreview();
                              clearResult();
                              invalidateGeneratedNarration();
                              setBoundaryTransitionPreferences((current) => {
                                const active =
                                  pruneVideoMixBoundaryTransitionPreferences(
                                    sourcesRef.current,
                                    current,
                                  );
                                if (nextType === transition) {
                                  const next = { ...active };
                                  delete next[preferenceKey];
                                  return next;
                                }
                                return { ...active, [preferenceKey]: nextType };
                              });
                            }}
                          >
                            {TRANSITION_OPTIONS.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : null}
          </section>

          <section className="videoMixSection videoMixNarrationSection videoMixStep videoMixStep3">
            <div className="videoMixSectionTitle">
              <span>03</span>
              <div>
                <h2>音声の仕上げを選ぶ</h2>
                <p>「元音声のまま」ではテロップを追加しません。AI音声へ置き換える場合や話し声のない素材では、AIナレーションとテロップ表示を選べます。</p>
              </div>
            </div>
            <div className="videoMixFinishMode" role="radiogroup" aria-label="完成動画の音声">
              <button
                ref={(element) => { finishModeButtonRefs.current[0] = element; }}
                type="button"
                role="radio"
                aria-checked={!narrationEnabled}
                tabIndex={!narrationEnabled ? 0 : -1}
                className={!narrationEnabled ? "isActive" : ""}
                disabled={editingLocked}
                onKeyDown={(event) => handleFinishModeKeyDown(event, 0)}
                onClick={() => selectFinishMode(false)}
              >
                <strong>元音声のまま</strong>
                <small>会話・解説など元の話し声を、テロップなしで活かしたいときにおすすめ</small>
              </button>
              <button
                ref={(element) => { finishModeButtonRefs.current[1] = element; }}
                type="button"
                role="radio"
                aria-checked={narrationEnabled}
                tabIndex={narrationEnabled ? 0 : -1}
                className={narrationEnabled ? "isActive" : ""}
                disabled={editingLocked}
                onKeyDown={(event) => handleFinishModeKeyDown(event, 1)}
                onClick={() => selectFinishMode(true)}
              >
                <strong>AIナレーションを入れる</strong>
                <small>話し声のない動画、または元の声をAI音声へ置き換えたいとき</small>
              </button>
            </div>

            {narrationEnabled ? (
              <div className="videoMixNarrationSettings">
                <fieldset className="videoMixVoiceOptions">
                  <legend>元動画の音</legend>
                  <button
                    type="button"
                    aria-pressed={narrationSourceAudioMode === "mute"}
                    className={narrationSourceAudioMode === "mute" ? "isActive" : ""}
                    disabled={editingLocked}
                    onClick={() => {
                      if (narrationSourceAudioMode === "mute") return;
                      stopPreview();
                      clearResult();
                      setNarrationSourceAudioMode("mute");
                    }}
                  >
                    <strong>元動画の音を消す</strong>
                    <small>話し声の置き換えにおすすめ</small>
                  </button>
                  <button
                    type="button"
                    aria-pressed={narrationSourceAudioMode === "ambient"}
                    className={narrationSourceAudioMode === "ambient" ? "isActive" : ""}
                    disabled={editingLocked}
                    onClick={() => {
                      if (narrationSourceAudioMode === "ambient") return;
                      stopPreview();
                      clearResult();
                      setNarrationSourceAudioMode("ambient");
                    }}
                  >
                    <strong>環境音を薄く残す</strong>
                    <small>話し声のない素材向け</small>
                  </button>
                </fieldset>
                <fieldset className="videoMixGoalOptions">
                  <legend>この動画の目的</legend>
                  {([
                    ["follow", "雰囲気を伝える"],
                    ["sales", "商品・お店を紹介"],
                    ["reach", "広く見てもらう"],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={narrationGoal === id}
                      className={narrationGoal === id ? "isActive" : ""}
                      disabled={editingLocked}
                      onClick={() => {
                        if (narrationGoal === id) return;
                        invalidateGeneratedNarration();
                        setNarrationGoal(id);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </fieldset>
                <label className="videoMixNarrationBrief">
                  <span>動画で伝えたいこと <small>任意</small></span>
                  <textarea
                    value={narrationBrief}
                    maxLength={800}
                    rows={3}
                    disabled={editingLocked}
                    placeholder="例：海辺のホテルで過ごした朝。静かな景色と朝食の魅力を伝えたい"
                    onChange={(event) => {
                      invalidateGeneratedNarration();
                      setNarrationBrief(event.target.value);
                    }}
                  />
                  <small>具体的に書くほど、映像に合う自然な台本になります。</small>
                </label>
                <fieldset className="videoMixVoiceOptions">
                  <legend>ナレーションの声</legend>
                  {NARRATION_STYLES.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      aria-pressed={narrationStyle === style.id}
                      className={narrationStyle === style.id ? "isActive" : ""}
                      disabled={editingLocked}
                      onClick={() => {
                        if (narrationStyle === style.id) return;
                        invalidateGeneratedNarration();
                        setNarrationStyle(style.id);
                      }}
                    >
                      <strong>{style.label}</strong>
                      <small>{style.note}</small>
                    </button>
                  ))}
                </fieldset>
                <label className="videoMixCaptionToggle">
                  <input
                    type="checkbox"
                    checked={narrationCaptionsEnabled}
                    disabled={editingLocked}
                    onChange={(event) => {
                      stopPreview();
                      clearResult();
                      setNarrationCaptionsEnabled(event.target.checked);
                      if (!event.target.checked) {
                        const canvas = previewCaptionRef.current;
                        canvas?.getContext("2d")?.clearRect(
                          0,
                          0,
                          canvas.width,
                          canvas.height,
                        );
                      }
                    }}
                  />
                  <span>
                    <strong>AIナレーションのテロップも表示する</strong>
                    <small>発話の「間」を端末内で解析し、実際に話す位置へ合わせます</small>
                  </span>
                </label>
                {narrationCaptionsEnabled ? (
                  <fieldset className="videoMixCaptionStyles">
                    <legend>テロップの見た目</legend>
                    <p>音声を作り直さず、プレビューと完成動画へ同じデザインを反映します。</p>
                    <div>
                      {VIDEO_MIX_CAPTION_STYLE_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={narrationCaptionStyle === option.id}
                          className={narrationCaptionStyle === option.id ? "isActive" : ""}
                          disabled={editingLocked}
                          onClick={() => {
                            if (narrationCaptionStyle === option.id) return;
                            stopPreview();
                            clearResult();
                            setNarrationCaptionStyle(option.id);
                            window.requestAnimationFrame(() => updateNarrationOverlay(previewTime, option.id));
                          }}
                        >
                          <span className={`videoMixCaptionStylePreview ${option.id}`} aria-hidden="true">あの日の景色</span>
                          <strong>{option.label}</strong>
                          <small>{option.note}</small>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
                <div className="videoMixNarrationAction">
                  <button
                    type="button"
                    onClick={generateMixNarration}
                    disabled={!plan || sceneSelectionBusy || narrationGenerating || exporting || aiOperationsRemaining <= 0}
                  >
                    {narrationGenerating
                      ? "台本と音声を作成中…"
                      : narration
                        ? "台本と音声を作り直す"
                        : "台本と音声を自動生成"}
                  </button>
                  <span>
                    1回の操作で台本と音声を作成
                    <small>AI処理 残り{aiOperationsRemaining} / {aiOperationLimit}回</small>
                  </span>
                  {narrationGenerating ? (
                    <button
                      type="button"
                      className="videoMixNarrationCancel"
                      onClick={() => narrationAbortRef.current?.abort()}
                    >
                      作成を中止
                    </button>
                  ) : null}
                </div>
                {narration ? (
                  <div className="videoMixNarrationReady">
                    <div>
                      <span>AI仕上げを確認できます</span>
                      <strong>{narration.plan.title}</strong>
                      <small>{narration.audioDuration.toFixed(1)}秒・{NARRATION_STYLES.find((style) => style.id === narration.style)?.label}</small>
                    </div>
                    {narrationStale ? (
                      <p className="videoMixNarrationStale" role="status">設定変更前の音声です。現在の映像へ合わせるには作り直してください。</p>
                    ) : null}
                    {previousNarration ? (
                      <button
                        type="button"
                        onClick={() => {
                          const current = narrationRef.current;
                          narrationRef.current = previousNarration;
                          previousNarrationRef.current = current;
                          setNarration(previousNarration);
                          setPreviousNarration(current);
                          setNarrationStale(false);
                          setDisclosureConfirmed(false);
                          setMessage("ひとつ前のAI音声へ戻しました。");
                        }}
                      >
                        ひとつ前の音声へ戻す
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        stopPreview();
                        const player = narrationAudioRef.current;
                        if (!player) return;
                        ensurePreviewAudioGraph();
                        player.currentTime = 0;
                        setPreviewNarrationGain(player, narration.normalizationGain);
                        void player.play().catch(() => undefined);
                      }}
                    >
                      音声だけ試聴
                    </button>
                    <details>
                      <summary>自動で作った台本と投稿文を見る</summary>
                      <p>{narration.plan.script}</p>
                      <div className="videoMixPostCaption">
                        <p>{buildDisclosedPostCaption(narration.plan.socialCaption)}</p>
                        <button
                          type="button"
                          onClick={() =>
                            void navigator.clipboard
                              ?.writeText(buildDisclosedPostCaption(narration.plan.socialCaption))
                              .then(() => setMessage("投稿文をコピーしました。"))
                              .catch(() => setError("投稿文をコピーできませんでした。"))
                          }
                        >
                          投稿文をコピー
                        </button>
                      </div>
                    </details>
                    <label className="videoMixDisclosureCheck">
                      <input
                        type="checkbox"
                        checked={disclosureConfirmed}
                        disabled={editingLocked}
                        onChange={(event) => setDisclosureConfirmed(event.target.checked)}
                      />
                      <span>
                        投稿時に「{NARRATION_DISCLOSURE_TEXT}」を含めます。
                        <Link href="/terms" target="_blank">利用規約</Link>を確認しました。
                      </span>
                    </label>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="videoMixExportCard">
            <div><span aria-hidden="true">MP4</span><p><strong>高画質で1本に書き出す</strong><small>1080×1920・完成動画1本分</small></p></div>
            <ul><li>素材は選んだ順、各素材内は時間順を維持</li><li>{narrationEnabled ? narrationSourceAudioMode === "mute" ? "元動画の音を消し、AI音声を主役にします" : "AI音声を主役にし、環境音を薄く残します" : "素材ごとの音量差を自動で調整"}</li><li>つなぎ方とテロップ表示の変更は追加料金なし</li><li>有料枠は品質確認済みの書き出し成功時だけ使用</li></ul>
            <p className="videoMixAlwaysPrice">編集・プレビュー無料　<span>保存は1本¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}／月額¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}から</span></p>
            {planResult.error ? <p className="videoMixError" role="alert">{planResult.error}</p> : null}
            <button type="button" className="videoMixExportButton" onClick={startExport} disabled={!plan || preparing || sceneSelectionBusy || narrationGenerating || exporting || Boolean(pendingFinalize) || (narrationEnabled && (!narration || narrationStale || !disclosureConfirmed))}>
              {finalizingUsage
                ? "保存枠を確定中…"
                : exporting
                  ? `動画を作成中… ${Math.round(exportProgress * 100)}%`
                  : showPurchase
                    ? "購入を確認して書き出す"
                    : "1本の動画として書き出す"}
              <span aria-hidden="true">↓</span>
            </button>
            {exporting ? <><div className="videoMixProgress" role="progressbar" aria-label={finalizingUsage ? "保存枠を確定中" : "動画を書き出し中"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress * 100)} aria-valuetext={finalizingUsage ? "動画は完成し、保存枠を確定しています" : `${Math.round(exportProgress * 100)}パーセント`}><span style={{ width: `${Math.max(2, exportProgress * 100)}%` }} /></div><button type="button" className="videoMixCancel" disabled={finalizingUsage} onClick={() => exportAbortRef.current?.abort()}>{finalizingUsage ? "保存枠を確定中" : "書き出しを中止"}</button></> : null}
            {pendingFinalize ? <div className="videoMixFinalize"><button type="button" disabled={finalizingUsage || discardingPending} onClick={retryFinalize}>{finalizingUsage ? "利用確認中…" : "利用確認を再試行して保存へ進む"}</button><button type="button" disabled={finalizingUsage || discardingPending} onClick={discardPending}>{discardingPending ? "破棄を確認中…" : "完成データを破棄して編集へ戻る"}</button></div> : null}
          </section>

          <div className="videoMixStatus" aria-live="polite">
            {error ? <p className="videoMixError" role="alert">{error}</p> : null}
            {message ? <p className="videoMixMessage">{message}</p> : null}
            {showPurchase ? (
              <div className="videoMixPurchase">
                <strong>完成動画を保存するプランを選択</strong>
                <small>決済後、この画面へ戻って「購入を確認して書き出す」を押してください。</small>
                <div>
                  <Link className="primary" href="/account?checkout=one_time" target="_blank" rel="noreferrer" onClick={() => trackClientEvent("checkout_started", { plan: "one_time", source: "result" })}><span>1回払い・自動更新なし</span><strong>この動画1本を¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}で保存</strong></Link>
                  <Link href="/account?checkout=starter" target="_blank" rel="noreferrer" onClick={() => trackClientEvent("checkout_started", { plan: "starter", source: "result" })}><span>1か月ごと</span><strong>{STARTER_MONTHLY_PLAN_LABEL} ¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}</strong><small>1か月に動画{STARTER_MONTHLY_VIDEO_LIMIT}本まで</small></Link>
                  <Link href="/account?checkout=standard" target="_blank" rel="noreferrer" onClick={() => trackClientEvent("checkout_started", { plan: "standard", source: "result" })}><span>1か月ごと</span><strong>{STANDARD_MONTHLY_PLAN_LABEL} ¥{STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}</strong><small>1か月に動画{STANDARD_MONTHLY_VIDEO_LIMIT}本まで</small></Link>
                </div>
              </div>
            ) : null}
          </div>

          {result ? (
            <section className="videoMixResult" aria-label="完成動画">
              <div><span>完成</span><strong>{result.qualityMessage}</strong></div>
              <video src={result.url} controls playsInline preload="metadata" />
              <button type="button" onClick={saveResult} disabled={deletingDurableCopy}>完成動画を保存・共有</button>
              {result.durableId ? (
                <aside className="videoMixDurableCopy">
                  <small>保存確認用の一時コピーはこの端末内に保持され、7日以内に自動削除されます。</small>
                  <button
                    type="button"
                    className="videoMixDurableDelete"
                    disabled={deletingDurableCopy || exporting || finalizingUsage}
                    onClick={deleteResultDurableCopy}
                  >
                    {deletingDurableCopy ? "削除中…" : "端末内の一時コピーを削除"}
                  </button>
                </aside>
              ) : null}
            </section>
          ) : null}
        </div>
      </section>

      <nav className="videoMixMobileSteps" aria-label="編集手順">
        <button type="button" className={mobileStep === 1 ? "isActive" : ""} aria-current={mobileStep === 1 ? "step" : undefined} onClick={() => setMobileStep(1)}>1 素材</button>
        <button type="button" className={mobileStep === 2 ? "isActive" : ""} aria-current={mobileStep === 2 ? "step" : undefined} disabled={!plan} onClick={() => setMobileStep(2)}>2 つなぎ</button>
        <button type="button" className={mobileStep === 3 ? "isActive" : ""} aria-current={mobileStep === 3 ? "step" : undefined} disabled={!plan} onClick={() => setMobileStep(3)}>3 音声・保存</button>
      </nav>

      <footer className="videoMixFooter"><Link href="/" target="_blank" rel="noreferrer">トップへ戻る</Link><Link href="/support" target="_blank" rel="noreferrer">よくある質問・お問い合わせ</Link><Link href="/privacy" target="_blank" rel="noreferrer">プライバシー</Link><Link href="/terms" target="_blank" rel="noreferrer">利用規約</Link></footer>
    </main>
  );
}
