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
};

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
];

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
  if (!payload.required) return { reservationId: null, bucket: null };
  if (!payload.reservationId || !isBillingBucket(payload.bucket)) {
    throw new Error("利用枠を確認できませんでした。");
  }
  return { reservationId: payload.reservationId, bucket: payload.bucket };
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
  const inspection = await inspectExportedVideoQuality(blob, {
    packetSampleCount: 360,
    inspectAudioActivity: audioMetadata.inspectAudioActivity,
  });
  const assessment = assessExportedVideoQuality(inspection, { width: 1080, height: 1920 }, {
    expectedDurationSeconds: plan.duration,
    durationToleranceSeconds: 0.16,
    requireH264: true,
    requireAudio: audioMetadata.requireAudio,
    requireCompatibleAudio: audioMetadata.requireAudio,
    // A source may intentionally contain a silent encoded track. Require the
    // track, duration and compatible codec without rejecting that valid case.
    minimumAudibleRms: 0,
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
  const animationRef = useRef<number | null>(null);
  const previewStartedAtRef = useRef(0);
  const previewStartTimeRef = useRef(0);
  const activeLayerRef = useRef<0 | 1>(0);
  const activeClipRef = useRef(-1);
  const exportAbortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<MixResult | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalize | null>(null);
  const sourcesRef = useRef<MixSource[]>([]);
  const preparingRef = useRef(false);
  const activeReservationRef = useRef<string | null>(null);
  const reservationKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const [sources, setSources] = useState<MixSource[]>([]);
  const [transition, setTransition] = useState<VideoCompositionTransitionType>("crossfade");
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
  const editingLocked = preparing || exporting || Boolean(pendingFinalize);

  const stopPreview = useCallback(() => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    for (const video of [previewPrimaryRef.current, previewSecondaryRef.current]) {
      video?.pause();
      if (video) video.muted = true;
    }
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
    sourcesRef.current = sources;
  }, [sources]);

  const releaseActiveReservationBestEffort = useCallback(() => {
    const reservationId = activeReservationRef.current;
    if (!reservationId) return;
    activeReservationRef.current = null;
    if (!sendMixUsageReleaseBeacon(reservationId)) {
      void updateUsage("release", reservationId).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const primaryVideo = previewPrimaryRef.current;
    const secondaryVideo = previewSecondaryRef.current;
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
      exportAbortRef.current?.abort();
      releaseActiveReservationBestEffort();
      sourcesRef.current.forEach((source) => URL.revokeObjectURL(source.url));
      if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
      if (
        pendingFinalizeRef.current &&
        pendingFinalizeRef.current.result.url !== resultRef.current?.url
      ) {
        URL.revokeObjectURL(pendingFinalizeRef.current.result.url);
      }
    };
  }, [releaseActiveReservationBestEffort]);

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
      incoming.pause();
      incoming.src = source.url;
      incoming.dataset.sourceId = source.id;
      incoming.muted = false;
      incoming.volume = 1;
      incoming.style.zIndex = "2";
      incoming.style.opacity = "0";
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
      current.volume = 1;
      current.style.zIndex = "2";
      if (Math.abs(current.currentTime - targetTime) > 0.3) current.currentTime = targetTime;
      if (play && current.paused) void current.play().catch(() => undefined);
    }
  }, [plan, sources]);

  const updatePreviewTransition = useCallback((time: number) => {
    if (!plan || schedule.length === 0) return;
    const frameIndex = Math.min(schedule.length - 1, Math.max(0, Math.floor(time * plan.frameRate)));
    const frame: VideoCompositionFrameScheduleEntry = schedule[frameIndex];
    const transitionFrame = frame?.transition;
    const active = activeLayerRef.current === 0 ? previewPrimaryRef.current : previewSecondaryRef.current;
    const other = activeLayerRef.current === 0 ? previewSecondaryRef.current : previewPrimaryRef.current;
    if (!active || !other) return;
    if (transitionFrame?.type === "crossfade") {
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
      active.style.zIndex = "2";
      other.style.zIndex = "1";
      active.style.opacity = String(transitionFrame.progress);
      other.style.opacity = "1";
      active.muted = false;
      other.muted = true;
      setOverlayStyle({ opacity: 0 });
      return;
    }
    active.style.zIndex = "2";
    other.style.zIndex = "1";
    active.style.opacity = "1";
    other.style.opacity = "0";
    active.muted = false;
    other.muted = true;
    other.pause();
    if (transitionFrame?.type === "fade-black" || transitionFrame?.type === "fade-white") {
      const opacity = transitionFrame.phase === "fade-out"
        ? transitionFrame.progress
        : 1 - transitionFrame.progress;
      setOverlayStyle({
        opacity,
        background: transitionFrame.type === "fade-white" ? "#fff" : "#000",
      });
    } else {
      setOverlayStyle({ opacity: 0 });
    }
  }, [plan, schedule, sources]);

  const startPreview = () => {
    if (!plan || exporting) return;
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
    setIsPlaying(true);
    const tick = (now: number) => {
      const next = previewStartTimeRef.current + (now - previewStartedAtRef.current) / 1000;
      if (!mountedRef.current || next >= plan.duration) {
        setPreviewTime(plan.duration);
        configurePreviewAt(plan.duration - 0.001, false);
        updatePreviewTransition(plan.duration - 0.001);
        stopPreview();
        return;
      }
      setPreviewTime(next);
      configurePreviewAt(next, true);
      updatePreviewTransition(next);
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
      const idempotencyKey = reservationKeyRef.current ?? crypto.randomUUID();
      reservationKeyRef.current = idempotencyKey;
      // Usage policy is based on the combined source duration, while the
      // resulting file still counts as one completed video.
      const reservation = await reserveMixUsage(aggregateDuration, idempotencyKey);
      reservationId = reservation.reservationId;
      activeReservationRef.current = reservationId;
      if (!reservationId) reservationKeyRef.current = null;
      if (!canSaveCompletedVideo(reservation.bucket)) {
        if (reservationId) {
          await updateUsage("release", reservationId);
          activeReservationRef.current = null;
          reservationKeyRef.current = null;
        }
        setShowPurchase(true);
        setMessage("編集とプレビューは無料です。完成動画を保存するにはプランを選んでください。");
        return;
      }
      if (!reservation.bucket) throw new Error("保存できる利用枠を確認できませんでした。");
      let audioMetadata: VideoMixAudioExportMetadata | null = null;
      const blob = await exportVideoMixMp4({
        sources: sources.map((source) => ({ id: source.id, file: source.file, clips: source.clips })),
        transition,
        signal: controller.signal,
        onProgress: setExportProgress,
        onAudioMetadata: (metadata) => {
          audioMetadata = metadata;
        },
      });
      ensureMixExportActive(controller.signal, mountedRef.current);
      if (!audioMetadata) {
        throw new Error("完成動画の音声構成を確認できませんでした。もう一度書き出してください。");
      }
      const qualityMessage = await inspectMixOutput(blob, plan, audioMetadata);
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
          await updateUsage("complete", reservationId);
        } catch (caught) {
          if (controller.signal.aborted || !mountedRef.current) throw caught;
          activeReservationRef.current = reservationId;
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
          <p>各動画から1〜2カットを選び、素材を選んだ順につなぎます。途中で前の動画へ戻る編集や、逆再生は行いません。</p>
        </div>
        <aside>
          <strong>追加のAI料金なし</strong>
          <span>カット範囲とフェード変更は、すべて端末内で処理します。</span>
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
            <button type="button" onClick={startPreview} disabled={!plan || exporting} aria-label={isPlaying ? "プレビューを停止" : "プレビューを再生"}>{isPlaying ? "Ⅱ" : "▶"}</button>
            <input
              type="range"
              min={0}
              max={plan?.duration ?? 1}
              step={0.03}
              value={Math.min(previewTime, plan?.duration ?? 0)}
              disabled={!plan || exporting}
              aria-label="プレビューの再生位置"
              onChange={(event) => {
                stopPreview();
                const next = Number(event.target.value);
                setPreviewTime(next);
                configurePreviewAt(next, false);
                updatePreviewTransition(next);
              }}
            />
            <span>{formatSeconds(previewTime)} / {formatSeconds(plan?.duration ?? 0)}</span>
          </div>
          <div className="videoMixFacts">
            <span><strong>1080 × 1920</strong>完成動画</span>
            <span><strong>素材順を固定</strong>前後・逆再生なし</span>
          </div>
          <p className="videoMixPreviewNote">プレビューは映像・順番・フェードの確認用です。素材ごとの音量調整は書き出し時に反映します。</p>
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

          <section className="videoMixExportCard">
            <div><span aria-hidden="true">MP4</span><p><strong>高画質で1本に書き出す</strong><small>1080×1920・完成動画1本分</small></p></div>
            <ul><li>素材は選んだ順、各素材内は時間順を維持</li><li>素材ごとの音量差を自動で調整</li><li>プレビュー中の変更は追加料金なし</li><li>有料枠は品質確認済みの書き出し成功時だけ使用</li></ul>
            {planResult.error ? <p className="videoMixError" role="alert">{planResult.error}</p> : null}
            <button type="button" className="videoMixExportButton" onClick={startExport} disabled={!plan || preparing || exporting || Boolean(pendingFinalize)}>
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
