"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  canSaveCompletedVideo,
  isBillingBucket,
  ONE_TIME_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_VIDEO_LIMIT,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  type BillingBucket,
} from "../../lib/billing-policy";
import {
  VIDEO_COMPOSITION_MAX_AGGREGATE_SOURCE_DURATION_SECONDS,
  VIDEO_COMPOSITION_MAX_OUTPUT_DURATION_SECONDS,
  VIDEO_COMPOSITION_MAX_SOURCES,
  VIDEO_COMPOSITION_MAX_TOTAL_SOURCE_BYTES,
  buildVideoCompositionFrameSchedule,
  createVideoCompositionPlan,
  type VideoCompositionClip,
  type VideoCompositionFrameScheduleEntry,
  type VideoCompositionPlan,
  type VideoCompositionTransitionType,
} from "../../lib/video-composition";
import {
  exportVideoMixMp4,
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
  drawVideoMixNarrationCaption,
  extractVideoMixNarrationFrames,
  prepareVideoMixNarration,
} from "../../lib/video-mix-narration";
import type { CaptionGoal } from "../../lib/caption-design";
import { getCaptionDisplayRange, type CaptionSegment } from "../../lib/captions";

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
};

type MixResult = {
  blob: Blob;
  url: string;
  filename: string;
  bucket: BillingBucket;
  qualityMessage: string;
};

type PendingFinalize = {
  result: MixResult;
  reservationId: string;
};

type UsageReservation = {
  reservationId: string | null;
  bucket: BillingBucket | null;
  aiOperationLimit: number;
  aiOperationsRemaining: number;
};

type MixNarration = Readonly<{
  plan: NarrationPlan;
  audio: Blob;
  url: string;
  captions: CaptionSegment[];
  audioDuration: number;
  style: NarrationStyle;
}>;

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

const DEFAULT_AI_OPERATION_LIMIT = 6;

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

async function reserveMixUsage(duration: number, idempotencyKey: string): Promise<UsageReservation> {
  const request = () => fetch("/api/usage/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceDurationSeconds: duration, idempotencyKey, creationType: "video_mix" }),
  });
  let response = await request();
  if (response.status === 401) {
    const trial = await fetch("/api/session/trial", { method: "POST" });
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
  const payload = (await response.json()) as { required?: boolean; reservationId?: string; bucket?: unknown };
  if (!payload.required) {
    return {
      reservationId: null,
      bucket: null,
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
    aiOperationLimit,
    aiOperationsRemaining,
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frames: options.frames,
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

async function recordMixNarrationDisclosure(reservationId: string | null) {
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
  });
  if (!response.ok) {
    throw new Error(
      await readApiError(response, "AIナレーションの投稿表示を確認できませんでした。"),
    );
  }
}

async function updateUsage(action: "complete" | "release", reservationId: string) {
  const response = await fetch(`/api/usage/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { completed?: boolean; released?: boolean; error?: string }
    | null;
  const confirmed = action === "complete" ? payload?.completed : payload?.released;
  if (!response.ok || !confirmed) {
    throw new Error(payload?.error || "利用記録を確認できませんでした。");
  }
}

function sendMixUsageReleaseBeacon(reservationId: string) {
  const body = JSON.stringify({ reservationId });
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
    ? narrationCaptions.map(getCaptionDisplayRange)
    : [];
  const captionRanges = captionsEnabled ? expectedNarrationRanges : [];
  const inspection = await inspectExportedVideoQuality(blob, {
    packetSampleCount: 360,
    inspectAudioActivity: audioMetadata.inspectAudioActivity,
    expectedNarrationRanges,
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
  return plan.clips.find((clip, index) =>
    time >= clip.editedStart && (time < clip.editedEnd || index === plan.clips.length - 1),
  ) ?? plan.clips.at(-1)!;
}

export default function VideoMixClient() {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewPrimaryRef = useRef<HTMLVideoElement>(null);
  const previewSecondaryRef = useRef<HTMLVideoElement>(null);
  const previewCaptionRef = useRef<HTMLCanvasElement>(null);
  const narrationAudioRef = useRef<HTMLAudioElement>(null);
  const animationRef = useRef<number | null>(null);
  const previewStartedAtRef = useRef(0);
  const previewStartTimeRef = useRef(0);
  const activeLayerRef = useRef<0 | 1>(0);
  const activeClipRef = useRef(-1);
  const exportAbortRef = useRef<AbortController | null>(null);
  const narrationAbortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<MixResult | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalize | null>(null);
  const sourcesRef = useRef<MixSource[]>([]);
  const preparingRef = useRef(false);
  const activeReservationRef = useRef<string | null>(null);
  const activeReservationBucketRef = useRef<BillingBucket | null>(null);
  const reservationKeyRef = useRef<string | null>(null);
  const narrationRef = useRef<MixNarration | null>(null);
  const mountedRef = useRef(true);

  const [sources, setSources] = useState<MixSource[]>([]);
  const [transition, setTransition] = useState<VideoCompositionTransitionType>("crossfade");
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [narrationCaptionsEnabled, setNarrationCaptionsEnabled] = useState(true);
  const [narrationStyle, setNarrationStyle] = useState<NarrationStyle>("bright");
  const [narrationGoal, setNarrationGoal] = useState<CaptionGoal>("follow");
  const [narrationBrief, setNarrationBrief] = useState("");
  const [narration, setNarration] = useState<MixNarration | null>(null);
  const [narrationGenerating, setNarrationGenerating] = useState(false);
  const [aiOperationLimit, setAiOperationLimit] = useState(DEFAULT_AI_OPERATION_LIMIT);
  const [aiOperationsRemaining, setAiOperationsRemaining] = useState(DEFAULT_AI_OPERATION_LIMIT);
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [result, setResult] = useState<MixResult | null>(null);
  const [pendingFinalize, setPendingFinalize] = useState<PendingFinalize | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPurchase, setShowPurchase] = useState(false);

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
        }),
        error: "",
      };
    } catch (caught) {
      return { plan: null, error: getCompositionErrorMessage(caught) };
    }
  }, [sources, transition]);
  const plan = planResult.plan;
  const schedule = useMemo(() => plan ? buildVideoCompositionFrameSchedule(plan) : [], [plan]);
  const totalBytes = sources.reduce((sum, source) => sum + source.file.size, 0);
  const aggregateDuration = sources.reduce((sum, source) => sum + source.duration, 0);
  const editingLocked =
    preparing || exporting || narrationGenerating || Boolean(pendingFinalize);

  const stopPreview = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    for (const video of [previewPrimaryRef.current, previewSecondaryRef.current]) {
      video?.pause();
      if (video) video.muted = true;
    }
    narrationAudioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const clearResult = useCallback(() => {
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      resultRef.current = null;
      return null;
    });
    setMessage("");
    setShowPurchase(false);
  }, []);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    pendingFinalizeRef.current = pendingFinalize;
  }, [pendingFinalize]);

  useEffect(() => {
    narrationRef.current = narration;
  }, [narration]);

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  const releaseActiveReservationBestEffort = useCallback(() => {
    const reservationId = activeReservationRef.current;
    if (!reservationId) return;
    activeReservationRef.current = null;
    activeReservationBucketRef.current = null;
    if (!sendMixUsageReleaseBeacon(reservationId)) {
      void updateUsage("release", reservationId).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const primaryVideo = previewPrimaryRef.current;
    const secondaryVideo = previewSecondaryRef.current;
    const narrationAudio = narrationAudioRef.current;
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) releaseActiveReservationBestEffort();
    };
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", releaseOnPageHide);
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      primaryVideo?.pause();
      secondaryVideo?.pause();
      narrationAudio?.pause();
      exportAbortRef.current?.abort();
      narrationAbortRef.current?.abort();
      releaseActiveReservationBestEffort();
      sourcesRef.current.forEach((source) => URL.revokeObjectURL(source.url));
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      if (
        pendingFinalizeRef.current &&
        pendingFinalizeRef.current.result.url !== resultRef.current?.url
      ) {
        URL.revokeObjectURL(pendingFinalizeRef.current.result.url);
      }
      if (narrationRef.current) URL.revokeObjectURL(narrationRef.current.url);
    };
  }, [releaseActiveReservationBestEffort]);

  const rememberAiQuota = useCallback(
    (limit: number | null, remaining: number | null) => {
      if (limit !== null) setAiOperationLimit(limit);
      if (remaining !== null) setAiOperationsRemaining(remaining);
    },
    [],
  );

  const ensureMixUsageReservation = useCallback(async () => {
    if (activeReservationRef.current) {
      return {
        reservationId: activeReservationRef.current,
        bucket: activeReservationBucketRef.current,
        aiOperationLimit,
        aiOperationsRemaining,
      } satisfies UsageReservation;
    }
    const idempotencyKey = reservationKeyRef.current ?? crypto.randomUUID();
    reservationKeyRef.current = idempotencyKey;
    const reservation = await reserveMixUsage(aggregateDuration, idempotencyKey);
    activeReservationRef.current = reservation.reservationId;
    activeReservationBucketRef.current = reservation.bucket;
    rememberAiQuota(
      reservation.aiOperationLimit,
      reservation.aiOperationsRemaining,
    );
    if (!reservation.reservationId) reservationKeyRef.current = null;
    return reservation;
  }, [aggregateDuration, aiOperationLimit, aiOperationsRemaining, rememberAiQuota]);

  const clearNarrationDraft = useCallback(
    (releaseReservation = true) => {
      narrationAudioRef.current?.pause();
      setNarration((current) => {
        if (current) URL.revokeObjectURL(current.url);
        narrationRef.current = null;
        return null;
      });
      setDisclosureConfirmed(false);
      const canvas = previewCaptionRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      if (releaseReservation) {
        releaseActiveReservationBestEffort();
        reservationKeyRef.current = null;
      }
    },
    [releaseActiveReservationBestEffort],
  );

  const updateNarrationOverlay = useCallback(
    (time: number) => {
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
        );
      }
    },
    [narration, narrationCaptionsEnabled, narrationEnabled],
  );

  const configurePreviewAt = useCallback((time: number, play: boolean) => {
    if (!plan || sources.length === 0) return;
    const safeTime = Math.max(0, Math.min(plan.duration, time));
    const clip = clipAtTime(plan, safeTime);
    const source = sources[clip.sourceIndex];
    const primary = previewPrimaryRef.current;
    const secondary = previewSecondaryRef.current;
    if (!primary || !secondary || !source) return;
    const current = activeLayerRef.current === 0 ? primary : secondary;
    const inactive = activeLayerRef.current === 0 ? secondary : primary;
    const sourcePreviewGain = narrationEnabled && narration ? 0.14 : 1;
    if (activeClipRef.current !== clip.globalClipIndex || current.dataset.sourceId !== source.id) {
      const incomingIndex: 0 | 1 = activeLayerRef.current === 0 ? 1 : 0;
      const incoming = inactive;
      const outgoing = current;
      const targetTime = Math.min(
        clip.end,
        clip.start + Math.max(0, safeTime - clip.editedStart),
      );
      outgoing.pause();
      outgoing.muted = true;
      outgoing.style.zIndex = "1";
      outgoing.style.opacity = "1";
      outgoing.style.transform = "none";
      outgoing.style.clipPath = "none";
      incoming.pause();
      incoming.src = source.url;
      incoming.dataset.sourceId = source.id;
      incoming.muted = false;
      incoming.volume = sourcePreviewGain;
      incoming.style.zIndex = "2";
      incoming.style.opacity = "0";
      incoming.style.transform = "none";
      incoming.style.clipPath = "none";
      activeLayerRef.current = incomingIndex;
      activeClipRef.current = clip.globalClipIndex;
      const seekAndMaybePlay = () => {
        if (incoming.dataset.sourceId !== source.id) return;
        incoming.currentTime = targetTime;
        if (play) void incoming.play().catch(() => undefined);
      };
      if (incoming.readyState >= HTMLMediaElement.HAVE_METADATA) {
        seekAndMaybePlay();
      } else {
        incoming.addEventListener("loadedmetadata", seekAndMaybePlay, { once: true });
        incoming.load();
      }
    } else {
      const targetTime = Math.min(clip.end, clip.start + Math.max(0, safeTime - clip.editedStart));
      current.muted = false;
      current.volume = sourcePreviewGain;
      current.style.zIndex = "2";
      current.style.transform = "none";
      current.style.clipPath = "none";
      if (Math.abs(current.currentTime - targetTime) > 0.3) current.currentTime = targetTime;
      if (play && current.paused) void current.play().catch(() => undefined);
    }
  }, [narration, narrationEnabled, plan, sources]);

  const updatePreviewTransition = useCallback((time: number) => {
    if (!plan || schedule.length === 0) return;
    const frameIndex = Math.min(schedule.length - 1, Math.max(0, Math.floor(time * plan.frameRate)));
    const frame: VideoCompositionFrameScheduleEntry = schedule[frameIndex];
    const transitionFrame = frame?.transition;
    const active = activeLayerRef.current === 0 ? previewPrimaryRef.current : previewSecondaryRef.current;
    const other = activeLayerRef.current === 0 ? previewSecondaryRef.current : previewPrimaryRef.current;
    if (!active || !other) return;
    const sourcePreviewGain = narrationEnabled && narration ? 0.14 : 1;
    if (transitionFrame) {
      const outgoingSource = sources[transitionFrame.from.sourceIndex];
      if (outgoingSource) {
        const seekOutgoingFrame = () => {
          if (other.dataset.sourceId !== outgoingSource.id) return;
          if (Math.abs(other.currentTime - transitionFrame.from.sourceTime) > 0.04) {
            other.currentTime = transitionFrame.from.sourceTime;
          }
        };
        other.pause();
        other.muted = true;
        if (other.dataset.sourceId !== outgoingSource.id) {
          other.src = outgoingSource.url;
          other.dataset.sourceId = outgoingSource.id;
          other.addEventListener("loadedmetadata", seekOutgoingFrame, { once: true });
          other.load();
        } else if (other.readyState >= HTMLMediaElement.HAVE_METADATA) {
          seekOutgoingFrame();
        }
      }
      const visual = transitionFrame.visual;
      active.style.zIndex = "2";
      other.style.zIndex = "1";
      active.style.opacity = String(visual.incomingOpacity);
      other.style.opacity = String(visual.outgoingOpacity);
      active.style.transform = `translateX(${visual.incomingOffsetX * 100}%) scale(${visual.incomingScale})`;
      other.style.transform = `translateX(${visual.outgoingOffsetX * 100}%) scale(${visual.outgoingScale})`;
      active.style.clipPath = visual.incomingReveal < 0.999
        ? `inset(0 0 0 ${(1 - visual.incomingReveal) * 100}%)`
        : "none";
      other.style.clipPath = "none";
      active.muted = false;
      active.volume = sourcePreviewGain;
      other.muted = true;
      setOverlayStyle({
        opacity: visual.overlayOpacity,
        background: visual.overlayColor ?? "transparent",
      });
      return;
    }
    active.style.zIndex = "2";
    other.style.zIndex = "1";
    active.style.opacity = "1";
    other.style.opacity = "0";
    active.style.transform = "none";
    other.style.transform = "none";
    active.style.clipPath = "none";
    other.style.clipPath = "none";
    active.muted = false;
    active.volume = sourcePreviewGain;
    other.muted = true;
    other.pause();
    setOverlayStyle({ opacity: 0, background: "transparent" });
  }, [narration, narrationEnabled, plan, schedule, sources]);

  const startPreview = () => {
    if (!plan || exporting || narrationGenerating) return;
    if (isPlaying) {
      stopPreview();
      return;
    }
    const startAt = previewTime >= plan.duration - 0.04 ? 0 : previewTime;
    setPreviewTime(startAt);
    previewStartTimeRef.current = startAt;
    previewStartedAtRef.current = performance.now();
    configurePreviewAt(startAt, true);
    updatePreviewTransition(startAt);
    updateNarrationOverlay(startAt);
    const narrationPlayer = narrationAudioRef.current;
    if (narrationEnabled && narration && narrationPlayer) {
      narrationPlayer.currentTime = Math.min(startAt, narration.audioDuration);
      narrationPlayer.volume = 1;
      void narrationPlayer.play().catch(() => undefined);
    }
    setIsPlaying(true);
    const tick = (now: number) => {
      const next = previewStartTimeRef.current + (now - previewStartedAtRef.current) / 1000;
      if (!mountedRef.current || next >= plan.duration) {
        setPreviewTime(plan.duration);
        configurePreviewAt(plan.duration - 0.001, false);
        updatePreviewTransition(plan.duration - 0.001);
        updateNarrationOverlay(plan.duration - 0.001);
        stopPreview();
        return;
      }
      setPreviewTime(next);
      configurePreviewAt(next, true);
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
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  };

  const addVideos = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (
      picked.length === 0 ||
      preparingRef.current ||
      exporting ||
      pendingFinalize
    ) return;
    clearNarrationDraft();
    preparingRef.current = true;
    setPreparing(true);
    setError("");
    stopPreview();
    clearResult();
    const availableSlots = VIDEO_COMPOSITION_MAX_SOURCES - sources.length;
    const limited = picked.slice(0, Math.max(0, availableSlots));
    if (availableSlots <= 0) {
      setError("動画は最大5つです。追加済みの動画を削除してから選んでください。");
      preparingRef.current = false;
      setPreparing(false);
      return;
    }
    const existingFingerprints = new Set(sources.map((source) => fileFingerprint(source.file)));
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
        const id = createSourceId(file);
        added.push({
          id,
          file,
          url: URL.createObjectURL(file),
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          clips: [],
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
    const combined = [...sources, ...added].map((source) => ({
      ...source,
      clips: source.clips.length > 0 ? source.clips : [createInitialClip(source.duration)],
    }));
    sourcesRef.current = combined;
    setSources(combined);
    if (picked.length > limited.length) skipped.push(`6本目以降（最大5本）`);
    if (skipped.length > 0) setError(`追加しなかった動画：${skipped.join("、")}`);
    else setMessage(`${added.length}本を追加しました。選んだ順につなぎます。`);
    preparingRef.current = false;
    setPreparing(false);
  };

  const removeSource = (sourceId: string) => {
    if (preparingRef.current || exporting || pendingFinalize) return;
    stopPreview();
    clearResult();
    clearNarrationDraft();
    setSources((current) => {
      const target = current.find((source) => source.id === sourceId);
      if (target) URL.revokeObjectURL(target.url);
      const next = current.filter((source) => source.id !== sourceId);
      sourcesRef.current = next;
      return next;
    });
    activeClipRef.current = -1;
    setPreviewTime(0);
  };

  const setClipCount = (sourceId: string, count: 1 | 2) => {
    if (preparingRef.current || exporting || pendingFinalize) return;
    stopPreview();
    clearResult();
    clearNarrationDraft();
    setSources((current) => current.map((source) => {
      if (source.id !== sourceId) return source;
      if (source.clips.length === count) return source;
      if (count === 1) {
        return { ...source, clips: [{ start: source.clips[0].start, end: source.clips.at(-1)!.end }] };
      }
      if (source.duration < MINIMUM_CLIP_SECONDS * 2) return source;
      return { ...source, clips: splitIntoTwoClips(source.duration, source.clips[0]) };
    }));
  };

  const updateClip = (sourceId: string, clipIndex: number, field: "start" | "end", raw: number) => {
    if (preparingRef.current || exporting || pendingFinalize) return;
    stopPreview();
    clearResult();
    clearNarrationDraft();
    setSources((current) => current.map((source) => {
      if (source.id !== sourceId) return source;
      const clips = source.clips.map((clip) => ({ ...clip }));
      const clip = clips[clipIndex];
      if (!clip) return source;
      if (field === "start") {
        const minimum = clipIndex === 0 ? 0 : clips[clipIndex - 1].end;
        clip.start = Math.max(minimum, Math.min(clip.end - MINIMUM_CLIP_SECONDS, raw));
      } else {
        const maximum = clipIndex === clips.length - 1 ? source.duration : clips[clipIndex + 1].start;
        clip.end = Math.min(maximum, Math.max(clip.start + MINIMUM_CLIP_SECONDS, raw));
      }
      return { ...source, clips };
    }));
  };

  const generateMixNarration = async () => {
    if (
      !plan ||
      !narrationEnabled ||
      narrationGenerating ||
      exporting ||
      pendingFinalize
    ) {
      return;
    }
    if (plan.duration < 1) {
      setError("AIナレーションを入れるには、完成動画を1秒以上にしてください。");
      return;
    }
    stopPreview();
    clearResult();
    setError("");
    setMessage("動画の場面を端末内で選んでいます…");
    setNarrationGenerating(true);
    const controller = new AbortController();
    narrationAbortRef.current = controller;
    try {
      const reservation = await ensureMixUsageReservation();
      const operationId = crypto.randomUUID();
      const frames = (
        await extractVideoMixNarrationFrames(
          sources.map((source) => ({ file: source.file, clips: source.clips })),
          6,
          controller.signal,
        )
      ).filter((frame) => frame.length <= 700_000);
      if (frames.length === 0) {
        throw new Error("AIナレーションに使う場面を読み取れませんでした。");
      }
      setMessage("映像の順番に合わせて台本を作っています…");
      let scriptResult = await requestMixNarrationPlan({
        frames,
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
      );
      if (prepared.decodedDuration > plan.duration + 0.08) {
        const timingScale = Math.max(
          0.55,
          Math.min(0.98, (plan.duration / prepared.decodedDuration) * 0.96),
        );
        setMessage("音声が動画に自然に収まるよう、台本を短く整えています…");
        scriptResult = await requestMixNarrationPlan({
          frames,
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
        );
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
        audioDuration: prepared.audioDuration,
        style: narrationStyle,
      };
      setNarration((current) => {
        if (current) URL.revokeObjectURL(current.url);
        narrationRef.current = next;
        return next;
      });
      setDisclosureConfirmed(false);
      updateNarrationOverlay(0);
      setMessage(
        `AIナレーションとテロップを作成しました。AI処理はあと${speechResult.quota.remaining ?? aiOperationsRemaining}回です。`,
      );
    } catch (caught) {
      releaseActiveReservationBestEffort();
      reservationKeyRef.current = null;
      setShowPurchase(
        caught instanceof VideoMixRequestError && caught.status === 402,
      );
      setError(
        caught instanceof Error
          ? caught.message
          : "AIナレーションを作成できませんでした。",
      );
      setMessage("");
    } finally {
      if (narrationAbortRef.current === controller) {
        narrationAbortRef.current = null;
      }
      setNarrationGenerating(false);
    }
  };

  const finalizeResult = useCallback((next: MixResult) => {
    if (!mountedRef.current) {
      URL.revokeObjectURL(next.url);
      return;
    }
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      resultRef.current = next;
      return next;
    });
    pendingFinalizeRef.current = null;
    setPendingFinalize(null);
    setMessage(`${next.qualityMessage} 保存または共有できます。`);
  }, []);

  const startExport = async () => {
    if (!plan || exporting || pendingFinalize) return;
    if (narrationEnabled && !narration) {
      setError("AIナレーションを作成してから書き出してください。");
      return;
    }
    if (narrationEnabled && !disclosureConfirmed) {
      setError("AIナレーションを使う場合は、投稿時の表示を確認してください。");
      return;
    }
    stopPreview();
    clearResult();
    setError("");
    setMessage("");
    setShowPurchase(false);
    setExporting(true);
    setExportProgress(0);
    const controller = new AbortController();
    exportAbortRef.current = controller;
    let reservationId: string | null = null;
    let preparedResult: MixResult | null = null;
    try {
      // Usage policy is based on the combined source duration, while the
      // resulting file still counts as one completed video.
      const reservation = await ensureMixUsageReservation();
      reservationId = reservation.reservationId;
      if (!canSaveCompletedVideo(reservation.bucket)) {
        if (reservationId) {
          await updateUsage("release", reservationId);
          activeReservationRef.current = null;
          activeReservationBucketRef.current = null;
          reservationKeyRef.current = null;
        }
        setShowPurchase(true);
        setMessage("編集とプレビューは無料です。完成動画を保存するにはプランを選んでください。");
        return;
      }
      if (!reservation.bucket) throw new Error("保存できる利用枠を確認できませんでした。");
      if (narrationEnabled) {
        await recordMixNarrationDisclosure(reservationId);
      }
      let audioMetadata: VideoMixAudioExportMetadata | null = null;
      const blob = await exportVideoMixMp4({
        sources: sources.map((source) => ({ id: source.id, file: source.file, clips: source.clips })),
        transition,
        narrationAudio: narrationEnabled ? narration?.audio : undefined,
        duckSourceAudioDuringNarration: narrationEnabled,
        signal: controller.signal,
        onProgress: setExportProgress,
        onAudioMetadata: (metadata) => {
          audioMetadata = metadata;
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
                );
              }
            : undefined,
      });
      ensureMixExportActive(controller.signal, mountedRef.current);
      if (!audioMetadata) {
        throw new Error("完成動画の音声構成を確認できませんでした。もう一度書き出してください。");
      }
      const qualityMessage = await inspectMixOutput(
        blob,
        plan,
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
        const stagedPending = { result: preparedResult, reservationId };
        pendingFinalizeRef.current = stagedPending;
        try {
          ensureMixExportActive(controller.signal, mountedRef.current);
          // Encoding and fail-closed inspection are complete. From this point,
          // let the atomic completion request settle without racing pagehide's
          // best-effort release.
          activeReservationRef.current = null;
          activeReservationBucketRef.current = null;
          await updateUsage("complete", reservationId);
        } catch (caught) {
          if (controller.signal.aborted || !mountedRef.current) throw caught;
          activeReservationRef.current = reservationId;
          activeReservationBucketRef.current = reservation.bucket;
          setPendingFinalize(stagedPending);
          setError("動画は完成しましたが、利用記録を確認できませんでした。通信を確認して再試行してください。");
          return;
        }
      }
      reservationKeyRef.current = null;
      finalizeResult(preparedResult);
    } catch (caught) {
      if (pendingFinalizeRef.current?.result === preparedResult) {
        pendingFinalizeRef.current = null;
      }
      if (preparedResult) URL.revokeObjectURL(preparedResult.url);
      setShowPurchase(
        caught instanceof VideoMixRequestError && caught.status === 402,
      );
      if (reservationId) {
        try {
          await updateUsage("release", reservationId);
          activeReservationRef.current = null;
          activeReservationBucketRef.current = null;
          reservationKeyRef.current = null;
        } catch {
          setError("書き出しに失敗し、利用枠の戻し処理も確認できませんでした。しばらく待ってからお試しください。");
          return;
        }
      }
      setError(caught instanceof Error ? caught.message : "動画を書き出せませんでした。");
    } finally {
      exportAbortRef.current = null;
      setExporting(false);
    }
  };

  const retryFinalize = async () => {
    if (!pendingFinalize || exporting) return;
    setExporting(true);
    setError("");
    try {
      await updateUsage("complete", pendingFinalize.reservationId);
      activeReservationRef.current = null;
      activeReservationBucketRef.current = null;
      reservationKeyRef.current = null;
      finalizeResult(pendingFinalize.result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "利用記録を確認できませんでした。");
    } finally {
      setExporting(false);
    }
  };

  const discardPending = async () => {
    if (!pendingFinalize || exporting) return;
    setExporting(true);
    try {
      await updateUsage("release", pendingFinalize.reservationId);
      activeReservationRef.current = null;
      activeReservationBucketRef.current = null;
      URL.revokeObjectURL(pendingFinalize.result.url);
      pendingFinalizeRef.current = null;
      setPendingFinalize(null);
      reservationKeyRef.current = null;
      setMessage("完成データを破棄し、編集へ戻りました。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "利用枠を戻せませんでした。");
    } finally {
      setExporting(false);
    }
  };

  const saveResult = async () => {
    if (!result) return;
    const file = new File([result.blob], result.filename, { type: "video/mp4" });
    const shareData: ShareData = { files: [file], title: "撮るだけリールでつないだ動画" };
    try {
      if (typeof navigator.share === "function" && (!navigator.canShare || navigator.canShare(shareData))) {
        await navigator.share(shareData);
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

  return (
    <main className="videoMixShell">
      <header className="videoMixHeader">
        <Link href="/" className="videoMixBrand">撮るだけリール</Link>
        <div>
          <span>VIDEO MIX</span>
          <strong>複数動画をつなぐ</strong>
        </div>
        <Link href="/account">アカウント</Link>
      </header>

      <section className="videoMixHero">
        <div>
          <p className="videoMixEyebrow">最大5つの動画から、流れのある1本へ</p>
          <h1>順番を守って、<br /><em>いい場面だけをつなぐ。</em></h1>
          <p>各動画から1〜2カットを選び、素材を選んだ順につなぎます。途中で前の動画へ戻る編集や、逆再生は行いません。つないだ後は、AIナレーションと発話に合うテロップも追加できます。</p>
        </div>
        <aside>
          <strong>つなぎ方の変更は追加料金なし</strong>
          <span>カット範囲と8種類の場面転換は端末内で処理。AI音声を作る場合だけ、AI処理を1回使用します。</span>
          <small>保存時は完成動画1本分の利用枠を使用</small>
        </aside>
      </section>

      <section className="videoMixWorkspace" aria-label="複数動画の編集">
        <div className="videoMixPreviewPanel">
          <div className="videoMixPreviewHeading">
            <span>仕上がりプレビュー</span>
            <small>{plan ? `${sources.length}動画・${plan.clips.length}カット・${plan.duration.toFixed(1)}秒` : "9:16"}</small>
          </div>
          <div className="videoMixPhone">
            {sources.length > 0 ? (
              <>
                <video ref={previewPrimaryRef} muted={false} playsInline preload="metadata" />
                <video ref={previewSecondaryRef} muted={false} playsInline preload="metadata" />
                <span className="videoMixTransitionOverlay" style={overlayStyle} />
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
            <button type="button" onClick={startPreview} disabled={!plan || exporting || narrationGenerating} aria-label={isPlaying ? "プレビューを停止" : "プレビューを再生"}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <input
              type="range"
              min={0}
              max={plan?.duration ?? 1}
              step={0.03}
              value={Math.min(previewTime, plan?.duration ?? 0)}
              disabled={!plan || exporting || narrationGenerating}
              aria-label="プレビューの再生位置"
              onChange={(event) => {
                stopPreview();
                const next = Number(event.target.value);
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
          <div className="videoMixFacts">
            <span><strong>1080 × 1920</strong>完成動画</span>
            <span><strong>素材順を固定</strong>前後・逆再生なし</span>
          </div>
          <p className="videoMixPreviewNote">プレビューでは映像・つなぎ目・AI音声・テロップを確認できます。素材ごとの最終的な音量調整は書き出し時に反映します。</p>
        </div>

        <div className="videoMixControls">
          <section className="videoMixSection">
            <div className="videoMixSectionTitle">
              <span>01</span>
              <div><h2>動画を選ぶ</h2><p>選んだ順が、そのまま完成動画の順番です。</p></div>
              <strong>{sources.length} / {VIDEO_COMPOSITION_MAX_SOURCES}</strong>
            </div>
            <input
              ref={inputRef}
              className="visuallyHidden"
              type="file"
              multiple
              accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
              disabled={editingLocked || sources.length >= VIDEO_COMPOSITION_MAX_SOURCES}
              onChange={addVideos}
            />
            <button className="videoMixAddButton" type="button" onClick={() => inputRef.current?.click()} disabled={editingLocked || sources.length >= VIDEO_COMPOSITION_MAX_SOURCES}>
              <span aria-hidden="true">＋</span>
              <span><strong>{sources.length === 0 ? "動画を選ぶ" : "動画を追加する"}</strong><small>最大5本・合計500MB・合計5分まで</small></span>
            </button>
            {preparing ? <p className="videoMixPreparing" aria-live="polite">動画の長さと向きを端末内で確認しています…</p> : null}
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
                      <video src={source.url} muted playsInline preload="metadata" aria-label={`${sourceIndex + 1}番目の素材 ${source.file.name}`} />
                      <div>
                        <strong>{source.file.name}</strong>
                        <small>{source.width}×{source.height}・{formatSeconds(source.duration)}・{formatBytes(source.file.size)}</small>
                        <em>{source.clips.length}カット・時間順</em>
                      </div>
                      <button type="button" onClick={() => removeSource(source.id)} disabled={editingLocked} aria-label={`${sourceIndex + 1}番目の動画 ${source.file.name}を削除`}>削除</button>
                    </div>
                    <fieldset className="videoMixClipCount">
                      <legend>この動画から使う場面</legend>
                      <button type="button" className={source.clips.length === 1 ? "isActive" : ""} aria-pressed={source.clips.length === 1} onClick={() => setClipCount(source.id, 1)} disabled={editingLocked}>1カット</button>
                      <button type="button" className={source.clips.length === 2 ? "isActive" : ""} aria-pressed={source.clips.length === 2} onClick={() => setClipCount(source.id, 2)} disabled={editingLocked || source.duration < MINIMUM_CLIP_SECONDS * 2}>2カット</button>
                    </fieldset>
                    <div className="videoMixClipList">
                      {source.clips.map((clip, clipIndex) => (
                        <fieldset key={`${source.id}-${clipIndex}`}>
                          <legend>{clipIndex + 1}つ目のカット <strong>{formatSeconds(clip.start)}〜{formatSeconds(clip.end)}</strong></legend>
                          <label><span>開始</span><input type="range" min={0} max={source.duration} step={0.1} value={clip.start} disabled={editingLocked} onChange={(event) => updateClip(source.id, clipIndex, "start", Number(event.target.value))} /></label>
                          <label><span>終了</span><input type="range" min={0} max={source.duration} step={0.1} value={clip.end} disabled={editingLocked} onChange={(event) => updateClip(source.id, clipIndex, "end", Number(event.target.value))} /></label>
                        </fieldset>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          <section className="videoMixSection">
            <div className="videoMixSectionTitle"><span>02</span><div><h2>つなぎ方を選ぶ</h2><p>何度変えても追加料金やAI処理回数は発生しません。</p></div></div>
            <div className="videoMixTransitionGrid" role="radiogroup" aria-label="動画のつなぎ方">
              {TRANSITION_OPTIONS.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={transition === option.id} className={transition === option.id ? "isActive" : ""} disabled={editingLocked} onClick={() => { if (editingLocked) return; stopPreview(); clearResult(); setTransition(option.id); }}>
                  <span className={`videoMixTransitionIcon ${option.id}`} aria-hidden="true"><i /><i /></span>
                  <strong>{option.label}</strong><small>{option.note}</small>
                  {option.id === "crossfade" ? <em>おすすめ</em> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="videoMixSection videoMixNarrationSection">
            <div className="videoMixSectionTitle">
              <span>03</span>
              <div>
                <h2>声とテロップを選ぶ</h2>
                <p>元音声のまま仕上げるか、映像に合わせたAIナレーションを追加できます。</p>
              </div>
            </div>
            <div className="videoMixFinishMode" role="radiogroup" aria-label="完成動画の音声">
              <button
                type="button"
                role="radio"
                aria-checked={!narrationEnabled}
                className={!narrationEnabled ? "isActive" : ""}
                disabled={editingLocked}
                onClick={() => {
                  if (editingLocked) return;
                  stopPreview();
                  clearResult();
                  setNarrationEnabled(false);
                  const canvas = previewCaptionRef.current;
                  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
                }}
              >
                <strong>元音声のまま</strong>
                <small>選んだ動画の音を自動でそろえてつなぎます</small>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={narrationEnabled}
                className={narrationEnabled ? "isActive" : ""}
                disabled={editingLocked}
                onClick={() => {
                  if (editingLocked) return;
                  stopPreview();
                  clearResult();
                  setNarrationEnabled(true);
                }}
              >
                <strong>AIナレーションを入れる</strong>
                <small>映像の順番を見て台本・声・テロップを自動作成</small>
              </button>
            </div>

            {narrationEnabled ? (
              <div className="videoMixNarrationSettings">
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
                      onClick={() => setNarrationGoal(id)}
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
                    onChange={(event) => setNarrationBrief(event.target.value)}
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
                      onClick={() => setNarrationStyle(style.id)}
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
                <div className="videoMixNarrationAction">
                  <button
                    type="button"
                    onClick={generateMixNarration}
                    disabled={!plan || narrationGenerating || exporting || aiOperationsRemaining <= 0}
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
                    <button
                      type="button"
                      onClick={() => {
                        stopPreview();
                        const player = narrationAudioRef.current;
                        if (!player) return;
                        player.currentTime = 0;
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
            <ul><li>素材は選んだ順、各素材内は時間順を維持</li><li>{narrationEnabled ? "AI音声中は元音声を自動で小さく調整" : "素材ごとの音量差を自動で調整"}</li><li>つなぎ方とテロップ表示の変更は追加料金なし</li><li>有料枠は品質確認済みの書き出し成功時だけ使用</li></ul>
            {planResult.error ? <p className="videoMixError" role="alert">{planResult.error}</p> : null}
            <button type="button" className="videoMixExportButton" onClick={startExport} disabled={!plan || preparing || narrationGenerating || exporting || Boolean(pendingFinalize) || (narrationEnabled && !narration)}>
              {exporting ? `動画を作成中… ${Math.round(exportProgress * 100)}%` : showPurchase ? "購入を確認して書き出す" : "1本の動画として書き出す"}
              <span aria-hidden="true">↓</span>
            </button>
            {exporting ? <><div className="videoMixProgress" aria-live="polite"><span style={{ width: `${Math.max(2, exportProgress * 100)}%` }} /></div><button type="button" className="videoMixCancel" onClick={() => exportAbortRef.current?.abort()}>書き出しを中止</button></> : null}
            {pendingFinalize ? <div className="videoMixFinalize"><button type="button" onClick={retryFinalize}>利用確認を再試行して保存へ進む</button><button type="button" onClick={discardPending}>完成データを破棄して編集へ戻る</button></div> : null}
          </section>

          <div className="videoMixStatus" aria-live="polite">
            {error ? <p className="videoMixError" role="alert">{error}</p> : null}
            {message ? <p className="videoMixMessage">{message}</p> : null}
            {showPurchase ? (
              <div className="videoMixPurchase">
                <strong>完成動画を保存するプランを選択</strong>
                <small>決済後、この画面へ戻って「購入を確認して書き出す」を押してください。</small>
                <div>
                  <Link className="primary" href="/account?checkout=one_time" target="_blank" rel="noreferrer"><span>1回払い・自動更新なし</span><strong>この動画1本を¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}で保存</strong></Link>
                  <Link href="/account?checkout=starter" target="_blank" rel="noreferrer"><span>1か月ごと</span><strong>{STARTER_MONTHLY_PLAN_LABEL} ¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}</strong><small>1か月に動画{STARTER_MONTHLY_VIDEO_LIMIT}本まで</small></Link>
                  <Link href="/account?checkout=standard" target="_blank" rel="noreferrer"><span>1か月ごと</span><strong>{STANDARD_MONTHLY_PLAN_LABEL} ¥{STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}</strong><small>1か月に動画{STANDARD_MONTHLY_VIDEO_LIMIT}本まで</small></Link>
                </div>
              </div>
            ) : null}
          </div>

          {result ? (
            <section className="videoMixResult" aria-label="完成動画">
              <div><span>完成</span><strong>{result.qualityMessage}</strong></div>
              <video src={result.url} controls playsInline preload="metadata" />
              <button type="button" onClick={saveResult}>完成動画を保存・共有</button>
            </section>
          ) : null}
        </div>
      </section>

      <footer className="videoMixFooter"><Link href="/">トップへ戻る</Link><Link href="/privacy">プライバシー</Link><Link href="/terms">利用規約</Link></footer>
    </main>
  );
}
