"use client";

import Link from "next/link";
import AuthenticationGate from "./authentication-gate";
import {
  MONTHLY_FIRST_OFFER_VERSION,
  MonthlyFirstPurchaseOptions,
  OneTimeRescue,
} from "./monthly-first-purchase";
import SiteFooter from "./site-footer";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  captionsToSrt,
  captionsToVtt,
  formatCaptionClock,
  getCaptionDisplayRange,
  selectCaptionHighlight,
  type CaptionSegment,
} from "../lib/captions";
import {
  buildSpokenEditRanges,
  createNaturalEdit,
  editedTimeToSourceTime,
  explainCaptionCut,
  getEditedDuration,
  isIncludedCaption,
  remapCaptionsToEditedTimeline,
  setCaptionCut,
  sourceTimeToEditedTime,
  summarizeAutomaticSilenceCuts,
  type SpokenCutMode,
  type EditPlanVisualEvidence,
} from "../lib/edit-plan";
import { buildPostingReadinessChecklist } from "../lib/posting-readiness";
import {
  DEFAULT_PERSONAL_EDIT_RECIPE,
  PERSONAL_EDIT_PREFERENCE_LIMITS,
  dictionaryMatchKey,
  normalizePersonalEditRecipe,
  normalizePronunciationDictionary,
  type PersonalEditRecipe,
  type PronunciationDictionaryEntry,
} from "../lib/personal-edit-preferences";
import {
  buildPreviewRanges,
  decideNarrationPreviewAction,
  resolveEditedPreviewPosition,
} from "../lib/preview-sync";
import {
  encodeMonoWavChunk,
  TRANSCRIPTION_AUDIO_CHUNK_SECONDS,
} from "../lib/audio";
import {
  CAPTION_ACCENT_PRESETS,
  CAPTION_MOODS,
  DEFAULT_CAPTION_PROFILE,
  getCaptionEntranceProgress,
  getCaptionPresentation,
  normalizeCaptionProfile,
  resolveCaptionDesign,
  wrapCaptionLines,
  type CaptionGoal,
  type CaptionProfile,
} from "../lib/caption-design";
import {
  canSaveCompletedVideo,
  FREE_AI_OPERATION_SUCCESS_LIMIT,
  isBillingBucket,
  monthlyVideoAllowanceLabel,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  ONE_TIME_PLAN_LABEL,
  ONE_TIME_PRICE_JPY,
  OPERATOR_AI_OPERATION_SUCCESS_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
  STANDARD_MONTHLY_PRICE_JPY,
  STANDARD_MONTHLY_PLAN_LABEL,
  STANDARD_MONTHLY_VIDEO_LIMIT,
  STARTER_MONTHLY_PRICE_JPY,
  STARTER_MONTHLY_PLAN_LABEL,
  STARTER_MONTHLY_VIDEO_LIMIT,
  type BillingBucket,
} from "../lib/billing-policy";
import { LINE_SHARE_URL } from "../lib/line-share";
import {
  calculateCoverCrop,
  selectThumbnailFrames,
  type ThumbnailCrop,
} from "../lib/thumbnail";
import {
  buildPortableDuckingEnvelope,
  computePortableVideoDimensions,
  computePortableVideoDrawRect,
  detectPortableNarrationActivity,
  getPortableExportMemoryPreflight,
  HIGH_QUALITY_VIDEO_BITRATE,
  measurePortableOriginalAudioProfile,
  type PortableOriginalAudioMeasurement,
  PortableVideoExportAbortedError,
  PORTABLE_AUDIO_CUT_FADE_SECONDS,
  PORTABLE_VIDEO_CROSSFADE_SECONDS,
  remapPortableNarrationActivity,
} from "../lib/portable-video-export";
import { explainVideoExportResolution } from "../lib/video-export-quality";
import { validateVideoInputDuration } from "../lib/video-input-policy";
import { refineCaptionCutsWithLocalSilence } from "../lib/local-silence-analysis";
import {
  calculateSceneDifference,
  createRepresentativeFrameSampleTimes,
  selectRepresentativeVideoFrames,
  type NormalizedFace,
} from "../lib/video-frame-analysis";
import {
  applyNarrationPronunciationGuide,
  attachNarrationPronunciationReadings,
  buildDisclosedPostCaption,
  buildNarrationEditRanges,
  buildNarrationTimeline,
  canonicalizeNarrationPronunciationGuide,
  countNarrationPronunciationOccurrences,
  DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT,
  getNarrationBufferSlice,
  getNarrationMixLevels,
  getNarrationPlaybackRate,
  MAX_NARRATION_ORIGINAL_AUDIO_PERCENT,
  NARRATION_DELIVERY_PRESETS,
  NARRATION_DISCLOSURE_TEXT,
  NARRATION_STYLES,
  NARRATION_TERMS_VERSION,
  splitNarrationScript,
  validateNarrationPronunciationGuide,
  type NarrationDeliveryPreset,
  type NarrationPlan,
  type NarrationOriginalAudioLevel,
  type NarrationStyle,
  type VideoAudioMode,
} from "../lib/narration";
import { VOICE_SAMPLE_SCRIPTS } from "../lib/voice-sample-catalog";
import {
  buildNarrationAudioSpans,
  resolveNarrationAudioBoundaries,
  spliceNarrationAudioSegment,
} from "../lib/narration-audio-edit";
import { attachNarrationCaptionDisplayTiming } from "../lib/narration-alignment";
import {
  assessCaptionReadability,
  fitCaptionDisplayTimelineWithinEditRanges,
  getCaptionSafeArea,
} from "../lib/caption-readability";
import {
  clearLocalEditDraft,
  createVideoDraftFingerprint,
  loadLocalEditDraft,
  matchesVideoDraftFingerprint,
  saveLocalEditDraft,
  type LocalEditDraft,
} from "../lib/client-edit-draft";
import { trackClientEvent } from "../lib/client-analytics";
import {
  MAX_ASR_DICTIONARY_TERMS,
  sanitizeAsrUserDictionary,
} from "../lib/asr-user-dictionary";
import { HomeLanding, VideoEditLanding } from "./landing-router";

type Stage = "start" | "setup" | "processing" | "result";

type BrowserFaceDetector = {
  detect(
    source: CanvasImageSource,
  ): Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
};

type BrowserFaceDetectorConstructor = new (options?: {
  fastMode?: boolean;
  maxDetectedFaces?: number;
}) => BrowserFaceDetector;
type Goal = CaptionGoal;
type PreviewMode = "before" | "after";
type PreviewTransportState =
  | "paused"
  | "loading"
  | "playing"
  | "seeking"
  | "ended";

const PARTIAL_NARRATION_MODEL = "gpt-realtime-2.1-mini";

type CompletedVideoQuality = {
  accepted: boolean;
  meetsTargetResolution: boolean | null;
  userMessage: string;
};

type VideoDimensions = {
  width: number;
  height: number;
};

type ThumbnailFrameChoice = {
  id: string;
  time: number;
  previewDataUrl: string;
  crop: ThumbnailCrop;
  faceCount: number;
  score: number;
  qualityLabel: string;
  qualityScore: number;
  sceneChangeScore: number;
  faceScore: number;
};

type ThumbnailFrameAnalysis = {
  choices: ThumbnailFrameChoice[];
  faceDetectionSupported: boolean;
  detectedFaceCount: number;
};

type TranscriptLine = CaptionSegment;

function analyticsDurationBucket(seconds: number) {
  if (seconds <= 30) return "0_30s";
  if (seconds <= 60) return "31_60s";
  if (seconds <= 90) return "61_90s";
  if (seconds <= 180) return "91_180s";
  return "over_180s";
}

function analyticsVideoFormat(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (["mp4", "mov", "m4v", "webm"].includes(extension ?? "")) {
    return extension as "mp4" | "mov" | "m4v" | "webm";
  }
  return "other";
}

type NarrationPronunciationRow = {
  id: number;
  surface: string;
  reading: string;
};

function buildSavedNarrationPronunciationGuide(
  dictionary: readonly PronunciationDictionaryEntry[],
) {
  const validRows: string[] = [];
  for (const entry of dictionary) {
    if (validRows.length >= 20) break;
    const display = entry.display.replace(/\s+/g, " ").trim();
    const reading = entry.reading.replace(/\s+/g, " ").trim();
    if (!display || !reading || display === reading) continue;
    const row = `${display} → ${reading}`;
    const validation = validateNarrationPronunciationGuide(row);
    const parsed = validation.entries[0];
    if (
      validation.error ||
      validation.entries.length !== 1 ||
      parsed?.surface !== display ||
      parsed.reading !== reading
    ) {
      continue;
    }
    validRows.push(row);
  }
  return canonicalizeNarrationPronunciationGuide(validRows.join("\n"));
}

type ApiPayload = {
  error?: string;
  code?: string;
};

type TranscriptionResult = {
  aiOperationLimit: number | null;
  aiOperationsRemaining: number | null;
  refined: boolean;
  segments: TranscriptLine[];
};

type NarrationSegmentCorrectionResult = {
  audio: Blob;
  originalPreview: Blob;
  correctedPreview: Blob;
  model: string;
  voice: string;
  profile: string;
  baseAudioUrl: string;
  baseAudioRevision: number;
  segmentIndex: number;
  remaining: number;
};

type NarrationSegmentCorrectionCandidate = {
  result: NarrationSegmentCorrectionResult;
  originalPreviewUrl: string;
  correctedPreviewUrl: string;
  deliveryPreset: NarrationDeliveryPreset;
};

type AiOperationQuotaResult = {
  aiOperationLimit: number | null;
  aiOperationsRemaining: number | null;
};

function addCutBoundaryFades(
  envelope: ReadonlyArray<{ time: number; gain: number }>,
  duration: number,
) {
  if (!Number.isFinite(duration) || duration <= 0 || envelope.length === 0) {
    return envelope;
  }
  const fade = Math.min(PORTABLE_AUDIO_CUT_FADE_SECONDS, duration / 2);
  if (fade <= 0) return envelope;
  const gainAt = (time: number) => {
    let gain = envelope[0]?.gain ?? 1;
    for (const point of envelope) {
      if (point.time > time) break;
      gain = point.gain;
    }
    return gain;
  };
  return [
    { time: 0, gain: 0 },
    { time: fade, gain: gainAt(fade) },
    ...envelope.filter(
      (point) => point.time > fade && point.time < duration - fade,
    ),
    { time: Math.max(fade, duration - fade), gain: gainAt(duration - fade) },
    { time: duration, gain: 0 },
  ];
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly aiOperationsRemaining: number | null = null,
    readonly aiOperationLimit: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const DIRECT_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
const MAX_AI_OPERATION_LIMIT = Math.max(
  FREE_AI_OPERATION_SUCCESS_LIMIT,
  SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT,
  ONE_TIME_AI_OPERATION_SUCCESS_LIMIT,
  OPERATOR_AI_OPERATION_SUCCESS_LIMIT,
);
const MAX_EDIT_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_SAFE_BROWSER_AUDIO_DECODE_BYTES = 96 * 1024 * 1024;
const NARRATION_DURATION_TOLERANCE_SECONDS = 0.08;
const SUPPORTED_VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm)$/i;
const UNSUPPORTED_VIDEO_EXTENSION = /\.(avi|mkv|wmv|flv|mts|m2ts)$/i;
function readAiOperationQuota(response: Response): AiOperationQuotaResult {
  const parsedLimit = Number(
    response.headers.get("X-AI-Operation-Limit") ??
      response.headers.get("X-Narration-Generation-Limit"),
  );
  const aiOperationLimit =
    Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(MAX_AI_OPERATION_LIMIT, parsedLimit)
      : null;
  const parsedRemaining = Number(
    response.headers.get("X-AI-Operations-Remaining") ??
      response.headers.get("X-Narration-Generations-Remaining"),
  );
  const aiOperationsRemaining =
    Number.isInteger(parsedRemaining) && parsedRemaining >= 0
      ? Math.min(aiOperationLimit ?? MAX_AI_OPERATION_LIMIT, parsedRemaining)
      : null;

  return { aiOperationLimit, aiOperationsRemaining };
}

function describeAiOperationQuota(
  usageBucket: BillingBucket | null,
  limit: number,
) {
  switch (usageBucket) {
    case "free":
      return `無料体験では、この動画1本につき合計${limit}回まで利用できます。`;
    case "subscription":
      return `月3本・月7本プランでは、この動画1本につき合計${limit}回まで利用できます。`;
    case "one_time":
      return `${ONE_TIME_PLAN_LABEL}では、この動画1本につき合計${limit}回まで利用できます。`;
    case "operator":
      return `運営端末では、この動画1本につき合計${limit}回まで利用できます。`;
    default:
      return "サンプルではAI処理の利用回数を消費しません。";
  }
}

async function inspectCompletedVideoQuality(
  output: Blob,
  sourceDimensions: VideoDimensions,
  expectedDimensions: VideoDimensions,
  validation: {
    expectedDurationSeconds: number;
    requireAudioTrack: boolean;
    requireAudibleAudio: boolean;
    expectedNarrationRanges: ReadonlyArray<{ start: number; end: number }>;
    captionRanges: ReadonlyArray<{ start: number; end: number }>;
    videoContentBoundarySeconds: readonly number[];
  },
): Promise<CompletedVideoQuality> {
  try {
    const {
      assessExportedVideoQuality,
      inspectExportedVideoQuality,
    } = await import("../lib/video-export-quality");
    const inspection = await inspectExportedVideoQuality(output, {
      packetSampleCount: 360,
      inspectAudioActivity: validation.requireAudibleAudio,
      expectedNarrationRanges: validation.expectedNarrationRanges,
      videoContentInspection: {
        boundarySeconds: validation.videoContentBoundarySeconds,
      },
    });
    const assessment = assessExportedVideoQuality(
      inspection,
      expectedDimensions,
      {
        expectedDurationSeconds: validation.expectedDurationSeconds,
        requireAudioTrack: validation.requireAudioTrack,
        requireAudibleAudio: validation.requireAudibleAudio,
        expectedNarrationRanges: validation.expectedNarrationRanges,
        captionRanges: validation.captionRanges,
      },
    );

    const outputDimensions =
      inspection.status === "ok" &&
      inspection.metrics.width !== null &&
      inspection.metrics.height !== null
        ? {
            width: inspection.metrics.width,
            height: inspection.metrics.height,
          }
        : null;
    const resolution = explainVideoExportResolution({
      source: sourceDimensions,
      output: outputDimensions,
      expected: expectedDimensions,
    });
    const resolutionSummary = resolution.outputResolutionLabel
      ? `元動画：${resolution.sourceResolutionLabel ?? "確認できません"} → 完成動画（実測）：${resolution.outputResolutionLabel}。`
      : `元動画：${resolution.sourceResolutionLabel ?? "確認できません"}。完成動画の解像度を確認できませんでした。`;

    if (inspection.status !== "ok") {
      return {
        accepted: false,
        meetsTargetResolution: null,
        userMessage: `${resolutionSummary}${resolution.detail} 完成動画を安全に確認できなかったため、保存できません。もう一度書き出してください。`,
      };
    }

    const blockingIssue = assessment.issues.find(
      (issue) => issue.severity === "error",
    );
    if (blockingIssue) {
      return {
        accepted: false,
        meetsTargetResolution: assessment.meetsTargetResolution,
        userMessage: `${blockingIssue.message} 完成動画は保存せず、もう一度書き出してください。`,
      };
    }

    if (assessment.meetsTargetResolution === false) {
      return {
        accepted: false,
        meetsTargetResolution: false,
        userMessage: `${resolutionSummary}${resolution.detail} SafariまたはiOSを最新版にして、もう一度書き出すと改善する場合があります。`,
      };
    }

    const hasFrameRateWarning = assessment.issues.some(
      (issue) =>
        issue.code === "frame-rate-critical" ||
        issue.code === "frame-rate-below-recommended",
    );
    if (hasFrameRateWarning) {
      return {
        accepted: true,
        meetsTargetResolution: assessment.meetsTargetResolution,
        userMessage: `${resolutionSummary}${resolution.detail} 端末の負荷により動きが滑らかでない可能性があります。画面を開いたまま再度お試しください。`,
      };
    }

    const hasCompatibilityWarning = assessment.issues.some(
      (issue) => issue.code === "codec-compatibility",
    );
    if (hasCompatibilityWarning) {
      return {
        accepted: true,
        meetsTargetResolution: assessment.meetsTargetResolution,
        userMessage: `${resolutionSummary}${resolution.detail} iPhoneで使う場合はSafariから書き出すと、より互換性の高いMP4になります。`,
      };
    }

    return {
      accepted: true,
      meetsTargetResolution: assessment.meetsTargetResolution,
      userMessage: `${resolutionSummary}${resolution.detail} iPhoneでは共有画面から「ビデオを保存」を選べます。`,
    };
  } catch {
    const resolution = explainVideoExportResolution({
      source: sourceDimensions,
      output: null,
      expected: expectedDimensions,
    });
    return {
      accepted: false,
      meetsTargetResolution: null,
      userMessage: `元動画：${resolution.sourceResolutionLabel ?? "確認できません"}。完成動画を安全に確認できなかったため、保存できません。もう一度書き出してください。`,
    };
  }
}

function isSupportedVideoFile(selectedFile: File) {
  if (UNSUPPORTED_VIDEO_EXTENSION.test(selectedFile.name)) return false;
  if (SUPPORTED_VIDEO_EXTENSION.test(selectedFile.name)) return true;
  const contentType = selectedFile.type.toLowerCase();
  return [
    "video/mp4",
    "video/quicktime",
    "video/x-m4v",
    "video/webm",
  ].includes(contentType);
}

function isSilentMediaError(error: unknown) {
  return (
    error instanceof Error &&
    /動画に音声が見つかりません|音声を字幕にできません|声が聞こえる区間/.test(
      error.message,
    )
  );
}

function throwIfProcessingAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("処理を中止しました。", "AbortError");
  }
}

function getAudioContextConstructor() {
  return (
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext
  );
}

async function createRunningNarrationAudioContext() {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    throw new Error("このブラウザはAI音声の書き出しに対応していません。");
  }
  const context = new AudioContextConstructor();
  try {
    if (context.state !== "running") await context.resume();
    if (context.state !== "running") throw new Error();
    const unlockSource = context.createBufferSource();
    unlockSource.buffer = context.createBuffer(1, 1, context.sampleRate);
    unlockSource.connect(context.destination);
    unlockSource.start();
    return context;
  } catch {
    await context.close().catch(() => undefined);
    throw new Error(
      "AI音声の書き出しを開始できませんでした。画面を開いたまま、もう一度お試しください。",
    );
  }
}

function needsBrowserAudioExtraction(selectedFile: File) {
  return (
    selectedFile.size > DIRECT_TRANSCRIPTION_BYTES ||
    selectedFile.type.toLowerCase() === "video/quicktime" ||
    /\.(mov|m4v)$/i.test(selectedFile.name)
  );
}

async function readApiResponse<T extends ApiPayload>(
  response: Response,
  fallbackMessage: string,
) {
  const quota = readAiOperationQuota(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const responseText = (await response.text()).trim();
    throw new ApiRequestError(
      response.status === 413
        ? "動画の送信サイズが上限を超えました。動画を短くするか圧縮してお試しください。"
        : responseText || fallbackMessage,
      response.status,
      quota.aiOperationsRemaining,
      quota.aiOperationLimit,
    );
  }

  let payload: T;
  try {
    payload = (await response.json()) as T;
  } catch {
    throw new Error(fallbackMessage);
  }

  if (!response.ok) {
    throw new ApiRequestError(
      payload.error || fallbackMessage,
      response.status,
      quota.aiOperationsRemaining,
      quota.aiOperationLimit,
      typeof payload.code === "string" ? payload.code : null,
    );
  }
  return payload;
}

function isAuthenticationRequiredError(error: unknown) {
  return (
    error instanceof ApiRequestError &&
    error.status === 401 &&
    error.code === "authentication_required"
  );
}

async function transcribeMediaFile(
  mediaFile: File,
  highAccuracy = false,
  usageReservationId: string | null = null,
  aiOperationId = crypto.randomUUID(),
  signal?: AbortSignal,
  asrDictionary: readonly string[] = [],
): Promise<TranscriptionResult> {
  const formData = new FormData();
  formData.set("file", mediaFile, mediaFile.name);
  if (usageReservationId) {
    formData.set("usageReservationId", usageReservationId);
  }
  formData.set("aiOperationId", aiOperationId);
  if (highAccuracy) {
    formData.set("quality", "high");
  }
  const sanitizedDictionary = sanitizeAsrUserDictionary(asrDictionary);
  if (sanitizedDictionary.length > 0) {
    formData.set("asrDictionary", JSON.stringify(sanitizedDictionary));
  }
  const response = await fetch("/api/transcribe", {
    method: "POST",
    body: formData,
    signal,
  });
  const quota = readAiOperationQuota(response);
  const payload = await readApiResponse<
    ApiPayload & {
      refined?: boolean;
      segments?: TranscriptLine[];
      silent?: boolean;
    }
  >(response, "字幕を生成できませんでした。もう一度お試しください。");

  if (payload.silent) {
    return { ...quota, segments: [], refined: Boolean(payload.refined) };
  }
  if (!payload.segments?.length) {
    throw new Error("字幕を生成できませんでした。もう一度お試しください。");
  }
  return {
    ...quota,
    segments: payload.segments,
    refined: Boolean(payload.refined),
  };
}

async function transcribeLargeVideo(
  selectedFile: File,
  onProgress: (progress: number) => void,
  highAccuracy = false,
  usageReservationId: string | null = null,
  aiOperationId = crypto.randomUUID(),
  signal?: AbortSignal,
  asrDictionary: readonly string[] = [],
): Promise<TranscriptionResult> {
  let extractionDetail = "";
  try {
    onProgress(8);
    const {
      DEFAULT_MAX_AUDIO_CHUNK_BYTES,
      MIN_AUDIO_CHUNK_BYTES,
      extractTranscriptionAudioChunks,
    } = await import("../lib/transcription-media");
    throwIfProcessingAborted(signal);
    let maxChunkBytes = DEFAULT_MAX_AUDIO_CHUNK_BYTES;

    while (maxChunkBytes >= MIN_AUDIO_CHUNK_BYTES) {
      try {
        const mergedSegments: TranscriptLine[] = [];
        let completedChunks = 0;
        let refined = false;
        let latestQuota: AiOperationQuotaResult = {
          aiOperationLimit: null,
          aiOperationsRemaining: null,
        };

        for await (const chunk of extractTranscriptionAudioChunks(
          selectedFile,
          { maxChunkBytes },
        )) {
          throwIfProcessingAborted(signal);
          onProgress(Math.min(84, 14 + completedChunks * 6));
          const chunkResult = await transcribeMediaFile(
            chunk.file,
            highAccuracy,
            usageReservationId,
            aiOperationId,
            signal,
            asrDictionary,
          );
          latestQuota = chunkResult;
          refined ||= chunkResult.refined;

          for (const segment of chunkResult.segments) {
            mergedSegments.push({
              ...segment,
              id: mergedSegments.length + 1,
              start:
                Math.round((segment.start + chunk.startSeconds) * 1000) /
                1000,
              end:
                Math.round((segment.end + chunk.startSeconds) * 1000) /
                1000,
            });
          }
          completedChunks += 1;
          onProgress(Math.min(88, 20 + completedChunks * 6));
        }

        if (mergedSegments.length > 0) {
          return { ...latestQuota, segments: mergedSegments, refined };
        }
        if (completedChunks > 0) {
          return { ...latestQuota, segments: [], refined };
        }
        break;
      } catch (error) {
        if (
          error instanceof ApiRequestError &&
          error.status === 413 &&
          maxChunkBytes > MIN_AUDIO_CHUNK_BYTES
        ) {
          maxChunkBytes = Math.max(
            MIN_AUDIO_CHUNK_BYTES,
            Math.floor(maxChunkBytes / 2),
          );
          onProgress(12);
          continue;
        }
        throw error;
      }
    }
  } catch (transmuxError) {
    if (
      transmuxError instanceof DOMException &&
      transmuxError.name === "AbortError"
    ) {
      throw transmuxError;
    }
    if (transmuxError instanceof ApiRequestError) {
      throw transmuxError;
    }
    extractionDetail =
      transmuxError instanceof Error
        ? transmuxError.message.replace(/\s+/g, " ").slice(0, 160)
        : "音声トラックの解析に失敗しました";
    console.warn(
      "Direct audio extraction failed; falling back to browser decoding.",
      transmuxError,
    );
  }

  if (selectedFile.size > MAX_SAFE_BROWSER_AUDIO_DECODE_BYTES) {
    throw new Error(
      `動画から音声を取り出せませんでした。${
        extractionDetail ? `音声抽出の詳細：${extractionDetail}。` : ""
      }この端末では大容量動画の一括変換を安全に行えません。動画を100MB以下に圧縮するか、PC版Chromeでお試しください。`,
    );
  }

  const AudioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;

  if (!AudioContextConstructor) {
    throw new Error(
      "このブラウザでは動画の音声を処理できません。iPhoneでは最新版のSafariでお試しください。",
    );
  }

  let decodedAudio: AudioBuffer;
  const audioContext = new AudioContextConstructor();
  try {
    throwIfProcessingAborted(signal);
    onProgress(8);
    const sourceBytes = await selectedFile.arrayBuffer();
    throwIfProcessingAborted(signal);
    onProgress(14);
    decodedAudio = await audioContext.decodeAudioData(sourceBytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new Error(
      `動画から音声を取り出せませんでした。音声抽出の詳細：${
        extractionDetail || "ブラウザが動画の音声形式に対応していません"
      }`,
    );
  } finally {
    await audioContext.close().catch(() => undefined);
  }

  if (!Number.isFinite(decodedAudio.duration) || decodedAudio.duration <= 0) {
    throw new Error("動画に音声が見つかりませんでした。");
  }

  const transcriptionDuration = decodedAudio.duration;
  const chunkCount = Math.ceil(
    transcriptionDuration / TRANSCRIPTION_AUDIO_CHUNK_SECONDS,
  );
  const mergedSegments: TranscriptLine[] = [];
  let refined = false;
  let latestQuota: AiOperationQuotaResult = {
    aiOperationLimit: null,
    aiOperationsRemaining: null,
  };
  const baseName =
    selectedFile.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "_") ||
    "video";

  for (let index = 0; index < chunkCount; index += 1) {
    throwIfProcessingAborted(signal);
    const chunkStart = index * TRANSCRIPTION_AUDIO_CHUNK_SECONDS;
    const chunkDuration = Math.min(
      TRANSCRIPTION_AUDIO_CHUNK_SECONDS,
      transcriptionDuration - chunkStart,
    );
    onProgress(18 + Math.round((index / chunkCount) * 68));

    const wavBytes = encodeMonoWavChunk(
      decodedAudio,
      chunkStart,
      chunkDuration,
    );
    const audioFile = new File(
      [wavBytes],
      `${baseName}-audio-${String(index + 1).padStart(2, "0")}.wav`,
      { type: "audio/wav" },
    );
    const chunkResult = await transcribeMediaFile(
      audioFile,
      highAccuracy,
      usageReservationId,
      aiOperationId,
      signal,
      asrDictionary,
    );
    latestQuota = chunkResult;
    refined ||= chunkResult.refined;

    for (const segment of chunkResult.segments) {
      mergedSegments.push({
        ...segment,
        id: mergedSegments.length + 1,
        start: Math.round((segment.start + chunkStart) * 1000) / 1000,
        end: Math.round((segment.end + chunkStart) * 1000) / 1000,
      });
    }
    onProgress(18 + Math.round(((index + 1) / chunkCount) * 70));
  }

  if (mergedSegments.length === 0) {
    throw new Error(
      "音声を字幕にできませんでした。声が聞こえる区間がある動画でお試しください。",
    );
  }
  return { ...latestQuota, segments: mergedSegments, refined };
}

async function getVideoDurationSeconds(selectedFile: File) {
  const objectUrl = URL.createObjectURL(selectedFile);
  const video = document.createElement("video");
  video.preload = "metadata";

  try {
    return await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("動画の長さを確認できませんでした。")),
        10000,
      );
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        const duration = video.duration;
        if (Number.isFinite(duration) && duration > 0) {
          resolve(duration);
        } else {
          reject(new Error("動画の長さを確認できませんでした。"));
        }
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("動画の長さを確認できませんでした。"));
      };
      video.src = objectUrl;
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function extractNarrationFrames(
  selectedFile: File,
  count = 6,
  signal?: AbortSignal,
) {
  const objectUrl = URL.createObjectURL(selectedFile);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    throwIfProcessingAborted(signal);
    const duration = await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("動画の場面を読み取れませんでした。")),
        15_000,
      );
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        if (
          Number.isFinite(video.duration) &&
          video.duration > 0 &&
          video.videoWidth > 0 &&
          video.videoHeight > 0
        ) {
          resolve(video.duration);
        } else {
          reject(new Error("動画の場面を読み取れませんでした。"));
        }
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(
          new Error(
            "動画の場面を読み取れませんでした。MP4またはWebM形式でお試しください。",
          ),
        );
      };
      video.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 540 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("動画の場面を読み取れませんでした。");
    const frameCount = Math.max(3, Math.min(8, count));
    const analysisCanvas = document.createElement("canvas");
    const analysisScale = Math.min(1, 192 / Math.max(canvas.width, canvas.height));
    analysisCanvas.width = Math.max(1, Math.round(canvas.width * analysisScale));
    analysisCanvas.height = Math.max(1, Math.round(canvas.height * analysisScale));
    const analysisContext = analysisCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!analysisContext) {
      throw new Error("動画の代表場面を確認できませんでした。");
    }
    const candidates: Array<{
      time: number;
      image: ImageData;
      value: string;
    }> = [];
    const sampleTimes = createRepresentativeFrameSampleTimes(duration);

    for (const time of sampleTimes) {
      throwIfProcessingAborted(signal);
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("動画の場面の読み取りに時間がかかっています。")),
          8_000,
        );
        video.onseeked = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        video.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("動画の場面を読み取れませんでした。"));
        };
        video.currentTime = time;
      });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      analysisContext.drawImage(
        canvas,
        0,
        0,
        analysisCanvas.width,
        analysisCanvas.height,
      );
      candidates.push({
        time,
        image: analysisContext.getImageData(
          0,
          0,
          analysisCanvas.width,
          analysisCanvas.height,
        ),
        value: canvas.toDataURL("image/jpeg", 0.7),
      });
    }
    const frames = selectRepresentativeVideoFrames(candidates, {
      count: frameCount,
      duration,
    })
      .map((entry) => entry.candidate.value)
      .filter((frame): frame is string => Boolean(frame));
    return { duration, frames };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

function clampFrameCoordinate(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function calculateFaceFocusedCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  faces: readonly NormalizedFace[],
): ThumbnailCrop {
  const centered = calculateCoverCrop(sourceWidth, sourceHeight, 9, 16);
  if (faces.length === 0) return centered;

  const visibleFaces = faces.filter(
    (face) =>
      Number.isFinite(face.x) &&
      Number.isFinite(face.y) &&
      Number.isFinite(face.width) &&
      Number.isFinite(face.height) &&
      face.width > 0 &&
      face.height > 0,
  );
  if (visibleFaces.length === 0) return centered;

  const left = Math.min(...visibleFaces.map((face) => face.x));
  const top = Math.min(...visibleFaces.map((face) => face.y));
  const right = Math.max(
    ...visibleFaces.map((face) => face.x + face.width),
  );
  const bottom = Math.max(
    ...visibleFaces.map((face) => face.y + face.height),
  );
  const faceCenterX = clampFrameCoordinate((left + right) / 2, 0, 1);
  const faceCenterY = clampFrameCoordinate((top + bottom) / 2, 0, 1);

  if (centered.width < sourceWidth) {
    centered.x = clampFrameCoordinate(
      faceCenterX * sourceWidth - centered.width / 2,
      0,
      sourceWidth - centered.width,
    );
  }
  if (centered.height < sourceHeight) {
    // Keep a detected face slightly above center so the cover title has room.
    centered.y = clampFrameCoordinate(
      faceCenterY * sourceHeight - centered.height * 0.4,
      0,
      sourceHeight - centered.height,
    );
  }
  return centered;
}

async function waitForDetachedVideoMetadata(
  video: HTMLVideoElement,
  videoUrl: string,
  signal: AbortSignal,
) {
  throwIfProcessingAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("表紙候補の解析に時間がかかっています。")),
      15_000,
    );
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleLoaded = () => {
      cleanup();
      if (
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      ) {
        resolve();
      } else {
        reject(new Error("動画の場面を読み取れませんでした。"));
      }
    };
    const handleError = () => {
      cleanup();
      reject(new Error("動画の場面を読み取れませんでした。"));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("処理を中止しました。", "AbortError"));
    };
    video.addEventListener("loadedmetadata", handleLoaded, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });
    video.src = videoUrl;
    video.load();
  });
}

async function seekDetachedVideoFrame(
  video: HTMLVideoElement,
  targetTime: number,
  signal: AbortSignal,
) {
  throwIfProcessingAborted(signal);
  const safeTime = Math.min(
    Math.max(0, targetTime),
    Math.max(0, video.duration - 0.04),
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("表紙候補の場面を読み取れませんでした。")),
      8_000,
    );
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("表紙候補の場面を読み取れませんでした。"));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("処理を中止しました。", "AbortError"));
    };
    video.addEventListener("seeked", handleSeeked, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });
    video.currentTime = safeTime;
  });

  const decodedVideo = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: () => void) => number;
  };
  if (!decodedVideo.requestVideoFrameCallback) {
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => resolve()),
      ),
    );
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 1_000);
    decodedVideo.requestVideoFrameCallback?.(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

async function analyzeThumbnailFrameChoices(
  videoUrl: string,
  signal: AbortSignal,
): Promise<ThumbnailFrameAnalysis> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    await waitForDetachedVideoMetadata(video, videoUrl, signal);
    const analysisLongEdge = 192;
    const analysisScale = Math.min(
      1,
      analysisLongEdge / Math.max(video.videoWidth, video.videoHeight),
    );
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = Math.max(
      1,
      Math.round(video.videoWidth * analysisScale),
    );
    analysisCanvas.height = Math.max(
      1,
      Math.round(video.videoHeight * analysisScale),
    );
    const analysisContext = analysisCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!analysisContext) {
      throw new Error("表紙候補を解析できませんでした。");
    }

    const FaceDetectorConstructor = (
      globalThis as typeof globalThis & {
        FaceDetector?: BrowserFaceDetectorConstructor;
      }
    ).FaceDetector;
    let faceDetector: BrowserFaceDetector | null = null;
    if (FaceDetectorConstructor) {
      try {
        faceDetector = new FaceDetectorConstructor({
          fastMode: true,
          maxDetectedFaces: 4,
        });
      } catch {
        faceDetector = null;
      }
    }
    let faceDetectionSupported = Boolean(faceDetector);
    let detectedFaceCount = 0;
    const candidates: Array<{
      id: string;
      time: number;
      image: ImageData;
      metadata?: { faces: NormalizedFace[] };
      value: Omit<
        ThumbnailFrameChoice,
        | "score"
        | "qualityLabel"
        | "qualityScore"
        | "sceneChangeScore"
        | "faceScore"
      >;
    }> = [];

    for (const time of createRepresentativeFrameSampleTimes(video.duration, {
      count: 10,
    })) {
      await seekDetachedVideoFrame(video, time, signal);
      throwIfProcessingAborted(signal);
      analysisContext.drawImage(
        video,
        0,
        0,
        analysisCanvas.width,
        analysisCanvas.height,
      );
      let faces: NormalizedFace[] = [];
      if (faceDetector) {
        try {
          faces = (await faceDetector.detect(analysisCanvas))
            .map(({ boundingBox }) => ({
              x: boundingBox.x / analysisCanvas.width,
              y: boundingBox.y / analysisCanvas.height,
              width: boundingBox.width / analysisCanvas.width,
              height: boundingBox.height / analysisCanvas.height,
              confidence: 1,
            }))
            .filter(
              (face) =>
                face.width > 0 &&
                face.height > 0 &&
                face.x + face.width > 0 &&
                face.y + face.height > 0 &&
                face.x < 1 &&
                face.y < 1,
            );
          detectedFaceCount += faces.length;
        } catch {
          faceDetector = null;
          faceDetectionSupported = false;
          faces = [];
        }
      }

      const crop = calculateFaceFocusedCoverCrop(
        video.videoWidth,
        video.videoHeight,
        faces,
      );
      const previewCanvas = document.createElement("canvas");
      previewCanvas.width = 144;
      previewCanvas.height = 256;
      const previewContext = previewCanvas.getContext("2d");
      if (!previewContext) continue;
      previewContext.drawImage(
        video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        previewCanvas.width,
        previewCanvas.height,
      );
      const id = `frame-${time.toFixed(3)}`;
      candidates.push({
        id,
        time,
        image: analysisContext.getImageData(
          0,
          0,
          analysisCanvas.width,
          analysisCanvas.height,
        ),
        metadata: faces.length > 0 ? { faces } : undefined,
        value: {
          id,
          time,
          previewDataUrl: previewCanvas.toDataURL("image/jpeg", 0.78),
          crop,
          faceCount: faces.length,
        },
      });
    }

    const choices = selectThumbnailFrames(candidates, {
      limit: Math.min(3, candidates.length),
      minSpacingSeconds: Math.min(2.5, video.duration / 8),
    }).flatMap((entry) => {
      const value = entry.candidate.value;
      if (!value) return [];
      const sourceIndex = candidates.findIndex(
        (candidate) => candidate.id === entry.candidate.id,
      );
      const neighboringSceneScores = [
        candidates[sourceIndex - 1],
        candidates[sourceIndex + 1],
      ].flatMap((neighbor) =>
        neighbor
          ? [calculateSceneDifference(entry.candidate.image, neighbor.image)]
          : [],
      );
      return [{
        ...value,
        score: entry.score,
        qualityScore: entry.analysis.qualityScore,
        sceneChangeScore:
          neighboringSceneScores.length > 0
            ? Math.max(...neighboringSceneScores)
            : 0,
        faceScore: entry.analysis.faceScore,
        qualityLabel:
          value.faceCount > 0
            ? "顔と構図が見やすい"
            : entry.analysis.qualityScore >= 0.68
              ? "明るさ・鮮明さが良好"
              : "場面変化と構図から選択",
      }];
    });
    if (choices.length === 0) {
      throw new Error("表紙候補を作成できませんでした。");
    }
    return { choices, faceDetectionSupported, detectedFaceCount };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

async function analyzeVideoForNaturalEdit(
  selectedFile: File,
  signal: AbortSignal,
): Promise<EditPlanVisualEvidence[]> {
  const objectUrl = URL.createObjectURL(selectedFile);
  try {
    const analysis = await analyzeThumbnailFrameChoices(objectUrl, signal);
    return analysis.choices.map((choice) => ({
      time: choice.time,
      qualityScore: choice.qualityScore,
      sceneChangeScore: choice.sceneChangeScore,
      faceScore: choice.faceScore,
    }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return [];
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function requestNarrationPlan({
  frames,
  brief,
  goal,
  length,
  style,
  sourceDuration,
  usageReservationId,
  aiOperationId,
  initialNarration,
  narrationBundleToken,
  timingScale,
  previousScript,
  pronunciationGuide,
  signal,
}: {
  frames: string[];
  brief: string;
  goal: Goal;
  length: number;
  style: NarrationStyle;
  sourceDuration: number;
  usageReservationId: string | null;
  aiOperationId: string;
  initialNarration?: boolean;
  narrationBundleToken?: string;
  timingScale?: number;
  previousScript?: string;
  pronunciationGuide?: string;
  signal?: AbortSignal;
}) {
  const response = await fetch("/api/narration/script", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Usage-Reservation-Id": usageReservationId ?? "",
      "X-AI-Operation-Id": aiOperationId,
    },
    body: JSON.stringify({
      frames,
      brief,
      goal,
      length,
      style,
      sourceDuration,
      usageReservationId,
      aiOperationId,
      initialNarration,
      narrationBundleToken,
      timingScale,
      previousScript,
      pronunciationGuide,
    }),
    signal,
  });
  const quota = readAiOperationQuota(response);
  const plan = await readApiResponse<
    ApiPayload & NarrationPlan & { narrationBundleToken?: string }
  >(
    response,
    "AIナレーションの台本を作成できませんでした。",
  );
  return { ...plan, ...quota };
}

async function reserveVideoUsage(selectedFile: File, signal?: AbortSignal) {
  throwIfProcessingAborted(signal);
  const requestBody = JSON.stringify({
    sourceDurationSeconds: await getVideoDurationSeconds(selectedFile),
    idempotencyKey: crypto.randomUUID(),
  });
  const requestReservation = () =>
    fetch("/api/usage/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal,
    });
  let response = await requestReservation();

  if (response.status === 401) {
    const sessionResponse = await fetch("/api/session/trial", {
      method: "POST",
      signal,
    });
    await readApiResponse<ApiPayload & { ready?: boolean }>(
      sessionResponse,
      "無料体験を開始できませんでした。ページを再読み込みしてお試しください。",
    );
    response = await requestReservation();
  }
  if (response.status === 401) {
    throw new ApiRequestError(
      "無料体験を開始できませんでした。ページを再読み込みしてお試しください。",
      401,
    );
  }
  const payload = await readApiResponse<
    ApiPayload & {
      bucket?: unknown;
      required?: boolean;
      reservationId?: string;
      aiOperationLimit?: number;
      aiOperationsRemaining?: number;
      narrationGenerationLimit?: number;
      narrationGenerationsRemaining?: number;
    }
  >(response, "利用枠を確認できませんでした。");
  const rawAiOperationLimit =
    payload.aiOperationLimit ?? payload.narrationGenerationLimit;
  const aiOperationLimit =
    Number.isInteger(rawAiOperationLimit) && Number(rawAiOperationLimit) > 0
      ? Math.min(MAX_AI_OPERATION_LIMIT, Number(rawAiOperationLimit))
      : MAX_AI_OPERATION_LIMIT;
  const rawAiOperationsRemaining =
    payload.aiOperationsRemaining ?? payload.narrationGenerationsRemaining;
  const aiOperationsRemaining =
    Number.isInteger(rawAiOperationsRemaining) &&
    Number(rawAiOperationsRemaining) >= 0
      ? Math.min(aiOperationLimit, Number(rawAiOperationsRemaining))
      : aiOperationLimit;
  const bucket = payload.required
    ? isBillingBucket(payload.bucket)
      ? payload.bucket
      : null
    : null;
  if (payload.required && !bucket) {
    throw new ApiRequestError("利用枠を確認できませんでした。", 500);
  }
  return {
    reservationId: payload.required ? (payload.reservationId ?? null) : null,
    bucket,
    aiOperationLimit,
    aiOperationsRemaining,
  };
}

async function renewVideoUsage(
  reservationId: string,
  selectedFile: File,
  signal?: AbortSignal,
  options: { resumeReleased?: boolean } = {},
) {
  throwIfProcessingAborted(signal);
  const response = await fetch("/api/usage/renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reservationId,
      sourceDurationSeconds: await getVideoDurationSeconds(selectedFile),
      resumeReleased: options.resumeReleased,
    }),
    signal,
  });
  const payload = await readApiResponse<
    ApiPayload & {
      bucket?: unknown;
      required?: boolean;
      reservationId?: string;
      aiOperationLimit?: number;
      aiOperationsRemaining?: number;
      narrationGenerationLimit?: number;
      narrationGenerationsRemaining?: number;
    }
  >(response, "利用枠の有効期限を更新できませんでした。");
  const rawAiOperationLimit =
    payload.aiOperationLimit ?? payload.narrationGenerationLimit;
  const aiOperationLimit =
    Number.isInteger(rawAiOperationLimit) && Number(rawAiOperationLimit) > 0
      ? Math.min(MAX_AI_OPERATION_LIMIT, Number(rawAiOperationLimit))
      : MAX_AI_OPERATION_LIMIT;
  const rawAiOperationsRemaining =
    payload.aiOperationsRemaining ?? payload.narrationGenerationsRemaining;
  const aiOperationsRemaining =
    Number.isInteger(rawAiOperationsRemaining) &&
    Number(rawAiOperationsRemaining) >= 0
      ? Math.min(aiOperationLimit, Number(rawAiOperationsRemaining))
      : aiOperationLimit;
  const bucket = payload.required
    ? isBillingBucket(payload.bucket)
      ? payload.bucket
      : null
    : null;
  if (
    payload.required &&
    (!bucket ||
      typeof payload.reservationId !== "string" ||
      payload.reservationId !== reservationId)
  ) {
    throw new ApiRequestError("更新した利用枠を確認できませんでした。", 500);
  }
  return {
    reservationId: payload.required ? reservationId : null,
    bucket,
    aiOperationLimit,
    aiOperationsRemaining,
  };
}

async function updateVideoUsage(
  action: "complete" | "release",
  reservationId: string,
) {
  try {
    const response = await fetch(`/api/usage/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sendVideoUsageReleaseBeacon(reservationId: string) {
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

async function releaseVideoUsageBestEffort(reservationId: string) {
  if (await updateVideoUsage("release", reservationId)) return;
  sendVideoUsageReleaseBeacon(reservationId);
}

async function requestNarrationSpeech(
  script: string,
  style: NarrationStyle,
  usageReservationId: string | null,
  targetDurationSeconds: number,
  aiOperationId: string,
  signal?: AbortSignal,
  initialNarration = false,
  narrationBundleToken?: string,
  correction?: {
    deliveryPreset: NarrationDeliveryPreset;
    emphasisText: string;
    expectedDurationSeconds: number;
  },
) {
  const response = await fetch("/api/narration/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script,
      style,
      usageReservationId,
      targetDurationSeconds,
      aiOperationId,
      initialNarration,
      narrationBundleToken,
      partialCorrection: Boolean(correction),
      deliveryPreset: correction?.deliveryPreset,
      emphasisText: correction?.emphasisText,
      expectedDurationSeconds: correction?.expectedDurationSeconds,
    }),
    signal,
  });
  const quota = readAiOperationQuota(response);
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json().catch(() => ({}))) as ApiPayload)
      : {};
    throw new ApiRequestError(
      payload.error || "AI音声を生成できませんでした。もう一度お試しください。",
      response.status,
      quota.aiOperationsRemaining,
      quota.aiOperationLimit,
      typeof payload.code === "string" ? payload.code : null,
    );
  }
  const audio = await response.blob();
  if (!audio.size) throw new Error("AI音声を生成できませんでした。");
  return {
    audio,
    model: response.headers.get("X-Narration-Model") ?? "",
    voice: response.headers.get("X-Narration-Voice") ?? "",
    profile: response.headers.get("X-Narration-Profile") ?? "",
    ...quota,
  };
}

function narrationGenerationKey(
  script: string,
  style: NarrationStyle,
  pronunciationGuide: string,
) {
  const normalizedScript = script.replace(/\s+/g, " ").trim();
  const normalizedGuide =
    canonicalizeNarrationPronunciationGuide(pronunciationGuide);
  return JSON.stringify([normalizedScript, style, normalizedGuide]);
}

async function getNarrationAudioDuration(audio: Blob) {
  const url = URL.createObjectURL(audio);
  const player = document.createElement("audio");
  player.preload = "metadata";

  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        window.clearTimeout(timeout);
        player.onloadedmetadata = null;
        player.ondurationchange = null;
        player.oncanplay = null;
        player.onerror = null;
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("AI音声の長さを確認できませんでした。"));
      };
      const finish = () => {
        if (
          settled ||
          !Number.isFinite(player.duration) ||
          player.duration <= 0
        ) {
          return;
        }
        settled = true;
        cleanup();
        resolve(player.duration);
      };
      const timeout = window.setTimeout(fail, 10_000);
      player.onloadedmetadata = finish;
      player.ondurationchange = finish;
      player.oncanplay = finish;
      player.onerror = fail;
      player.src = url;
      player.load();
    });
  } finally {
    player.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

async function snapNarrationTimelineToAudioSilence(
  audio: Blob,
  segments: NarrationPlan["segments"],
  timeline: TranscriptLine[],
  _sourceDuration: number,
  _autoCut: boolean,
  signal?: AbortSignal,
) {
  if (timeline.length === 0) return timeline;
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) return timeline;
  const context = new AudioContextConstructor();
  try {
    throwIfProcessingAborted(signal);
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    throwIfProcessingAborted(signal);
    const activityRanges = detectPortableNarrationActivity(
      Array.from(
        { length: decoded.numberOfChannels },
        (_, channel) => decoded.getChannelData(channel),
      ),
      decoded.sampleRate,
      decoded.duration,
    );
    if (activityRanges.length > 0) {
      return attachNarrationCaptionDisplayTiming(
        timeline,
        activityRanges,
        { maximumDurationSeconds: decoded.duration },
      );
    }
    const spans = buildNarrationAudioSpans(segments, decoded.duration);
    if (spans.length !== timeline.length) return timeline;
    const detectedSpeechRanges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < timeline.length; index += 1) {
      const line = timeline[index];
      const span = spans[index];
      if (!line || !span) return timeline;
      let boundary;
      try {
        boundary = resolveNarrationAudioBoundaries(
          decoded,
          span.start,
          span.end,
        );
      } catch {
        boundary = {
          originalStart: span.start,
          originalEnd: span.end,
        };
      }
      detectedSpeechRanges.push({
        start: boundary.originalStart,
        end: boundary.originalEnd,
      });
    }
    return attachNarrationCaptionDisplayTiming(
      timeline,
      detectedSpeechRanges,
      { maximumDurationSeconds: decoded.duration },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return timeline;
  } finally {
    await context.close().catch(() => undefined);
  }
}

type VideoUsageReleaseResult = Readonly<{
  released: boolean;
  pending: boolean;
  status: "released" | "release_pending" | "completed" | "not_found";
}>;

async function requestVideoUsageRelease(
  reservationId: string,
): Promise<VideoUsageReleaseResult | null> {
  try {
    const response = await fetch("/api/usage/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId }),
    });
    const payload = (await response.json().catch(() => null)) as
      | Partial<VideoUsageReleaseResult>
      | null;
    if (
      !response.ok ||
      !payload ||
      !["released", "release_pending", "completed", "not_found"].includes(
        payload.status ?? "",
      )
    ) {
      return null;
    }
    return {
      released: payload.released === true,
      pending: payload.pending === true,
      status: payload.status as VideoUsageReleaseResult["status"],
    };
  } catch {
    return null;
  }
}

const goals: { id: Goal; icon: string; title: string; note: string }[] = [
  { id: "follow", icon: "＋", title: "フォローを増やす", note: "結論を先に見せる" },
  { id: "sales", icon: "↗", title: "商品を紹介する", note: "信頼とCTAを重視" },
  { id: "reach", icon: "◎", title: "まず見てもらう", note: "テンポと冒頭を重視" },
];

const initialTranscript: TranscriptLine[] = [
  { id: 1, start: 0, end: 2.2, text: "えー、今日はですね、", removed: true },
  { id: 2, start: 2.2, end: 5.8, text: "続けられる人が最初にやっている", removed: false },
  {
    id: 3,
    start: 5.8,
    end: 9.5,
    text: "たったひとつの習慣を紹介します。",
    removed: false,
    accent: true,
  },
  { id: 4, start: 9.5, end: 12, text: "私も前までは、あの、", removed: true },
  { id: 5, start: 12, end: 15.6, text: "何を始めても三日坊主でした。", removed: false },
  {
    id: 6,
    start: 15.6,
    end: 19.8,
    text: "でも、小さく始めるだけで変わりました。",
    removed: false,
    accent: true,
  },
];

const CAPTION_PROFILE_STORAGE_KEY = "torudake-caption-profile";
const PERSONAL_EDIT_PREFERENCES_STORAGE_KEY =
  "torudake-personal-edit-preferences";
const ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY =
  `${PERSONAL_EDIT_PREFERENCES_STORAGE_KEY}:anonymous`;
const ACCOUNT_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY_PREFIX =
  `${PERSONAL_EDIT_PREFERENCES_STORAGE_KEY}:account:`;
const ACCOUNT_AUTHENTICATED_STORAGE_KEY = "torudake-account-authenticated";
const CAPTION_PROFILE_SAVE_DELAY_MS = 500;
const PERSONAL_EDIT_PREFERENCES_SAVE_DELAY_MS = 650;

type CaptionProfileSyncStatus =
  | "checking"
  | "local-only"
  | "authenticated"
  | "unavailable";

type PersonalEditPreferencesSyncStatus =
  | "checking"
  | "local-only"
  | "authenticated"
  | "unavailable";

type PersonalEditPreferencesPayload = Readonly<{
  recipe: PersonalEditRecipe;
  dictionary: PronunciationDictionaryEntry[];
}>;

function normalizePersonalEditPreferencesPayload(
  value: unknown,
): PersonalEditPreferencesPayload {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  return {
    recipe: normalizePersonalEditRecipe(candidate?.recipe),
    dictionary: normalizePronunciationDictionary(candidate?.dictionary).map(
      ({ display, reading }) => ({ display, reading }),
    ),
  };
}

function defaultPersonalEditPreferences(): PersonalEditPreferencesPayload {
  return {
    recipe: { ...DEFAULT_PERSONAL_EDIT_RECIPE },
    dictionary: [],
  };
}

function readLocalPersonalEditPreferences(
  storageKey: string,
  options: { migrateLegacyAnonymous?: boolean } = {},
) {
  if (typeof window === "undefined") {
    return defaultPersonalEditPreferences();
  }
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      return normalizePersonalEditPreferencesPayload(JSON.parse(saved));
    }
    if (options.migrateLegacyAnonymous) {
      const legacy = window.localStorage.getItem(
        PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
      );
      if (legacy) {
        const preferences = normalizePersonalEditPreferencesPayload(
          JSON.parse(legacy),
        );
        window.localStorage.setItem(storageKey, JSON.stringify(preferences));
        window.localStorage.removeItem(PERSONAL_EDIT_PREFERENCES_STORAGE_KEY);
        return preferences;
      }
    }
    return defaultPersonalEditPreferences();
  } catch {
    return defaultPersonalEditPreferences();
  }
}

function authenticatedPersonalPreferencesStorageKey(value: unknown) {
  const accountStorageId =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).accountStorageId
      : null;
  if (
    typeof accountStorageId !== "string" ||
    !/^[a-zA-Z0-9_-]{43}$/.test(accountStorageId)
  ) {
    throw new Error("Authenticated account identifier is unavailable.");
  }
  return `${ACCOUNT_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY_PREFIX}${accountStorageId}`;
}

function readLocalCaptionProfile() {
  if (typeof window === "undefined") return DEFAULT_CAPTION_PROFILE;
  try {
    const saved = window.localStorage.getItem(CAPTION_PROFILE_STORAGE_KEY);
    return saved
      ? normalizeCaptionProfile(JSON.parse(saved))
      : DEFAULT_CAPTION_PROFILE;
  } catch {
    return DEFAULT_CAPTION_PROFILE;
  }
}

function profilesMatch(left: CaptionProfile, right: CaptionProfile) {
  return (
    left.mood === right.mood &&
    left.accentColor === right.accentColor &&
    left.brandName === right.brandName
  );
}

function removeAccountAuthenticationHint() {
  try {
    window.localStorage.removeItem(ACCOUNT_AUTHENTICATED_STORAGE_KEY);
  } catch {
    // Profile editing remains available even when browser storage is blocked.
  }
}

function useCaptionProfileSync() {
  const [captionProfile, setCaptionProfileState] =
    useState<CaptionProfile>(readLocalCaptionProfile);
  const [syncStatus, setSyncStatus] =
    useState<CaptionProfileSyncStatus>("checking");
  const [hasUserEdited, setHasUserEdited] = useState(false);
  const hasUserEditedRef = useRef(false);
  const syncStartedRef = useRef(false);
  const mountedRef = useRef(true);

  function setCaptionProfile(nextProfile: CaptionProfile) {
    if (profilesMatch(captionProfile, nextProfile)) return;
    hasUserEditedRef.current = true;
    setHasUserEdited(true);
    setCaptionProfileState(nextProfile);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        CAPTION_PROFILE_STORAGE_KEY,
        JSON.stringify(captionProfile),
      );
    } catch {
      // Keep the editor usable in private modes that deny localStorage access.
    }
  }, [captionProfile]);

  useEffect(() => {
    if (syncStartedRef.current) return;
    syncStartedRef.current = true;

    let hasAuthenticationHint = false;
    try {
      hasAuthenticationHint =
        window.localStorage.getItem(ACCOUNT_AUTHENTICATED_STORAGE_KEY) === "1";
    } catch {
      // Without a trusted hint, an anonymous visit must stay local-only.
    }
    if (!hasAuthenticationHint) {
      setSyncStatus("local-only");
      return;
    }

    void fetch("/api/caption-profile", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!mountedRef.current) return;
        if (response.status === 401) {
          removeAccountAuthenticationHint();
          setSyncStatus("local-only");
          return;
        }
        if (!response.ok) {
          setSyncStatus("unavailable");
          return;
        }
        const payload = (await response.json()) as { profile?: unknown };
        if (!mountedRef.current) return;
        if (payload.profile && !hasUserEditedRef.current) {
          setCaptionProfileState(normalizeCaptionProfile(payload.profile));
        }
        setSyncStatus("authenticated");
      })
      .catch(() => {
        if (mountedRef.current) setSyncStatus("unavailable");
      });
  }, []);

  useEffect(() => {
    if (syncStatus !== "authenticated" || !hasUserEdited) return;
    const timeout = window.setTimeout(() => {
      void fetch("/api/caption-profile", {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: captionProfile }),
      })
        .then((response) => {
          if (response.status === 401 && mountedRef.current) {
            removeAccountAuthenticationHint();
            setSyncStatus("local-only");
          }
        })
        .catch(() => undefined);
    }, CAPTION_PROFILE_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [captionProfile, hasUserEdited, syncStatus]);

  return [captionProfile, setCaptionProfile] as const;
}

type HomeProps = {
  landingVariant?: "home" | "video-edit";
};

export default function Home({ landingVariant = "home" }: HomeProps = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const editAbortRef = useRef<AbortController | null>(null);
  const editGenerationRef = useRef(0);
  const usageReservationRef = useRef<string | null>(null);
  const usageReservationPendingExportRef = useRef(false);
  const usageReservationFinalizingRef = useRef(false);
  const narrationRegenerationAbortRef = useRef<AbortController | null>(null);
  const paidAccessCheckRef = useRef(false);
  const paidAccessCheckCallbackRef = useRef<() => Promise<boolean>>(
    async () => false,
  );
  const checkoutReturnPendingRef = useRef(false);
  const aiOperationsRemainingRef = useRef(MAX_AI_OPERATION_LIMIT);
  const aiOperationLimitRef = useRef(MAX_AI_OPERATION_LIMIT);
  const [usageReservationId, setUsageReservationId] = useState<string | null>(
    null,
  );
  const [usageBucket, setUsageBucket] = useState<BillingBucket | null>(null);
  const [usageReservationPendingExport, setUsageReservationPendingExport] =
    useState(false);
  const [isCheckingPaidExportAccess, setIsCheckingPaidExportAccess] =
    useState(false);
  const [stage, setStage] = useState<Stage>("start");
  const [goal, setGoal] = useState<Goal>("follow");
  const [captionProfile, setCaptionProfile] = useCaptionProfileSync();
  const [personalDictionary, setPersonalDictionaryState] = useState<
    PronunciationDictionaryEntry[]
  >([]);
  const [personalPreferencesSyncStatus, setPersonalPreferencesSyncStatus] =
    useState<PersonalEditPreferencesSyncStatus>("checking");
  const [personalPreferencesHydrated, setPersonalPreferencesHydrated] =
    useState(false);
  const [personalPreferencesStorageKey, setPersonalPreferencesStorageKey] =
    useState<string | null>(null);
  const [personalPreferencesEditRevision, setPersonalPreferencesEditRevision] =
    useState(0);
  const personalPreferencesEditedRef = useRef(false);
  const personalPreferencesMountedRef = useRef(true);
  const personalPreferencesSyncStartedRef = useRef(false);
  const preDemoPersonalRecipeRef = useRef<PersonalEditRecipe | null>(null);
  const [length, setLength] = useState(60);
  const [audioMode, setAudioMode] = useState<VideoAudioMode>("spoken");
  const [spokenCaptionsEnabled, setSpokenCaptionsEnabled] = useState(false);
  const [spokenCutMode, setSpokenCutMode] =
    useState<SpokenCutMode>("auto");
  const [asrDictionaryInput, setAsrDictionaryInput] = useState("");
  const asrDictionary = useMemo(
    () =>
      sanitizeAsrUserDictionary(
        [
          ...sanitizeAsrUserDictionary(asrDictionaryInput),
          ...personalDictionary.map((entry) => entry.display),
        ].join("、"),
      ),
    [asrDictionaryInput, personalDictionary],
  );
  const [narrationStyle, setNarrationStyle] =
    useState<NarrationStyle>("calm");
  const [narrationOriginalAudio, setNarrationOriginalAudio] =
    useState<NarrationOriginalAudioLevel>(
      DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT,
    );
  const [narrationBrief, setNarrationBrief] = useState("");
  const [narrationCaptionsEnabled, setNarrationCaptionsEnabled] =
    useState(true);
  const [narrationAutoCutEnabled, setNarrationAutoCutEnabled] =
    useState(false);
  const personalEditRecipe = useMemo(
    () =>
      normalizePersonalEditRecipe({
        version: 1,
        audioMode,
        targetDurationSeconds: length,
        editingPace: "balanced",
        spokenCaptionsEnabled,
        spokenCutMode,
        narrationStyle,
        narrationCaptionsEnabled,
        narrationAutoCutEnabled,
        narrationOriginalAudioPercent: narrationOriginalAudio,
      }),
    [
      audioMode,
      length,
      narrationAutoCutEnabled,
      narrationCaptionsEnabled,
      narrationOriginalAudio,
      narrationStyle,
      spokenCaptionsEnabled,
      spokenCutMode,
    ],
  );
  const [narrationPlan, setNarrationPlan] = useState<NarrationPlan | null>(
    null,
  );
  const [initialNarrationPronunciationGuide, setInitialNarrationPronunciationGuide] =
    useState("");
  const [narrationAudioUrl, setNarrationAudioUrlState] = useState("");
  const narrationAudioUrlRef = useRef("");
  const narrationAudioRevisionRef = useRef(0);
  function setNarrationAudioUrl(nextUrl: string) {
    if (narrationAudioUrlRef.current !== nextUrl) {
      narrationAudioUrlRef.current = nextUrl;
      narrationAudioRevisionRef.current += 1;
    }
    setNarrationAudioUrlState(nextUrl);
  }
  const [narrationAudioModel, setNarrationAudioModel] = useState("");
  const [narrationAudioVoice, setNarrationAudioVoice] = useState("");
  const [narrationAudioProfile, setNarrationAudioProfile] = useState("");
  const [aiOperationsRemaining, setAiOperationsRemaining] = useState(
    MAX_AI_OPERATION_LIMIT,
  );
  const [aiOperationLimit, setAiOperationLimit] = useState(
    MAX_AI_OPERATION_LIMIT,
  );
  const [file, setFile] = useState<File | null>(null);
  const [selectedVideoDuration, setSelectedVideoDuration] = useState(0);
  const [isDemoSample, setIsDemoSample] = useState(false);
  const [isSampleLoading, setIsSampleLoading] = useState(false);
  const videoUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : ""),
    [file],
  );
  const [progress, setProgress] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("after");
  const [transcript, setTranscript] =
    useState<TranscriptLine[]>(initialTranscript);
  const [editError, setEditError] = useState("");
  const [silentFallback, setSilentFallback] = useState(false);
  const [isHighAccuracyRun, setIsHighAccuracyRun] = useState(false);
  const [usedHighAccuracy, setUsedHighAccuracy] = useState(false);
  const [toast, setToast] = useState("");
  const [billingBusyPlan, setBillingBusyPlan] = useState<
    "starter" | "standard" | "one_time" | null
  >(null);
  const [billingError, setBillingError] = useState("");
  const [checkoutReturnMessage, setCheckoutReturnMessage] = useState("");
  const [authenticationGateOpen, setAuthenticationGateOpen] = useState(false);
  const [recoverableDraft, setRecoverableDraft] =
    useState<LocalEditDraft | null>(null);
  const pendingDraftRestoreRef = useRef<LocalEditDraft | null>(null);

  const applyPersonalEditPreferences = useCallback(
    (preferences: PersonalEditPreferencesPayload) => {
      const recipe = normalizePersonalEditRecipe(preferences.recipe);
      setAudioMode(recipe.audioMode);
      setLength(recipe.targetDurationSeconds);
      setSpokenCaptionsEnabled(recipe.spokenCaptionsEnabled);
      setSpokenCutMode(recipe.spokenCutMode);
      setNarrationStyle(recipe.narrationStyle);
      setNarrationCaptionsEnabled(recipe.narrationCaptionsEnabled);
      setNarrationAutoCutEnabled(recipe.narrationAutoCutEnabled);
      setNarrationOriginalAudio(
        recipe.narrationOriginalAudioPercent as NarrationOriginalAudioLevel,
      );
      setPersonalDictionaryState(
        normalizePronunciationDictionary(preferences.dictionary).map(
          ({ display, reading }) => ({ display, reading }),
        ),
      );
    },
    [],
  );

  function markPersonalPreferenceEdited() {
    personalPreferencesEditedRef.current = true;
    setPersonalPreferencesEditRevision((revision) => revision + 1);
  }

  function setPersonalDictionary(entries: PronunciationDictionaryEntry[]) {
    markPersonalPreferenceEdited();
    setPersonalDictionaryState(
      normalizePronunciationDictionary(entries).map(({ display, reading }) => ({
        display,
        reading,
      })),
    );
  }

  function rememberPronunciationEntries(
    entries: PronunciationDictionaryEntry[],
  ) {
    if (entries.length === 0) return;
    markPersonalPreferenceEdited();
    setPersonalDictionaryState((current) =>
      normalizePronunciationDictionary([...entries, ...current]).map(
        ({ display, reading }) => ({ display, reading }),
      ),
    );
  }

  function setPersonalLength(nextLength: number) {
    markPersonalPreferenceEdited();
    setLength(nextLength);
  }

  function setPersonalAudioMode(nextMode: VideoAudioMode) {
    markPersonalPreferenceEdited();
    setAudioMode(nextMode);
  }

  function setPersonalSpokenCaptionsEnabled(enabled: boolean) {
    markPersonalPreferenceEdited();
    setSpokenCaptionsEnabled(enabled);
  }

  function setPersonalSpokenCutMode(nextMode: SpokenCutMode) {
    markPersonalPreferenceEdited();
    setSpokenCutMode(nextMode);
  }

  function setPersonalNarrationStyle(nextStyle: NarrationStyle) {
    markPersonalPreferenceEdited();
    setNarrationStyle(nextStyle);
  }

  function setPersonalNarrationCaptionsEnabled(enabled: boolean) {
    markPersonalPreferenceEdited();
    setNarrationCaptionsEnabled(enabled);
  }

  function setPersonalNarrationAutoCutEnabled(enabled: boolean) {
    markPersonalPreferenceEdited();
    setNarrationAutoCutEnabled(enabled);
  }

  function setPersonalNarrationOriginalAudio(
    percent: NarrationOriginalAudioLevel,
  ) {
    markPersonalPreferenceEdited();
    setNarrationOriginalAudio(percent);
  }

  useEffect(() => {
    personalPreferencesMountedRef.current = true;
    if (personalPreferencesSyncStartedRef.current) {
      return () => {
        personalPreferencesMountedRef.current = false;
      };
    }
    personalPreferencesSyncStartedRef.current = true;

    let hasAuthenticationHint = false;
    try {
      hasAuthenticationHint =
        window.localStorage.getItem(ACCOUNT_AUTHENTICATED_STORAGE_KEY) === "1";
    } catch {
      // Local personalization remains available when storage access is blocked.
    }
    if (!hasAuthenticationHint) {
      const localPreferences = readLocalPersonalEditPreferences(
        ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
        { migrateLegacyAnonymous: true },
      );
      applyPersonalEditPreferences(localPreferences);
      setPersonalPreferencesStorageKey(
        ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
      );
      setPersonalPreferencesHydrated(true);
      setPersonalPreferencesSyncStatus("local-only");
      return () => {
        personalPreferencesMountedRef.current = false;
      };
    }

    void fetch("/api/personal-edit-preferences", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(async (response) => {
        if (!personalPreferencesMountedRef.current) return;
        if (response.status === 401) {
          removeAccountAuthenticationHint();
          const localPreferences = readLocalPersonalEditPreferences(
            ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
            { migrateLegacyAnonymous: true },
          );
          if (!personalPreferencesEditedRef.current) {
            applyPersonalEditPreferences(localPreferences);
          }
          setPersonalPreferencesStorageKey(
            ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
          );
          setPersonalPreferencesHydrated(true);
          setPersonalPreferencesSyncStatus("local-only");
          return;
        }
        if (!response.ok) {
          setPersonalPreferencesHydrated(true);
          setPersonalPreferencesSyncStatus("unavailable");
          return;
        }
        const responsePayload: unknown = await response.json();
        const preferences =
          normalizePersonalEditPreferencesPayload(responsePayload);
        const accountStorageKey =
          authenticatedPersonalPreferencesStorageKey(responsePayload);
        if (!personalPreferencesMountedRef.current) return;
        if (!personalPreferencesEditedRef.current) {
          applyPersonalEditPreferences(preferences);
        }
        setPersonalPreferencesStorageKey(accountStorageKey);
        setPersonalPreferencesHydrated(true);
        setPersonalPreferencesSyncStatus("authenticated");
      })
      .catch(() => {
        if (personalPreferencesMountedRef.current) {
          setPersonalPreferencesStorageKey(null);
          setPersonalPreferencesHydrated(true);
          setPersonalPreferencesSyncStatus("unavailable");
        }
      });

    return () => {
      personalPreferencesMountedRef.current = false;
    };
  }, [applyPersonalEditPreferences]);

  useEffect(() => {
    if (!personalPreferencesHydrated || isDemoSample) return;
    const payload = {
      recipe: personalEditRecipe,
      dictionary: personalDictionary,
    };
    if (personalPreferencesStorageKey) {
      try {
        window.localStorage.setItem(
          personalPreferencesStorageKey,
          JSON.stringify(payload),
        );
      } catch {
        // Settings continue to work for the current page session.
      }
    }
    if (
      personalPreferencesSyncStatus !== "authenticated" ||
      !personalPreferencesEditedRef.current
    ) {
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetch("/api/personal-edit-preferences", {
        method: "PUT",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((response) => {
          if (
            controller.signal.aborted ||
            !personalPreferencesMountedRef.current
          ) {
            return;
          }
          if (response.status === 401 && personalPreferencesMountedRef.current) {
            removeAccountAuthenticationHint();
            personalPreferencesEditedRef.current = false;
            applyPersonalEditPreferences(
              readLocalPersonalEditPreferences(
                ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
                { migrateLegacyAnonymous: true },
              ),
            );
            setPersonalPreferencesStorageKey(
              ANONYMOUS_PERSONAL_EDIT_PREFERENCES_STORAGE_KEY,
            );
            setPersonalPreferencesSyncStatus("local-only");
            return;
          }
          if (!response.ok) {
            setPersonalPreferencesSyncStatus("unavailable");
          }
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          if (personalPreferencesMountedRef.current) {
            setPersonalPreferencesSyncStatus("unavailable");
          }
        });
    }, PERSONAL_EDIT_PREFERENCES_SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    applyPersonalEditPreferences,
    personalDictionary,
    personalEditRecipe,
    personalPreferencesEditRevision,
    personalPreferencesHydrated,
    personalPreferencesStorageKey,
    personalPreferencesSyncStatus,
    isDemoSample,
  ]);

  useEffect(() => {
    let active = true;
    void loadLocalEditDraft().then((draft) => {
      if (!active || !draft) return;
      if (Date.now() - draft.savedAt > 1000 * 60 * 60 * 24 * 7) {
        void clearLocalEditDraft();
        return;
      }
      setRecoverableDraft(draft);
      trackClientEvent("draft_recovery_shown", {
        outcome: draft.resultReady ? "result_settings" : "setup_settings",
      });
    });
    return () => {
      active = false;
    };
  }, []);

  function rememberUsageReservation(
    nextReservationId: string | null,
    nextBucket: BillingBucket | null = null,
    pendingExport = false,
  ) {
    usageReservationRef.current = nextReservationId;
    usageReservationPendingExportRef.current = pendingExport;
    usageReservationFinalizingRef.current = false;
    setUsageReservationId(nextReservationId);
    setUsageBucket(nextBucket);
    setUsageReservationPendingExport(pendingExport);
  }

  async function settleVideoUsageAfterProcessing(
    reservationId: string,
    bucket: BillingBucket | null,
  ) {
    if (usageReservationRef.current !== reservationId) return;

    if (bucket === "free") {
      // A free trial is consumed when its preview is successfully prepared.
      // Paid/operator reservations stay reversible until a verified export.
      await updateVideoUsage("complete", reservationId);
      if (usageReservationRef.current !== reservationId) return;
      usageReservationPendingExportRef.current = false;
      setUsageReservationPendingExport(false);
      return;
    }

    usageReservationPendingExportRef.current = true;
    setUsageReservationPendingExport(true);
  }

  function releasePendingExportReservation() {
    const reservationId = usageReservationRef.current;
    if (
      usageReservationPendingExportRef.current &&
      !usageReservationFinalizingRef.current &&
      reservationId
    ) {
      usageReservationPendingExportRef.current = false;
      setUsageReservationPendingExport(false);
      void releaseVideoUsageBestEffort(reservationId);
    }
  }

  async function cancelPendingExportReservation() {
    const reservationId = usageReservationRef.current;
    if (usageReservationFinalizingRef.current) {
      setCheckoutReturnMessage(
        "完成動画の利用枠を確定しています。確定が終わるまでお待ちください。",
      );
      return;
    }
    if (!usageReservationPendingExportRef.current || !reservationId) return;
    usageReservationPendingExportRef.current = false;
    setUsageReservationPendingExport(false);
    rememberUsageReservation(null);
    setCheckoutReturnMessage(
      "書き出しを中止し、利用枠の返却を確認しています…",
    );
    const release = await requestVideoUsageRelease(reservationId);
    if (release?.released || release?.status === "released") {
      setCheckoutReturnMessage(
        "書き出しを中止し、利用枠を戻しました。再開するときは購入状況を再確認してください。",
      );
      return;
    }
    if (release?.status === "completed") {
      setCheckoutReturnMessage(
        "書き出しの確定が先に完了したため、利用枠は返却されませんでした。購入状況を再確認してください。",
      );
      return;
    }
    if (release?.pending) {
      setCheckoutReturnMessage(
        "書き出しを中止し、利用枠の返却を受け付けました。反映後に購入状況を再確認できます。",
      );
      return;
    }
    sendVideoUsageReleaseBeacon(reservationId);
    setCheckoutReturnMessage(
      "書き出しを中止し、利用枠の返却を依頼しました。通信回復後に購入状況を再確認してください。",
    );
  }

  function rememberAiOperationsRemaining(nextRemaining: number) {
    const normalized = Math.max(
      0,
      Math.min(aiOperationLimitRef.current, Math.floor(nextRemaining)),
    );
    aiOperationsRemainingRef.current = normalized;
    setAiOperationsRemaining(normalized);
    return normalized;
  }

  function rememberAiOperationLimit(nextLimit: number) {
    const normalized = Math.max(
      1,
      Math.min(MAX_AI_OPERATION_LIMIT, Math.floor(nextLimit)),
    );
    aiOperationLimitRef.current = normalized;
    setAiOperationLimit(normalized);
    if (aiOperationsRemainingRef.current > normalized) {
      rememberAiOperationsRemaining(normalized);
    }
    return normalized;
  }

  function resetAiOperationQuota() {
    rememberAiOperationLimit(MAX_AI_OPERATION_LIMIT);
    rememberAiOperationsRemaining(MAX_AI_OPERATION_LIMIT);
  }

  function rememberReservationAiQuota(reservation: {
    aiOperationLimit: number;
    aiOperationsRemaining: number;
  }) {
    rememberAiOperationLimit(reservation.aiOperationLimit);
    rememberAiOperationsRemaining(reservation.aiOperationsRemaining);
  }

  function recordAiOperationResult(result: AiOperationQuotaResult) {
    if (result.aiOperationLimit !== null) {
      rememberAiOperationLimit(result.aiOperationLimit);
    }
    return rememberAiOperationsRemaining(
      result.aiOperationsRemaining ?? aiOperationsRemainingRef.current - 1,
    );
  }

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(
    () => () => {
      editAbortRef.current?.abort();
      narrationRegenerationAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const releaseUnusedPaidExportReservation = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      const reservationId = usageReservationRef.current;
      if (
        usageReservationPendingExportRef.current &&
        !usageReservationFinalizingRef.current &&
        reservationId
      ) {
        if (!sendVideoUsageReleaseBeacon(reservationId)) {
          void updateVideoUsage("release", reservationId);
        }
        usageReservationPendingExportRef.current = false;
      }
    };
    window.addEventListener("pagehide", releaseUnusedPaidExportReservation);
    return () => {
      window.removeEventListener("pagehide", releaseUnusedPaidExportReservation);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (narrationAudioUrl) URL.revokeObjectURL(narrationAudioUrl);
    };
  }, [narrationAudioUrl]);

  const keptLines = useMemo(
    () => transcript.filter(isIncludedCaption),
    [transcript],
  );

  useEffect(() => {
    if (!file || isDemoSample || stage === "start" || stage === "processing") {
      return;
    }
    const timeout = window.setTimeout(() => {
      void saveLocalEditDraft({
        version: 1,
        savedAt: Date.now(),
        fingerprint: createVideoDraftFingerprint(
          file,
          selectedVideoDuration,
        ),
        resultReady: stage === "result",
        goal,
        length,
        audioMode,
        spokenCaptionsEnabled,
        spokenCutMode,
        asrDictionary,
        narrationStyle,
        narrationOriginalAudio,
        narrationBrief,
        narrationCaptionsEnabled,
        narrationAutoCutEnabled,
        captionProfile,
        transcript,
        narrationScript: narrationPlan?.script,
        usedHighAccuracy,
      });
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [
    audioMode,
    captionProfile,
    file,
    goal,
    isDemoSample,
    length,
    narrationAutoCutEnabled,
    narrationBrief,
    narrationCaptionsEnabled,
    narrationOriginalAudio,
    narrationPlan?.script,
    narrationStyle,
    selectedVideoDuration,
    spokenCaptionsEnabled,
    spokenCutMode,
    asrDictionary,
    stage,
    transcript,
    usedHighAccuracy,
  ]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  async function chooseFile(
    selected?: File,
    options: { demo?: boolean } = {},
  ) {
    if (!selected) return false;
    if (!isSupportedVideoFile(selected)) {
      notify(
        UNSUPPORTED_VIDEO_EXTENSION.test(selected.name)
          ? "AVI・MKVなどには対応していません。MP4・MOV・M4V・WebMの動画を選んでください"
          : "MP4・MOV・M4V・WebMの動画を選んでください",
      );
      return false;
    }
    if (selected.size > MAX_EDIT_VIDEO_BYTES) {
      notify("動画編集は500MBまでです");
      return false;
    }
    let selectedDurationSeconds = 0;
    let matchingDraft: LocalEditDraft | null = null;
    try {
      const durationResult = validateVideoInputDuration(
        await getVideoDurationSeconds(selected),
      );
      if (!durationResult.ok) {
        notify(durationResult.message);
        return false;
      }
      selectedDurationSeconds = durationResult.durationSeconds;
      setSelectedVideoDuration(selectedDurationSeconds);
      const pendingDraft = pendingDraftRestoreRef.current;
      if (pendingDraft) {
        const selectedFingerprint = createVideoDraftFingerprint(
          selected,
          durationResult.durationSeconds,
        );
        if (
          matchesVideoDraftFingerprint(
            pendingDraft.fingerprint,
            selectedFingerprint,
          )
        ) {
          matchingDraft = pendingDraft;
        } else {
          notify(
            `前回と同じ動画「${pendingDraft.fingerprint.name}」を選んでください`,
          );
          return false;
        }
      }
    } catch {
      notify("動画の長さを確認できませんでした。動画を選び直してください");
      return false;
    }
    editAbortRef.current?.abort();
    narrationRegenerationAbortRef.current?.abort();
    narrationRegenerationAbortRef.current = null;
    editAbortRef.current = null;
    editGenerationRef.current += 1;
    releasePendingExportReservation();
    setFile(selected);
    trackClientEvent(options.demo ? "demo_started" : "video_selected", {
      ...(options.demo
        ? {}
        : {
            mode: audioMode,
            duration_bucket: analyticsDurationBucket(selectedDurationSeconds),
            format: analyticsVideoFormat(selected),
          }),
    });
    const restoringAfterDemo =
      !options.demo && isDemoSample ? preDemoPersonalRecipeRef.current : null;
    if (options.demo && !isDemoSample) {
      preDemoPersonalRecipeRef.current = personalEditRecipe;
    }
    setIsDemoSample(Boolean(options.demo));
    if (options.demo) {
      setAudioMode("spoken");
      setSpokenCaptionsEnabled(true);
    } else if (restoringAfterDemo && !matchingDraft) {
      applyPersonalEditPreferences({
        recipe: restoringAfterDemo,
        dictionary: personalDictionary,
      });
      preDemoPersonalRecipeRef.current = null;
    }
    setEditError("");
    setSilentFallback(false);
    setUsedHighAccuracy(false);
    setIsHighAccuracyRun(false);
    setNarrationPlan(null);
    setInitialNarrationPronunciationGuide("");
    setNarrationAudioUrl("");
    setNarrationAudioModel("");
    setNarrationAudioVoice("");
    setNarrationAudioProfile("");
    resetAiOperationQuota();
    rememberUsageReservation(null);
    if (matchingDraft) {
      pendingDraftRestoreRef.current = null;
      setRecoverableDraft(null);
      setGoal(matchingDraft.goal);
      setLength(matchingDraft.length);
      setAudioMode(matchingDraft.audioMode);
      setSpokenCaptionsEnabled(matchingDraft.spokenCaptionsEnabled === true);
      setSpokenCutMode(matchingDraft.spokenCutMode);
      setAsrDictionaryInput(
        sanitizeAsrUserDictionary(matchingDraft.asrDictionary).join("、"),
      );
      setNarrationStyle(matchingDraft.narrationStyle);
      setNarrationOriginalAudio(matchingDraft.narrationOriginalAudio);
      setNarrationBrief(matchingDraft.narrationBrief);
      setNarrationCaptionsEnabled(matchingDraft.narrationCaptionsEnabled !== false);
      setNarrationAutoCutEnabled(matchingDraft.narrationAutoCutEnabled);
      setCaptionProfile(normalizeCaptionProfile(matchingDraft.captionProfile));
      const restoredTranscript = matchingDraft.transcript.filter(
        (line): line is TranscriptLine =>
          Boolean(
            line &&
              typeof line === "object" &&
              typeof (line as TranscriptLine).id === "number" &&
              typeof (line as TranscriptLine).text === "string" &&
              typeof (line as TranscriptLine).start === "number" &&
              typeof (line as TranscriptLine).end === "number",
          ),
      );
      if (restoredTranscript.length) setTranscript(restoredTranscript);
      setUsedHighAccuracy(matchingDraft.usedHighAccuracy);
      notify(
        matchingDraft.resultReady
          ? "前回の編集設定を復元しました。現在のテロップとカット設定で、もう一度仕上がりを作成できます"
          : "前回の設定を復元しました",
      );
      trackClientEvent("draft_recovered", {
        outcome: matchingDraft.resultReady ? "result_settings" : "setup_settings",
      });
    }
    setStage("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  async function loadSampleVideo() {
    if (isSampleLoading) return;
    setIsSampleLoading(true);
    try {
      const response = await fetch("/demo/torudake-demo.mp4", {
        cache: "force-cache",
      });
      if (!response.ok) {
        throw new Error("サンプル動画を読み込めませんでした。");
      }
      const blob = await response.blob();
      if (!blob.size) {
        throw new Error("サンプル動画を読み込めませんでした。");
      }
      const sampleFile = new File([blob], "torudake-demo.mp4", {
        type: blob.type || "video/mp4",
        lastModified: 1_786_291_200_000,
      });
      await chooseFile(sampleFile, { demo: true });
    } catch (error) {
      notify(
        error instanceof Error
          ? `${error.message} 通信を確認して、もう一度お試しください`
          : "サンプル動画を読み込めませんでした。もう一度お試しください",
      );
    } finally {
      setIsSampleLoading(false);
    }
  }

  async function startEditing(
    highAccuracy = false,
    forceSpokenAudioAnalysis = false,
  ) {
    if (file && file.size > MAX_EDIT_VIDEO_BYTES) {
      setEditError(
        "動画編集は500MBまでです。動画を短くするか圧縮してお試しください。",
      );
      return;
    }

    editAbortRef.current?.abort();
    const controller = new AbortController();
    editAbortRef.current = controller;
    const generation = editGenerationRef.current + 1;
    editGenerationRef.current = generation;
    const isCurrent = () =>
      editGenerationRef.current === generation && !controller.signal.aborted;
    const updateProgress = (nextProgress: number) => {
      if (isCurrent()) setProgress(nextProgress);
    };

    setEditError("");
    setIsHighAccuracyRun(highAccuracy);
    setProgress(4);
    setStage("processing");

    let progressTimer: number | undefined;
    let newlyReservedUsage: string | null = null;
    let processingReservationId = usageReservationRef.current;
    let processingReservationBucket = usageBucket;
    const transcriptionOperationId = crypto.randomUUID();

    try {
      const shouldAnalyzeSpokenAudio =
        forceSpokenAudioAnalysis ||
        spokenCaptionsEnabled ||
        spokenCutMode !== "none";
      let nextTranscript: TranscriptLine[] = isDemoSample
        ? DEMO_CAPTIONS.map((caption, index) => ({
            id: index + 1,
            ...caption,
            removed: false,
          }))
        : shouldAnalyzeSpokenAudio
          ? initialTranscript
          : [];
      let refined = false;
      if (
        file &&
        !isDemoSample &&
        shouldAnalyzeSpokenAudio &&
        usageReservationRef.current
      ) {
        const wasPendingExport = usageReservationPendingExportRef.current;
        try {
          const renewed = await renewVideoUsage(
            usageReservationRef.current,
            file,
            controller.signal,
          );
          processingReservationId = renewed.reservationId;
          processingReservationBucket = renewed.bucket;
          throwIfProcessingAborted(controller.signal);
          rememberUsageReservation(
            renewed.reservationId,
            renewed.bucket,
            wasPendingExport,
          );
          rememberReservationAiQuota(renewed);
        } catch (error) {
          if (!(error instanceof ApiRequestError) || error.status !== 404) {
            throw error;
          }
          rememberUsageReservation(null);
          processingReservationId = null;
          processingReservationBucket = null;
        }
      }
      if (file && !isDemoSample && !usageReservationRef.current) {
        const reservation = await reserveVideoUsage(file, controller.signal);
        newlyReservedUsage = reservation.reservationId;
        processingReservationId = reservation.reservationId;
        processingReservationBucket = reservation.bucket;
        throwIfProcessingAborted(controller.signal);
        rememberUsageReservation(newlyReservedUsage, reservation.bucket);
        rememberReservationAiQuota(reservation);
      }
      const usageReservationId = usageReservationRef.current;

      if (file && !isDemoSample) {
        if (!shouldAnalyzeSpokenAudio) {
          updateProgress(88);
        } else if (needsBrowserAudioExtraction(file)) {
          const transcriptionResult = await transcribeLargeVideo(
            file,
            updateProgress,
            highAccuracy,
            usageReservationId,
            transcriptionOperationId,
            controller.signal,
            asrDictionary,
          );
          nextTranscript = transcriptionResult.segments;
          refined = transcriptionResult.refined;
          recordAiOperationResult(transcriptionResult);
        } else {
          progressTimer = window.setInterval(() => {
            if (isCurrent()) {
              setProgress((current) => Math.min(current + 2, 88));
            }
          }, 600);
          const transcriptionResult = await transcribeMediaFile(
            file,
            highAccuracy,
            usageReservationId,
            transcriptionOperationId,
            controller.signal,
            asrDictionary,
          );
          nextTranscript = transcriptionResult.segments;
          refined = transcriptionResult.refined;
          recordAiOperationResult(transcriptionResult);
        }
      } else {
        progressTimer = window.setInterval(() => {
          if (isCurrent()) {
            setProgress((current) => Math.min(current + 7, 88));
          }
        }, 500);
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }

      throwIfProcessingAborted(controller.signal);
      if (
        file &&
        !isDemoSample &&
        shouldAnalyzeSpokenAudio &&
        nextTranscript.length === 0
      ) {
        if (progressTimer !== undefined) {
          window.clearInterval(progressTimer);
        }
        usageReservationPendingExportRef.current = true;
        setUsageReservationPendingExport(true);
        setSilentFallback(true);
        setSpokenCaptionsEnabled(false);
        setSpokenCutMode("none");
        setProgress(0);
        setStage("setup");
        return;
      }
      if (spokenCutMode === "auto") {
        const visualEvidence = file
          ? await analyzeVideoForNaturalEdit(file, controller.signal)
          : [];
        throwIfProcessingAborted(controller.signal);
        nextTranscript = createNaturalEdit(nextTranscript, length, goal, {
          visualEvidence,
        });
        if (file) {
          nextTranscript = await refineCaptionCutsWithLocalSilence(
            file,
            nextTranscript,
            controller.signal,
          );
          throwIfProcessingAborted(controller.signal);
        }
      } else {
        nextTranscript = nextTranscript.map((line) => ({
          ...line,
          removed: false,
        }));
      }
      if (progressTimer !== undefined) {
        window.clearInterval(progressTimer);
      }
      setTranscript(nextTranscript);
      setUsedHighAccuracy(refined);
      if (
        processingReservationId &&
        isCurrent() &&
        usageReservationRef.current === processingReservationId
      ) {
        await settleVideoUsageAfterProcessing(
          processingReservationId,
          processingReservationBucket,
        );
      }
      if (!isCurrent()) return;
      setProgress(100);
      window.setTimeout(() => {
        if (!isCurrent()) return;
        setPreviewMode(
          spokenCaptionsEnabled || forceSpokenAudioAnalysis
            ? "after"
            : "before",
        );
        setStage("result");
        trackClientEvent("preview_completed", {
          mode: "spoken",
          outcome: highAccuracy ? "high_accuracy" : "standard",
        });
      }, 320);
    } catch (error) {
      if (progressTimer !== undefined) {
        window.clearInterval(progressTimer);
      }
      if (isCurrent() && isSilentMediaError(error)) {
        usageReservationPendingExportRef.current = true;
        setUsageReservationPendingExport(true);
        setSilentFallback(true);
        setSpokenCaptionsEnabled(false);
        setSpokenCutMode("none");
        setProgress(0);
        setStage("setup");
        return;
      }
      if (newlyReservedUsage) {
        await updateVideoUsage("release", newlyReservedUsage);
        if (usageReservationRef.current === newlyReservedUsage) {
          rememberUsageReservation(null);
        }
      }
      if (!isCurrent()) return;
      if (error instanceof ApiRequestError) {
        if (error.aiOperationLimit !== null) {
          rememberAiOperationLimit(error.aiOperationLimit);
        }
        if (error.aiOperationsRemaining !== null) {
          rememberAiOperationsRemaining(error.aiOperationsRemaining);
        }
      }
      if (isAuthenticationRequiredError(error)) {
        explainAuthenticationRequired();
        return;
      }
      setProgress(0);
      setEditError(
        error instanceof Error
          ? error.message
          : "字幕を生成できませんでした。もう一度お試しください。",
      );
      setStage("setup");
    } finally {
      if (editAbortRef.current === controller) editAbortRef.current = null;
    }
  }

  async function chooseSilentNarrationMode() {
    const reservationId = usageReservationRef.current;
    if (reservationId) {
      await releaseVideoUsageBestEffort(reservationId);
    }
    rememberUsageReservation(null);
    setSilentFallback(false);
    setEditError("");
    setPersonalAudioMode("narration");
    setPersonalNarrationOriginalAudio(0);
    setPersonalNarrationAutoCutEnabled(false);
    setPersonalNarrationCaptionsEnabled(true);
  }

  async function finishSilentVideoWithoutCaptions() {
    const reservationId = usageReservationRef.current;
    if (reservationId) {
      await settleVideoUsageAfterProcessing(reservationId, usageBucket);
    }
    setSilentFallback(false);
    setEditError("");
    setPersonalAudioMode("spoken");
    setPersonalSpokenCaptionsEnabled(false);
    setPersonalSpokenCutMode("none");
    setTranscript([]);
    setPreviewMode("before");
    setStage("result");
    trackClientEvent("preview_completed", {
      mode: "spoken",
      outcome: "silent_no_caption",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startNarrationEditing() {
    if (isDemoSample) {
      setAudioMode("spoken");
      setEditError(
        "サンプルは元音声モードで、API利用や無料体験の回数を消費せずに確認できます。AIナレーションはご自身の動画でお試しください。",
      );
      return;
    }
    if (!file) {
      setEditError(
        "AIナレーションは実際の動画から場面を読み取って作ります。動画を選んでください。",
      );
      return;
    }
    editAbortRef.current?.abort();
    const controller = new AbortController();
    editAbortRef.current = controller;
    const generation = editGenerationRef.current + 1;
    editGenerationRef.current = generation;
    const isCurrent = () =>
      editGenerationRef.current === generation && !controller.signal.aborted;
    const updateProgress = (nextProgress: number) => {
      if (isCurrent()) setProgress(nextProgress);
    };

    setEditError("");
    setIsHighAccuracyRun(false);
    setProgress(4);
    setStage("processing");
    let newlyReservedUsage: string | null = null;
    let newlyReservedBucket: BillingBucket | null = null;
    const initialNarrationOperationId = crypto.randomUUID();
    const initialPronunciationGuide = buildSavedNarrationPronunciationGuide(
      personalDictionary,
    );
    setInitialNarrationPronunciationGuide(initialPronunciationGuide);

    try {
      const reservation = await reserveVideoUsage(file, controller.signal);
      newlyReservedUsage = reservation.reservationId;
      newlyReservedBucket = reservation.bucket;
      throwIfProcessingAborted(controller.signal);
      rememberUsageReservation(newlyReservedUsage, reservation.bucket);
      rememberReservationAiQuota(reservation);
      updateProgress(14);
      const extracted = await extractNarrationFrames(file, 6, controller.signal);
      throwIfProcessingAborted(controller.signal);
      updateProgress(36);
      const narrationPlanLength = narrationAutoCutEnabled ? length : 90;
      const narrationTargetDuration = Math.max(
        1,
        Math.min(narrationPlanLength, extracted.duration),
      );

      let nextPlan = await requestNarrationPlan({
        frames: extracted.frames,
        brief: narrationBrief,
        goal,
        length: narrationPlanLength,
        style: narrationStyle,
        sourceDuration: extracted.duration,
        usageReservationId: newlyReservedUsage,
        aiOperationId: initialNarrationOperationId,
        initialNarration: true,
        pronunciationGuide: initialPronunciationGuide,
        signal: controller.signal,
      });
      recordAiOperationResult(nextPlan);
      throwIfProcessingAborted(controller.signal);
      updateProgress(68);
      const maximumDuration = narrationTargetDuration;
      let speechReadyPlan = attachNarrationPronunciationReadings(
        nextPlan,
        initialPronunciationGuide,
      );
      let speechScript = applyNarrationPronunciationGuide(
        nextPlan.script,
        initialPronunciationGuide,
      );
      let speechResult = await requestNarrationSpeech(
        speechScript,
        narrationStyle,
        newlyReservedUsage,
        maximumDuration,
        initialNarrationOperationId,
        controller.signal,
        true,
        nextPlan.narrationBundleToken,
      );
      recordAiOperationResult(speechResult);
      let audio = speechResult.audio;
      let audioDuration = await getNarrationAudioDuration(audio);

      if (
        audioDuration >
        maximumDuration + NARRATION_DURATION_TOLERANCE_SECONDS
      ) {
        updateProgress(76);
        const timingScale = Math.max(
          0.55,
          Math.min(0.94, (maximumDuration / audioDuration) * 0.9),
        );
        nextPlan = await requestNarrationPlan({
          frames: extracted.frames,
          brief: narrationBrief,
          goal,
          length: narrationPlanLength,
          style: narrationStyle,
          sourceDuration: extracted.duration,
          usageReservationId: newlyReservedUsage,
          timingScale,
          previousScript: nextPlan.script,
          aiOperationId: initialNarrationOperationId,
          initialNarration: true,
          narrationBundleToken: nextPlan.narrationBundleToken,
          pronunciationGuide: initialPronunciationGuide,
          signal: controller.signal,
        });
        recordAiOperationResult(nextPlan);
        speechReadyPlan = attachNarrationPronunciationReadings(
          nextPlan,
          initialPronunciationGuide,
        );
        speechScript = applyNarrationPronunciationGuide(
          nextPlan.script,
          initialPronunciationGuide,
        );
        speechResult = await requestNarrationSpeech(
          speechScript,
          narrationStyle,
          newlyReservedUsage,
          maximumDuration,
          initialNarrationOperationId,
          controller.signal,
          true,
          nextPlan.narrationBundleToken,
        );
        recordAiOperationResult(speechResult);
        audio = speechResult.audio;
        audioDuration = await getNarrationAudioDuration(audio);
      }
      if (
        audioDuration >
        maximumDuration + NARRATION_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `AI音声が${Math.ceil(audioDuration)}秒になり、${Math.floor(maximumDuration)}秒以内へ自然に収まりませんでした。台本を短くしてもう一度お試しください。`,
        );
      }
      throwIfProcessingAborted(controller.signal);
      updateProgress(90);
      let timeline = buildNarrationTimeline(
        speechReadyPlan.segments,
        extracted.duration,
        narrationTargetDuration,
        audioDuration,
        { autoCut: narrationAutoCutEnabled },
      );
      timeline = await snapNarrationTimelineToAudioSilence(
        audio,
        speechReadyPlan.segments,
        timeline,
        extracted.duration,
        narrationAutoCutEnabled,
        controller.signal,
      );
      if (!timeline.length) {
        throw new Error("AIナレーションを動画へ同期できませんでした。");
      }

      setTranscript(timeline);
      setNarrationPlan(speechReadyPlan);
      setNarrationAudioUrl(URL.createObjectURL(audio));
      setNarrationAudioModel(speechResult.model);
      setNarrationAudioVoice(speechResult.voice);
      setNarrationAudioProfile(speechResult.profile);
      setUsedHighAccuracy(true);
      if (
        newlyReservedUsage &&
        isCurrent() &&
        usageReservationRef.current === newlyReservedUsage
      ) {
        await settleVideoUsageAfterProcessing(
          newlyReservedUsage,
          newlyReservedBucket,
        );
      }
      if (!isCurrent()) return;
      setProgress(100);
      window.setTimeout(() => {
        if (!isCurrent()) return;
        setPreviewMode("after");
        setStage("result");
        trackClientEvent("preview_completed", {
          mode: "narration",
          outcome: narrationAutoCutEnabled ? "auto_cut" : "no_cut",
        });
      }, 320);
    } catch (error) {
      if (newlyReservedUsage) {
        await updateVideoUsage("release", newlyReservedUsage);
        if (usageReservationRef.current === newlyReservedUsage) {
          rememberUsageReservation(null);
        }
      }
      if (!isCurrent()) return;
      if (error instanceof ApiRequestError) {
        if (error.aiOperationLimit !== null) {
          rememberAiOperationLimit(error.aiOperationLimit);
        }
        if (error.aiOperationsRemaining !== null) {
          rememberAiOperationsRemaining(error.aiOperationsRemaining);
        }
      }
      if (isAuthenticationRequiredError(error)) {
        explainAuthenticationRequired();
        return;
      }
      setProgress(0);
      setEditError(
        error instanceof Error
          ? error.message
          : "AIナレーションを生成できませんでした。もう一度お試しください。",
      );
      setStage("setup");
    } finally {
      if (editAbortRef.current === controller) editAbortRef.current = null;
    }
  }

  async function regenerateNarration(
    script: string,
    style: NarrationStyle,
    pronunciationGuide: string,
  ) {
    if (!file || !narrationPlan) {
      throw new Error("AI音声を更新する動画が見つかりませんでした。");
    }
    if (narrationRegenerationAbortRef.current) {
      throw new Error("AI音声を生成中です。完了まで少しお待ちください。");
    }
    if (aiOperationsRemainingRef.current <= 0) {
      throw new Error(
        `この動画で利用できるAI処理の上限（${aiOperationLimitRef.current}回）に達しました。現在の編集内容はそのままプレビュー・書き出しできます。`,
      );
    }
    const cleanScript = script.replace(/\s+/g, " ").trim();
    if (!cleanScript) throw new Error("ナレーション台本を入力してください。");
    const pronunciationValidation = validateNarrationPronunciationGuide(
      pronunciationGuide,
    );
    if (pronunciationValidation.error) {
      throw new Error(pronunciationValidation.error);
    }
    const pronunciationEntries = pronunciationValidation.entries;
    const unmatchedPronunciationEntries = pronunciationEntries.filter(
      (entry) =>
        countNarrationPronunciationOccurrences(cleanScript, entry.surface) === 0,
    );
    if (unmatchedPronunciationEntries.length) {
      const labels = unmatchedPronunciationEntries
        .slice(0, 3)
        .map((entry) => `「${entry.surface}」`)
        .join("、");
      throw new Error(
        `台本に${labels}が見つかりません。台本と同じ表記で入力してください。`,
      );
    }
    const speechScript = applyNarrationPronunciationGuide(
      cleanScript,
      pronunciationGuide,
    );
    if (speechScript.length > 2_000) {
      throw new Error("読み方を反映した台本が長すぎます。指定を短くしてください。");
    }
    const controller = new AbortController();
    const generation = editGenerationRef.current;
    narrationRegenerationAbortRef.current = controller;
    try {
      const duration = await getVideoDurationSeconds(file);
      const maximumDuration = Math.max(
        1,
        Math.min(narrationAutoCutEnabled ? length : 90, duration),
      );
      const speechResult = await requestNarrationSpeech(
        speechScript,
        style,
        usageReservationRef.current,
        maximumDuration,
        crypto.randomUUID(),
        controller.signal,
      );
      throwIfProcessingAborted(controller.signal);
      if (editGenerationRef.current !== generation) {
        throw new DOMException("処理を中止しました。", "AbortError");
      }
      const remaining = recordAiOperationResult(speechResult);
      const audio = speechResult.audio;
      const audioDuration = await getNarrationAudioDuration(audio);
      if (
        audioDuration >
        maximumDuration + NARRATION_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `この台本は約${Math.ceil(audioDuration)}秒です。自然な速さを保つため、${Math.floor(maximumDuration)}秒以内になるよう少し短くしてください。残り${remaining}回です。`,
        );
      }
      const segments = splitNarrationScript(cleanScript).map((text, index) => ({
        text,
        speechText: applyNarrationPronunciationGuide(text, pronunciationGuide),
        emphasis: index === 0,
      }));
      throwIfProcessingAborted(controller.signal);
      if (editGenerationRef.current !== generation) {
        throw new DOMException("処理を中止しました。", "AbortError");
      }
      setPersonalNarrationStyle(style);
      setNarrationPlan({ ...narrationPlan, script: cleanScript, segments });
      const baseTimeline = buildNarrationTimeline(
        segments,
        duration,
        maximumDuration,
        audioDuration,
        {
          autoCut: narrationAutoCutEnabled,
        },
      );
      setTranscript(
        await snapNarrationTimelineToAudioSilence(
          audio,
          segments,
          baseTimeline,
          duration,
          narrationAutoCutEnabled,
          controller.signal,
        ),
      );
      setNarrationAudioUrl(URL.createObjectURL(audio));
      setNarrationAudioModel(speechResult.model);
      setNarrationAudioVoice(speechResult.voice);
      setNarrationAudioProfile(speechResult.profile);
      return remaining;
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.aiOperationLimit !== null) {
          rememberAiOperationLimit(error.aiOperationLimit);
        }
        if (error.aiOperationsRemaining !== null) {
          rememberAiOperationsRemaining(error.aiOperationsRemaining);
        }
      }
      if (isAuthenticationRequiredError(error)) {
        setAuthenticationGateOpen(true);
        throw new Error(
          "ログイン後、AI音声の生成ボタンをもう一度押してください。編集中の内容は保持されています。",
        );
      }
      throw error;
    } finally {
      if (narrationRegenerationAbortRef.current === controller) {
        narrationRegenerationAbortRef.current = null;
      }
    }
  }

  async function regenerateNarrationSegment(
    segmentIndex: number,
    deliveryPreset: NarrationDeliveryPreset,
    emphasisText: string,
  ): Promise<NarrationSegmentCorrectionResult> {
    if (!file || !narrationPlan || !narrationAudioUrl) {
      throw new Error("修正するAI音声が見つかりませんでした。");
    }
    if (narrationRegenerationAbortRef.current) {
      throw new Error("別のAI音声を生成中です。完了まで少しお待ちください。");
    }
    if (aiOperationsRemainingRef.current <= 0) {
      throw new Error(
        `この動画で利用できるAI処理の上限（${aiOperationLimitRef.current}回）に達しました。`,
      );
    }
    if (
      narrationAudioModel !== PARTIAL_NARRATION_MODEL ||
      !narrationAudioVoice ||
      !narrationAudioProfile
    ) {
      throw new Error(
        "現在の音声は部分修正と異なる音声方式で作られています。台本の生成ボタンでAI音声全体を一度更新してからお試しください。",
      );
    }
    const segment = narrationPlan.segments[segmentIndex];
    if (!segment?.text.trim()) {
      throw new Error("修正する一文を選んでください。");
    }
    const spokenText = (segment.speechText || segment.text)
      .replace(/\s+/g, " ")
      .trim();
    const cleanEmphasis = emphasisText.replace(/\s+/g, " ").trim();
    if (
      deliveryPreset === "emphasis" &&
      (!cleanEmphasis || !spokenText.includes(cleanEmphasis))
    ) {
      throw new Error("強調したい言葉を、選んだ一文と同じ表記で入力してください。");
    }

    const controller = new AbortController();
    const generation = editGenerationRef.current;
    const baseAudioUrl = narrationAudioUrlRef.current;
    const baseAudioRevision = narrationAudioRevisionRef.current;
    narrationRegenerationAbortRef.current = controller;
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      narrationRegenerationAbortRef.current = null;
      throw new Error("このブラウザはAI音声の部分修正に対応していません。");
    }
    const audioContext = new AudioContextConstructor();
    try {
      const currentResponse = await fetch(baseAudioUrl, {
        signal: controller.signal,
      });
      if (!currentResponse.ok) {
        throw new Error("現在のAI音声を読み込めませんでした。");
      }
      const originalBuffer = await audioContext.decodeAudioData(
        await currentResponse.arrayBuffer(),
      );
      const targetSpan = buildNarrationAudioSpans(
        narrationPlan.segments,
        originalBuffer.duration,
      ).find((span) => span.index === segmentIndex);
      if (!targetSpan) {
        throw new Error("修正する一文の位置を確認できませんでした。");
      }
      const expectedDurationSeconds = Math.min(
        20,
        Math.max(0.4, targetSpan.end - targetSpan.start),
      );
      // Confirm both joins are genuinely quiet before spending an AI action.
      // The same boundaries are reused for the splice so the preflight and
      // final edit cannot choose different cut points.
      const resolvedBoundaries = resolveNarrationAudioBoundaries(
        originalBuffer,
        targetSpan.start,
        targetSpan.end,
      );
      const sourceDuration = await getVideoDurationSeconds(file);
      const maximumDuration = Math.max(
        1,
        Math.min(narrationAutoCutEnabled ? length : 90, sourceDuration),
      );
      const speechResult = await requestNarrationSpeech(
        spokenText,
        narrationStyle,
        usageReservationRef.current,
        maximumDuration,
        crypto.randomUUID(),
        controller.signal,
        false,
        undefined,
        {
          deliveryPreset,
          emphasisText:
            deliveryPreset === "emphasis" ? cleanEmphasis : "",
          expectedDurationSeconds,
        },
      );
      const remaining = recordAiOperationResult(speechResult);
      if (
        speechResult.model !== PARTIAL_NARRATION_MODEL ||
        speechResult.voice !== narrationAudioVoice ||
        speechResult.profile !== narrationAudioProfile
      ) {
        throw new Error(
          "元の声質と同じ方式で修正版を生成できませんでした。少し待ってからもう一度お試しください。",
        );
      }
      const replacementBuffer = await audioContext.decodeAudioData(
        await speechResult.audio.arrayBuffer(),
      );
      const splice = spliceNarrationAudioSegment(
        originalBuffer,
        replacementBuffer,
        targetSpan.start,
        targetSpan.end,
        resolvedBoundaries,
      );
      if (
        splice.duration >
        maximumDuration + NARRATION_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `修正版を入れるとAI音声が約${Math.ceil(splice.duration)}秒になり、動画の長さへ自然に収まりません。別の抑揚をお試しください（AI処理 残り${remaining}回）。`,
        );
      }
      if (
        Math.abs(splice.duration - originalBuffer.duration) >
        NARRATION_DURATION_TOLERANCE_SECONDS
      ) {
        throw new Error(
          `修正版の長さを元の一文へ合わせられませんでした。別の抑揚をお試しください（AI処理 残り${remaining}回）。`,
        );
      }
      throwIfProcessingAborted(controller.signal);
      if (
        editGenerationRef.current !== generation ||
        narrationAudioRevisionRef.current !== baseAudioRevision ||
        narrationAudioUrlRef.current !== baseAudioUrl
      ) {
        throw new DOMException("AI音声が更新されました。", "AbortError");
      }
      return {
        audio: new Blob([splice.audio], { type: "audio/wav" }),
        originalPreview: new Blob([splice.originalPreview], {
          type: "audio/wav",
        }),
        correctedPreview: new Blob([splice.correctedPreview], {
          type: "audio/wav",
        }),
        model: speechResult.model,
        voice: speechResult.voice,
        profile: speechResult.profile,
        baseAudioUrl,
        baseAudioRevision,
        segmentIndex,
        remaining,
      };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.aiOperationLimit !== null) {
          rememberAiOperationLimit(error.aiOperationLimit);
        }
        if (error.aiOperationsRemaining !== null) {
          rememberAiOperationsRemaining(error.aiOperationsRemaining);
        }
      }
      if (isAuthenticationRequiredError(error)) {
        setAuthenticationGateOpen(true);
        throw new Error(
          "ログイン後、選んだ一文の修正をもう一度お試しください。編集中の内容は保持されています。",
        );
      }
      throw error;
    } finally {
      await audioContext.close().catch(() => undefined);
      if (narrationRegenerationAbortRef.current === controller) {
        narrationRegenerationAbortRef.current = null;
      }
    }
  }

  function applyNarrationSegmentCorrection(
    correction: NarrationSegmentCorrectionResult,
  ) {
    if (
      narrationAudioRevisionRef.current !== correction.baseAudioRevision ||
      narrationAudioUrlRef.current !== correction.baseAudioUrl
    ) {
      throw new Error(
        "AI音声が更新されたため、この修正候補は採用できません。もう一度生成してください。",
      );
    }
    setNarrationAudioUrl(URL.createObjectURL(correction.audio));
    setNarrationAudioModel(correction.model);
    setNarrationAudioVoice(correction.voice);
    setNarrationAudioProfile(correction.profile);
  }

  async function updateNarrationCutMode(autoCut: boolean) {
    if (autoCut === narrationAutoCutEnabled) return;
    if (!file || !narrationPlan || !narrationAudioUrl) {
      setNarrationAutoCutEnabled(autoCut);
      return;
    }

    const narrationResponse = await fetch(narrationAudioUrl);
    if (!narrationResponse.ok) {
      throw new Error("AI音声を読み込めませんでした。");
    }
    const narrationBlob = await narrationResponse.blob();
    const [audioDuration, sourceDuration] = await Promise.all([
      getNarrationAudioDuration(narrationBlob),
      getVideoDurationSeconds(file),
    ]);
    let timeline = buildNarrationTimeline(
      narrationPlan.segments,
      sourceDuration,
      length,
      audioDuration,
      { autoCut },
    );
    timeline = await snapNarrationTimelineToAudioSilence(
      narrationBlob,
      narrationPlan.segments,
      timeline,
      sourceDuration,
      autoCut,
    );
    if (!timeline.length) {
      throw new Error("映像の仕上げ方を変更できませんでした。");
    }
    setTranscript(timeline);
    setNarrationAutoCutEnabled(autoCut);
  }

  function reset() {
    editAbortRef.current?.abort();
    editAbortRef.current = null;
    narrationRegenerationAbortRef.current?.abort();
    narrationRegenerationAbortRef.current = null;
    editGenerationRef.current += 1;
    releasePendingExportReservation();
    if (isDemoSample && preDemoPersonalRecipeRef.current) {
      applyPersonalEditPreferences({
        recipe: preDemoPersonalRecipeRef.current,
        dictionary: personalDictionary,
      });
    }
    preDemoPersonalRecipeRef.current = null;
    setFile(null);
    setSelectedVideoDuration(0);
    setIsDemoSample(false);
    setStage("start");
    setProgress(0);
    setPreviewMode("after");
    setTranscript(initialTranscript);
    setEditError("");
    setSilentFallback(false);
    setUsedHighAccuracy(false);
    setIsHighAccuracyRun(false);
    setAsrDictionaryInput("");
    setNarrationPlan(null);
    setInitialNarrationPronunciationGuide("");
    setNarrationAudioUrl("");
    setNarrationAudioModel("");
    setNarrationAudioVoice("");
    setNarrationAudioProfile("");
    resetAiOperationQuota();
    rememberUsageReservation(null);
    checkoutReturnPendingRef.current = false;
    setCheckoutReturnMessage("");
    pendingDraftRestoreRef.current = null;
    setRecoverableDraft(null);
    setAuthenticationGateOpen(false);
    void clearLocalEditDraft();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function explainAuthenticationRequired() {
    setProgress(0);
    setStage("setup");
    setEditError(
      "AI機能を使うにはログインが必要です。編集中の素材と設定はこの画面に残っています。ログイン後、同じ操作をもう一度お試しください。",
    );
    setAuthenticationGateOpen(true);
  }

  function beginDraftRecovery() {
    if (!recoverableDraft) return;
    pendingDraftRestoreRef.current = recoverableDraft;
    inputRef.current?.click();
  }

  async function discardRecoverableDraft() {
    pendingDraftRestoreRef.current = null;
    setRecoverableDraft(null);
    await clearLocalEditDraft();
    trackClientEvent("draft_cleared", { source: "landing" });
    notify("前回の編集データをこの端末から削除しました");
  }

  function markCheckoutStarted(plan: "starter" | "standard" | "one_time") {
    trackClientEvent("checkout_started", {
      plan,
      source: "result",
      mode: audioMode === "narration" ? "narration" : "spoken",
      offer_version: MONTHLY_FIRST_OFFER_VERSION,
    });
    checkoutReturnPendingRef.current = true;
    setCheckoutReturnMessage(
      "別タブで決済を完了してください。この画面へ戻ると購入状況を自動で確認します。",
    );
  }

  async function checkPaidExportAccess() {
    if (!file || paidAccessCheckRef.current) return false;
    const accessGeneration = editGenerationRef.current;
    const accessFile = file;
    paidAccessCheckRef.current = true;
    setIsCheckingPaidExportAccess(true);
    setCheckoutReturnMessage("購入状況を確認しています…");
    try {
      const reservation = await reserveVideoUsage(accessFile);
      if (editGenerationRef.current !== accessGeneration) {
        if (reservation.reservationId) {
          await releaseVideoUsageBestEffort(reservation.reservationId);
        }
        return false;
      }
      if (
        !reservation.reservationId ||
        !canSaveCompletedVideo(reservation.bucket)
      ) {
        if (reservation.reservationId) {
          await updateVideoUsage("release", reservation.reservationId);
        }
        throw new Error(
          "購入済みの利用枠をまだ確認できませんでした。決済完了後、少し待ってからもう一度お試しください。",
        );
      }
      rememberUsageReservation(
        reservation.reservationId,
        reservation.bucket,
        true,
      );
      rememberReservationAiQuota(reservation);
      checkoutReturnPendingRef.current = false;
      setCheckoutReturnMessage(
        "購入済みの利用枠を確認しました。下の「動画を書き出す」から保存を再開できます。",
      );
      notify("購入済みの利用枠を確認しました。動画の書き出しを再開できます");
      return true;
    } catch (error) {
      if (editGenerationRef.current !== accessGeneration) return false;
      const message =
        error instanceof ApiRequestError && error.status === 402
          ? "購入済みの利用枠をまだ確認できませんでした。決済完了後、少し待ってから「購入状況を再確認」を押してください。"
          : error instanceof Error
            ? error.message
            : "購入状況を確認できませんでした。";
      checkoutReturnPendingRef.current = false;
      setCheckoutReturnMessage(message);
      notify(message);
      return false;
    } finally {
      paidAccessCheckRef.current = false;
      setIsCheckingPaidExportAccess(false);
    }
  }
  useEffect(() => {
    paidAccessCheckCallbackRef.current = checkPaidExportAccess;
  });

  async function startCheckout(
    plan: "starter" | "standard" | "one_time",
  ) {
    if (billingBusyPlan) return;
    setBillingError("");
    setBillingBusyPlan(plan);
    trackClientEvent("checkout_started", {
      plan,
      source: "landing",
    });
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          requestId: crypto.randomUUID(),
        }),
      });
      if (response.status === 401) {
        window.location.href = `/account?checkout=${plan}`;
        return;
      }
      const payload = await readApiResponse<
        ApiPayload & {
          url?: string;
        }
      >(response, "決済画面を開けませんでした。");
      if (!payload.url) throw new Error("決済画面を開けませんでした。");
      window.location.href = payload.url;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "決済画面を開けませんでした。";
      setBillingError(message);
      notify(message);
      setBillingBusyPlan(null);
    }
  }

  useEffect(() => {
    const recheckAfterCheckout = () => {
      if (
        stage !== "result" ||
        document.visibilityState !== "visible" ||
        !checkoutReturnPendingRef.current ||
        paidAccessCheckRef.current
      ) {
        return;
      }
      void paidAccessCheckCallbackRef.current();
    };
    window.addEventListener("focus", recheckAfterCheckout);
    document.addEventListener("visibilitychange", recheckAfterCheckout);
    return () => {
      window.removeEventListener("focus", recheckAfterCheckout);
      document.removeEventListener("visibilitychange", recheckAfterCheckout);
    };
  }, [file, stage]);

  return (
    <>
      <main className="siteShell" data-build="20260809-refined-luxury">
      <header className="topbar">
        <button
          className="brand"
          onClick={() => {
            if (stage === "start" && landingVariant === "video-edit") {
              window.location.assign("/");
              return;
            }
            reset();
          }}
          aria-label="トップへ戻る"
        >
          <span className="brandIcon">
            <span />
            <i>▶</i>
          </span>
          <span className="brandText">
            撮るだけリール
            <small>日常で撮った動画から、投稿できる1本へ</small>
          </span>
        </button>

        {stage === "start" ? (
          <nav aria-label="メインメニュー">
            <a href={landingVariant === "home" ? "#create" : "/#create"}>作り方</a>
            <a href="#how">使い方</a>
            <Link href="/pricing">料金</Link>
          </nav>
        ) : (
          <div className="workspaceStatus">
            <span className="statusDot" />
            動画を編集中
          </div>
        )}

        <div className="topActions">
          {stage === "start" && (
            <Link className="mobilePriceLink" href="/pricing">
              料金
            </Link>
          )}
          <a className="accountButton" href="/account">
            アカウント
          </a>
          {stage !== "start" && (
            <button className="quietButton" onClick={reset}>
              新しく作る
            </button>
          )}
          {stage === "start" && (
            <button
              className="trialButton"
              onClick={() => {
                if (landingVariant === "video-edit") {
                  inputRef.current?.click();
                  return;
                }
                document.getElementById("create")?.scrollIntoView({
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                    .matches
                    ? "auto"
                    : "smooth",
                  block: "start",
                });
              }}
            >
              {landingVariant === "video-edit" ? "動画を選ぶ" : "作り方を選ぶ"}
            </button>
          )}
        </div>
      </header>

      <input
        ref={inputRef}
        className="visuallyHidden"
        type="file"
        accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          void chooseFile(selected);
        }}
      />
      {stage === "start" && (
        <Landing
          variant={landingVariant}
          openPicker={() => inputRef.current?.click()}
          openSample={loadSampleVideo}
          isSampleLoading={isSampleLoading}
          startCheckout={startCheckout}
          billingBusyPlan={billingBusyPlan}
          billingError={billingError}
          recoverableDraft={recoverableDraft}
          recoverDraft={beginDraftRecovery}
          discardDraft={() => void discardRecoverableDraft()}
        />
      )}

      {stage === "setup" && (
        <SetupWorkspace
          file={file}
          isDemoSample={isDemoSample}
          selectedVideoDuration={selectedVideoDuration}
          videoUrl={videoUrl}
          goal={goal}
          setGoal={setGoal}
          captionProfile={captionProfile}
          length={length}
          setLength={setPersonalLength}
          audioMode={audioMode}
          setAudioMode={setPersonalAudioMode}
          spokenCaptionsEnabled={spokenCaptionsEnabled}
          setSpokenCaptionsEnabled={(enabled) => {
            setPersonalSpokenCaptionsEnabled(enabled);
            setPreviewMode(enabled ? "after" : "before");
          }}
          spokenCutMode={spokenCutMode}
          setSpokenCutMode={setPersonalSpokenCutMode}
          asrDictionaryInput={asrDictionaryInput}
          setAsrDictionaryInput={setAsrDictionaryInput}
          narrationStyle={narrationStyle}
          setNarrationStyle={setPersonalNarrationStyle}
          narrationOriginalAudio={narrationOriginalAudio}
          setNarrationOriginalAudio={setPersonalNarrationOriginalAudio}
          narrationBrief={narrationBrief}
          setNarrationBrief={setNarrationBrief}
          narrationCaptionsEnabled={narrationCaptionsEnabled}
          setNarrationCaptionsEnabled={setPersonalNarrationCaptionsEnabled}
          narrationAutoCutEnabled={narrationAutoCutEnabled}
          setNarrationAutoCutEnabled={setPersonalNarrationAutoCutEnabled}
          personalPreferencesSyncStatus={personalPreferencesSyncStatus}
          personalDictionary={personalDictionary}
          setPersonalDictionary={setPersonalDictionary}
          silentFallback={silentFallback}
          chooseSilentNarration={() => void chooseSilentNarrationMode()}
          finishSilentWithoutCaptions={() =>
            void finishSilentVideoWithoutCaptions()
          }
          chooseAnother={() => inputRef.current?.click()}
          startEditing={() =>
            audioMode === "narration"
              ? startNarrationEditing()
              : startEditing(false)
          }
          error={editError}
        />
      )}

      {stage === "processing" && (
        <Processing
          file={file}
          progress={progress}
          highAccuracy={isHighAccuracyRun}
          narration={audioMode === "narration"}
          spokenCaptionsEnabled={spokenCaptionsEnabled}
          spokenCutMode={spokenCutMode}
          narrationCaptionsEnabled={narrationCaptionsEnabled}
          narrationAutoCutEnabled={narrationAutoCutEnabled}
          cancel={reset}
        />
      )}

      {stage === "result" && (
        <ResultWorkspace
          file={file}
          videoUrl={videoUrl}
          audioMode={audioMode}
          previewMode={previewMode}
          spokenCaptionsEnabled={spokenCaptionsEnabled}
          setSpokenCaptionsEnabled={(enabled) => {
            if (
              enabled &&
              !transcript.some((line) => line.text.trim().length > 0)
            ) {
              setSpokenCaptionsEnabled(true);
              void startEditing(false, true);
              return;
            }
            setPersonalSpokenCaptionsEnabled(enabled);
            setPreviewMode(enabled ? "after" : "before");
          }}
          spokenCutMode={spokenCutMode}
          transcript={transcript}
          setTranscript={setTranscript}
          keptLines={keptLines}
          goal={goal}
          captionProfile={captionProfile}
          setCaptionProfile={setCaptionProfile}
          length={length}
          notify={notify}
          reset={reset}
          chooseVideo={() => inputRef.current?.click()}
          regenerateHighAccuracy={() => startEditing(true)}
          usedHighAccuracy={usedHighAccuracy}
          narrationPlan={narrationPlan}
          setNarrationPlan={setNarrationPlan}
          narrationAudioUrl={narrationAudioUrl}
          initialNarrationPronunciationGuide={
            initialNarrationPronunciationGuide
          }
          narrationStyle={narrationStyle}
          narrationGenerationsRemaining={aiOperationsRemaining}
          narrationGenerationLimit={aiOperationLimit}
          narrationOriginalAudio={narrationOriginalAudio}
          narrationCaptionsEnabled={narrationCaptionsEnabled}
          setNarrationCaptionsEnabled={setPersonalNarrationCaptionsEnabled}
          narrationAutoCutEnabled={narrationAutoCutEnabled}
          setNarrationAutoCutEnabled={async (enabled) => {
            markPersonalPreferenceEdited();
            await updateNarrationCutMode(enabled);
          }}
          usageReservationId={usageReservationId}
          usageBucket={usageBucket}
          usageReservationPendingExport={usageReservationPendingExport}
          setNarrationOriginalAudio={setPersonalNarrationOriginalAudio}
          rememberPronunciationEntries={rememberPronunciationEntries}
          regenerateNarration={regenerateNarration}
          regenerateNarrationSegment={regenerateNarrationSegment}
          applyNarrationSegmentCorrection={applyNarrationSegmentCorrection}
          checkPaidExportAccess={checkPaidExportAccess}
          isCheckingPaidExportAccess={isCheckingPaidExportAccess}
          markCheckoutStarted={markCheckoutStarted}
          checkoutReturnMessage={checkoutReturnMessage}
          markExportReservationCompleted={() => {
            usageReservationFinalizingRef.current = false;
            usageReservationPendingExportRef.current = false;
            setUsageReservationPendingExport(false);
          }}
          setExportReservationFinalizing={(finalizing) => {
            usageReservationFinalizingRef.current = finalizing;
          }}
          cancelPendingExportReservation={cancelPendingExportReservation}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
      </main>
      <AuthenticationGate
        open={authenticationGateOpen}
        reason="ai"
        onClose={() => setAuthenticationGateOpen(false)}
        onAuthenticated={() => {
          setAuthenticationGateOpen(false);
          setEditError(
            "ログインが完了しました。素材と編集内容は保持されています。AI操作をもう一度お試しください。",
          );
          notify("ログインが完了しました。AI操作を再開できます");
        }}
      />
      <SiteFooter />
    </>
  );
}

export function VideoEditExperience() {
  return <Home landingVariant="video-edit" />;
}

const DEMO_CAPTIONS = [
  { start: 0.55, end: 2.42, text: "ふと撮った、今日の景色。" },
  {
    start: 3.43,
    end: 6.53,
    text: "少しの工夫で、空気感まで伝わる一本に。",
  },
  { start: 7.36, end: 9.4, text: "編集は、もっと心地よく。" },
] as const;

function RealVideoDemo() {
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const demoStartedRef = useRef(false);

  function trackDemoStart() {
    if (demoStartedRef.current) return;
    demoStartedRef.current = true;
    trackClientEvent("demo_started", { source: "hero_video" });
  }

  return (
    <figure className="heroVisual realDemo" aria-labelledby="realDemoCaption">
      {videoUnavailable ? (
        <div className="realDemoFallback" role="status">
          <span aria-hidden="true">▶</span>
          <strong>デモ動画を準備しています</strong>
          <p>動画を選ぶと、同じ編集画面で仕上がりを無料で確認できます。</p>
        </div>
      ) : (
        <div className="realDemoPlayer">
          <video
            controls
            playsInline
            preload="none"
            poster="/demo/torudake-demo-poster.jpg"
            aria-label="音声と日本語字幕付き、約10秒の完成動画"
            onPlay={trackDemoStart}
            onError={() => setVideoUnavailable(true)}
          >
            <source src="/demo/torudake-demo.mp4" type="video/mp4" />
            <track
              default
              kind="captions"
              src="/demo/torudake-demo-ja.vtt"
              srcLang="ja"
              label="日本語"
            />
          </video>
          <div className="realDemoStatus">
            <span>完成動画</span>
            <strong>約10秒・音声付き</strong>
          </div>
        </div>
      )}
      <figcaption className="visualResult" id="realDemoCaption">
        <span aria-hidden="true">✓</span>
        <p>
          <strong>実際の動画・音声・テロップで確認</strong>
          1回の再生操作で、仕上がりの雰囲気を確かめられます
        </p>
      </figcaption>
    </figure>
  );
}

function Landing({
  variant,
  openPicker,
  openSample,
  isSampleLoading,
  startCheckout,
  billingBusyPlan,
  billingError,
  recoverableDraft,
  recoverDraft,
  discardDraft,
}: {
  variant: "home" | "video-edit" | "legacy";
  openPicker: () => void;
  openSample: () => void | Promise<void>;
  isSampleLoading: boolean;
  startCheckout: (plan: "starter" | "standard" | "one_time") => void;
  billingBusyPlan: "starter" | "standard" | "one_time" | null;
  billingError: string;
  recoverableDraft: LocalEditDraft | null;
  recoverDraft: () => void;
  discardDraft: () => void;
}) {
  const pricingSectionRef = useRef<HTMLElement>(null);
  const pricingViewedRef = useRef(false);

  useEffect(() => {
    const pricingSection = pricingSectionRef.current;
    if (!pricingSection || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          pricingViewedRef.current ||
          !entries.some((entry) => entry.isIntersecting)
        ) {
          return;
        }
        pricingViewedRef.current = true;
        trackClientEvent("pricing_viewed", { source: "landing" });
        observer.disconnect();
      },
      { threshold: 0.25 },
    );
    observer.observe(pricingSection);
    return () => observer.disconnect();
  }, []);

  const sharedProps = {
    openPicker,
    openSample,
    isSampleLoading,
    demo: <RealVideoDemo />,
    recoverableDraftName: recoverableDraft?.fingerprint.name,
    recoverDraft,
    discardDraft,
  };

  if (variant === "home") {
    return <HomeLanding {...sharedProps} />;
  }

  if (variant === "video-edit") {
    return <VideoEditLanding {...sharedProps} />;
  }

  return (
    <>
      <section className="hero">
        <div className="heroCopy">
          {recoverableDraft && (
            <aside className="draftRecovery" aria-label="前回の編集を再開">
              <span aria-hidden="true">↻</span>
              <p>
                <strong>前回の編集を続けられます</strong>
                <small>
                  {recoverableDraft.fingerprint.name}・この端末に設定だけ一時保存
                </small>
              </p>
              <button type="button" onClick={recoverDraft}>
                同じ動画を選んで再開
              </button>
              <button
                type="button"
                className="draftDiscard"
                onClick={discardDraft}
                aria-label="前回の編集データを削除"
              >
                削除
              </button>
            </aside>
          )}
          <p className="eyebrow">
            <span>かんたん動画編集</span>
            素材を選ぶだけで、投稿できる動画へ
          </p>
          <h1>
            撮った動画を選ぶだけ。
            <br />
            <em>編集の手間を、もっと軽く。</em>
          </h1>
          <p className="heroLead">
            自動カット、必要に応じたテロップ、AIナレーション、表紙候補まで。
            AIナレーションモードなら投稿文も作れます。
            <br />
            仕上がりを見て、気になるところだけ直せます。
          </p>
          <div className="heroActions">
            <button className="mainCta" onClick={openPicker}>
              <span>無料で仕上がりを見る</span>
              <i>→</i>
            </button>
            <button
              className="sampleButton"
              type="button"
              disabled={isSampleLoading}
              onClick={() => void openSample()}
            >
              {isSampleLoading ? "サンプルを読込中…" : "サンプルで体験"}
            </button>
          </div>
          <div className="operationTrustSummary" aria-label="動画データの取り扱い">
            <strong>動画データの取り扱い</strong>
            <span>
              カットや書き出しは、お使いのスマホ・タブレット・パソコンで行います。AI機能を使う場合は、動画ファイル、または動画から取り出した音声・静止画を外部サービスへ送信します。
            </span>
            <a href="/privacy">詳しい取り扱いを見る</a>
          </div>
        </div>

          <div className="heroDetails">
          <div className="heroOffer" aria-label="無料体験と保存料金">
            <span className="heroOfferMark" aria-hidden="true">
              ¥0
            </span>
            <div>
              <strong>無料体験：合計3分以内・動画2本まで</strong>
              <small>AI処理は動画1本につき3回。編集結果が完成すると動画1本分を使用します</small>
            </div>
            <div className="heroOfferPrice">
              <strong>保存は動画1本 ¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}</strong>
              <small>
                プラン購入時に決済・書き出し成功時に1本分を使用
              </small>
            </div>
            <a href="#price">
              料金を見る
              <i aria-hidden="true">→</i>
            </a>
          </div>
          <Link className="photoReelEntry" href="/video-mix">
            <span className="photoReelEntryMark" aria-hidden="true">
              動画
            </span>
            <span>
              <strong>動画をつないで作る</strong>
              <small>最大5本・順番を保って合成・元音声テロップも選べる</small>
            </span>
            <i aria-hidden="true">→</i>
          </Link>
          <Link className="photoReelEntry" href="/photo-reel">
            <span className="photoReelEntryMark" aria-hidden="true">
              写真
            </span>
            <span>
              <strong>写真からリールを作る</strong>
              <small>2〜10枚・自動編集5パターン</small>
            </span>
            <i aria-hidden="true">→</i>
          </Link>
          <div className="trustRow">
            <span>✓ サンプル体験は登録不要</span>
            <span>✓ 最大1080p・透かしなし</span>
            <span>✓ スマホ動画をそのまま選択</span>
          </div>
        </div>

        <RealVideoDemo />
      </section>

      <section className="voiceSampleShelf" aria-labelledby="voiceSampleTitle">
        <div>
          <p className="eyebrow">AI音声を試聴</p>
          <h2 id="voiceSampleTitle">AIナレーションの仕上がりを、先に聴けます。</h2>
          <p className="voiceSampleDescription">
            それぞれの雰囲気が伝わる用途別の例文で、4つの話し方を聴き比べられます。一度生成した固定見本のため、試聴時にAPI料金やAI処理の回数は発生しません。実際の生成では、最新の日本語向け発音調整が加わります。
          </p>
        </div>
        <div className="voiceSampleTypes" aria-label="選べるAI音声の固定見本">
          {NARRATION_STYLES.map((style) => {
            const exampleId = `voiceSampleExample-${style.id}`;
            return (
              <article key={style.id}>
                <div>
                  <strong>{style.label}</strong>
                  <small>{style.note}</small>
                </div>
                <p className="voiceSampleExample" id={exampleId}>
                  <span>試聴する例文</span>
                  <q>{VOICE_SAMPLE_SCRIPTS[style.id]}</q>
                </p>
                <audio
                  controls
                  preload="none"
                  src={`/demo/voices/${style.id}-v5.wav`}
                  aria-label={`${style.label}の用途別固定音声サンプル`}
                  aria-describedby={exampleId}
                  onPlay={() =>
                    trackClientEvent("voice_sample_played", {
                      voice: style.id,
                    })
                  }
                />
              </article>
            );
          })}
        </div>
      </section>

      <section className="painStrip">
        <span>こんな編集、まだ手でやっていませんか？</span>
        <div>
          <p>
            <i>01</i>
            無音部分を探して切る
          </p>
          <p>
            <i>02</i>
            字幕を一文字ずつ直す
          </p>
          <p>
            <i>03</i>
            毎回同じデザインに整える
          </p>
          <p>
            <i>04</i>
            表紙と投稿文を別で作る
          </p>
        </div>
      </section>

      <section className="howSection" id="how">
        <div className="sectionHeading">
          <p className="eyebrow">かんたん3ステップ</p>
          <h2>
            あなたがするのは、
            <br />
            <em>選ぶ・決める・確認する。</em>
          </h2>
          <p>難しい編集画面はありません。</p>
        </div>
        <div className="stepGrid">
          <article>
            <span className="stepNo">01</span>
            <div className="stepIcon uploadIcon">↑</div>
            <h3>撮った動画を送る</h3>
            <p>5分までの縦・横・正方形動画をそのままアップロード。</p>
            <small>MP4・MOV・スマホ対応・最大500MB</small>
          </article>
          <article>
            <span className="stepNo">02</span>
            <div className="stepIcon magicIcon">✦</div>
            <h3>目的に合わせて自動編集</h3>
            <p>会話・解説は元の音声を活かし、必要ならAI音声に切り替え。</p>
            <small>動画に合わせて音声の仕上げ方を選択</small>
          </article>
          <article>
            <span className="stepNo">03</span>
            <div className="stepIcon checkIcon">✓</div>
            <h3>文字を読んで確認</h3>
            <p>気になる文だけ、タップで戻す・消す。</p>
            <small>タイムライン操作は不要</small>
          </article>
        </div>
      </section>

      <section className="differenceSection" id="difference">
        <div className="differenceCopy">
          <p className="eyebrow">このサービスでできること</p>
          <h2>
            編集ソフトではなく、
            <br />
            <em>投稿前の1本まで、迷わず整う。</em>
          </h2>
          <p>
            高機能なタイムラインを覚える必要はありません。
            テロップの雰囲気、色、ブランド名を保存して、次回も同じ設定から始められます。
          </p>
          <ul>
            <li>
              <span>✓</span>
              元の話し声を活かすか、AIナレーションに置き換える
            </li>
            <li>
              <span>✓</span>
              1行を短く、読みやすい位置で改行する
            </li>
            <li>
              <span>✓</span>
              漢字の読み方をAI音声の生成前に修正できる
            </li>
          </ul>
        </div>
        <div className="memoryCard">
          <div className="memoryTop">
            <span>自分の設定</span>
            <i>自動保存</i>
          </div>
          <div className="stylePreview">
            <span className="styleCaption">あなたのテロップ</span>
            <strong>大切な言葉だけ</strong>
            <em>色を変える</em>
          </div>
          <dl>
            <div>
              <dt>テロップ設定</dt>
              <dd>
                <i style={{ width: "88%" }} />
              </dd>
            </div>
            <div>
              <dt>強調カラー</dt>
              <dd>
                <i style={{ width: "82%" }} />
              </dd>
            </div>
            <div>
              <dt>ブランド名</dt>
              <dd>
                <i style={{ width: "72%" }} />
              </dd>
            </div>
          </dl>
          <p>保存した設定を、次の動画でもすぐ呼び出せます。</p>
        </div>
      </section>

      <section className="priceSection" id="price" ref={pricingSectionRef}>
        <div className="sectionHeading compact">
          <p className="eyebrow">料金プラン</p>
          <h2>使い方に合う保存方法を。</h2>
          <p>まず無料で仕上がりを確認。気に入った動画だけ保存できます。</p>
        </div>
        <div className="freePreviewBand">
          <span aria-hidden="true">¥0</span>
          <div>
            <strong>まずは無料で、編集後の動画を確認</strong>
            <small>
              合計3分以内・動画2本まで（いずれか先に達するまで）。AI処理は動画1本につき3回。編集・プレビューまで無料、完成動画の保存は有料です。
            </small>
          </div>
          <button onClick={openPicker}>無料で試す</button>
        </div>
        <p className="paidChoiceLabel">仕上がりが気に入ったら、保存方法を選択</p>
        <div className="priceGrid">
          <article className="featuredPrice subscriptionPrice">
            <span className="popular">おすすめ</span>
            <p>1か月ごと</p>
            <h3>1か月に動画{STANDARD_MONTHLY_VIDEO_LIMIT}本まで</h3>
            <strong>
              ¥{STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
              <small>／1か月（税込）</small>
            </strong>
            <span>
              {monthlyVideoAllowanceLabel(STANDARD_MONTHLY_VIDEO_LIMIT)}・1本あたり約
              {Math.round(
                STANDARD_MONTHLY_PRICE_JPY / STANDARD_MONTHLY_VIDEO_LIMIT,
              )}
              円
            </span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>
                ✓ AI処理は動画1本につき
                {SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回
              </li>
              <li>✓ 最大1080p・透かしなし</li>
              <li>✓ 編集スタイルを記憶</li>
            </ul>
            <button
              onClick={() => startCheckout("standard")}
              disabled={billingBusyPlan !== null}
            >
              {billingBusyPlan === "standard"
                ? "決済画面を準備中…"
                : `${STANDARD_MONTHLY_PLAN_LABEL}を始める`}
            </button>
          </article>
          <article className="subscriptionPrice">
            <p>1か月ごと</p>
            <h3>1か月に動画{STARTER_MONTHLY_VIDEO_LIMIT}本まで</h3>
            <strong>
              ¥{STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
              <small>／1か月（税込）</small>
            </strong>
            <span>
              {`${monthlyVideoAllowanceLabel(STARTER_MONTHLY_VIDEO_LIMIT)}・1本あたり約${Math.round(
                STARTER_MONTHLY_PRICE_JPY / STARTER_MONTHLY_VIDEO_LIMIT,
              )}円`}
            </span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>
                ✓ AI処理は動画1本につき
                {SUBSCRIPTION_AI_OPERATION_SUCCESS_LIMIT}回
              </li>
              <li>✓ 最大1080p・透かしなし</li>
              <li>✓ 編集スタイルを記憶</li>
            </ul>
            <button
              onClick={() => startCheckout("starter")}
              disabled={billingBusyPlan !== null}
            >
              {billingBusyPlan === "starter"
                ? "決済画面を準備中…"
                : `${STARTER_MONTHLY_PLAN_LABEL}を始める`}
            </button>
          </article>
          <article>
            <p>1回だけ</p>
            <h3>動画1本だけ保存</h3>
            <strong>
              ¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}
              <small>／1本（税込）</small>
            </strong>
            <span>動画1本だけ保存・月額料金なし</span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>✓ AI処理は動画1本につき5回</li>
              <li>✓ 最大1080p・透かしなし</li>
              <li>✓ 表紙つき・AIナレーションなら投稿文も作成</li>
            </ul>
            <button
              onClick={() => startCheckout("one_time")}
              disabled={billingBusyPlan !== null}
            >
              {billingBusyPlan === "one_time"
                ? "決済画面を準備中…"
                : "動画1本分を購入する"}
            </button>
          </article>
        </div>
        {billingError && (
          <p className="billingInlineError" role="alert">
            {billingError}
          </p>
        )}
        <p className="billingFootnote">
          決済はStripeの安全な画面で行います。カード情報は撮るだけリールに保存されません。
        </p>
        <p className="billingFootnote">
          月3本・月7本プランは1か月ごとの自動更新です。未使用の保存本数は次の1か月へ繰り越されません。アカウント画面からいつでも解約できます。動画1本プランは1回払いで、自動更新はありません。
        </p>
        <p className="billingFootnote">
          無料体験は編集結果が完成した時点で1本分を使用します。有料プランでは、動画の書き出しに成功した時点で、保存できる残り本数が1本減ります。
        </p>
      </section>

      <section className="bottomCta">
        <div>
          <p className="eyebrow">次の投稿を作る</p>
          <h2>
            撮りっぱなしの動画を、
            <br />
            今日の投稿に。
          </h2>
        </div>
        <div className="bottomCtaActions">
          <button className="mainCta light" onClick={openPicker}>
            <span>動画を選んで無料で試す</span>
            <i>→</i>
          </button>
          <a
            className="bottomLineShare"
            href={LINE_SHARE_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="LINEを開き、撮るだけリールのリンクを送る"
          >
            LINEに送る（スマホであとから開く）
          </a>
          <small className="bottomLineNote">
            スマホであとから試したい方へ。送信されるのは公開ページのURLと案内文だけです。
          </small>
        </div>
      </section>
    </>
  );
}

const ORIGINAL_AUDIO_PRESETS = [
  {
    percent: 0,
    label: "0%",
    badge: "音を消す",
    note: "AIナレーションだけを明瞭に",
  },
  {
    percent: 8,
    label: "8%",
    badge: "周りの音を薄く残す",
    note: "風景や料理の環境音向け",
  },
  {
    percent: 12,
    label: "12%",
    badge: "その場の音におすすめ",
    note: "料理・街・作業音を活かす",
  },
] as const;

function OriginalAudioMixControl({
  value,
  onChange,
  disabled = false,
}: {
  value: NarrationOriginalAudioLevel;
  onChange: (percent: NarrationOriginalAudioLevel) => void;
  disabled?: boolean;
}) {
  const roundedValue = Math.round(value);
  const advice =
    roundedValue === 0
      ? "元の話し声を入れず、AIナレーションだけで伝えたいときにおすすめです。"
      : roundedValue <= 8
        ? "環境音やBGMを薄く残せます。元動画に話し声がある場合は0%がおすすめです。"
        : roundedValue <= 12
          ? "声のない料理・街歩き・作業動画向けです。元動画に話し声がある場合は0%がおすすめです。"
          : "元動画の音がはっきり残ります。話し声があるとAIナレーションと重なるため、仕上がりプレビューで確認してください。";

  return (
    <section
      className="originalAudioMix"
      aria-label="元動画の音量"
    >
      <div className="originalAudioMixHeading">
        <div>
          <strong>元動画の音量</strong>
          <small>
            AIナレーションを100%としたときの、周りの音・BGM
          </small>
        </div>
        <output aria-live="polite">{roundedValue}%</output>
      </div>
      <div className="originalAudioPresets">
        {ORIGINAL_AUDIO_PRESETS.map((preset) => (
          <button
            key={preset.percent}
            type="button"
            className={roundedValue === preset.percent ? "selected" : ""}
            onClick={() => onChange(preset.percent)}
            aria-pressed={roundedValue === preset.percent}
            disabled={disabled}
          >
            <span>
              <strong>{preset.label}</strong>
              <i>{preset.badge}</i>
            </span>
            <small>{preset.note}</small>
          </button>
        ))}
      </div>
      <label className="originalAudioSlider">
        <span>
          <strong>細かく調整</strong>
          <small>0〜{MAX_NARRATION_ORIGINAL_AUDIO_PERCENT}%</small>
        </span>
        <input
          type="range"
          min={0}
          max={MAX_NARRATION_ORIGINAL_AUDIO_PERCENT}
          step={1}
          value={roundedValue}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="AIナレーションと一緒に残す環境音とBGMの音量"
          aria-valuetext={`${roundedValue}%`}
          disabled={disabled}
        />
      </label>
      <p className="originalAudioAdvice">{advice}</p>
    </section>
  );
}

function CaptionStylePicker({
  profile,
  setProfile,
  goal,
  disabled = false,
  compact = false,
}: {
  profile: CaptionProfile;
  setProfile: (profile: CaptionProfile) => void;
  goal: Goal;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`captionStylePicker ${compact ? "compact" : ""}`}
      role="group"
      aria-label="テロップの雰囲気"
    >
      <div className="captionStylePickerHeading">
        <strong>6種類から選ぶ</strong>
        <span>枠付き2種類・文字のみ4種類をプレビューと書き出しへ反映</span>
      </div>
      <div className="captionStyleChoices">
        {CAPTION_MOODS.map((item) => {
          const design = resolveCaptionDesign(
            { ...profile, mood: item.id },
            goal,
          );
          const style = {
            "--caption-accent": design.palette.highlight,
            "--caption-border": design.palette.border,
            "--caption-text": design.palette.text,
            "--caption-panel": design.palette.background,
            "--caption-highlight-stroke":
              design.palette.highlight === "#181818"
                ? "#fffdf7"
                : design.palette.stroke || "#172033",
          } as CSSProperties;
          return (
            <button
              type="button"
              className={profile.mood === item.id ? "active" : ""}
              aria-pressed={profile.mood === item.id}
              disabled={disabled}
              key={item.id}
              onClick={() => setProfile({ ...profile, mood: item.id })}
            >
              <span
                className={`captionStyleSample ${design.tone}`}
                style={style}
                aria-hidden="true"
              >
                今日の<em>おすすめ</em>
              </span>
              <strong>{item.label}</strong>
              <small>{item.note}</small>
              <i aria-hidden="true">
                {profile.mood === item.id ? "✓" : ""}
              </i>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function personalPreferenceStorageLabel(
  status: PersonalEditPreferencesSyncStatus,
) {
  switch (status) {
    case "authenticated":
      return "アカウントに保存";
    case "checking":
      return "保存先を確認中";
    case "unavailable":
      return "この端末に保存（同期は一時停止）";
    default:
      return "この端末に保存";
  }
}

function PersonalDictionaryEditor({
  entries,
  onChange,
  syncStatus,
}: {
  entries: PronunciationDictionaryEntry[];
  onChange: (entries: PronunciationDictionaryEntry[]) => void;
  syncStatus: PersonalEditPreferencesSyncStatus;
}) {
  const [display, setDisplay] = useState("");
  const [reading, setReading] = useState("");
  const normalizedCandidate = normalizePronunciationDictionary([
    { display, reading },
  ])[0];
  const duplicate = Boolean(
    normalizedCandidate &&
      entries.some(
        (entry) =>
          dictionaryMatchKey(entry.display) === normalizedCandidate.matchKey,
      ),
  );
  const atLimit =
    entries.length >= PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryEntries;
  const canAdd = Boolean(normalizedCandidate && !duplicate && !atLimit);

  function addEntry() {
    if (!canAdd || !normalizedCandidate) return;
    onChange([
      { display: normalizedCandidate.display, reading: normalizedCandidate.reading },
      ...entries,
    ]);
    setDisplay("");
    setReading("");
  }

  return (
    <details className="personalDictionaryPanel">
      <summary>
        <span aria-hidden="true">読</span>
        <div>
          <strong>名前や商品名の読み方を記憶</strong>
          <small>一度直した言葉を、次の動画でも自動で使います</small>
        </div>
        <b>{entries.length}件</b>
      </summary>
      <div className="personalDictionaryBody">
        <p className="personalDictionaryIntro">
          元音声の文字起こしでは正しい表記の参考にし、AIナレーションでは台本内の同じ言葉へ読み方を反映します。登録・削除だけではAI処理回数や料金は増えません。
        </p>
        {entries.length > 0 && (
          <ul className="personalDictionaryEntries" aria-label="記憶した読み方">
            {entries.map((entry) => (
              <li key={dictionaryMatchKey(entry.display)}>
                <span>
                  <strong>{entry.display}</strong>
                  <small>読み：{entry.reading}</small>
                </span>
                <button
                  type="button"
                  aria-label={`${entry.display}の読み方を削除`}
                  onClick={() =>
                    onChange(
                      entries.filter(
                        (candidate) =>
                          dictionaryMatchKey(candidate.display) !==
                          dictionaryMatchKey(entry.display),
                      ),
                    )
                  }
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="personalDictionaryForm">
          <label>
            <span>動画に表示する言葉</span>
            <input
              value={display}
              maxLength={PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryDisplayCharacters}
              placeholder="例：撮るだけリール"
              onChange={(event) => setDisplay(event.target.value)}
            />
          </label>
          <label>
            <span>AI音声での読み方</span>
            <input
              value={reading}
              maxLength={PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryReadingCharacters}
              placeholder="例：とるだけりーる"
              onChange={(event) => setReading(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canAdd) {
                  event.preventDefault();
                  addEntry();
                }
              }}
            />
          </label>
          <button type="button" disabled={!canAdd} onClick={addEntry}>
            読み方を記憶
          </button>
        </div>
        {duplicate && (
          <small className="personalDictionaryFeedback" role="status">
            この言葉は登録済みです。いったん削除して登録し直してください。
          </small>
        )}
        {atLimit && (
          <small className="personalDictionaryFeedback" role="status">
            読み方は{PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryEntries}件まで記憶できます。
          </small>
        )}
        <p className="personalDictionaryStorage">
          <span aria-hidden="true">✓</span>
          {personalPreferenceStorageLabel(syncStatus)}
        </p>
      </div>
    </details>
  );
}

function SetupWorkspace({
  file,
  isDemoSample,
  selectedVideoDuration,
  videoUrl,
  goal,
  setGoal,
  captionProfile,
  length,
  setLength,
  audioMode,
  setAudioMode,
  spokenCaptionsEnabled,
  setSpokenCaptionsEnabled,
  spokenCutMode,
  setSpokenCutMode,
  asrDictionaryInput,
  setAsrDictionaryInput,
  narrationStyle,
  setNarrationStyle,
  narrationOriginalAudio,
  setNarrationOriginalAudio,
  narrationBrief,
  setNarrationBrief,
  narrationCaptionsEnabled,
  setNarrationCaptionsEnabled,
  narrationAutoCutEnabled,
  setNarrationAutoCutEnabled,
  personalPreferencesSyncStatus,
  personalDictionary,
  setPersonalDictionary,
  silentFallback,
  chooseSilentNarration,
  finishSilentWithoutCaptions,
  chooseAnother,
  startEditing,
  error,
}: {
  file: File | null;
  isDemoSample: boolean;
  selectedVideoDuration: number;
  videoUrl: string;
  goal: Goal;
  setGoal: (goal: Goal) => void;
  captionProfile: CaptionProfile;
  length: number;
  setLength: (length: number) => void;
  audioMode: VideoAudioMode;
  setAudioMode: (mode: VideoAudioMode) => void;
  spokenCaptionsEnabled: boolean;
  setSpokenCaptionsEnabled: (enabled: boolean) => void;
  spokenCutMode: SpokenCutMode;
  setSpokenCutMode: (mode: SpokenCutMode) => void;
  asrDictionaryInput: string;
  setAsrDictionaryInput: (value: string) => void;
  narrationStyle: NarrationStyle;
  setNarrationStyle: (style: NarrationStyle) => void;
  narrationOriginalAudio: NarrationOriginalAudioLevel;
  setNarrationOriginalAudio: (
    percent: NarrationOriginalAudioLevel,
  ) => void;
  narrationBrief: string;
  setNarrationBrief: (brief: string) => void;
  narrationCaptionsEnabled: boolean;
  setNarrationCaptionsEnabled: (enabled: boolean) => void;
  narrationAutoCutEnabled: boolean;
  setNarrationAutoCutEnabled: (enabled: boolean) => void;
  personalPreferencesSyncStatus: PersonalEditPreferencesSyncStatus;
  personalDictionary: PronunciationDictionaryEntry[];
  setPersonalDictionary: (entries: PronunciationDictionaryEntry[]) => void;
  silentFallback: boolean;
  chooseSilentNarration: () => void;
  finishSilentWithoutCaptions: () => void;
  chooseAnother: () => void;
  startEditing: () => Promise<void>;
  error: string;
}) {
  const [sourceOrientation, setSourceOrientation] = useState("動画");
  const sanitizedAsrDictionary = useMemo(
    () => sanitizeAsrUserDictionary(asrDictionaryInput),
    [asrDictionaryInput],
  );
  const asrDictionaryCandidateCount = useMemo(
    () =>
      asrDictionaryInput
        .split(/[,、，\n\r\t]+/u)
        .filter((term) => term.trim()).length,
    [asrDictionaryInput],
  );
  const isIosDevice =
    typeof navigator !== "undefined" &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  const keepsOriginalVideo =
    audioMode === "narration"
      ? !narrationAutoCutEnabled
      : spokenCutMode === "none";
  const recommendedPresetTitle =
    audioMode === "narration"
      ? narrationAutoCutEnabled
        ? `${length}秒以内に整え、AIナレーションで伝える`
        : "元動画の順番と長さを保ち、AIナレーションで伝える"
      : spokenCutMode === "auto"
        ? `${length}秒以内を目安に、会話を活かして自動編集`
        : spokenCutMode === "manual"
          ? "手動で選んだ区間だけをつないで仕上げる"
          : "元動画の順番と長さを保ち、音声を活かす";

  return (
    <section className="workspace">
      <div className="workspaceHeading">
        <div>
          <p className="eyebrow">新しい動画</p>
          <h1>どんなリールにしますか？</h1>
          <p>
            会話・解説を活かすか、AIナレーションで伝え直すかを選べます。
          </p>
        </div>
        <span>ステップ 1 / 2</span>
      </div>

      <div className="setupGrid">
        <aside className="sourceCard">
          <div className="sourcePreview">
            {videoUrl ? (
              <video
                src={videoUrl}
                controls
                muted
                playsInline
                onLoadedMetadata={(event) => {
                  const { videoWidth, videoHeight } = event.currentTarget;
                  const ratio = videoWidth / Math.max(1, videoHeight);
                  setSourceOrientation(
                    ratio > 1.08
                      ? "横動画"
                      : ratio < 0.92
                        ? "縦動画"
                        : "正方形動画",
                  );
                }}
              />
            ) : (
              <div className="sampleSource">
                <video
                  src="/demo/torudake-demo.mp4"
                  controls
                  muted
                  playsInline
                  preload="metadata"
                  aria-label="編集に使用するサンプル動画"
                >
                  <track
                    kind="captions"
                    src="/demo/torudake-demo-ja.vtt"
                    srcLang="ja"
                    label="日本語"
                  />
                </video>
                <span>実際のサンプル動画</span>
              </div>
            )}
            <i>元動画</i>
          </div>
          <div className="fileRow">
            <span className="fileIcon">▶</span>
            <p>
              <strong>{file?.name ?? "sample_reel_video.mp4"}</strong>
              <small>
                {file ? `${Math.max(file.size / 1024 / 1024, 0.1).toFixed(1)}MB` : "18.4MB"}・{sourceOrientation}
              </small>
            </p>
            <button onClick={chooseAnother}>変更</button>
          </div>
          <div className="localNote">
            <span>●</span>
            {audioMode === "narration"
              ? "元の話し声をAI音声へ置き換えたい動画にも使えます。初期設定では元動画の音を0%にします。"
              : "iPhoneのMOVや25MBを超える動画は、端末内で音声だけを取り出し、選んだ設定に応じてカット判定やテロップ作成に使用します（最大500MB）。"}
          </div>
        </aside>

        <div className="setupForm">
          {silentFallback && (
            <section className="silentFallback" aria-labelledby="silentFallbackTitle">
              <span className="silentFallbackIcon" aria-hidden="true">♪</span>
              <div>
                <p className="eyebrow">音声がありません</p>
                <h2 id="silentFallbackTitle">話し声のない動画でした</h2>
                <p>
                  エラーで止めず、動画に合う2つの仕上げ方から選べます。
                </p>
                <div className="silentFallbackActions">
                  <button type="button" onClick={chooseSilentNarration}>
                    <strong>AIナレーションを付ける</strong>
                    <small>元動画はカットせず、声とテロップを追加</small>
                  </button>
                  <button type="button" onClick={finishSilentWithoutCaptions}>
                    <strong>音声なしのまま仕上げる</strong>
                    <small>カットもテロップもせず、元動画をそのまま使用</small>
                  </button>
                </div>
              </div>
            </section>
          )}

          {!silentFallback && (
          <>
          <section className="setupQuickStart" aria-labelledby="quickStartTitle">
            <div className="setupQuickStartHeading">
              <div>
                <span>おすすめ</span>
                <h2 id="quickStartTitle">おすすめで作る</h2>
              </div>
              <p>会話・解説を活かすか、AI音声で伝え直すかを選べます。</p>
            </div>
            <fieldset className="quickAudioMode">
              <legend>音声の仕上げ方</legend>
              <div className="audioModeCards">
                <button
                  type="button"
                  className={audioMode === "spoken" ? "selected" : ""}
                  aria-pressed={audioMode === "spoken"}
                  onClick={() => setAudioMode("spoken")}
                >
                  <i aria-hidden="true">元</i>
                  <strong>元の音声を活かす</strong>
                  <small>会話・解説がある動画におすすめ。元の声を活かして編集し、テロップは必要なときだけ追加</small>
                  <b>{audioMode === "spoken" ? "✓" : ""}</b>
                </button>
                <button
                  type="button"
                  className={audioMode === "narration" ? "selected" : ""}
                  aria-pressed={audioMode === "narration"}
                  aria-describedby={isDemoSample ? "sampleNarrationNotice" : undefined}
                  disabled={isDemoSample}
                  onClick={() => {
                    setAudioMode("narration");
                    setNarrationOriginalAudio(0);
                  }}
                >
                  <i aria-hidden="true">AI</i>
                  <strong>AIナレーションにする</strong>
                  <small>話し声のない動画、または元の声をAI音声へ置き換えたいとき</small>
                  <b>{audioMode === "narration" ? "✓" : ""}</b>
                </button>
              </div>
              {isDemoSample && (
                <p id="sampleNarrationNotice" className="optionCostNote" role="status">
                  サンプルは元音声モードのみです。API利用や無料体験の回数を消費せずに仕上がりを確認できます。
                </p>
              )}
            </fieldset>

            <div className="recommendedPreset">
              <span aria-hidden="true">{audioMode === "spoken" ? "声" : "AI"}</span>
              <p>
                <strong>
                  {audioMode === "spoken"
                    ? "会話・解説をそのまま活かしたい動画におすすめ"
                    : "元の声を使わず、AI音声で伝え直す設定"}
                </strong>
                <small>
                  {audioMode === "spoken"
                    ? spokenCaptionsEnabled
                      ? "AI音声は追加せず、話した内容をテロップにも表示します。"
                      : "AI音声とテロップは追加しません。おまかせ編集では、自然なカット判定のために音声を解析します。"
                    : narrationOriginalAudio === 0
                      ? "元動画の音量は0%です。環境音やBGMを残したい場合だけ調整できます。"
                      : `元動画の音量は${Math.round(narrationOriginalAudio)}%です。話し声を重ねたくない場合は0%にしてください。`}
                </small>
              </p>
            </div>

            <div className="recommendedPreset" role="status">
              <span aria-hidden="true">✦</span>
              <p>
                <strong>
                  {recommendedPresetTitle}
                </strong>
                <small>
                  {audioMode === "spoken" && !spokenCaptionsEnabled
                    ? "元音声ではテロップを付けない設定です。必要な場合だけ「細かく設定」から追加できます。"
                    : "テロップは見やすい設定で作成し、色とデザインは仕上がりを見てから無料で変更できます。"}
                </small>
              </p>
            </div>
          </section>

          <details className="advancedSettings">
            <summary>
              <span>
                <strong>細かく設定</strong>
                <small>目的・長さ・カット・声・テロップ・環境音の音量を調整</small>
              </span>
              <b aria-hidden="true">＋</b>
            </summary>
            <div className="advancedSettingsBody">

          <fieldset>
            <legend>
              <span>01</span>
              この動画の目的
            </legend>
            <div className="optionCards three">
              {goals.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={goal === item.id ? "selected" : ""}
                  aria-pressed={goal === item.id}
                  onClick={() => setGoal(item.id)}
                >
                  <i>{item.icon}</i>
                  <strong>{item.title}</strong>
                  <small>{item.note}</small>
                  <b>{goal === item.id ? "✓" : ""}</b>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>
              <span>02</span>
              動画の長さ
            </legend>
            {keepsOriginalVideo ? (
              <div className="originalLengthSelection" role="status">
                <span aria-hidden="true">▶</span>
                <p>
                  <strong>元動画の長さ</strong>
                  <small>冒頭から最後まで、映像の尺を変えずに使用します。</small>
                </p>
                <b>選択中</b>
              </div>
            ) : (
              <div className="lengthOptions">
                {[30, 60, 90].map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={length === item ? "selected" : ""}
                    aria-pressed={length === item}
                    onClick={() => setLength(item)}
                  >
                    <strong>{item}</strong>
                    {audioMode === "spoken" && spokenCutMode === "manual"
                      ? "秒を目安"
                      : "秒以内"}
                    <small>
                      {item === 30 ? "短く強く" : item === 60 ? "おすすめ" : "しっかり解説"}
                    </small>
                  </button>
                ))}
              </div>
            )}
            <p className="optionCostNote">
              {audioMode === "narration"
                ? narrationAutoCutEnabled
                  ? "AI音声は自然な1倍速のまま、選んだ長さ以内に映像とテロップをまとめます。"
                  : "映像は元動画の長さのままです。AIナレーションは最大90秒で映像に収まる自然な長さにし、音声が終わった後も映像は最後まで続きます。"
                  : spokenCutMode === "auto"
                  ? "テロップを付けない場合も、自然なカット判定のため元動画の音声を1度だけ解析します。構成判定は端末内で行い、追加のAI呼び出しはしません。"
                  : spokenCutMode === "manual"
                    ? "話している区間をすべて残した状態から、自分で使わない部分を選べます。選んだ長さは仕上がりの目安です。"
                    : spokenCaptionsEnabled
                      ? "映像・順番・動画の長さは変えません。テロップと字幕データのために1度だけ文字起こしします。"
                      : "映像・順番・動画の長さは変えず、文字起こしやテロップ作成も行いません。"}
            </p>
          </fieldset>

          {audioMode === "spoken" && (
            <fieldset className="spokenOutputSetup">
              <legend>
                <span>03</span>
                元音声動画の仕上げ
              </legend>
              <div className="narrationOutputOptions">
                <div className="narrationOutputOption">
                  <p className="narrationOptionLabel">テロップ</p>
                  <div className="narrationChoiceCards">
                    <button
                      type="button"
                      className={!spokenCaptionsEnabled ? "selected" : ""}
                      aria-pressed={!spokenCaptionsEnabled}
                      onClick={() => setSpokenCaptionsEnabled(false)}
                    >
                      <strong>テロップを付けない</strong>
                      <small>元の話し声をそのまま聞かせる</small>
                      <b>おすすめ</b>
                    </button>
                    <button
                      type="button"
                      className={spokenCaptionsEnabled ? "selected" : ""}
                      aria-pressed={spokenCaptionsEnabled}
                      onClick={() => setSpokenCaptionsEnabled(true)}
                    >
                      <strong>自動テロップを付ける</strong>
                      <small>話した内容を画面にも表示したいとき</small>
                    </button>
                  </div>
                </div>
                <div className="narrationOutputOption">
                  <p className="narrationOptionLabel">映像の仕上げ方</p>
                  <div className="narrationChoiceCards three">
                    <button
                      type="button"
                      className={spokenCutMode === "auto" ? "selected" : ""}
                      aria-pressed={spokenCutMode === "auto"}
                      onClick={() => setSpokenCutMode("auto")}
                    >
                      <strong>おまかせ編集</strong>
                      <small>言い淀みや長い間を外し、選んだ長さ以内へ編集</small>
                      <b>おすすめ</b>
                    </button>
                    <button
                      type="button"
                      className={spokenCutMode === "manual" ? "selected" : ""}
                      aria-pressed={spokenCutMode === "manual"}
                      onClick={() => setSpokenCutMode("manual")}
                    >
                      <strong>自分で選んでカット</strong>
                      <small>文字起こし後、文章ごとに使う区間を選ぶ</small>
                    </button>
                    <button
                      type="button"
                      className={spokenCutMode === "none" ? "selected" : ""}
                      aria-pressed={spokenCutMode === "none"}
                      onClick={() => setSpokenCutMode("none")}
                    >
                      <strong>カットしない</strong>
                      <small>映像・順番・元の音声・動画の長さを変えない</small>
                    </button>
                  </div>
                  {spokenCutMode === "manual" && (
                    <div className="keepOriginalPromise manual" role="status">
                      <span aria-hidden="true">✂</span>
                      <p>
                        <strong>文字起こし後に、残す文章を自分で選べます</strong>
                        <small>プレビュー・元音声・テロップ・書き出しへ同じ選択を反映します。</small>
                      </p>
                    </div>
                  )}
                  {spokenCutMode === "none" && (
                    <div className="keepOriginalPromise" role="status">
                      <span aria-hidden="true">✓</span>
                      <p>
                        <strong>元動画をカットせず、そのまま使います</strong>
                        <small>テロップの有無だけを選んで仕上げられます。</small>
                      </p>
                    </div>
                  )}
                </div>
              </div>
              <label className="asrDictionaryField">
                <span>
                  商品名・人名・地名の表記 <small>任意</small>
                  <b>{sanitizedAsrDictionary.length} / {MAX_ASR_DICTIONARY_TERMS}語</b>
                </span>
                <textarea
                  value={asrDictionaryInput}
                  maxLength={360}
                  rows={3}
                  placeholder="例：撮るだけリール、山田太郎、渋谷スクランブルスクエア"
                  aria-describedby="asrDictionaryHelp"
                  onChange={(event) =>
                    setAsrDictionaryInput(event.target.value)
                  }
                />
                <small id="asrDictionaryHelp">
                  カンマ「、」または改行で区切り、12語まで入力できます。正しい漢字表記を文字起こしの参考にします。追加のAI処理回数やAPI呼び出しは増えません。
                </small>
                {asrDictionaryInput.trim() &&
                  sanitizedAsrDictionary.length === 0 && (
                    <em role="status">
                      文章ではなく、商品名・人名・地名を短い語句で入力してください。
                    </em>
                  )}
                {asrDictionaryCandidateCount > MAX_ASR_DICTIONARY_TERMS && (
                  <em role="status">
                    先頭の12語だけを文字起こしに使用します。
                  </em>
                )}
              </label>
            </fieldset>
          )}

          {audioMode === "narration" && (
            <fieldset className="narrationSetup">
              <legend>
                <span>03</span>
                AIナレーションの仕上げ
              </legend>
              <p className="narrationOptionLabel">声の雰囲気</p>
              <div className="narrationStyleCards">
                {NARRATION_STYLES.map((style) => (
                  <button
                    type="button"
                    key={style.id}
                    data-style={style.id}
                    className={narrationStyle === style.id ? "selected" : ""}
                    aria-pressed={narrationStyle === style.id}
                    onClick={() => setNarrationStyle(style.id)}
                  >
                    <strong>{style.label}</strong>
                    <small>{style.note}</small>
                  </button>
                ))}
              </div>
              <OriginalAudioMixControl
                value={narrationOriginalAudio}
                onChange={setNarrationOriginalAudio}
              />
              <div className="narrationOutputOptions">
                <div className="narrationOutputOption">
                  <p className="narrationOptionLabel">テロップ</p>
                  <div className="narrationChoiceCards">
                    <button
                      type="button"
                      className={narrationCaptionsEnabled ? "selected" : ""}
                      aria-pressed={narrationCaptionsEnabled}
                      onClick={() => setNarrationCaptionsEnabled(true)}
                    >
                      <strong>テロップを付ける</strong>
                      <small>AI音声と同じ内容を見やすく表示</small>
                      <b>おすすめ</b>
                    </button>
                    <button
                      type="button"
                      className={!narrationCaptionsEnabled ? "selected" : ""}
                      aria-pressed={!narrationCaptionsEnabled}
                      onClick={() => setNarrationCaptionsEnabled(false)}
                    >
                      <strong>テロップを付けない</strong>
                      <small>映像とAI音声だけでシンプルに仕上げる</small>
                    </button>
                  </div>
                </div>
                <div className="narrationOutputOption">
                  <p className="narrationOptionLabel">映像の仕上げ方</p>
                  <div className="narrationChoiceCards">
                    <button
                      type="button"
                      className={!narrationAutoCutEnabled ? "selected" : ""}
                      aria-pressed={!narrationAutoCutEnabled}
                      onClick={() => setNarrationAutoCutEnabled(false)}
                    >
                      <strong>元動画を保ち、AI音声で伝える</strong>
                      <small>映像・順番・再生速度・動画の長さを変えない</small>
                      <b>おすすめ</b>
                    </button>
                    <button
                      type="button"
                      className={narrationAutoCutEnabled ? "selected" : ""}
                      aria-pressed={narrationAutoCutEnabled}
                      onClick={() => setNarrationAutoCutEnabled(true)}
                    >
                      <strong>AIで短く編集</strong>
                      <small>AI音声に合わせて映像を短くつなぎ直す</small>
                    </button>
                  </div>
                  {!narrationAutoCutEnabled && (
                    <div className="keepOriginalPromise" role="status">
                      <span aria-hidden="true">✓</span>
                      <p>
                        <strong>元動画の映像と長さは変更しません</strong>
                        <small>AI音声を主役にして、必要なテロップを追加します。元動画の音は下で調整できます。</small>
                      </p>
                    </div>
                  )}
                </div>
              </div>
              <label className="narrationBrief">
                <span>伝えたい内容・商品名など <small>任意</small></span>
                <textarea
                  value={narrationBrief}
                  maxLength={800}
                  rows={3}
                  placeholder="例：新作のバッグ。軽さと内ポケットの使いやすさを伝えたい"
                  onChange={(event) => setNarrationBrief(event.target.value)}
                />
                <small>
                  映像から分からない固有名詞や価格だけ補足すると、創作を防いで自然に仕上がります。
                </small>
              </label>
            </fieldset>
          )}

          <div className="personalRecipeNotice" role="status">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>この設定を「いつもの仕上がり」として記憶</strong>
              <small>
                次の動画では、音声モード・長さ・テロップ・カット・元音量を自動で呼び戻します。
              </small>
            </div>
            <b>{personalPreferenceStorageLabel(personalPreferencesSyncStatus)}</b>
          </div>

          <PersonalDictionaryEditor
            entries={personalDictionary}
            onChange={setPersonalDictionary}
            syncStatus={personalPreferencesSyncStatus}
          />

          <div className="autoTelopNote">
            <span aria-hidden="true">Aa</span>
            <div>
              <strong>
                {audioMode === "narration" && !narrationCaptionsEnabled
                  ? "テロップなしで、映像とAI音声を主役に"
                  : audioMode === "spoken" && !spokenCaptionsEnabled
                    ? "テロップなしで、映像と元の音声を主役に"
                    : `「${CAPTION_MOODS.find((item) => item.id === captionProfile.mood)?.label ?? "ナチュラル"}」のテロップで仕上げます`}
              </strong>
              <p>
                {audioMode === "narration"
                  ? narrationCaptionsEnabled
                    ? "ナレーションの文の切れ目に合わせ、音声と同じ内容をリッチなテロップで表示します。"
                    : "プレビューと書き出し動画のどちらにもテロップを重ねません。字幕データは別途保存できます。"
                  : spokenCaptionsEnabled
                    ? "冒頭・数字・強調したい言葉を見分け、選んだ雰囲気のままプレビューと書き出しへ反映します。"
                    : "プレビューと書き出し動画のどちらにもテロップを重ねません。字幕データは別途保存できます。"}
              </p>
            </div>
            <small>
              {audioMode === "narration"
                ? narrationCaptionsEnabled
                  ? "テロップあり"
                  : "テロップなし"
                : spokenCaptionsEnabled
                  ? "デザイン変更は追加料金なし"
                  : "テロップなし"}
            </small>
          </div>

              <p className="captionAfterPreviewNote">
                テロップのデザインと色は、仕上がりプレビューを見ながら何度でも変更できます。見た目の変更ではAI処理の回数を使用しません。
              </p>
            </div>
          </details>

          <div className="editSummary">
            {isIosDevice && selectedVideoDuration > 120 && keepsOriginalVideo && (
              <p className="editError" role="status">
                <span>!</span>
                iPhone・iPadでは120秒を超えるノーカット動画の書き出しが端末のメモリ不足で止まることがあります。「おまかせ編集」または「AIで短く編集」で90秒以内にすると安定します。
              </p>
            )}
            <div>
              <span>今回の編集方針</span>
              <p>
                <strong>{goals.find((item) => item.id === goal)?.title}</strong>
                ・
                {audioMode === "narration"
                  ? `「${NARRATION_STYLES.find((item) => item.id === narrationStyle)?.label}」のAI音声・環境音とBGM${Math.round(narrationOriginalAudio)}%・${narrationCaptionsEnabled ? "テロップあり" : "テロップなし"}・${narrationAutoCutEnabled ? "短く自動編集" : "元動画のまま"}`
                  : `${spokenCaptionsEnabled ? `${CAPTION_MOODS.find((item) => item.id === captionProfile.mood)?.label ?? "ナチュラル"}テロップ` : "テロップなし"}・${spokenCutMode === "auto" ? "おまかせ編集" : spokenCutMode === "manual" ? "自分で区間を選ぶ" : "カットしない"}`}
                ・{keepsOriginalVideo
                  ? "元動画の長さ"
                  : audioMode === "spoken" && spokenCutMode === "manual"
                    ? `目安${length}秒`
                    : `${length}秒以内`}
              </p>
            </div>
            <p className="optionCostNote">
              {audioMode === "narration"
                ? "初回のAI台本とAI音声は、まとめてAI処理を1回使用します。内部の自動調整では追加消費しません。"
                : spokenCutMode === "none" && !spokenCaptionsEnabled
                  ? "文字起こしやテロップ生成は行いません。"
                  : "この編集では、カット判定またはテロップ作成のため、音声解析にAI処理を1回使用します。動画を分割して処理しても追加消費しません。"}
              正常に完了したAI処理の回数は、この編集を保存せず終了した場合も戻りません。
            </p>
            <button className="mainCta" onClick={startEditing}>
              <span>
                {audioMode === "narration"
                  ? "AIナレーション付きで作る"
                  : spokenCutMode === "auto"
                    ? "おすすめ設定で作る"
                    : spokenCutMode === "manual"
                      ? "文字起こしして自分で選ぶ"
                      : "元動画の流れを保って仕上げる"}
              </span>
              <i>✦</i>
            </button>
          </div>
          {error && (
            <p className="editError" role="alert">
              <span>!</span>
              {error}
            </p>
          )}
          </>
          )}
        </div>
      </div>
    </section>
  );
}

function Processing({
  file,
  progress,
  highAccuracy,
  narration,
  spokenCaptionsEnabled,
  spokenCutMode,
  narrationCaptionsEnabled,
  narrationAutoCutEnabled,
  cancel,
}: {
  file: File | null;
  progress: number;
  highAccuracy: boolean;
  narration: boolean;
  spokenCaptionsEnabled: boolean;
  spokenCutMode: SpokenCutMode;
  narrationCaptionsEnabled: boolean;
  narrationAutoCutEnabled: boolean;
  cancel: () => void;
}) {
  const skipsSpokenAnalysis = Boolean(
    !narration && spokenCutMode === "none" && !spokenCaptionsEnabled,
  );
  const steps = narration
    ? [
        { threshold: 18, label: "場面を選んでいます", note: "動画全体から代表的な場面を抽出" },
        { threshold: 42, label: "構成を考えています", note: "映像の順序と目的から自然な台本を作成" },
        { threshold: 70, label: "AI音声を作っています", note: "選んだ雰囲気で日本語ナレーションを生成" },
        {
          threshold: 90,
          label: narrationCaptionsEnabled
            ? "テロップを合わせています"
            : "映像と音声を合わせています",
          note: narrationCaptionsEnabled
            ? "文の切れ目でAI音声とテロップを同期"
            : "テロップを重ねず、AI音声を自然に同期",
        },
        { threshold: 100, label: "仕上げ中", note: "投稿文とプレビューを準備" },
      ]
    : skipsSpokenAnalysis
      ? [
          {
            threshold: 88,
            label: "元動画を確認しています",
            note: "音声解析やテロップ生成をせず、映像・順番・長さを保持",
          },
          {
            threshold: 100,
            label: "仕上げ中",
            note: "元動画の流れを保ったプレビューを準備",
          },
        ]
      : [
    { threshold: 18, label: "音声を整えています", note: "音量をそろえて声を聞き取りやすく調整" },
    {
      threshold: 42,
      label: highAccuracy ? "高精度で文字起こし中" : "文字起こし中",
      note: highAccuracy
        ? "2つの認識結果を照合して言葉を補正"
        : "日本語の発話と時刻を一度で取得",
    },
    { threshold: 68, label: "時刻を合わせています", note: "発話の開始と終了を同期" },
    {
      threshold: 88,
      label:
        spokenCutMode === "auto"
          ? "自然に再構成中"
          : spokenCutMode === "manual"
            ? "手動カットを準備中"
            : "元動画を確認中",
      note:
        spokenCutMode === "auto"
          ? "文の切れ目で指定時間へ編集"
          : spokenCutMode === "manual"
            ? "文章ごとに残す区間を選べる状態へ準備"
            : "映像・順番・長さを変えずに保持",
    },
    {
      threshold: 100,
      label: "仕上げ中",
      note: spokenCaptionsEnabled
        ? "選んだ映像の流れとテロップを準備"
        : "テロップを重ねずにプレビューを準備",
    },
  ];
  const activeIndex = steps.findIndex((step) => progress <= step.threshold);

  return (
    <section className="processingPage">
      <div className="processingCard">
        <div className="processingVisual">
          <div className="processingPhone">
            <CreatorFigure variant="after" />
            <span className="scanLine" />
            <div className="captionGhost">
              <i />
              <i />
            </div>
          </div>
          <span className="orbit one">✦</span>
          <span className="orbit two">
            {narration
              ? narrationAutoCutEnabled
                ? "短く編集"
                : "長さを保持"
              : spokenCutMode === "auto"
                ? "自動"
                : spokenCutMode === "manual"
                  ? "手動"
                  : "長さを保持"}
          </span>
          <span className="orbit three">
            {(narration
              ? narrationCaptionsEnabled
              : spokenCaptionsEnabled)
              ? "字幕"
              : "音声"}
          </span>
        </div>

        <div className="processingCopy">
          <p className="eyebrow">
            {skipsSpokenAnalysis ? "端末内で準備中" : "AIで編集中"}
          </p>
          <h1>投稿できる状態に整えています。</h1>
          <p>
            {file?.name ?? "サンプル動画"}の
            {narration
              ? `場面を読み取り、映像に合う台本とAI音声を作っています。${narrationAutoCutEnabled ? "選んだ長さを目安に映像をつなぎます。" : "元動画はカットしません。"}${narrationCaptionsEnabled ? "テロップも同期します。" : "テロップは付けません。"}`
              : skipsSpokenAnalysis
                ? "音声解析やテロップ生成をせず、元動画の映像・順番・長さを保って仕上げています。"
                : `${highAccuracy ? "言葉を高精度で確認し、" : "音量と発話区間を整え、"}${spokenCutMode === "auto" ? "音声に合わせて映像を自然につなぎ直しています。" : spokenCutMode === "manual" ? "文章ごとに残す区間を選べる状態へ準備しています。" : "元動画の映像・順番・長さを保って仕上げています。"}${spokenCaptionsEnabled ? "テロップも準備します。" : "テロップは付けません。"}`}
          </p>
          <div className="bigProgress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="progressNumber">
            <strong>{progress}</strong>%
          </div>
          <div className="processingSteps">
            {steps.map((step, index) => (
              <div
                key={step.label}
                className={
                  progress > step.threshold
                    ? "done"
                    : index === activeIndex
                      ? "active"
                      : ""
                }
              >
                <span>{progress > step.threshold ? "✓" : index + 1}</span>
                <p>
                  <strong>{step.label}</strong>
                  <small>{step.note}</small>
                </p>
              </div>
            ))}
          </div>
          <button className="quietButton" type="button" onClick={cancel}>
            処理を中止して戻る
          </button>
        </div>
      </div>
    </section>
  );
}

function ResultWorkspace({
  file,
  videoUrl,
  audioMode,
  previewMode,
  spokenCaptionsEnabled,
  setSpokenCaptionsEnabled,
  spokenCutMode,
  transcript,
  setTranscript,
  keptLines,
  goal,
  captionProfile,
  setCaptionProfile,
  length,
  notify,
  reset,
  chooseVideo,
  regenerateHighAccuracy,
  usedHighAccuracy,
  narrationPlan,
  setNarrationPlan,
  narrationAudioUrl,
  initialNarrationPronunciationGuide,
  narrationStyle,
  narrationGenerationsRemaining,
  narrationGenerationLimit,
  narrationOriginalAudio,
  narrationCaptionsEnabled,
  setNarrationCaptionsEnabled,
  narrationAutoCutEnabled,
  setNarrationAutoCutEnabled,
  usageReservationId,
  usageBucket,
  usageReservationPendingExport,
  setNarrationOriginalAudio,
  rememberPronunciationEntries,
  regenerateNarration,
  regenerateNarrationSegment,
  applyNarrationSegmentCorrection,
  checkPaidExportAccess,
  isCheckingPaidExportAccess,
  markCheckoutStarted,
  checkoutReturnMessage,
  markExportReservationCompleted,
  setExportReservationFinalizing,
  cancelPendingExportReservation,
}: {
  file: File | null;
  videoUrl: string;
  audioMode: VideoAudioMode;
  previewMode: PreviewMode;
  spokenCaptionsEnabled: boolean;
  setSpokenCaptionsEnabled: (enabled: boolean) => void;
  spokenCutMode: SpokenCutMode;
  transcript: TranscriptLine[];
  setTranscript: (lines: TranscriptLine[]) => void;
  keptLines: TranscriptLine[];
  goal: Goal;
  captionProfile: CaptionProfile;
  setCaptionProfile: (profile: CaptionProfile) => void;
  length: number;
  notify: (message: string) => void;
  reset: () => void;
  chooseVideo: () => void;
  regenerateHighAccuracy: () => Promise<void>;
  usedHighAccuracy: boolean;
  narrationPlan: NarrationPlan | null;
  setNarrationPlan: (plan: NarrationPlan | null) => void;
  narrationAudioUrl: string;
  initialNarrationPronunciationGuide: string;
  narrationStyle: NarrationStyle;
  narrationGenerationsRemaining: number;
  narrationGenerationLimit: number;
  narrationOriginalAudio: NarrationOriginalAudioLevel;
  narrationCaptionsEnabled: boolean;
  setNarrationCaptionsEnabled: (enabled: boolean) => void;
  narrationAutoCutEnabled: boolean;
  setNarrationAutoCutEnabled: (enabled: boolean) => Promise<void>;
  usageReservationId: string | null;
  usageBucket: BillingBucket | null;
  usageReservationPendingExport: boolean;
  setNarrationOriginalAudio: (
    percent: NarrationOriginalAudioLevel,
  ) => void;
  rememberPronunciationEntries: (
    entries: PronunciationDictionaryEntry[],
  ) => void;
  regenerateNarration: (
    script: string,
    style: NarrationStyle,
    pronunciationGuide: string,
  ) => Promise<number>;
  regenerateNarrationSegment: (
    segmentIndex: number,
    deliveryPreset: NarrationDeliveryPreset,
    emphasisText: string,
  ) => Promise<NarrationSegmentCorrectionResult>;
  applyNarrationSegmentCorrection: (
    correction: NarrationSegmentCorrectionResult,
  ) => void;
  checkPaidExportAccess: () => Promise<boolean>;
  isCheckingPaidExportAccess: boolean;
  markCheckoutStarted: (plan: "starter" | "standard" | "one_time") => void;
  checkoutReturnMessage: string;
  markExportReservationCompleted: () => void;
  setExportReservationFinalizing: (finalizing: boolean) => void;
  cancelPendingExportReservation: () => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captionPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCaptionOverlayRef = useRef<
    (
      context: CanvasRenderingContext2D,
      canvas: HTMLCanvasElement,
      sourceTime: number,
    ) => void
  >(() => undefined);
  const narrationDraftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const narrationSampleAudioRef = useRef<HTMLAudioElement>(null);
  const narrationCorrectionAudioRefs = useRef<
    [HTMLAudioElement | null, HTMLAudioElement | null]
  >([null, null]);
  const previewNarrationEngineRef = useRef<{
    url: string;
    context: AudioContext;
    gain: GainNode;
    originalGain: GainNode | null;
    mediaSource: MediaElementAudioSourceNode | null;
    buffer: AudioBuffer | null;
    narrationActivity: ReturnType<typeof detectPortableNarrationActivity>;
    source: AudioBufferSourceNode | null;
    sourceOffset: number;
    sourceStartedAt: number;
    stateChangeHandler: () => void;
  } | null>(null);
  const previewNarrationLoadRef = useRef<Promise<AudioBuffer> | null>(null);
  const previewInternalSeekRef = useRef<{
    id: number;
    target: number;
    startedAt: number;
    cancel: () => void;
  } | null>(null);
  const previewSeekSequenceRef = useRef(0);
  const previewContinuousCutSeekRef = useRef(false);
  const previewPlaybackReadyRef = useRef(false);
  const previewHoldingFinalFrameRef = useRef(false);
  const previewOperationRef = useRef(0);
  const previewScrubbingRef = useRef(false);
  const previewScrubWasPlayingRef = useRef(false);
  const previewScrubTimeRef = useRef<number | null>(null);
  const captionEditStartTextRef = useRef(new Map<number, string>());
  const [currentTime, setCurrentTime] = useState(0);
  const [originalAudioNormalizationGain, setOriginalAudioNormalizationGain] =
    useState(1);
  const originalAudioMeasurementRef = useRef<
    Promise<PortableOriginalAudioMeasurement> | null
  >(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [sourceVideoDimensions, setSourceVideoDimensions] =
    useState<VideoDimensions | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTransportState, setPreviewTransportState] =
    useState<PreviewTransportState>("paused");
  const [scrubbedEditedTime, setScrubbedEditedTime] = useState<number | null>(
    null,
  );
  const [isExporting, setIsExporting] = useState(false);
  const isExportingRef = useRef(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportPageHidingRef = useRef(false);
  const exportFinalizingRef = useRef(false);
  const [isFinalizingExport, setIsFinalizingExport] = useState(false);
  const [exportedVideoFile, setExportedVideoFile] = useState<File | null>(null);
  const [exportedVideoQualityMessage, setExportedVideoQualityMessage] =
    useState<string | null>(null);
  const [exportedVideoRevision, setExportedVideoRevision] = useState<
    string | null
  >(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<
    "helpful" | "needs_work" | null
  >(null);
  const [feedbackTags, setFeedbackTags] = useState<string[]>([]);
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false);
  const [thumbnailCandidateId, setThumbnailCandidateId] = useState<
    string | null
  >(null);
  const [thumbnailTitleOverrides, setThumbnailTitleOverrides] = useState<
    Record<string, string>
  >({});
  const [thumbnailFrameChoices, setThumbnailFrameChoices] = useState<
    ThumbnailFrameChoice[]
  >([]);
  const [isAnalyzingThumbnailFrames, setIsAnalyzingThumbnailFrames] =
    useState(false);
  const [thumbnailAnalysisError, setThumbnailAnalysisError] = useState("");
  const [thumbnailAnalysisNote, setThumbnailAnalysisNote] = useState("");
  const [thumbnailAnalysisRevision, setThumbnailAnalysisRevision] =
    useState(0);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailRevision, setThumbnailRevision] = useState<string | null>(
    null,
  );
  const [isCaptionDesignerOpen, setIsCaptionDesignerOpen] = useState(false);
  const [narrationDraft, setNarrationDraft] = useState(
    narrationPlan?.script ?? "",
  );
  const initialPersonalPronunciationEntries = useMemo(
    () => {
      const validation = validateNarrationPronunciationGuide(
        initialNarrationPronunciationGuide,
      );
      if (validation.error) return [];
      return validation.entries
        .filter((entry) =>
          Boolean(narrationPlan?.script.includes(entry.surface)),
        )
        .map((entry) => ({
          display: entry.surface,
          reading: entry.reading,
        }));
    },
    [initialNarrationPronunciationGuide, narrationPlan?.script],
  );
  const initialPersonalPronunciationGuide = useMemo(
    () =>
      initialPersonalPronunciationEntries
        .map((entry) => `${entry.display} → ${entry.reading}`)
        .join("\n"),
    [initialPersonalPronunciationEntries],
  );
  const pronunciationRowSequenceRef = useRef(
    Math.max(1, initialPersonalPronunciationEntries.length),
  );
  const [narrationPronunciationRows, setNarrationPronunciationRows] = useState<
    NarrationPronunciationRow[]
  >(() =>
    initialPersonalPronunciationEntries.length
      ? initialPersonalPronunciationEntries.map((entry, index) => ({
          id: index,
          surface: entry.display,
          reading: entry.reading,
        }))
      : [{ id: 0, surface: "", reading: "" }],
  );
  const [usePronunciationCorrections, setUsePronunciationCorrections] =
    useState(initialPersonalPronunciationEntries.length > 0);
  const narrationPronunciationGuide = useMemo(
    () =>
      narrationPronunciationRows
        .filter((row) => row.surface.trim() || row.reading.trim())
        .map((row) => `${row.surface.trim()} → ${row.reading.trim()}`)
        .join("\n"),
    [narrationPronunciationRows],
  );
  const normalizedNarrationPronunciationGuide = useMemo(
    () => canonicalizeNarrationPronunciationGuide(narrationPronunciationGuide),
    [narrationPronunciationGuide],
  );
  const [lastAppliedPronunciationGuide, setLastAppliedPronunciationGuide] =
    useState(() =>
      canonicalizeNarrationPronunciationGuide(
        initialPersonalPronunciationGuide,
      ),
    );
  const [draftNarrationStyle, setDraftNarrationStyle] =
    useState<NarrationStyle>(narrationStyle);
  const [lastNarrationGenerationKey, setLastNarrationGenerationKey] = useState(
    () =>
      narrationGenerationKey(
        narrationPlan?.script ?? "",
        narrationStyle,
        initialPersonalPronunciationGuide,
      ),
  );
  const [isRegeneratingNarration, setIsRegeneratingNarration] =
    useState(false);
  const [selectedNarrationSegmentIndex, setSelectedNarrationSegmentIndex] =
    useState(0);
  const [narrationDeliveryPreset, setNarrationDeliveryPreset] =
    useState<NarrationDeliveryPreset>("natural");
  const [narrationEmphasisText, setNarrationEmphasisText] = useState("");
  const [narrationCorrectionCandidate, setNarrationCorrectionCandidate] =
    useState<NarrationSegmentCorrectionCandidate | null>(null);
  function stopNarrationCorrectionComparisonAudio(
    except: HTMLAudioElement | null = null,
  ) {
    narrationCorrectionAudioRefs.current.forEach((audio) => {
      if (!audio || audio === except) return;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        // The element may not have loaded metadata yet. Pausing is sufficient.
      }
    });
  }
  function clearNarrationCorrectionCandidate() {
    stopNarrationCorrectionComparisonAudio();
    setNarrationCorrectionCandidate(null);
  }
  const [isGeneratingNarrationCorrection, setIsGeneratingNarrationCorrection] =
    useState(false);
  const [isUpdatingNarrationCutMode, setIsUpdatingNarrationCutMode] =
    useState(false);
  useEffect(() => {
    const handlePageHide = () => {
      exportPageHidingRef.current = true;
      if (!exportFinalizingRef.current) exportAbortRef.current?.abort();
      videoRef.current?.pause();
    };
    const handlePageShow = () => {
      exportPageHidingRef.current = false;
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      exportPageHidingRef.current = true;
      if (!exportFinalizingRef.current) exportAbortRef.current?.abort();
    };
  }, []);
  const pronunciationValidation = useMemo(() => {
    const incompleteRowIndex = narrationPronunciationRows.findIndex(
      (row) => Boolean(row.surface.trim()) !== Boolean(row.reading.trim()),
    );
    if (incompleteRowIndex >= 0) {
      return {
        entries: [],
        error: `${incompleteRowIndex + 1}件目の「台本の言葉」と「正しい読み方」を両方入力してください。`,
      };
    }
    const validation = validateNarrationPronunciationGuide(
      narrationPronunciationGuide,
    );
    if (validation.error) return validation;
    const unmatchedEntry = validation.entries.find(
      (entry) =>
        countNarrationPronunciationOccurrences(
          narrationDraft.replace(/\s+/g, " ").trim(),
          entry.surface,
        ) === 0,
    );
    return unmatchedEntry
      ? {
          entries: validation.entries,
          error: `台本に「${unmatchedEntry.surface}」が見つかりません。台本と同じ表記で入力してください。`,
        }
      : validation;
  }, [
    narrationDraft,
    narrationPronunciationGuide,
    narrationPronunciationRows,
  ]);
  const pronunciationEntryCount = narrationPronunciationRows.filter(
    (row) => row.surface.trim() && row.reading.trim(),
  ).length;
  const canAddPronunciationRow =
    narrationPronunciationRows.length < 20 &&
    narrationPronunciationRows.every(
      (row) => row.surface.trim() && row.reading.trim(),
    );
  const hasPendingPronunciationChanges =
    normalizedNarrationPronunciationGuide !== lastAppliedPronunciationGuide;
  const pronunciationMatchCounts = useMemo(
    () =>
      new Map(
        narrationPronunciationRows.map((row) => [
          row.id,
          countNarrationPronunciationOccurrences(
            narrationDraft.replace(/\s+/g, " ").trim(),
            row.surface.replace(/\s+/g, " ").trim(),
          ),
        ]),
      ),
    [narrationDraft, narrationPronunciationRows],
  );
  const pendingNarrationGenerationKey = useMemo(
    () =>
      narrationGenerationKey(
        narrationDraft,
        draftNarrationStyle,
        narrationPronunciationGuide,
      ),
    [narrationDraft, draftNarrationStyle, narrationPronunciationGuide],
  );
  const hasPendingNarrationChanges =
    pendingNarrationGenerationKey !== lastNarrationGenerationKey;
  const narrationSegments = narrationPlan?.segments ?? [];
  const selectedNarrationSegment =
    narrationSegments[selectedNarrationSegmentIndex] ?? narrationSegments[0];
  const selectedNarrationSpeechText =
    selectedNarrationSegment?.speechText || selectedNarrationSegment?.text || "";
  const narrationEmphasisIsValid =
    narrationDeliveryPreset !== "emphasis" ||
    (Boolean(narrationEmphasisText.trim()) &&
      selectedNarrationSpeechText.includes(narrationEmphasisText.trim()));
  const narrationGenerationLimitReached =
    narrationGenerationsRemaining <= 0;
  const isSourceMetadataPending = Boolean(
    file && (sourceDuration <= 0 || !sourceVideoDimensions),
  );
  const isMediaBusy =
    isExporting ||
    isGeneratingThumbnail ||
    isAnalyzingThumbnailFrames ||
    isRegeneratingNarration ||
    isGeneratingNarrationCorrection ||
    isUpdatingNarrationCutMode ||
    isSourceMetadataPending;
  useEffect(() => {
    if (!file || !videoUrl) return;

    const controller = new AbortController();
    window.queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setIsAnalyzingThumbnailFrames(true);
      setThumbnailAnalysisError("");
      setThumbnailAnalysisNote("");
      void analyzeThumbnailFrameChoices(videoUrl, controller.signal)
        .then((analysis) => {
          if (controller.signal.aborted) return;
          setThumbnailFrameChoices(analysis.choices);
          setThumbnailCandidateId((current) =>
            analysis.choices.some((choice) => choice.id === current)
              ? current
              : (analysis.choices[0]?.id ?? null),
          );
          setThumbnailAnalysisNote(
            analysis.faceDetectionSupported
              ? analysis.detectedFaceCount > 0
                ? "顔・構図・明るさ・鮮明さ・場面変化を端末内で確認して選びました。顔が見やすい位置へ9:16で切り抜きます。"
                : "顔が見つからなかったため、明るさ・鮮明さ・構図・場面変化を端末内で確認して選びました。"
              : "この端末では顔検出に対応していないため、明るさ・鮮明さ・構図・場面変化から端末内で選びました。",
          );
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setThumbnailFrameChoices([]);
          setThumbnailCandidateId(null);
          setThumbnailAnalysisError(
            error instanceof Error
              ? error.message
              : "表紙候補を解析できませんでした。",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsAnalyzingThumbnailFrames(false);
        });
    });
    return () => controller.abort();
  }, [file, thumbnailAnalysisRevision, videoUrl]);
  useEffect(
    () => () => {
      if (narrationCorrectionCandidate?.originalPreviewUrl) {
        URL.revokeObjectURL(
          narrationCorrectionCandidate.originalPreviewUrl,
        );
      }
      if (narrationCorrectionCandidate?.correctedPreviewUrl) {
        URL.revokeObjectURL(
          narrationCorrectionCandidate.correctedPreviewUrl,
        );
      }
    },
    [narrationCorrectionCandidate],
  );
  const [showDisclosureConfirm, setShowDisclosureConfirm] = useState(false);
  const disclosureDialogRef = useRef<HTMLDivElement>(null);
  const disclosurePreviousFocusRef = useRef<HTMLElement | null>(null);
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false);
  const [isRecordingDisclosure, setIsRecordingDisclosure] = useState(false);
  useEffect(() => {
    if (!showDisclosureConfirm) return;
    disclosurePreviousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = disclosureDialogRef.current;
    window.queueMicrotask(() => dialog?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowDisclosureConfirm(false);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      const previous = disclosurePreviousFocusRef.current;
      disclosurePreviousFocusRef.current = null;
      window.queueMicrotask(() => previous?.focus());
    };
  }, [showDisclosureConfirm]);
  const [initialCutState] = useState(
    () =>
      new Map(
        transcript.map((line) => [line.id, line.removed] as const),
      ),
  );
  const [manuallyChangedCutIds, setManuallyChangedCutIds] = useState(
    () => new Set<number>(),
  );
  const captionDesign = useMemo(
    () => resolveCaptionDesign(captionProfile, goal),
    [captionProfile, goal],
  );
  const tone = captionDesign.tone;
  const editRanges = useMemo(
    () =>
      narrationPlan
        ? buildNarrationEditRanges(
            transcript,
            sourceDuration,
            narrationAutoCutEnabled,
          )
        : buildSpokenEditRanges(
            transcript,
            sourceDuration,
            spokenCutMode,
          ),
    [
      narrationAutoCutEnabled,
      narrationPlan,
      sourceDuration,
      spokenCutMode,
      transcript,
    ],
  );
  const editDuration = getEditedDuration(editRanges);
  const displayTranscript = useMemo(() => {
    if (editRanges.length === 0 || editDuration <= 0) return transcript;
    return fitCaptionDisplayTimelineWithinEditRanges(transcript, editRanges);
  }, [editDuration, editRanges, transcript]);
  const displayKeptLines = useMemo(
    () => displayTranscript.filter(isIncludedCaption),
    [displayTranscript],
  );
  useEffect(() => {
    const controller = new AbortController();
    window.queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setOriginalAudioNormalizationGain(1);
      }
    });
    if (!file || editRanges.length === 0) {
      originalAudioMeasurementRef.current = null;
      return () => controller.abort();
    }

    const measurementPromise = measurePortableOriginalAudioProfile(
      file,
      editRanges,
      controller.signal,
    );
    originalAudioMeasurementRef.current = measurementPromise;
    void measurementPromise.then((measurement) => {
      if (!controller.signal.aborted) {
        setOriginalAudioNormalizationGain(measurement.normalizationGain);
      }
    }).catch(() => undefined);
    return () => {
      controller.abort();
      if (originalAudioMeasurementRef.current === measurementPromise) {
        originalAudioMeasurementRef.current = null;
      }
    };
  }, [editRanges, file]);
  const previewRanges = useMemo(
    () => buildPreviewRanges(editRanges),
    [editRanges],
  );
  const editedTranscript = useMemo(
    () =>
      remapCaptionsToEditedTimeline(displayTranscript, editRanges).map(
        (line) => ({
          ...line,
          displayStart: line.start,
          displayEnd: line.end,
        }),
      ),
    [displayTranscript, editRanges],
  );
  const editedCurrentTime = sourceTimeToEditedTime(
    editRanges,
    currentTime,
  );
  const previewDisplayTime = scrubbedEditedTime ?? editedCurrentTime;
  const previewProgress =
    editDuration > 0
      ? Math.min(100, Math.max(0, (previewDisplayTime / editDuration) * 100))
      : 0;
  const previewStatusLabel =
    previewTransportState === "loading"
      ? "AI音声を準備中"
      : previewTransportState === "seeking"
        ? "移動中"
        : previewTransportState === "playing"
          ? narrationPlan
            ? "AI音声と同期再生中"
            : "再生中"
          : previewTransportState === "ended"
            ? "再生終了"
            : narrationPlan
              ? "AI音声を合成済み"
              : "停止中";
  const captionsVisible = narrationPlan
    ? narrationCaptionsEnabled
    : spokenCaptionsEnabled;
  const needsSpokenCaptionAnalysis = Boolean(
    !narrationPlan && !transcript.some((line) => line.text.trim().length > 0),
  );
  const unreadableCaptionCount = useMemo(
    () =>
      editedTranscript.filter((line) => {
        if (!line.text.trim()) return false;
        const display = getCaptionDisplayRange(line);
        return !assessCaptionReadability({
          ...line,
          start: display.start,
          end: display.end,
        }).readable;
      }).length,
    [editedTranscript],
  );
  const narrationKeepsFullVideo = Boolean(
    narrationPlan && !narrationAutoCutEnabled,
  );
  const activeCaption =
    displayKeptLines.find(
      (line) => {
        const display = getCaptionDisplayRange(line);
        return currentTime >= display.start && currentTime < display.end;
      },
    ) ?? (!videoUrl ? displayKeptLines[0] : undefined);
  const captionStyle = {
    "--caption-accent": captionDesign.palette.highlight,
    "--caption-border": captionDesign.palette.border,
    "--caption-text": captionDesign.palette.text,
    "--caption-panel": captionDesign.palette.background,
    "--caption-highlight-stroke":
      captionDesign.palette.highlight === "#181818"
        ? "#fffdf7"
        : captionDesign.palette.stroke || "#172033",
  } as CSSProperties;
  useEffect(() => {
    const canvas = captionPreviewCanvasRef.current;
    if (!canvas) return;
    let animationFrame = 0;
    const renderCaptionFrame = () => {
      const video = videoRef.current;
      const width =
        video?.videoWidth || sourceVideoDimensions?.width || 1080;
      const height =
        video?.videoHeight || sourceVideoDimensions?.height || 1920;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) return;
      context.clearRect(0, 0, width, height);
      if (captionsVisible) {
        drawCaptionOverlayRef.current(
          context,
          canvas,
          video?.currentTime ?? currentTime,
        );
      }
      if (isPlaying) {
        animationFrame = window.requestAnimationFrame(renderCaptionFrame);
      }
    };
    renderCaptionFrame();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    captionDesign,
    captionProfile,
    captionsVisible,
    currentTime,
    isPlaying,
    keptLines,
    sourceVideoDimensions,
    transcript,
  ]);
  const selectedThumbnailFrame =
    thumbnailFrameChoices.find(
      (choice) => choice.id === thumbnailCandidateId,
    ) ?? thumbnailFrameChoices[0];
  const thumbnailTitleSourceCaption = selectedThumbnailFrame
    ? keptLines
        .filter((line) => line.text.trim())
        .sort(
          (left, right) =>
            Math.abs((left.start + left.end) / 2 - selectedThumbnailFrame.time) -
            Math.abs((right.start + right.end) / 2 - selectedThumbnailFrame.time),
        )[0]
    : undefined;
  const thumbnailDefaultTitle = Array.from(
    thumbnailTitleSourceCaption?.text.trim() ||
      captionProfile.brandName.trim() ||
      "今日のハイライト",
  )
    .slice(0, 36)
    .join("");
  const thumbnailTitle = selectedThumbnailFrame
    ? (thumbnailTitleOverrides[selectedThumbnailFrame.id] ??
      thumbnailDefaultTitle)
    : "";
  const exportName =
    file?.name.replace(/\.[^.]+$/, "") ?? "sample_reel_video";
  const exportSuffix = narrationPlan
    ? narrationCaptionsEnabled
      ? "narrated_captioned"
      : "narrated"
    : spokenCaptionsEnabled
      ? spokenCutMode === "none"
        ? "captioned_full"
        : spokenCutMode === "manual"
          ? "captioned_manual"
          : "captioned"
      : spokenCutMode === "none"
        ? "original"
        : spokenCutMode === "manual"
          ? "manual_edit"
          : "edited";
  const plannedExportDimensions = useMemo(
    () =>
      sourceVideoDimensions
        ? computePortableVideoDimensions(
            sourceVideoDimensions.width,
            sourceVideoDimensions.height,
          )
        : null,
    [sourceVideoDimensions],
  );
  const plannedResolutionMessage = useMemo(() => {
    if (!sourceVideoDimensions || !plannedExportDimensions) {
      return "元動画の解像度を確認中です。完成後に実測します。";
    }
    const explanation = explainVideoExportResolution({
      source: sourceVideoDimensions,
      output: plannedExportDimensions,
      expected: plannedExportDimensions,
    });
    const comparison = `元動画：${explanation.sourceResolutionLabel} → 書き出し予定：${explanation.expectedResolutionLabel}。`;
    return explanation.sourceRequiresUpscaling
      ? `${comparison}書き出しサイズを整えますが、映像の細かさは元動画の解像度に準じます。`
      : `${comparison}SNS投稿向けの解像度へ最適化します。`;
  }, [plannedExportDimensions, sourceVideoDimensions]);
  const exportInputRevision = useMemo(
    () =>
      JSON.stringify({
        file: file
          ? [file.name, file.size, file.lastModified, file.type]
          : null,
        transcript,
        captionProfile,
        narrationAudioUrl,
        narrationOriginalAudio,
        narrationCaptionsEnabled,
        narrationAutoCutEnabled,
        spokenCaptionsEnabled,
        spokenCutMode,
      }),
    [
      captionProfile,
      file,
      narrationAudioUrl,
      narrationAutoCutEnabled,
      narrationCaptionsEnabled,
      narrationOriginalAudio,
      spokenCutMode,
      spokenCaptionsEnabled,
      transcript,
    ],
  );
  const readyExportedVideoFile =
    exportedVideoRevision === exportInputRevision
      ? exportedVideoFile
      : null;
  const completedVideoSaveAllowed = canSaveCompletedVideo(usageBucket);

  async function completePendingExportReservation() {
    if (!usageReservationPendingExport) return;
    exportFinalizingRef.current = true;
    setIsFinalizingExport(true);
    setExportReservationFinalizing(true);
    try {
      if (
        !usageReservationId ||
        !(await updateVideoUsage("complete", usageReservationId))
      ) {
        throw new Error(
          "完成動画は作成できましたが、購入済みの利用枠を確認できませんでした。通信を確認して、もう一度書き出してください。",
        );
      }
      markExportReservationCompleted();
    } finally {
      exportFinalizingRef.current = false;
      setIsFinalizingExport(false);
      setExportReservationFinalizing(false);
    }
  }
  const thumbnailInputRevision = JSON.stringify({
    file: file ? [file.name, file.size, file.lastModified, file.type] : null,
    candidateId: selectedThumbnailFrame?.id ?? null,
    candidateTime: selectedThumbnailFrame?.time ?? null,
    crop: selectedThumbnailFrame?.crop ?? null,
    title: thumbnailTitle.trim(),
    captionProfile,
  });
  const readyThumbnailFile =
    thumbnailRevision === thumbnailInputRevision ? thumbnailFile : null;
  const thumbnailPreviewUrl = useMemo(
    () =>
      readyThumbnailFile ? URL.createObjectURL(readyThumbnailFile) : "",
    [readyThumbnailFile],
  );
  useEffect(
    () => () => {
      if (thumbnailPreviewUrl) URL.revokeObjectURL(thumbnailPreviewUrl);
    },
    [thumbnailPreviewUrl],
  );
  const removedCount = transcript.filter((line) => line.removed).length;
  const cutReasonById = useMemo(() => {
    if (narrationPlan || spokenCutMode === "none") {
      return new Map<number, ReturnType<typeof explainCaptionCut>>();
    }
    return new Map(
      transcript
        .filter((line) => line.removed)
        .map(
          (line) =>
            [
              line.id,
              explainCaptionCut(
                transcript,
                line.id,
                manuallyChangedCutIds.has(line.id) ? "manual" : spokenCutMode,
                length,
              ),
            ] as const,
        ),
    );
  }, [
    length,
    manuallyChangedCutIds,
    narrationPlan,
    spokenCutMode,
    transcript,
  ]);
  const automaticSilenceSummary = useMemo(
    () =>
      narrationPlan
        ? { count: 0, totalSeconds: 0 }
        : summarizeAutomaticSilenceCuts(transcript, spokenCutMode),
    [narrationPlan, spokenCutMode, transcript],
  );
  const postingReadinessChecks = useMemo(
    () =>
      buildPostingReadinessChecklist({
        durationSeconds: editDuration,
        captionsEnabled: captionsVisible,
        unreadableCaptionCount,
        outputWidth: plannedExportDimensions?.width,
        outputHeight: plannedExportDimensions?.height,
        exportVerified: Boolean(
          readyExportedVideoFile && exportedVideoQualityMessage,
        ),
        exportQualityMessage: exportedVideoQualityMessage,
      }),
    [
      captionsVisible,
      editDuration,
      exportedVideoQualityMessage,
      plannedExportDimensions,
      readyExportedVideoFile,
      unreadableCaptionCount,
    ],
  );
  const hasCutChanges = transcript.some(
    (line) =>
      initialCutState.get(line.id) !== undefined &&
      initialCutState.get(line.id) !== line.removed,
  );

  function getPreviewOriginalBaseGain(
    percent: NarrationOriginalAudioLevel = narrationOriginalAudio,
  ) {
    return narrationPlan
      ? getNarrationMixLevels(percent).original *
          originalAudioNormalizationGain
      : originalAudioNormalizationGain;
  }

  function scheduleGainEnvelope(
    param: AudioParam,
    envelope: ReadonlyArray<{ time: number; gain: number }>,
    startedAt: number,
  ) {
    param.cancelScheduledValues(startedAt);
    envelope.forEach((point, index) => {
      const time = startedAt + point.time;
      if (index === 0) param.setValueAtTime(point.gain, time);
      else param.linearRampToValueAtTime(point.gain, time);
    });
  }

  function resetPreviewOriginalGain(
    engine: NonNullable<typeof previewNarrationEngineRef.current>,
    percent: NarrationOriginalAudioLevel = narrationOriginalAudio,
  ) {
    const originalGain = engine.originalGain?.gain;
    if (!originalGain || engine.context.state === "closed") return;
    const now = engine.context.currentTime;
    originalGain.cancelScheduledValues(now);
    originalGain.setValueAtTime(getPreviewOriginalBaseGain(percent), now);
  }

  function schedulePreviewOriginalDucking(
    engine: NonNullable<typeof previewNarrationEngineRef.current>,
    sourceOffset: number,
    playbackRate: number,
    percent: NarrationOriginalAudioLevel = narrationOriginalAudio,
  ) {
    if (!engine.buffer || !engine.originalGain) return;
    const duration = Math.max(
      0,
      (engine.buffer.duration - sourceOffset) / playbackRate,
    );
    const activity = remapPortableNarrationActivity(
      engine.narrationActivity,
      sourceOffset,
      playbackRate,
      duration,
    );
    const envelope = buildPortableDuckingEnvelope(
      activity,
      getPreviewOriginalBaseGain(percent),
      duration,
    );
    scheduleGainEnvelope(
      engine.originalGain.gain,
      envelope,
      engine.context.currentTime,
    );
  }

  function stopPreviewNarrationSource() {
    const engine = previewNarrationEngineRef.current;
    const source = engine?.source;
    if (!engine) return;
    resetPreviewOriginalGain(engine);
    if (!source) return;
    engine.source = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A one-shot AudioBufferSource may already have reached its end.
    }
    source.disconnect();
  }

  function cancelPreviewSeek() {
    previewInternalSeekRef.current?.cancel();
  }

  function disposePreviewNarrationEngine() {
    const engine = previewNarrationEngineRef.current;
    previewNarrationEngineRef.current = null;
    previewNarrationLoadRef.current = null;
    if (!engine) return;
    const source = engine.source;
    engine.source = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already be stopped while the component is closing.
      }
      source.disconnect();
    }
    engine.context.removeEventListener(
      "statechange",
      engine.stateChangeHandler,
    );
    engine.mediaSource?.disconnect();
    engine.originalGain?.disconnect();
    engine.gain.disconnect();
    void engine.context.close().catch(() => undefined);
  }

  function getPreviewNarrationTime() {
    const engine = previewNarrationEngineRef.current;
    if (
      !engine?.buffer ||
      !engine.source ||
      engine.context.state !== "running"
    ) {
      return null;
    }
    const elapsed = Math.max(
      0,
      engine.context.currentTime - engine.sourceStartedAt,
    );
    return Math.min(
      engine.buffer.duration,
      engine.sourceOffset + elapsed * getNarrationPlaybackRate(),
    );
  }

  function finishPreviewAtEnd() {
    const video = videoRef.current;
    const lastRange = previewRanges.at(-1);
    previewOperationRef.current += 1;
    previewPlaybackReadyRef.current = false;
    previewHoldingFinalFrameRef.current = true;
    cancelPreviewSeek();
    stopPreviewNarrationSource();
    video?.pause();
    setIsPlaying(false);
    setPreviewTransportState("ended");
    if (!video || !lastRange) return;
    setCurrentTime(lastRange.sourceEnd);
    if (Math.abs(video.currentTime - lastRange.sourceEnd) > 0.015) {
      void seekVideoBeforePlayback(video, lastRange.sourceEnd);
    }
  }

  useEffect(() => {
    const operation = previewOperationRef.current + 1;
    previewOperationRef.current = operation;
    previewPlaybackReadyRef.current = false;
    previewHoldingFinalFrameRef.current = false;
    cancelPreviewSeek();
    stopPreviewNarrationSource();
    previewNarrationLoadRef.current = null;
    const engine = previewNarrationEngineRef.current;
    if (engine) {
      engine.url = "";
      engine.buffer = null;
      engine.narrationActivity = [];
    }
    videoRef.current?.pause();
    window.queueMicrotask(() => {
      if (previewOperationRef.current !== operation) return;
      setIsPlaying(false);
      setPreviewTransportState("paused");
      setScrubbedEditedTime(null);
    });
    if (narrationAudioUrl) {
      void ensurePreviewNarrationEngine(false).catch(() => undefined);
    }
    // The engine helpers deliberately read the latest media refs; a URL change
    // is the only lifecycle boundary that should recreate this preparation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationAudioUrl]);

  useEffect(
    () => () => {
      previewOperationRef.current += 1;
      cancelPreviewSeek();
      disposePreviewNarrationEngine();
    },
    [],
  );

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && previewPlaybackReadyRef.current) {
        pausePreviewTransport();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    // Visibility handling is registered once and operates on current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isPlaying || isExporting || !narrationPlan) return;

    let animationFrame = 0;
    const scheduleNextFrame = () => {
      animationFrame = window.requestAnimationFrame(updatePreview);
    };
    const updatePreview = () => {
      const video = videoRef.current;
      if (!video) return;

      const lastRange = previewRanges.at(-1);
      if (!lastRange) {
        cancelPreviewSeek();
        previewPlaybackReadyRef.current = false;
        previewHoldingFinalFrameRef.current = false;
        stopPreviewNarrationSource();
        video.pause();
        setIsPlaying(false);
        setPreviewTransportState("paused");
        return;
      }

      const narrationTime = getPreviewNarrationTime();
      const narrationBuffer = previewNarrationEngineRef.current?.buffer;
      if (
        narrationTime !== null &&
        narrationBuffer &&
        narrationTime >= narrationBuffer.duration - 0.015
      ) {
        if (narrationKeepsFullVideo) {
          previewPlaybackReadyRef.current = false;
          stopPreviewNarrationSource();
          scheduleNextFrame();
          return;
        }
        finishPreviewAtEnd();
        return;
      }

      const internalSeek = previewInternalSeekRef.current;
      if (internalSeek) {
        const seekAge = performance.now() - internalSeek.startedAt;
        if (seekAge > 2_500) {
          cancelPreviewSeek();
          previewContinuousCutSeekRef.current = false;
          previewPlaybackReadyRef.current = false;
          stopPreviewNarrationSource();
          video.pause();
          setIsPlaying(false);
          setPreviewTransportState("paused");
          return;
        }
        scheduleNextFrame();
        return;
      }

      if (
        !previewPlaybackReadyRef.current ||
        narrationTime === null
      ) {
        scheduleNextFrame();
        return;
      }
      if (previewHoldingFinalFrameRef.current) {
        scheduleNextFrame();
        return;
      }
      if (
        video.paused ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        scheduleNextFrame();
        return;
      }

      const action = decideNarrationPreviewAction(
        previewRanges,
        narrationTime,
        video.currentTime,
        false,
      );
      if (action.type === "end") {
        finishPreviewAtEnd();
        return;
      }
      if (action.type === "seek-video") {
        if (
          Math.abs(video.currentTime - action.position.sourceTime) > 0.015
        ) {
          const operation = previewOperationRef.current;
          previewContinuousCutSeekRef.current = true;
          void seekVideoBeforePlayback(
            video,
            action.position.sourceTime,
          ).then((seeked) => {
            previewContinuousCutSeekRef.current = false;
            if (
              !seeked ||
              operation !== previewOperationRef.current ||
              !previewPlaybackReadyRef.current
            ) {
              return;
            }
            if (video.paused) {
              void video.play().catch(() => {
                if (operation === previewOperationRef.current) {
                  pausePreviewTransport();
                  notify("プレビューを再開できませんでした。");
                }
              });
            }
          });
          setCurrentTime(action.position.sourceTime);
        }
      }

      scheduleNextFrame();
    };

    scheduleNextFrame();
    return () => window.cancelAnimationFrame(animationFrame);
    // Playback helpers act on current refs; these values are the animation
    // lifecycle boundaries and avoid restarting the loop for unrelated UI state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isExporting,
    isPlaying,
    narrationKeepsFullVideo,
    narrationPlan,
    previewRanges,
  ]);

  function movePreviewOutOfCut(
    nextTranscript: TranscriptLine[],
    cutLine: TranscriptLine,
  ) {
    const video = videoRef.current;
    if (
      !video ||
      video.currentTime < cutLine.start - 0.03 ||
      video.currentTime >= cutLine.end + 0.03
    ) {
      return;
    }

    const nextRanges = buildSpokenEditRanges(
      nextTranscript,
      sourceDuration,
      spokenCutMode,
    );
    const currentSourceTime = video.currentTime;
    const remainsIncluded = nextRanges.some(
      (range) =>
        currentSourceTime >= range.start &&
        currentSourceTime < range.end,
    );
    if (remainsIncluded) return;
    const nextRange = nextRanges.find(
      (range) => range.start > currentSourceTime,
    );
    cancelPreviewSeek();
    previewHoldingFinalFrameRef.current = false;
    if (nextRange) {
      video.currentTime = nextRange.start;
      setCurrentTime(nextRange.start);
      return;
    }

    video.pause();
    setIsPlaying(false);
    const previousRange = nextRanges.at(-1);
    if (previousRange) {
      video.currentTime = previousRange.end;
      setCurrentTime(previousRange.end);
    }
  }

  function toggleLine(id: number) {
    if (narrationPlan || isMediaBusy) return;
    const line = transcript.find((candidate) => candidate.id === id);
    if (!line) return;

    const shouldCut = !line.removed;
    const result = setCaptionCut(transcript, id, shouldCut);
    if (result.blockedReason === "would-remove-all") {
      notify("仕上がり動画には、残す区間が1つ以上必要です");
      return;
    }
    if (!result.changed) return;

    setManuallyChangedCutIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    setTranscript(result.captions);
    if (shouldCut) {
      movePreviewOutOfCut(result.captions, line);
      notify("映像・元音声・テロップを仕上がりからカットしました");
    } else {
      notify("この区間を仕上がり動画へ戻しました");
    }
  }

  function resetCaptionCuts() {
    if (!hasCutChanges || isMediaBusy) return;
    const restored = transcript.map((line) => ({
      ...line,
      removed: initialCutState.get(line.id) ?? line.removed,
    }));
    setManuallyChangedCutIds(new Set());
    setTranscript(restored);
    const video = videoRef.current;
    if (video) {
      const restoredRanges = buildSpokenEditRanges(
        restored,
        sourceDuration,
        spokenCutMode,
      );
      const isInsideRestoredRange = restoredRanges.some(
        (range) =>
          video.currentTime >= range.start &&
          video.currentTime < range.end,
      );
      if (!isInsideRestoredRange && restoredRanges[0]) {
        video.pause();
        setIsPlaying(false);
        const nextRange = restoredRanges.find(
          (range) => range.start > video.currentTime,
        );
        const targetTime =
          nextRange?.start ?? restoredRanges.at(-1)!.end;
        video.currentTime = targetTime;
        setCurrentTime(targetTime);
      }
    }
    notify(
      spokenCutMode === "auto"
        ? "カットの選択を最初の自動編集に戻しました"
        : "手動カットをすべて元に戻しました",
    );
  }

  function updateLine(id: number, text: string) {
    if (isMediaBusy) return;
    clearNarrationCorrectionCandidate();
    const highlight = selectCaptionHighlight(text);
    setTranscript(
      transcript.map((line) =>
        line.id === id
          ? { ...line, text, highlight, accent: Boolean(highlight) }
          : line,
      ),
    );
  }

  function finishLineEdit(id: number) {
    const line = transcript.find((candidate) => candidate.id === id);
    if (!line || line.text.trim()) return;
    const previousText = captionEditStartTextRef.current.get(id);
    if (!previousText?.trim()) return;
    setTranscript(
      transcript.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              text: previousText,
              highlight: selectCaptionHighlight(previousText),
              accent: Boolean(selectCaptionHighlight(previousText)),
            }
          : candidate,
      ),
    );
    notify("テロップは空欄にできないため、編集前の文へ戻しました");
  }

  function applyNarrationPreviewMix(
    video: HTMLVideoElement,
    percent: NarrationOriginalAudioLevel,
  ) {
    const mix = getNarrationMixLevels(percent);
    video.volume = 1;
    const engine = previewNarrationEngineRef.current;
    if (engine) {
      const narrationTime = getPreviewNarrationTime();
      if (engine.source && narrationTime !== null) {
        schedulePreviewOriginalDucking(
          engine,
          narrationTime,
          getNarrationPlaybackRate(),
          percent,
        );
      } else {
        resetPreviewOriginalGain(engine, percent);
      }
      engine.gain.gain.setValueAtTime(
        mix.narration,
        engine.context.currentTime,
      );
    }
  }

  useEffect(() => {
    const engine = previewNarrationEngineRef.current;
    const video = videoRef.current;
    if (!engine || !video || engine.context.state === "closed") return;
    if (narrationPlan) {
      applyNarrationPreviewMix(video, narrationOriginalAudio);
    } else {
      video.volume = 1;
      resetPreviewOriginalGain(engine);
    }
    // The gain helpers use the current engine and do not change its lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrationOriginalAudio, narrationPlan, originalAudioNormalizationGain]);

  async function ensureVideoAudioEngine(shouldResume = true) {
    let engine = previewNarrationEngineRef.current;
    if (!engine || engine.context.state === "closed") {
      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) {
        throw new Error("このブラウザは仕上がり音声の再生に対応していません。");
      }

      const context = new AudioContextConstructor();
      const gain = context.createGain();
      gain.connect(context.destination);
      const createdEngine = {
        url: "",
        context,
        gain,
        originalGain: null as GainNode | null,
        mediaSource: null as MediaElementAudioSourceNode | null,
        buffer: null as AudioBuffer | null,
        narrationActivity: [] as ReturnType<
          typeof detectPortableNarrationActivity
        >,
        source: null as AudioBufferSourceNode | null,
        sourceOffset: 0,
        sourceStartedAt: 0,
        stateChangeHandler: () => undefined,
      };
      createdEngine.stateChangeHandler = () => {
        if (
          previewNarrationEngineRef.current !== createdEngine ||
          createdEngine.context.state !== "suspended" ||
          !previewPlaybackReadyRef.current
        ) {
          return;
        }
        const video = videoRef.current;
        previewOperationRef.current += 1;
        previewPlaybackReadyRef.current = false;
        stopPreviewNarrationSource();
        video?.pause();
        if (video) setCurrentTime(video.currentTime);
        setIsPlaying(false);
        setPreviewTransportState("paused");
      };
      context.addEventListener(
        "statechange",
        createdEngine.stateChangeHandler,
      );
      engine = createdEngine;
      previewNarrationEngineRef.current = createdEngine;
    }

    if (shouldResume && !engine.mediaSource) {
      const video = videoRef.current;
      if (!video) {
        throw new Error("動画を読み込めませんでした。");
      }
      const originalGain = engine.context.createGain();
      const mediaSource = engine.context.createMediaElementSource(video);
      mediaSource.connect(originalGain);
      originalGain.connect(engine.context.destination);
      engine.originalGain = originalGain;
      engine.mediaSource = mediaSource;
      if (narrationPlan) {
        applyNarrationPreviewMix(video, narrationOriginalAudio);
      } else {
        originalGain.gain.setValueAtTime(
          originalAudioNormalizationGain,
          engine.context.currentTime,
        );
      }
    }

    if (shouldResume && engine.context.state !== "running") {
      await engine.context.resume();
    }
    if (shouldResume && engine.context.state !== "running") {
      throw new Error("動画の音声処理を開始できませんでした。");
    }
    return engine;
  }

  async function ensurePreviewNarrationEngine(shouldResume = true) {
    if (!narrationAudioUrl) {
      throw new Error("AI音声を読み込めませんでした。");
    }
    const engine = await ensureVideoAudioEngine(shouldResume);
    const resumePromise = Promise.resolve();
    if (engine.url === narrationAudioUrl && engine.buffer) {
      await resumePromise;
      return engine;
    }
    if (engine.url === narrationAudioUrl && previewNarrationLoadRef.current) {
      await Promise.all([previewNarrationLoadRef.current, resumePromise]);
      const loaded = previewNarrationEngineRef.current;
      if (loaded?.buffer && loaded.url === narrationAudioUrl) return loaded;
    }

    stopPreviewNarrationSource();
    engine.url = narrationAudioUrl;
    engine.buffer = null;
    engine.narrationActivity = [];
    const requestedUrl = narrationAudioUrl;

    const load = (async () => {
      const response = await fetch(requestedUrl);
      if (!response.ok) throw new Error();
      const buffer = await engine.context.decodeAudioData(
        await response.arrayBuffer(),
      );
      if (
        previewNarrationEngineRef.current !== engine ||
        engine.url !== requestedUrl
      ) {
        throw new Error("AI音声が更新されました。");
      }
      engine.buffer = buffer;
      engine.narrationActivity = detectPortableNarrationActivity(
        Array.from(
          { length: buffer.numberOfChannels },
          (_, channel) => buffer.getChannelData(channel),
        ),
        buffer.sampleRate,
        buffer.duration,
      );
      return buffer;
    })();
    previewNarrationLoadRef.current = load;

    try {
      await Promise.all([load, resumePromise]);
      if (shouldResume && engine.context.state !== "running") {
        throw new Error("AI音声の再生を開始できませんでした。");
      }
      return engine;
    } catch (error) {
      if (
        previewNarrationEngineRef.current === engine &&
        engine.url === requestedUrl
      ) {
        engine.url = "";
        engine.buffer = null;
        engine.narrationActivity = [];
      }
      if (error instanceof Error && error.message === "AI音声が更新されました。") {
        throw error;
      }
      throw new Error(
        "AI音声を読み込めませんでした。音声だけの試聴を止めて、もう一度お試しください。",
      );
    } finally {
      if (previewNarrationLoadRef.current === load) {
        previewNarrationLoadRef.current = null;
      }
    }
  }

  function startPreviewNarrationSource(
    engine: NonNullable<typeof previewNarrationEngineRef.current>,
    editedSeconds: number,
    operation: number,
  ) {
    if (!engine.buffer) throw new Error("AI音声を読み込めませんでした。");
    stopPreviewNarrationSource();
    const rate = getNarrationPlaybackRate();
    const maximumOffset = Math.max(0, engine.buffer.duration - 0.015);
    const offset = Math.min(
      maximumOffset,
      Math.max(0, editedSeconds) * rate,
    );
    const source = engine.context.createBufferSource();
    source.buffer = engine.buffer;
    source.playbackRate.value = rate;
    source.connect(engine.gain);
    engine.source = source;
    engine.sourceOffset = offset;
    engine.sourceStartedAt = engine.context.currentTime;
    schedulePreviewOriginalDucking(engine, offset, rate);
    source.onended = () => {
      if (
        previewOperationRef.current !== operation ||
        engine.source !== source ||
        !previewPlaybackReadyRef.current
      ) {
        return;
      }
      engine.source = null;
      source.disconnect();
      resetPreviewOriginalGain(engine);
      if (narrationKeepsFullVideo) {
        previewPlaybackReadyRef.current = false;
        return;
      }
      finishPreviewAtEnd();
    };
    source.start(0, offset);
  }

  function pausePreviewTransport(
    nextState: PreviewTransportState = "paused",
  ) {
    previewOperationRef.current += 1;
    previewPlaybackReadyRef.current = false;
    previewHoldingFinalFrameRef.current = nextState === "ended";
    previewContinuousCutSeekRef.current = false;
    cancelPreviewSeek();
    stopPreviewNarrationSource();
    const video = videoRef.current;
    video?.pause();
    if (video) setCurrentTime(video.currentTime);
    setIsPlaying(false);
    setPreviewTransportState(nextState);
  }

  async function playPreviewFromEditedTime(
    requestedEditedSeconds: number,
    operation: number,
    userInitiated = false,
  ) {
    const video = videoRef.current;
    if (!video) return false;
    const existingAudioEngine = previewNarrationEngineRef.current;
    if (
      !narrationPlan &&
      existingAudioEngine?.mediaSource &&
      existingAudioEngine.context.state !== "running"
    ) {
      await existingAudioEngine.context.resume().catch(() => undefined);
      if ((existingAudioEngine.context.state as AudioContextState) !== "running") {
        throw new Error("動画の音声を再開できませんでした。");
      }
    }
    const safeEditedSeconds = Math.max(
      0,
      Math.min(requestedEditedSeconds, editDuration),
    );
    const position = narrationPlan
      ? resolveEditedPreviewPosition(previewRanges, safeEditedSeconds)
      : {
          sourceTime: editedTimeToSourceTime(editRanges, safeEditedSeconds),
          ended: safeEditedSeconds >= editDuration,
        };
    if (position.ended) return false;

    setPreviewTransportState(narrationPlan ? "loading" : "seeking");
    const preparedEngine = previewNarrationEngineRef.current;
    const hasPreparedNarration = Boolean(
      narrationPlan &&
        preparedEngine?.url === narrationAudioUrl &&
        preparedEngine.buffer &&
        preparedEngine.context.state !== "closed",
    );
    const enginePromise = narrationPlan
      ? ensurePreviewNarrationEngine(true)
      : ensureVideoAudioEngine(true);
    let seekPromise: Promise<boolean> | null = null;
    let videoPlayPromise: Promise<void> | null = null;
    let unlockPromise: Promise<void> | null = null;
    const previousMuted = video.muted;

    if (userInitiated && hasPreparedNarration) {
      seekPromise = seekVideoBeforePlayback(video, position.sourceTime);
      videoPlayPromise = video.play();
    } else if (userInitiated && narrationPlan) {
      video.muted = true;
      unlockPromise = video
        .play()
        .then(() => video.pause())
        .catch(() => undefined);
    } else if (userInitiated) {
      seekPromise = seekVideoBeforePlayback(video, position.sourceTime);
      videoPlayPromise = video.play();
    }

    let engine: Awaited<typeof enginePromise>;
    try {
      engine = await enginePromise;
    } catch (error) {
      video.muted = previousMuted;
      throw error;
    }
    if (
      previewOperationRef.current !== operation ||
      (engine && engine.context.state !== "running")
    ) {
      video.muted = previousMuted;
      return false;
    }

    if (unlockPromise) {
      await unlockPromise;
      video.muted = previousMuted;
    }
    seekPromise ??= seekVideoBeforePlayback(video, position.sourceTime);
    const seeked = await seekPromise;
    if (previewOperationRef.current !== operation) return false;
    if (!seeked) return false;
    if (narrationPlan) {
      applyNarrationPreviewMix(video, narrationOriginalAudio);
    } else {
      video.volume = 1;
      if (engine) resetPreviewOriginalGain(engine);
    }

    previewHoldingFinalFrameRef.current = false;
    previewPlaybackReadyRef.current = false;
    videoPlayPromise ??= video.play();
    await videoPlayPromise;
    if (previewOperationRef.current !== operation) {
      video.pause();
      return false;
    }
    if (engine && narrationPlan) {
      startPreviewNarrationSource(engine, safeEditedSeconds, operation);
    }
    previewPlaybackReadyRef.current = Boolean(engine);
    setCurrentTime(video.currentTime);
    setIsPlaying(true);
    setPreviewTransportState("playing");
    return true;
  }

  function seekTo(seconds: number) {
    if (isExportingRef.current || isMediaBusy) return;
    const editedSeconds = sourceTimeToEditedTime(editRanges, seconds);
    void seekToEditedTime(editedSeconds);
  }

  async function seekToEditedTime(
    seconds: number,
    resumeAfterSeek = false,
    keepSeekingState = false,
  ) {
    if (isExportingRef.current || isMediaBusy) return false;
    const video = videoRef.current;
    if (!video) return false;
    const safeSeconds = Math.max(0, Math.min(seconds, editDuration));
    const position = narrationPlan
      ? resolveEditedPreviewPosition(previewRanges, safeSeconds)
      : {
          sourceTime: editedTimeToSourceTime(editRanges, safeSeconds),
          ended: safeSeconds >= editDuration,
        };
    const operation = previewOperationRef.current + 1;
    previewOperationRef.current = operation;
    previewPlaybackReadyRef.current = false;
    previewHoldingFinalFrameRef.current = false;
    previewContinuousCutSeekRef.current = false;
    cancelPreviewSeek();
    stopPreviewNarrationSource();
    video.pause();
    setIsPlaying(false);
    setPreviewTransportState("seeking");

    const seeked = await seekVideoBeforePlayback(
      video,
      Math.max(
        0,
        Math.min(position.sourceTime, sourceDuration || position.sourceTime),
      ),
    );
    if (previewOperationRef.current !== operation) return false;
    if (!seeked) {
      setPreviewTransportState("paused");
      return false;
    }
    setCurrentTime(video.currentTime);
    if (resumeAfterSeek && !position.ended) {
      try {
        return await playPreviewFromEditedTime(safeSeconds, operation);
      } catch (error) {
        if (previewOperationRef.current === operation) {
          pausePreviewTransport();
          notify(
            error instanceof Error
              ? error.message
              : "プレビューを再開できませんでした。",
          );
        }
        return false;
      }
    }
    previewHoldingFinalFrameRef.current = position.ended;
    setPreviewTransportState(
      position.ended ? "ended" : keepSeekingState ? "seeking" : "paused",
    );
    return true;
  }

  function beginPreviewScrub() {
    if (isExportingRef.current || isMediaBusy || previewScrubbingRef.current) {
      return;
    }
    previewScrubbingRef.current = true;
    previewScrubWasPlayingRef.current = isPlaying;
    previewScrubTimeRef.current = editedCurrentTime;
    setScrubbedEditedTime(editedCurrentTime);
    pausePreviewTransport("seeking");
  }

  function updatePreviewScrub(seconds: number) {
    if (!previewScrubbingRef.current) beginPreviewScrub();
    const safeSeconds = Math.max(0, Math.min(seconds, editDuration));
    previewScrubTimeRef.current = safeSeconds;
    setScrubbedEditedTime(safeSeconds);
    void seekToEditedTime(safeSeconds, false, true);
  }

  async function finishPreviewScrub() {
    if (!previewScrubbingRef.current) return;
    previewScrubbingRef.current = false;
    const target =
      previewScrubTimeRef.current ?? scrubbedEditedTime ?? editedCurrentTime;
    const shouldResume = previewScrubWasPlayingRef.current;
    previewScrubWasPlayingRef.current = false;
    previewScrubTimeRef.current = null;
    await seekToEditedTime(target, shouldResume);
    setScrubbedEditedTime(null);
  }

  async function seekVideoBeforePlayback(
    video: HTMLVideoElement,
    target: number,
  ) {
    const maximumTarget = Number.isFinite(video.duration)
      ? Math.max(0, video.duration - 0.02)
      : Math.max(0, target);
    const safeTarget = Math.max(0, Math.min(target, maximumTarget));
    if (
      !video.seeking &&
      Math.abs(video.currentTime - safeTarget) <= 0.015
    ) {
      return true;
    }

    cancelPreviewSeek();
    const id = previewSeekSequenceRef.current + 1;
    previewSeekSequenceRef.current = id;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout = 0;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", inspectPosition);
        video.removeEventListener("error", handleError);
        if (previewInternalSeekRef.current?.id === id) {
          previewInternalSeekRef.current = null;
        }
        resolve(success);
      };
      const inspectPosition = () => {
        if (previewInternalSeekRef.current?.id !== id) {
          finish(false);
          return;
        }
        if (
          !video.seeking &&
          Math.abs(video.currentTime - safeTarget) <= 0.12
        ) {
          finish(true);
        }
      };
      const handleError = () => finish(false);

      previewInternalSeekRef.current = {
        id,
        target: safeTarget,
        startedAt: performance.now(),
        cancel: () => finish(false),
      };
      video.addEventListener("seeked", inspectPosition);
      video.addEventListener("error", handleError);
      timeout = window.setTimeout(() => {
        finish(
          !video.seeking && Math.abs(video.currentTime - safeTarget) <= 0.18,
        );
      }, 2_000);
      try {
        video.currentTime = safeTarget;
        window.queueMicrotask(inspectPosition);
      } catch {
        finish(false);
      }
    });
  }

  async function crossfadePreviewToSourceTime(
    video: HTMLVideoElement,
    targetTime: number,
  ) {
    if (previewContinuousCutSeekRef.current) return;
    previewContinuousCutSeekRef.current = true;
    const engine = previewNarrationEngineRef.current;
    const gain = engine?.originalGain?.gain ?? null;
    const halfFade = PORTABLE_VIDEO_CROSSFADE_SECONDS / 2;
    const wasPlaying = !video.paused;
    try {
      if (gain && engine && engine.context.state !== "closed") {
        const now = engine.context.currentTime;
        const currentGain = Math.max(0, gain.value);
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(currentGain, now);
        gain.linearRampToValueAtTime(0, now + halfFade);
      }
      video.animate?.(
        [
          { opacity: 1 },
          { opacity: 0.86, offset: 0.5 },
          { opacity: 1 },
        ],
        {
          duration: PORTABLE_VIDEO_CROSSFADE_SECONDS * 1_000,
          easing: "ease-in-out",
        },
      );
      await new Promise((resolve) =>
        window.setTimeout(resolve, halfFade * 1_000),
      );
      video.pause();
      const seeked = await seekVideoBeforePlayback(video, targetTime);
      if (!seeked) throw new Error("カット後の映像へ移動できませんでした。");
      setCurrentTime(video.currentTime);
      if (gain && engine && engine.context.state !== "closed") {
        const now = engine.context.currentTime;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(0, now);
        gain.linearRampToValueAtTime(
          getPreviewOriginalBaseGain(),
          now + halfFade,
        );
      }
      if (wasPlaying) await video.play();
    } catch {
      video.pause();
      setIsPlaying(false);
      setPreviewTransportState("paused");
      notify("カットのつなぎ目を再生できませんでした。もう一度お試しください。");
    } finally {
      previewContinuousCutSeekRef.current = false;
    }
  }

  async function moveToNextKeptRange(video: HTMLVideoElement) {
    if (previewContinuousCutSeekRef.current) return;
    if (editRanges.length === 0) {
      video.pause();
      setIsPlaying(false);
      return;
    }

    const currentRangeIndex = editRanges.findIndex(
      (range) =>
        video.currentTime >= range.start - 0.03 &&
        video.currentTime < range.end - 0.03,
    );
    if (currentRangeIndex >= 0) return;

    const nextRange = editRanges.find(
      (range) => range.start > video.currentTime + 0.01,
    );
    if (nextRange) {
      await crossfadePreviewToSourceTime(video, nextRange.start);
      return;
    }

    video.pause();
    video.currentTime = editRanges.at(-1)!.end;
    setCurrentTime(editRanges.at(-1)!.end);
    setIsPlaying(false);
  }

  function handleVideoTimeUpdate(video: HTMLVideoElement) {
    if (isExportingRef.current) return;
    if (editRanges.length === 0) {
      video.pause();
      setIsPlaying(false);
      return;
    }

    if (narrationPlan) {
      setCurrentTime(video.currentTime);
      return;
    }

    const currentRangeIndex = editRanges.findIndex(
      (range) =>
        video.currentTime >= range.start - 0.03 &&
        video.currentTime < range.end - 0.03,
    );
    if (currentRangeIndex >= 0) {
      setCurrentTime(video.currentTime);
      return;
    }

    void moveToNextKeptRange(video);
  }

  async function togglePlayback() {
    if (isExportingRef.current || isMediaBusy) return;
    const video = videoRef.current;
    if (!video) {
      notify("実際の動画を選ぶと再生できます");
      return;
    }
    if (editRanges.length === 0) {
      notify("残す文を1つ以上選んでください");
      return;
    }

    if (
      isPlaying ||
      previewPlaybackReadyRef.current ||
      previewTransportState === "loading"
    ) {
      pausePreviewTransport();
      return;
    }

    narrationSampleAudioRef.current?.pause();
    stopNarrationCorrectionComparisonAudio();
    const shouldRestart =
      previewHoldingFinalFrameRef.current ||
      previewTransportState === "ended" ||
      editedCurrentTime >= editDuration - 0.03;
    const target = shouldRestart ? 0 : editedCurrentTime;
    const operation = previewOperationRef.current + 1;
    previewOperationRef.current = operation;

    try {
      const started = await playPreviewFromEditedTime(
        target,
        operation,
        true,
      );
      if (!started && previewOperationRef.current === operation) {
        pausePreviewTransport(shouldRestart ? "paused" : "ended");
      }
    } catch (error) {
      if (previewOperationRef.current !== operation) return;
      pausePreviewTransport();
      notify(
        error instanceof Error
          ? error.message
          : "プレビューを再生できませんでした。もう一度お試しください。",
      );
    }
  }

  function downloadText(filename: string, content: string, mime: string) {
    const blob = new Blob(["\uFEFF", content], {
      type: `${mime};charset=utf-8`,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyTranscript() {
    const text = editedTranscript
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join("\n");
    await navigator.clipboard.writeText(text);
    notify("字幕テキストをコピーしました");
  }

  async function copyPostCaption() {
    if (!narrationPlan) return;
    await navigator.clipboard.writeText(
      buildDisclosedPostCaption(narrationPlan.socialCaption),
    );
    notify("開示文を含む投稿文をコピーしました");
  }

  function updateNarrationPronunciationRow(
    id: number,
    field: "surface" | "reading",
    value: string,
  ) {
    clearNarrationCorrectionCandidate();
    setNarrationPronunciationRows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  }

  function enableNarrationPronunciationCorrections() {
    clearNarrationCorrectionCandidate();
    setUsePronunciationCorrections(true);
  }

  function disableNarrationPronunciationCorrections() {
    clearNarrationCorrectionCandidate();
    setUsePronunciationCorrections(false);
    setNarrationPronunciationRows((rows) => [
      {
        id: rows[0]?.id ?? 0,
        surface: "",
        reading: "",
      },
    ]);
  }

  function addSelectedNarrationPronunciationTerm() {
    const textarea = narrationDraftTextareaRef.current;
    if (!textarea) return;
    const selectedTerm = narrationDraft
      .slice(textarea.selectionStart, textarea.selectionEnd)
      .trim();
    if (!selectedTerm) {
      notify("上の台本で、読み方を直したい言葉を選択してください");
      textarea.focus();
      return false;
    }
    if (selectedTerm.length > 50) {
      notify("選択する言葉は50文字以内にしてください");
      return;
    }
    if (
      narrationPronunciationRows.some(
        (row) => row.surface.trim() === selectedTerm,
      )
    ) {
      notify(`「${selectedTerm}」はすでに追加されています`);
      return;
    }
    clearNarrationCorrectionCandidate();
    setUsePronunciationCorrections(true);
    setNarrationPronunciationRows((rows) => {
      const emptyRowIndex = rows.findIndex(
        (row) => !row.surface.trim() && !row.reading.trim(),
      );
      if (emptyRowIndex >= 0) {
        return rows.map((row, index) =>
          index === emptyRowIndex ? { ...row, surface: selectedTerm } : row,
        );
      }
      if (rows.length >= 20) return rows;
      const id = pronunciationRowSequenceRef.current;
      pronunciationRowSequenceRef.current += 1;
      return [...rows, { id, surface: selectedTerm, reading: "" }];
    });
    notify(`「${selectedTerm}」を追加しました。正しい読みを入力してください`);
  }

  function addNarrationPronunciationRow() {
    if (!canAddPronunciationRow) return;
    clearNarrationCorrectionCandidate();
    const id = pronunciationRowSequenceRef.current;
    pronunciationRowSequenceRef.current += 1;
    setNarrationPronunciationRows((rows) => [
      ...rows,
      { id, surface: "", reading: "" },
    ]);
  }

  function removeNarrationPronunciationRow(id: number) {
    clearNarrationCorrectionCandidate();
    setNarrationPronunciationRows((rows) => {
      if (rows.length === 1) {
        return [{ ...rows[0], surface: "", reading: "" }];
      }
      return rows.filter((row) => row.id !== id);
    });
  }

  async function handleNarrationRegeneration() {
    if (
      isMediaBusy ||
      isExportingRef.current ||
      narrationGenerationLimitReached ||
      !hasPendingNarrationChanges
    ) {
      return;
    }
    pausePreviewTransport();
    narrationSampleAudioRef.current?.pause();
    clearNarrationCorrectionCandidate();
    setIsRegeneratingNarration(true);
    try {
      const remaining = await regenerateNarration(
        narrationDraft,
        draftNarrationStyle,
        narrationPronunciationGuide,
      );
      setLastNarrationGenerationKey(pendingNarrationGenerationKey);
      setLastAppliedPronunciationGuide(
        normalizedNarrationPronunciationGuide,
      );
      rememberPronunciationEntries(
        pronunciationValidation.entries.map((entry) => ({
          display: entry.surface,
          reading: entry.reading,
        })),
      );
      setSelectedNarrationSegmentIndex(0);
      setNarrationEmphasisText("");
      notify(
        pronunciationEntryCount
          ? `読み方${pronunciationEntryCount}件を反映してAI音声を更新しました（AI処理 残り${remaining}回）`
          : narrationCaptionsEnabled
            ? `AI音声とテロップを更新しました（AI処理 残り${remaining}回）`
            : `AI音声を更新しました（AI処理 残り${remaining}回）`,
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "AI音声を更新できませんでした",
      );
    } finally {
      setIsRegeneratingNarration(false);
    }
  }

  function selectNarrationCorrectionSegment(index: number) {
    clearNarrationCorrectionCandidate();
    setSelectedNarrationSegmentIndex(index);
    setNarrationEmphasisText("");
  }

  function selectNarrationDeliveryPreset(preset: NarrationDeliveryPreset) {
    clearNarrationCorrectionCandidate();
    setNarrationDeliveryPreset(preset);
    if (preset !== "emphasis") setNarrationEmphasisText("");
  }

  async function handleNarrationCorrectionGeneration() {
    if (
      isMediaBusy ||
      isExportingRef.current ||
      hasPendingNarrationChanges ||
      narrationGenerationLimitReached ||
      !selectedNarrationSegment ||
      !narrationEmphasisIsValid
    ) {
      return;
    }
    pausePreviewTransport();
    narrationSampleAudioRef.current?.pause();
    clearNarrationCorrectionCandidate();
    setIsGeneratingNarrationCorrection(true);
    try {
      const result = await regenerateNarrationSegment(
        selectedNarrationSegmentIndex,
        narrationDeliveryPreset,
        narrationEmphasisText,
      );
      setNarrationCorrectionCandidate({
        result,
        originalPreviewUrl: URL.createObjectURL(result.originalPreview),
        correctedPreviewUrl: URL.createObjectURL(result.correctedPreview),
        deliveryPreset: narrationDeliveryPreset,
      });
      notify(
        `修正前後を聴き比べられます（AI処理 残り${result.remaining}回）`,
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "この一文のAI音声を修正できませんでした",
      );
    } finally {
      setIsGeneratingNarrationCorrection(false);
    }
  }

  function handleNarrationCorrectionApply() {
    if (!narrationCorrectionCandidate || isMediaBusy) return;
    try {
      pausePreviewTransport();
      narrationSampleAudioRef.current?.pause();
      stopNarrationCorrectionComparisonAudio();
      applyNarrationSegmentCorrection(narrationCorrectionCandidate.result);
      clearNarrationCorrectionCandidate();
      notify("修正版をAIナレーションへ反映しました。追加のAI処理は使用していません");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "修正版を反映できませんでした",
      );
    }
  }

  async function handleNarrationCutModeChange(autoCut: boolean) {
    if (
      isMediaBusy ||
      isExportingRef.current ||
      autoCut === narrationAutoCutEnabled
    ) {
      return;
    }
    pausePreviewTransport();
    narrationSampleAudioRef.current?.pause();
    clearNarrationCorrectionCandidate();
    setIsUpdatingNarrationCutMode(true);
    try {
      await setNarrationAutoCutEnabled(autoCut);
      notify(
        autoCut
          ? "AI音声に合わせて映像を短くする設定へ変更しました"
          : "元動画の映像・順番・長さをそのまま残します",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "映像の仕上げ方を変更できませんでした",
      );
    } finally {
      setIsUpdatingNarrationCutMode(false);
    }
  }

  async function recordDisclosureConfirmation() {
    let clientSessionId = window.localStorage.getItem(
      "torudake-client-session-id",
    );
    if (!clientSessionId) {
      clientSessionId = crypto.randomUUID();
      window.localStorage.setItem(
        "torudake-client-session-id",
        clientSessionId,
      );
    }
    const response = await fetch("/api/narration/disclosure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmationId: crypto.randomUUID(),
        clientSessionId,
        termsVersion: NARRATION_TERMS_VERSION,
        confirmed: true,
        usageReservationId,
      }),
    });
    await readApiResponse<ApiPayload & { recorded?: boolean }>(
      response,
      "確認を記録できませんでした。もう一度お試しください。",
    );
  }

  function updateNarrationOriginalAudio(
    percent: NarrationOriginalAudioLevel,
  ) {
    if (isExportingRef.current || isMediaBusy) return;
    setNarrationOriginalAudio(percent);
    if (videoRef.current) {
      applyNarrationPreviewMix(videoRef.current, percent);
    }
  }

  async function generateThumbnail() {
    const video = videoRef.current;
    if (
      !video ||
      !file ||
      isMediaBusy ||
      isExportingRef.current
    ) {
      if (!file) notify("実際の動画を選ぶと表紙を生成できます");
      return;
    }

    const coverFrame = selectedThumbnailFrame;
    if (!coverFrame) {
      notify("表紙に使う場面を選んでください");
      return;
    }
    const coverTitle = thumbnailTitle.trim();
    if (!coverTitle) {
      notify("表紙に入れるタイトルを入力してください");
      return;
    }

    const previous = {
      currentTime: video.currentTime,
      editedTime: editedCurrentTime,
      wasPlaying: isPlaying,
    };
    setIsGeneratingThumbnail(true);
    pausePreviewTransport();

    try {
      video.pause();
      if (!video.videoWidth || !video.videoHeight || video.readyState < 1) {
        throw new Error("表紙に使う場面を読み込めませんでした。");
      }
      const sought = await seekVideoBeforePlayback(video, coverFrame.time);
      if (!sought) {
        throw new Error("表紙に使う場面を読み込めませんでした。");
      }

      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
        throw new Error("表紙に使う場面を読み込めませんでした。");
      }
      await document.fonts?.ready;
      await new Promise<void>((resolve) => {
        const decodedVideo = video as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: () => void) => number;
        };
        if (decodedVideo.requestVideoFrameCallback) {
          let settled = false;
          const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve();
          }, 1_500);
          decodedVideo.requestVideoFrameCallback(() => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            resolve();
          });
          return;
        }
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => resolve()),
        );
      });

      const canvas = document.createElement("canvas");
      canvas.width = 1080;
      canvas.height = 1920;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("表紙画像を作成できませんでした。");

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const analyzedCrop = coverFrame.crop;
      const crop =
        analyzedCrop.width > 0 &&
        analyzedCrop.height > 0 &&
        analyzedCrop.x >= 0 &&
        analyzedCrop.y >= 0 &&
        analyzedCrop.x + analyzedCrop.width <= sourceWidth + 1 &&
        analyzedCrop.y + analyzedCrop.height <= sourceHeight + 1
          ? analyzedCrop
          : calculateCoverCrop(
              sourceWidth,
              sourceHeight,
              canvas.width,
              canvas.height,
            );
      context.drawImage(
        video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );

      const shade = context.createLinearGradient(0, 0, 0, canvas.height);
      shade.addColorStop(0, "rgba(7,12,20,.12)");
      shade.addColorStop(0.48, "rgba(7,12,20,.04)");
      shade.addColorStop(0.72, "rgba(7,12,20,.48)");
      shade.addColorStop(1, "rgba(7,12,20,.86)");
      context.fillStyle = shade;
      context.fillRect(0, 0, canvas.width, canvas.height);

      const palette = {
        panel: captionDesign.palette.background || "rgba(11,16,24,.7)",
        border: captionDesign.palette.border,
        text: captionDesign.palette.text,
        accent: captionDesign.palette.highlight,
        label: captionDesign.palette.label,
      };
      const frame = captionDesign.frame;
      const roundRect = (
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number,
      ) => {
        const safeRadius = Math.min(radius, width / 2, height / 2);
        context.beginPath();
        context.moveTo(x + safeRadius, y);
        context.arcTo(x + width, y, x + width, y + height, safeRadius);
        context.arcTo(
          x + width,
          y + height,
          x,
          y + height,
          safeRadius,
        );
        context.arcTo(x, y + height, x, y, safeRadius);
        context.arcTo(x, y, x + width, y, safeRadius);
        context.closePath();
      };

      context.save();
      context.shadowColor = "rgba(4,10,18,.28)";
      context.shadowBlur = 32;
      context.shadowOffsetY = 12;
      context.fillStyle = "rgba(12,20,32,.76)";
      roundRect(70, 72, 360, 78, 39);
      context.fill();
      context.restore();
      context.fillStyle = palette.label;
      context.font = `800 30px ${frame.fontFamily}`;
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(
        captionProfile.brandName || "撮るだけリール",
        112,
        111,
        278,
      );

      const lines = wrapCaptionLines(coverTitle, 12, 3);

      const fontSize = lines.length >= 3 ? 74 : 82;
      const lineHeight = fontSize * 1.25;
      const panelX = 70;
      const panelWidth = canvas.width - 140;
      const panelHeight = lines.length * lineHeight + 220;
      const panelY = canvas.height - panelHeight - 150;
      const panelRadius = Math.max(4, Math.round(frame.cornerRadius * 150));
      context.save();
      context.shadowColor =
        frame.shadow === "offset"
          ? "#181818"
          : frame.shadow === "warm"
            ? "rgba(75,44,29,.34)"
            : "rgba(4,10,18,.38)";
      context.shadowBlur = frame.shadow === "offset" ? 0 : 42;
      context.shadowOffsetX = frame.shadow === "offset" ? 18 : 0;
      context.shadowOffsetY = frame.shadow === "offset" ? 18 : 18;
      context.fillStyle = palette.panel;
      roundRect(panelX, panelY, panelWidth, panelHeight, panelRadius);
      context.fill();
      context.restore();
      if (frame.borderPlacement === "outline") {
        context.lineWidth = tone === "mono" ? 8 : 5;
        context.strokeStyle = palette.border;
        roundRect(panelX, panelY, panelWidth, panelHeight, panelRadius);
        context.stroke();
      } else if (frame.borderPlacement === "left") {
        context.fillStyle = palette.border;
        roundRect(panelX, panelY, 12, panelHeight, 6);
        context.fill();
      } else if (frame.borderPlacement === "bottom") {
        context.fillStyle = palette.border;
        roundRect(panelX, panelY + panelHeight - 12, panelWidth, 12, 4);
        context.fill();
      }

      context.fillStyle = palette.accent;
      roundRect(panelX + 52, panelY + 48, 150, 12, 6);
      context.fill();
      context.fillStyle = palette.text;
      context.font = `${captionDesign.palette.fontWeight} ${fontSize}px ${frame.fontFamily}`;
      context.textAlign = "left";
      context.textBaseline = "middle";
      lines.forEach((line, index) => {
        context.fillText(
          line,
          panelX + 52,
          panelY + 116 + lineHeight * (index + 0.5),
          panelWidth - 104,
        );
      });

      context.fillStyle = palette.accent;
      context.font = `750 28px ${frame.fontFamily}`;
      context.fillText(
        captionProfile.brandName
          ? `${captionProfile.brandName}・Reel story`
          : "動画を選ぶだけ・自動動画編集",
        panelX + 52,
        panelY + panelHeight - 54,
      );

      const output = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error("表紙画像を保存できませんでした。")),
          "image/jpeg",
          0.92,
        );
      });
      const completedFile = new File(
        [output],
        `${exportName}_cover.jpg`,
        { type: "image/jpeg" },
      );
      setThumbnailFile(completedFile);
      setThumbnailRevision(thumbnailInputRevision);
      notify("表紙を生成しました。仕上がりを確認して保存してください");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "表紙画像の生成に失敗しました",
      );
    } finally {
      video.pause();
      await seekVideoBeforePlayback(video, previous.currentTime);
      setCurrentTime(video.currentTime);
      setIsGeneratingThumbnail(false);
      if (previous.wasPlaying) {
        const operation = previewOperationRef.current + 1;
        previewOperationRef.current = operation;
        await playPreviewFromEditedTime(previous.editedTime, operation).catch(
          () => undefined,
        );
      }
    }
  }

  function chooseThumbnailCandidate(choice: ThumbnailFrameChoice) {
    if (isMediaBusy || isExportingRef.current) return;
    setThumbnailCandidateId(choice.id);
  }

  function updateThumbnailCrop(axis: "x" | "y", value: number) {
    if (!selectedThumbnailFrame || !sourceVideoDimensions) return;
    setThumbnailFrameChoices((current) =>
      current.map((choice) => {
        if (choice.id !== selectedThumbnailFrame.id) return choice;
        const maximum =
          axis === "x"
            ? Math.max(0, sourceVideoDimensions.width - choice.crop.width)
            : Math.max(0, sourceVideoDimensions.height - choice.crop.height);
        return {
          ...choice,
          crop: {
            ...choice.crop,
            [axis]: Math.min(maximum, Math.max(0, value)),
          },
        };
      }),
    );
  }

  async function saveThumbnail() {
    if (!readyThumbnailFile) return;

    const shareData = {
      files: [readyThumbnailFile],
      title: "撮るだけリールの表紙",
    };
    try {
      if (
        typeof navigator.share === "function" &&
        (typeof navigator.canShare !== "function" ||
          navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }

    const url = URL.createObjectURL(readyThumbnailFile);
    const link = document.createElement("a");
    link.href = url;
    link.download = readyThumbnailFile.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notify("表紙画像の保存を開始しました");
  }

  function drawCaptionOverlay(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    sourceTime: number,
  ) {
    if (!captionsVisible) return;
    const caption = displayTranscript.find((line) => {
      if (line.removed || !line.text.trim()) return false;
      const display = getCaptionDisplayRange(line);
      return sourceTime >= display.start && sourceTime < display.end;
    });

    if (!caption) return;

    const displayRange = getCaptionDisplayRange(caption);
    const keptIndex = displayKeptLines.findIndex(
      (line) => line.id === caption.id,
    );
    const presentation = getCaptionPresentation(
      caption,
      Math.max(0, keptIndex),
    );
    const palette = captionDesign.palette;
    const frame = captionDesign.frame;
    const presentationScale =
      presentation === "hook"
        ? 1.12
        : presentation === "metric"
          ? 1.08
          : 1;
    const fontSize =
      (tone === "vlog"
        ? Math.max(22, Math.min(52, canvas.width * 0.041))
        : Math.max(26, Math.min(64, canvas.width * 0.052))) *
      presentationScale;
    const captionFontWeight =
      tone === "vlog" && presentation === "hook"
        ? 700
        : palette.fontWeight;
    const horizontalPadding =
      fontSize * (frame.borderPlacement === "none" ? 0.32 : 0.72);
    const verticalPadding =
      fontSize * (frame.borderPlacement === "none" ? 0.18 : 0.44);
    const safeArea = getCaptionSafeArea(canvas.width, canvas.height);
    const maxTextWidth = Math.max(
      fontSize * 8,
      safeArea.width - horizontalPadding * 2,
    );
    const charactersPerLine = Math.max(
      8,
      Math.floor(maxTextWidth / fontSize),
    );
    const lines = wrapCaptionLines(caption.text, charactersPerLine, 2);
    const showBrand =
      presentation === "hook" && Boolean(captionProfile.brandName);
    const brandHeight = showBrand ? fontSize * 0.52 : 0;

    context.font = `${captionFontWeight} ${fontSize}px ${frame.fontFamily}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const widestLine = Math.max(
      ...lines.map((line) => context.measureText(line).width),
    );
    const lineHeight = fontSize * 1.25;
    const boxWidth = Math.min(
      safeArea.width,
      widestLine + horizontalPadding * 2,
    );
    const boxHeight =
      lines.length * lineHeight + verticalPadding * 2 + brandHeight;
    const boxX = (canvas.width - boxWidth) / 2;
    const preferredBoxY =
      tone === "vlog"
        ? canvas.height * 0.43
        : safeArea.y + safeArea.height - boxHeight;
    const boxY = Math.min(
      safeArea.y + safeArea.height - boxHeight,
      Math.max(safeArea.y, preferredBoxY),
    );
    const boxRadius = Math.max(0, fontSize * frame.cornerRadius);
    const entrance = getCaptionEntranceProgress(sourceTime, displayRange.start);
    context.save();
    context.globalAlpha = 0.35 + entrance * 0.65;
    context.translate(
      0,
      (1 - entrance) * fontSize * (tone === "vlog" ? 0.04 : 0.18),
    );
    if (palette.background) {
      context.save();
      context.shadowColor =
        frame.shadow === "offset"
          ? "#181818"
          : frame.shadow === "warm"
            ? "rgba(75,44,29,.34)"
            : frame.shadow === "deep"
              ? "rgba(0,0,0,.44)"
              : "rgba(8,15,25,.26)";
      context.shadowBlur = frame.shadow === "offset" ? 0 : fontSize * 0.4;
      context.shadowOffsetX =
        frame.shadow === "offset" ? fontSize * 0.16 : 0;
      context.shadowOffsetY = fontSize * 0.16;
      context.fillStyle = palette.background;
      context.beginPath();
      context.roundRect(boxX, boxY, boxWidth, boxHeight, boxRadius);
      context.fill();
      context.restore();
    }
    if (palette.border && frame.borderPlacement === "outline") {
      context.lineWidth = Math.max(
        2,
        fontSize * (tone === "mono" ? 0.065 : 0.035),
      );
      context.strokeStyle = palette.border;
      context.beginPath();
      context.roundRect(boxX, boxY, boxWidth, boxHeight, boxRadius);
      context.stroke();
    } else if (palette.border && frame.borderPlacement === "left") {
      context.fillStyle = palette.border;
      context.beginPath();
      context.roundRect(
        boxX,
        boxY,
        Math.max(4, fontSize * 0.075),
        boxHeight,
        Math.max(2, boxRadius * 0.45),
      );
      context.fill();
    } else if (palette.border && frame.borderPlacement === "bottom") {
      context.fillStyle = palette.border;
      context.beginPath();
      context.roundRect(
        boxX,
        boxY + boxHeight - Math.max(4, fontSize * 0.075),
        boxWidth,
        Math.max(4, fontSize * 0.075),
        Math.max(2, boxRadius * 0.45),
      );
      context.fill();
    }
    if (tone === "signature" && frame.borderPlacement !== "none") {
      context.strokeStyle = palette.border;
      context.lineWidth = Math.max(1, fontSize * 0.018);
      context.beginPath();
      context.moveTo(boxX + fontSize * 0.18, boxY + fontSize * 0.16);
      context.lineTo(boxX + fontSize * 0.55, boxY + fontSize * 0.16);
      context.moveTo(
        boxX + boxWidth - fontSize * 0.55,
        boxY + boxHeight - fontSize * 0.16,
      );
      context.lineTo(
        boxX + boxWidth - fontSize * 0.18,
        boxY + boxHeight - fontSize * 0.16,
      );
      context.stroke();
    }
    if (showBrand) {
      context.fillStyle = palette.highlight;
      context.font = `750 ${fontSize * 0.34}px ${frame.fontFamily}`;
      context.textAlign = "left";
      context.fillText(
        captionProfile.brandName,
        boxX + horizontalPadding,
        boxY + verticalPadding * 0.72,
        boxWidth - horizontalPadding * 2,
      );
    }
    const highlight = caption.highlight?.trim() ?? "";
    context.font = `${captionFontWeight} ${fontSize}px ${frame.fontFamily}`;
    context.textAlign = "left";
    if (!palette.background && frame.borderPlacement === "none") {
      context.shadowColor =
        tone === "pop"
          ? palette.highlight
          : tone === "vlog"
            ? "rgba(0,0,0,.82)"
          : tone === "signature"
            ? "rgba(20,14,10,.78)"
            : "rgba(0,0,0,.68)";
      context.shadowBlur =
        tone === "pop"
          ? 0
          : tone === "vlog"
            ? fontSize * 0.07
            : fontSize * 0.18;
      context.shadowOffsetX = tone === "pop" ? fontSize * 0.055 : 0;
      context.shadowOffsetY =
        tone === "pop"
          ? fontSize * 0.07
          : tone === "vlog"
            ? fontSize * 0.045
            : fontSize * 0.08;
    }
    lines.forEach((line, index) => {
      const lineY =
        boxY +
        verticalPadding +
        brandHeight +
        lineHeight * (index + 0.5);
      const highlightIndex = highlight ? line.indexOf(highlight) : -1;
      const parts =
        highlightIndex >= 0
          ? [
              {
                text: line.slice(0, highlightIndex),
                color: palette.text,
                highlighted: false,
              },
              {
                text: highlight,
                color:
                  frame.highlight === "block"
                    ? palette.label
                    : palette.highlight,
                highlighted: true,
              },
              {
                text: line.slice(highlightIndex + highlight.length),
                color: palette.text,
                highlighted: false,
              },
            ]
          : [{ text: line, color: palette.text, highlighted: false }];
      let textX = canvas.width / 2 - context.measureText(line).width / 2;

      parts.forEach((part) => {
        const partWidth = context.measureText(part.text).width;
        if (part.highlighted && frame.highlight === "marker") {
          context.fillStyle = `${palette.highlight}66`;
          context.fillRect(
            textX,
            lineY + fontSize * 0.18,
            partWidth,
            Math.max(3, fontSize * 0.22),
          );
        } else if (part.highlighted && frame.highlight === "block") {
          context.fillStyle = palette.highlight;
          context.beginPath();
          context.roundRect(
            textX - fontSize * 0.08,
            lineY - fontSize * 0.48,
            partWidth + fontSize * 0.16,
            fontSize * 0.96,
            fontSize * 0.08,
          );
          context.fill();
        }
        if (palette.stroke) {
          const strokeRatio =
            tone === "signature" ? 0.055 : tone === "cinema" ? 0.095 : 0.115;
          context.lineWidth = Math.max(3, fontSize * strokeRatio);
          context.lineJoin = "round";
          context.strokeStyle =
            part.highlighted &&
            frame.borderPlacement === "none" &&
            palette.highlight === "#181818"
              ? "#fffdf7"
              : palette.stroke;
          context.strokeText(part.text, textX, lineY);
        }
        context.fillStyle = part.color;
        context.fillText(part.text, textX, lineY);
        textX += partWidth;
      });
    });
    context.restore();
  }
  drawCaptionOverlayRef.current = drawCaptionOverlay;

  async function exportCaptionedVideo(
    preparedAudioContext: AudioContext | null = null,
  ) {
    if (!completedVideoSaveAllowed) {
      await preparedAudioContext?.close().catch(() => undefined);
      notify(
        "無料体験では編集とプレビューまで利用できます。完成動画の保存にはプランを選んでください",
      );
      return;
    }
    const video = videoRef.current;
    if (
      !video ||
      !file ||
      isExportingRef.current ||
      isGeneratingThumbnail ||
      isRegeneratingNarration
    ) {
      await preparedAudioContext?.close().catch(() => undefined);
      return;
    }
    const playableRanges = editRanges
      .map((range) => ({
        start: Math.max(0, range.start),
        end: Math.min(
          range.end,
          sourceDuration || video.duration || range.end,
        ),
      }))
      .filter((range) => range.end > range.start);
    if (playableRanges.length === 0) {
      await preparedAudioContext?.close().catch(() => undefined);
      notify("残す文を1つ以上選んでください");
      return;
    }
    if (!sourceVideoDimensions) {
      await preparedAudioContext?.close().catch(() => undefined);
      notify("元動画の解像度を確認しています。少し待ってからもう一度お試しください。");
      return;
    }
    const sourceExportDimensions = {
      width: video.videoWidth || sourceVideoDimensions.width,
      height: video.videoHeight || sourceVideoDimensions.height,
    };
    const expectedExportDimensions = computePortableVideoDimensions(
      sourceExportDimensions.width,
      sourceExportDimensions.height,
    );
    const editedDurationSeconds = playableRanges.reduce(
      (total, range) => total + (range.end - range.start),
      0,
    );
    let elapsedBoundarySeconds = 0;
    const videoContentBoundarySeconds = playableRanges
      .slice(0, -1)
      .map((range) => {
        elapsedBoundarySeconds += range.end - range.start;
        return elapsedBoundarySeconds;
      });
    const memoryPreflight = getPortableExportMemoryPreflight({
      editedDurationSeconds,
      userAgent: navigator.userAgent,
      maximumTouchPoints: navigator.maxTouchPoints,
      deviceMemoryGb:
        (navigator as Navigator & { deviceMemory?: number }).deviceMemory ??
        null,
    });
    if (!memoryPreflight.ok) {
      await preparedAudioContext?.close().catch(() => undefined);
      notify(
        memoryPreflight.message ??
          "この端末では動画を安全に書き出せません。PC版Chromeでお試しください。",
      );
      return;
    }
    const canUseLegacyRecorder =
      typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function";
    const exportController = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = exportController;
    const exportSignal = exportController.signal;
    const throwIfExportAborted = () => {
      if (exportSignal.aborted) throw new PortableVideoExportAbortedError();
    };
    const pendingExportReservationId =
      usageReservationPendingExport && usageReservationId
        ? usageReservationId
        : null;
    isExportingRef.current = true;
    setIsExporting(true);
    setExportedVideoFile(null);
    setExportedVideoQualityMessage(null);
    setExportedVideoRevision(null);
    setExportProgress(0);

    const awaitOriginalAudioMeasurement = async (): Promise<
      PortableOriginalAudioMeasurement | null
    > => {
      if (narrationPlan) return null;
      const pendingMeasurement = originalAudioMeasurementRef.current;
      if (!pendingMeasurement) return null;

      return new Promise((resolve, reject) => {
        let settled = false;
        let timeout = 0;
        const cleanup = () => {
          window.clearTimeout(timeout);
          exportSignal.removeEventListener("abort", abort);
        };
        const finish = (measurement: PortableOriginalAudioMeasurement | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(measurement);
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new PortableVideoExportAbortedError());
        };
        timeout = window.setTimeout(() => finish(null), 8_000);
        exportSignal.addEventListener("abort", abort, { once: true });
        void pendingMeasurement.then(finish, () => finish(null));
        if (exportSignal.aborted) abort();
      });
    };

    const audibleTranscript = editedTranscript.filter(
      (line) => !line.removed && line.text.trim(),
    );
    let originalAudioMeasurement: PortableOriginalAudioMeasurement | null = null;
    try {
      if (pendingExportReservationId) {
        const renewedUsage = await renewVideoUsage(
          pendingExportReservationId,
          file,
          exportSignal,
          { resumeReleased: false },
        );
        throwIfExportAborted();
        if (
          renewedUsage.reservationId !== pendingExportReservationId ||
          !canSaveCompletedVideo(renewedUsage.bucket)
        ) {
          throw new Error(
            "保存できる利用枠の有効期限を更新できませんでした。",
          );
        }
      }
      originalAudioMeasurement = await awaitOriginalAudioMeasurement();
      throwIfExportAborted();
    } catch (error) {
      const cancelled =
        exportSignal.aborted ||
        error instanceof PortableVideoExportAbortedError ||
        (error instanceof DOMException && error.name === "AbortError");
      await preparedAudioContext?.close().catch(() => undefined);
      if (exportAbortRef.current === exportController) {
        isExportingRef.current = false;
        exportAbortRef.current = null;
        setIsExporting(false);
        setExportProgress(null);
      }
      if (!exportPageHidingRef.current) {
        notify(
          cancelled
            ? "動画の書き出しを中止しました。"
            : error instanceof Error
              ? error.message
              : "動画の音声を確認できませんでした。",
        );
      }
      return;
    }
    const normalizedOriginalAudioRms =
      originalAudioMeasurement?.hasDecodedSamples &&
      originalAudioMeasurement.rms !== null
        ? originalAudioMeasurement.rms *
          originalAudioMeasurement.normalizationGain
        : null;
    const completedVideoValidation = {
      expectedDurationSeconds: editedDurationSeconds,
      requireAudioTrack: Boolean(
        narrationPlan || originalAudioMeasurement?.hasAudioTrack !== false,
      ),
      requireAudibleAudio: Boolean(
        narrationPlan ||
          (normalizedOriginalAudioRms !== null &&
            normalizedOriginalAudioRms >= 0.0025),
      ),
      expectedNarrationRanges: narrationPlan
        ? audibleTranscript.map((line) => ({
            start: line.start,
            end: line.end,
          }))
        : [],
      captionRanges: captionsVisible
        ? audibleTranscript.map((line) => ({
            start: line.start,
            end: line.end,
          }))
        : [],
      videoContentBoundarySeconds,
    };

    let portableColorConversionMessage = "";
    const previous = {
      currentTime: video.currentTime,
      editedTime: editedCurrentTime,
      muted: video.muted,
      volume: video.volume,
      loop: video.loop,
      wasPlaying: isPlaying,
    };
    previewOperationRef.current += 1;
    previewPlaybackReadyRef.current = false;
    previewHoldingFinalFrameRef.current = false;
    cancelPreviewSeek();
    stopPreviewNarrationSource();
    video.pause();
    setIsPlaying(false);
    setPreviewTransportState("paused");
    narrationSampleAudioRef.current?.pause();
    let animationFrame = 0;
    let keepDrawing = true;
    let outputStream: MediaStream | null = null;
    let exportAudioContext: AudioContext | null = preparedAudioContext;
    let exportNarrationBuffer: AudioBuffer | null = null;
    let exportNarrationActivity: ReturnType<
      typeof detectPortableNarrationActivity
    > = [];
    let exportNarrationGain: GainNode | null = null;
    let exportOriginalAudioSource: AudioNode | null = null;
    let exportOriginalGain: GainNode | null = null;
    let exportLimiter: DynamicsCompressorNode | null = null;
    let activeExportNarrationSource: AudioBufferSourceNode | null = null;
    let activeExportNarrationSliceGain: GainNode | null = null;
    let exportPreviewOriginalGain: GainNode | null = null;
    let exportPreviewOriginalGainValue = 1;
    let shouldCloseExportAudioContext = true;
    let recorder: MediaRecorder | null = null;
    let fallbackCrossfadeFrame: HTMLCanvasElement | null = null;
    let fallbackCrossfadeStartedAt: number | null = null;
    const seekExportMedia = async (
      media: HTMLMediaElement,
      seconds: number,
    ): Promise<void> => {
      throwIfExportAborted();
      const maximum = Number.isFinite(media.duration)
        ? Math.max(0, media.duration - 0.02)
        : Math.max(0, seconds);
      const target = Math.max(0, Math.min(seconds, maximum));
      const needsSeek = Math.abs(media.currentTime - target) > 0.02;
      if (!needsSeek && media.readyState >= 2) return;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const eventName = needsSeek ? "seeked" : "canplay";
        const cleanup = () => {
          window.clearTimeout(timeout);
          media.removeEventListener(eventName, finish);
          media.removeEventListener("error", fail);
          exportSignal.removeEventListener("abort", abort);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error("動画とAI音声の位置を合わせられませんでした。"),
          );
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new PortableVideoExportAbortedError());
        };
        const timeout = window.setTimeout(fail, 8_000);
        media.addEventListener(eventName, finish, { once: true });
        media.addEventListener("error", fail, { once: true });
        exportSignal.addEventListener("abort", abort, { once: true });
        if (exportSignal.aborted) {
          abort();
          return;
        }
        if (needsSeek) {
          media.currentTime = target;
        } else {
          media.preload = "auto";
          media.load();
        }
      });
      if (
        !needsSeek &&
        Math.abs(media.currentTime - target) > 0.02
      ) {
        await seekExportMedia(media, target);
      }
    };

    try {
      try {
        let portableNarrationBuffer: AudioBuffer | null = null;
        if (narrationPlan && narrationAudioUrl) {
          if (!exportAudioContext) {
            exportAudioContext = await createRunningNarrationAudioContext();
          }
          throwIfExportAborted();
          const narrationResponse = await fetch(narrationAudioUrl, {
            signal: exportSignal,
          });
          if (!narrationResponse.ok) {
            throw new Error("AI音声を読み込めませんでした。");
          }
          portableNarrationBuffer = await exportAudioContext.decodeAudioData(
            await narrationResponse.arrayBuffer(),
          );
          throwIfExportAborted();
        }

        const { exportPortableVideoMp4 } = await import(
          "../lib/portable-video-export"
        );
        const mix = narrationPlan
          ? getNarrationMixLevels(narrationOriginalAudio)
          : { original: 1, narration: 0 };
        const output = await exportPortableVideoMp4({
          file,
          ranges: playableRanges,
          originalGain: mix.original,
          narrationBuffer: portableNarrationBuffer,
          narrationGain: mix.narration,
          signal: exportSignal,
          drawCaption: ({ context, canvas, sourceTime }) => {
            drawCaptionOverlay(context, canvas, sourceTime);
          },
          onColorConversionPlan: (plan) => {
            if (plan.requiresToneMapping || plan.isWideGamut) {
              portableColorConversionMessage =
                " HDR・広色域の色をSNS互換のSDR色へ調整しました。";
            }
          },
          onProgress: (progress) => {
            if (!exportSignal.aborted) setExportProgress(progress * 100);
          },
        });
        throwIfExportAborted();
        if (!output.size) throw new Error("書き出した動画が空でした。");
        const portableQuality = await inspectCompletedVideoQuality(
          output,
          sourceExportDimensions,
          expectedExportDimensions,
          completedVideoValidation,
        );
        if (!portableQuality.accepted) {
          throw new Error(
            `${portableQuality.userMessage} 端末互換の書き出し方法でもう一度試します。`,
          );
        }
        throwIfExportAborted();
        const completedFile = new File(
          [output],
          `${exportName}_${exportSuffix}.mp4`,
          { type: "video/mp4" },
        );
        await completePendingExportReservation();
        setExportProgress(100);
        setExportedVideoFile(completedFile);
        setExportedVideoQualityMessage(
          `${portableQuality.userMessage}${portableColorConversionMessage}`,
        );
        setExportedVideoRevision(exportInputRevision);
        notify("動画ができました。下の「動画を保存・共有」を押してください");
        return;
      } catch (portableExportError) {
        if (
          exportSignal.aborted ||
          portableExportError instanceof PortableVideoExportAbortedError ||
          (portableExportError instanceof DOMException &&
            portableExportError.name === "AbortError")
        ) {
          throw new PortableVideoExportAbortedError();
        }
        if (!canUseLegacyRecorder) throw portableExportError;
        console.warn(
          "Portable MP4 export was unavailable; using the browser recorder fallback.",
          portableExportError,
        );
        setExportProgress(0);
      }

      video.pause();
      video.loop = false;
      video.muted = false;
      await seekExportMedia(video, playableRanges[0].start);

      const canvas = document.createElement("canvas");
      const sourceWidth = video.videoWidth || 1080;
      const sourceHeight = video.videoHeight || 1920;
      const dimensions = computePortableVideoDimensions(
        sourceWidth,
        sourceHeight,
      );
      const drawRect = computePortableVideoDrawRect(
        sourceWidth,
        sourceHeight,
        dimensions.width,
        dimensions.height,
      );
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("動画の描画を開始できませんでした。");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      const drawFrame = () => {
        if (exportSignal.aborted) {
          keepDrawing = false;
          return;
        }
        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(
          video,
          drawRect.x,
          drawRect.y,
          drawRect.width,
          drawRect.height,
        );
        if (fallbackCrossfadeFrame && fallbackCrossfadeStartedAt !== null) {
          const progress =
            (video.currentTime - fallbackCrossfadeStartedAt) /
            PORTABLE_VIDEO_CROSSFADE_SECONDS;
          if (progress >= 0 && progress < 1) {
            context.save();
            context.globalAlpha = 1 - progress;
            context.drawImage(fallbackCrossfadeFrame, 0, 0);
            context.restore();
          } else if (progress >= 1) {
            fallbackCrossfadeFrame = null;
            fallbackCrossfadeStartedAt = null;
          }
        }
        drawCaptionOverlay(context, canvas, video.currentTime);

        if (keepDrawing) {
          animationFrame = window.requestAnimationFrame(drawFrame);
        }
      };

      outputStream = canvas.captureStream(30);
      const liveOutputStream = outputStream;
      if (narrationPlan && narrationAudioUrl) {
        const previewEngine = await ensurePreviewNarrationEngine(true);
        throwIfExportAborted();
        if (exportAudioContext && exportAudioContext !== previewEngine.context) {
          await exportAudioContext.close().catch(() => undefined);
        }
        exportAudioContext = previewEngine.context;
        shouldCloseExportAudioContext = false;
        exportOriginalAudioSource = previewEngine.mediaSource;
        exportPreviewOriginalGain = previewEngine.originalGain;
        if (exportPreviewOriginalGain) {
          exportPreviewOriginalGainValue = exportPreviewOriginalGain.gain.value;
          exportPreviewOriginalGain.gain.setValueAtTime(
            0,
            exportAudioContext.currentTime,
          );
        }
        exportNarrationBuffer = previewEngine.buffer;
      } else {
        const videoAudioEngine = await ensureVideoAudioEngine(true);
        throwIfExportAborted();
        if (
          exportAudioContext &&
          exportAudioContext !== videoAudioEngine.context
        ) {
          await exportAudioContext.close().catch(() => undefined);
        }
        exportAudioContext = videoAudioEngine.context;
        shouldCloseExportAudioContext = false;
        exportOriginalAudioSource = videoAudioEngine.mediaSource;
        exportPreviewOriginalGain = videoAudioEngine.originalGain;
        if (exportPreviewOriginalGain) {
          exportPreviewOriginalGainValue = exportPreviewOriginalGain.gain.value;
          exportPreviewOriginalGain.gain.setValueAtTime(
            0,
            exportAudioContext.currentTime,
          );
        }
      }

      if (!exportAudioContext) {
        throw new Error("動画の音声処理を開始できませんでした。");
      }
      if (exportAudioContext.state !== "running") {
        await exportAudioContext.resume().catch(() => undefined);
      }
      if (exportAudioContext.state !== "running") {
        throw new Error(
          "動画の書き出しを開始できませんでした。画面を開いたまま、もう一度お試しください。",
        );
      }

      const destination = exportAudioContext.createMediaStreamDestination();
      exportLimiter = exportAudioContext.createDynamicsCompressor();
      exportLimiter.threshold.value = -1;
      exportLimiter.knee.value = 0;
      exportLimiter.ratio.value = 20;
      exportLimiter.attack.value = 0.002;
      exportLimiter.release.value = 0.08;
      exportLimiter.connect(destination);
      if (exportOriginalAudioSource) {
        exportOriginalGain = exportAudioContext.createGain();
        exportOriginalGain.gain.value =
          (narrationPlan
            ? getNarrationMixLevels(narrationOriginalAudio).original
            : 1) * originalAudioNormalizationGain;
        exportOriginalAudioSource
          .connect(exportOriginalGain)
          .connect(exportLimiter);
      }

      if (narrationPlan && narrationAudioUrl) {
        if (!exportNarrationBuffer) {
          try {
            const narrationResponse = await fetch(narrationAudioUrl, {
              signal: exportSignal,
            });
            if (!narrationResponse.ok) throw new Error();
            const narrationBytes = await narrationResponse.arrayBuffer();
            throwIfExportAborted();
            exportNarrationBuffer =
              await exportAudioContext.decodeAudioData(narrationBytes);
            throwIfExportAborted();
          } catch (error) {
            if (
              exportSignal.aborted ||
              (error instanceof DOMException && error.name === "AbortError")
            ) {
              throw new PortableVideoExportAbortedError();
            }
            throw new Error("AI音声を読み込めませんでした。");
          }
        }
        if (
          !Number.isFinite(exportNarrationBuffer.duration) ||
          exportNarrationBuffer.duration <= 0
        ) {
          throw new Error("AI音声を読み込めませんでした。");
        }
        exportNarrationActivity = detectPortableNarrationActivity(
          Array.from(
            { length: exportNarrationBuffer.numberOfChannels },
            (_, channel) => exportNarrationBuffer!.getChannelData(channel),
          ),
          exportNarrationBuffer.sampleRate,
          exportNarrationBuffer.duration,
        );
        exportNarrationGain = exportAudioContext.createGain();
        exportNarrationGain.gain.value =
          getNarrationMixLevels(narrationOriginalAudio).narration;
        exportNarrationGain.connect(exportLimiter);
        destination.stream
          .getAudioTracks()
          .forEach((track) => liveOutputStream.addTrack(track));
      } else {
        destination.stream
          .getAudioTracks()
          .forEach((track) => liveOutputStream.addTrack(track));
      }

      const preferredMimeTypes = [
        "video/mp4;codecs=avc1.640028,mp4a.40.2",
        "video/mp4;codecs=avc1.4D4028,mp4a.40.2",
        "video/mp4;codecs=avc1.42E028,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ];
      const mimeType =
        preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) ??
        "";
      const recorderOptions: MediaRecorderOptions = {
        videoBitsPerSecond: HIGH_QUALITY_VIDEO_BITRATE,
        ...(mimeType ? { mimeType } : {}),
      };
      recorder = new MediaRecorder(liveOutputStream, recorderOptions);
      const activeRecorder = recorder;
      const chunks: BlobPart[] = [];
      activeRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      const stopped = new Promise<void>((resolve, reject) => {
        activeRecorder.addEventListener("stop", () => resolve(), { once: true });
        activeRecorder.addEventListener(
          "error",
          () => reject(new Error("動画の書き出しに失敗しました。")),
          { once: true },
        );
      });
      const waitForEvent = (
        target: EventTarget,
        eventName: string,
        errorMessage: string,
        timeoutMs = 8_000,
      ) =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            window.clearTimeout(timeout);
            target.removeEventListener(eventName, finish);
            exportSignal.removeEventListener("abort", abort);
          };
          const finish = () => {
            cleanup();
            resolve();
          };
          const abort = () => {
            cleanup();
            reject(new PortableVideoExportAbortedError());
          };
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error(errorMessage));
          }, timeoutMs);
          target.addEventListener(eventName, finish, { once: true });
          exportSignal.addEventListener("abort", abort, { once: true });
          if (exportSignal.aborted) abort();
        });
      const pauseRecorderForSeek = async () => {
        if (activeRecorder.state !== "recording") return;
        const paused = waitForEvent(
          activeRecorder,
          "pause",
          "動画のカット処理を一時停止できませんでした。",
        );
        activeRecorder.pause();
        await paused;
      };
      const resumeRecorderAfterSeek = async () => {
        if (activeRecorder.state !== "paused") return;
        const resumed = waitForEvent(
          activeRecorder,
          "resume",
          "動画のカット処理を再開できませんでした。",
        );
        activeRecorder.resume();
        await resumed;
      };
      const waitForRangeEnd = (range: { start: number; end: number }) =>
        new Promise<void>((resolve, reject) => {
          const timeoutMs = Math.max(
            10_000,
            Math.ceil((range.end - range.start + 8) * 1_000),
          );
          let settled = false;
          let rangeAnimationFrame = 0;
          const cleanup = () => {
            window.clearTimeout(timeout);
            window.cancelAnimationFrame(rangeAnimationFrame);
            video.removeEventListener("ended", check);
            video.removeEventListener("error", fail);
            exportSignal.removeEventListener("abort", abort);
          };
          const finish = () => {
            if (settled) return;
            settled = true;
            video.pause();
            cleanup();
            resolve();
          };
          const check = () => {
            if (
              video.ended ||
              video.currentTime >= range.end - 0.015
            ) {
              finish();
              return;
            }
            rangeAnimationFrame = window.requestAnimationFrame(check);
          };
          const fail = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("動画のカット位置を再生できませんでした。"));
          };
          const abort = () => {
            if (settled) return;
            settled = true;
            video.pause();
            cleanup();
            reject(new PortableVideoExportAbortedError());
          };
          const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("動画の書き出しに時間がかかりすぎています。"));
          }, timeoutMs);
          video.addEventListener("ended", check);
          video.addEventListener("error", fail, { once: true });
          exportSignal.addEventListener("abort", abort, { once: true });
          if (exportSignal.aborted) {
            abort();
            return;
          }
          rangeAnimationFrame = window.requestAnimationFrame(check);
        });

      activeRecorder.start(1000);
      throwIfExportAborted();
      drawFrame();
      if (exportAudioContext?.state !== "running") {
        await exportAudioContext?.resume().catch(() => undefined);
      }
      if (exportAudioContext && exportAudioContext.state !== "running") {
        throw new Error(
          "AI音声の書き出しを開始できませんでした。画面を開いたまま、もう一度お試しください。",
        );
      }
      let narrationElapsed = 0;

      for (
        let rangeIndex = 0;
        rangeIndex < playableRanges.length;
        rangeIndex += 1
      ) {
        throwIfExportAborted();
        const range = playableRanges[rangeIndex];
        if (rangeIndex > 0) {
          const outgoingFrame = document.createElement("canvas");
          outgoingFrame.width = canvas.width;
          outgoingFrame.height = canvas.height;
          const outgoingContext = outgoingFrame.getContext("2d", {
            alpha: false,
          });
          if (outgoingContext) {
            outgoingContext.fillStyle = "#000";
            outgoingContext.fillRect(
              0,
              0,
              outgoingFrame.width,
              outgoingFrame.height,
            );
            outgoingContext.drawImage(
              video,
              drawRect.x,
              drawRect.y,
              drawRect.width,
              drawRect.height,
            );
            fallbackCrossfadeFrame = outgoingFrame;
          }
          await pauseRecorderForSeek();
        }
        await seekExportMedia(video, range.start);
        if (rangeIndex > 0) {
          fallbackCrossfadeStartedAt = range.start;
          await resumeRecorderAfterSeek();
        }

        const rangeEnded = waitForRangeEnd(range);
        const rangeDuration = range.end - range.start;
        const narrationSlice = exportNarrationBuffer
          ? getNarrationBufferSlice(
              narrationElapsed,
              rangeDuration,
              exportNarrationBuffer.duration,
            )
          : null;
        const narrationPlaybackRate = getNarrationPlaybackRate();
        if (exportOriginalGain && exportAudioContext) {
          const baseGain =
            (narrationPlan
              ? getNarrationMixLevels(narrationOriginalAudio).original
              : 1) * originalAudioNormalizationGain;
          const activity = narrationSlice
            ? remapPortableNarrationActivity(
                exportNarrationActivity,
                narrationSlice.offset,
                narrationPlaybackRate,
                rangeDuration,
              )
            : [];
          scheduleGainEnvelope(
            exportOriginalGain.gain,
            addCutBoundaryFades(
              buildPortableDuckingEnvelope(activity, baseGain, rangeDuration),
              rangeDuration,
            ),
            exportAudioContext.currentTime,
          );
        }
        if (
          narrationSlice &&
          exportAudioContext &&
          exportNarrationGain &&
          exportNarrationBuffer
        ) {
          activeExportNarrationSource =
            exportAudioContext.createBufferSource();
          activeExportNarrationSource.buffer = exportNarrationBuffer;
          activeExportNarrationSource.playbackRate.value = narrationPlaybackRate;
          activeExportNarrationSliceGain = exportAudioContext.createGain();
          activeExportNarrationSource
            .connect(activeExportNarrationSliceGain)
            .connect(exportNarrationGain);
          const audibleDuration = Math.min(
            rangeDuration,
            narrationSlice.duration / narrationPlaybackRate,
          );
          const fadeDuration = Math.min(
            PORTABLE_AUDIO_CUT_FADE_SECONDS,
            audibleDuration / 2,
          );
          const startedAt = exportAudioContext.currentTime;
          activeExportNarrationSliceGain.gain.setValueAtTime(0, startedAt);
          activeExportNarrationSliceGain.gain.linearRampToValueAtTime(
            1,
            startedAt + fadeDuration,
          );
          activeExportNarrationSliceGain.gain.setValueAtTime(
            1,
            startedAt + Math.max(fadeDuration, audibleDuration - fadeDuration),
          );
          activeExportNarrationSliceGain.gain.linearRampToValueAtTime(
            0,
            startedAt + audibleDuration,
          );
        }
        const videoPlayback = video.play();
        if (activeExportNarrationSource && narrationSlice) {
          activeExportNarrationSource.start(
            0,
            narrationSlice.offset,
            narrationSlice.duration,
          );
        }
        await Promise.all([videoPlayback, rangeEnded]);
        throwIfExportAborted();
        if (activeExportNarrationSource) {
          try {
            activeExportNarrationSource.stop();
          } catch {
            // The source may already have stopped at the end of the slice.
          }
          activeExportNarrationSource.disconnect();
          activeExportNarrationSource = null;
          activeExportNarrationSliceGain?.disconnect();
          activeExportNarrationSliceGain = null;
        }
        narrationElapsed += rangeDuration;
        setExportProgress(
          ((rangeIndex + 1) / playableRanges.length) * 100,
        );
      }
      video.pause();
      keepDrawing = false;
      activeRecorder.stop();
      await stopped;
      throwIfExportAborted();

      const output = new Blob(chunks, {
        type: activeRecorder.mimeType || mimeType || "video/webm",
      });
      if (!output.size) throw new Error("書き出した動画が空でした。");
      const fallbackQuality = await inspectCompletedVideoQuality(
        output,
        sourceExportDimensions,
        expectedExportDimensions,
        completedVideoValidation,
      );
      if (!fallbackQuality.accepted) {
        throw new Error(fallbackQuality.userMessage);
      }
      throwIfExportAborted();

      const outputType = output.type.toLowerCase();
      const extension = outputType.includes("mp4") ? "mp4" : "webm";
      const completedFile = new File(
        [output],
        `${exportName}_${exportSuffix}.${extension}`,
        { type: output.type || `video/${extension}` },
      );
      await completePendingExportReservation();
      setExportProgress(100);
      setExportedVideoFile(completedFile);
      setExportedVideoQualityMessage(fallbackQuality.userMessage);
      setExportedVideoRevision(exportInputRevision);
      notify("動画ができました。下の「動画を保存・共有」を押してください");
    } catch (error) {
      const cancelled =
        exportSignal.aborted ||
        error instanceof PortableVideoExportAbortedError ||
        (error instanceof DOMException && error.name === "AbortError");
      if (!exportPageHidingRef.current) {
        notify(
          cancelled
            ? "動画の書き出しを中止しました。"
            : error instanceof Error
              ? error.message
              : "動画の書き出しに失敗しました",
        );
      }
    } finally {
      keepDrawing = false;
      window.cancelAnimationFrame(animationFrame);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // The recorder may already be stopping after an asynchronous error.
        }
      }
      outputStream?.getTracks().forEach((track) => track.stop());
      if (fallbackCrossfadeFrame) {
        fallbackCrossfadeFrame.width = 0;
        fallbackCrossfadeFrame.height = 0;
        fallbackCrossfadeFrame = null;
      }
      if (activeExportNarrationSource) {
        try {
          activeExportNarrationSource.stop();
        } catch {
          // The source may already have stopped after a recorder error.
        }
        activeExportNarrationSource.disconnect();
      }
      activeExportNarrationSliceGain?.disconnect();
      if (exportOriginalAudioSource && exportOriginalGain) {
        try {
          exportOriginalAudioSource.disconnect(exportOriginalGain);
        } catch {
          // The temporary export connection may already be gone.
        }
      }
      exportOriginalGain?.disconnect();
      exportNarrationGain?.disconnect();
      exportLimiter?.disconnect();
      if (
        exportPreviewOriginalGain &&
        exportAudioContext &&
        exportAudioContext.state !== "closed"
      ) {
        exportPreviewOriginalGain.gain.setValueAtTime(
          exportPreviewOriginalGainValue,
          exportAudioContext.currentTime,
        );
      }
      if (shouldCloseExportAudioContext) {
        await exportAudioContext?.close().catch(() => undefined);
      }
      video.pause();
      video.loop = previous.loop;
      video.muted = previous.muted;
      video.volume = previous.volume;
      if (exportAbortRef.current === exportController) {
        isExportingRef.current = false;
        exportAbortRef.current = null;
        setIsExporting(false);
        setExportProgress(null);
      }
      if (!exportPageHidingRef.current) {
        await seekVideoBeforePlayback(video, previous.currentTime).catch(
          () => undefined,
        );
        setCurrentTime(video.currentTime);
      }
      if (
        previous.wasPlaying &&
        !exportSignal.aborted &&
        !exportPageHidingRef.current
      ) {
        const operation = previewOperationRef.current + 1;
        previewOperationRef.current = operation;
        await playPreviewFromEditedTime(previous.editedTime, operation).catch(
          () => undefined,
        );
      }
    }
  }

  async function saveExportedVideo() {
    if (!completedVideoSaveAllowed) {
      notify(
        "無料体験では編集とプレビューまで利用できます。完成動画の保存にはプランを選んでください",
      );
      return;
    }
    if (!readyExportedVideoFile) return;

    const shareData = {
      files: [readyExportedVideoFile],
      title: "撮るだけリール",
    };
    try {
      if (
        typeof navigator.share === "function" &&
        (typeof navigator.canShare !== "function" ||
          navigator.canShare(shareData))
      ) {
        await navigator.share(shareData);
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }

    const url = URL.createObjectURL(readyExportedVideoFile);
    const link = document.createElement("a");
    link.href = url;
    link.download = readyExportedVideoFile.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notify("動画の保存を開始しました");
  }

  async function submitResultFeedback(
    rating: "helpful" | "needs_work",
    tags: string[] = feedbackTags,
  ) {
    if (feedbackSending || feedbackSubmitted) return;
    setFeedbackRating(rating);
    if (rating === "needs_work" && tags.length === 0) return;
    setFeedbackSending(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          tags: tags.slice(0, 5),
          context: readyExportedVideoFile ? "export" : "preview",
        }),
      });
      if (!response.ok) throw new Error("feedback_failed");
      setFeedbackSubmitted(true);
      trackClientEvent("feedback_submitted", {
        rating,
        context: readyExportedVideoFile ? "export" : "preview",
        tags: tags.slice(0, 5),
      });
    } catch {
      notify("感想を送信できませんでした。通信を確認してもう一度お試しください");
    } finally {
      setFeedbackSending(false);
    }
  }

  function requestVideoExport() {
    if (isMediaBusy || isExportingRef.current) return;
    if (!completedVideoSaveAllowed) {
      notify(
        "無料体験では編集とプレビューまで利用できます。完成動画の保存にはプランを選んでください",
      );
      return;
    }
    if (narrationPlan) {
      setDisclosureConfirmed(false);
      setShowDisclosureConfirm(true);
      return;
    }
    void exportCaptionedVideo();
  }

  function cancelVideoExport() {
    if (!isExportingRef.current) return;
    if (exportFinalizingRef.current) {
      notify("完成動画の利用枠を確定しています。少しお待ちください");
      return;
    }
    exportAbortRef.current?.abort();
    videoRef.current?.pause();
    notify("動画の書き出しを中止しています…");
    void cancelPendingExportReservation();
  }

  async function confirmNarrationExport() {
    if (!completedVideoSaveAllowed) {
      setShowDisclosureConfirm(false);
      notify(
        "無料体験では編集とプレビューまで利用できます。完成動画の保存にはプランを選んでください",
      );
      return;
    }
    if (!disclosureConfirmed || isRecordingDisclosure) return;
    setIsRecordingDisclosure(true);
    let preparedAudioContext: AudioContext | null = null;
    try {
      preparedAudioContext = await createRunningNarrationAudioContext();
      await recordDisclosureConfirmation();
      setShowDisclosureConfirm(false);
      await exportCaptionedVideo(preparedAudioContext);
      preparedAudioContext = null;
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "確認を記録できませんでした。",
      );
    } finally {
      await preparedAudioContext?.close().catch(() => undefined);
      setIsRecordingDisclosure(false);
    }
  }

  return (
    <section className="resultPage">
      <div className="resultHeading">
        <div>
          <p className="completePill">
            <span>✓</span>
            {narrationPlan
              ? "AIナレーション付きで仕上げました"
              : usedHighAccuracy
              ? "高精度の文字起こしで仕上げました"
              : spokenCutMode === "auto"
                ? "音声に合わせた編集が完了しました"
                : spokenCutMode === "manual"
                  ? "自分でカットする準備ができました"
                  : "元動画の流れを保って仕上げました"}
          </p>
          <h1>
            {narrationPlan
              ? narrationCaptionsEnabled
                ? "映像の流れに合わせて、声とテロップを組み立てました。"
                : "映像に合わせたAIナレーションで仕上げました。"
              : spokenCutMode === "auto"
                ? spokenCaptionsEnabled
                  ? "元の音声に合わせて、映像とテロップを整えました。"
                  : "元の音声に合わせて、映像を自然につなぎ直しました。"
                : spokenCutMode === "manual"
                  ? "使う文章を選んで、映像を自分らしく整えられます。"
                  : spokenCaptionsEnabled
                    ? "元動画の流れを保ち、テロップだけを加えました。"
                    : "元動画の映像と音声を、そのまま保ちました。"}
          </h1>
          <p>
            {narrationPlan
              ? "台本と声の雰囲気はここで調整できます。公開動画にサービス名や透かしは入りません。"
              : spokenCutMode === "auto"
                ? "元動画全体から、言い淀み・重複・長い間を外し、文の切れ目で再構成しています。"
                : spokenCutMode === "manual"
                  ? "最初は元動画をすべて残しています。下の文章から、使わない区間だけを選んでください。"
                  : "映像・順番・元の音声・動画の長さは変更していません。"}
          </p>
        </div>
        <div className="timeSaved">
          <span>仕上がり時間</span>
          <strong>{formatCaptionClock(editDuration)}</strong>
          <small>
            {narrationPlan
              ? narrationAutoCutEnabled
                ? `全体から${length}秒以内へ自動構成`
                : "元動画をカットせず、そのまま使用"
              : spokenCutMode === "auto"
                ? `全体から約${length}秒へ自動構成`
                : spokenCutMode === "manual"
                  ? `自分で選択・目安${length}秒`
                  : "元動画をカットせず、そのまま使用"}
          </small>
        </div>
      </div>

      {file && (
        <aside className="resultPrimaryAction" aria-label="完成動画の保存">
          <div>
            <span className="resultPrimaryActionIcon" aria-hidden="true">▶</span>
            <p>
              <strong>まず仕上がりを確認。気に入ったら保存へ</strong>
              <small>
                実尺 {formatCaptionClock(editDuration)}・最大1080p・サービス名の透かしなし
              </small>
            </p>
          </div>
          {!completedVideoSaveAllowed ? (
            <div className="resultPrimaryPurchase">
              <Link
                className="mainCta"
                href="/account?checkout=starter"
                target="_blank"
                rel="noreferrer"
                onClick={() => markCheckoutStarted("starter")}
              >
                <span>
                  {STARTER_MONTHLY_PLAN_LABEL}・¥
                  {STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月
                </span>
                <i>→</i>
              </Link>
              <a href="#free-export-plans">ほかの月額プラン・今回だけ保存を見る</a>
            </div>
          ) : (
            <button
              type="button"
              className="mainCta reviewCta"
              onClick={
                readyExportedVideoFile
                  ? () => void saveExportedVideo()
                  : requestVideoExport
              }
              disabled={isMediaBusy}
            >
              <span>
                {readyExportedVideoFile
                  ? "動画を保存・共有"
                  : isExporting
                    ? "書き出し中…"
                    : "完成動画を書き出す"}
              </span>
              <i>{isExporting ? "●" : "↓"}</i>
            </button>
          )}
        </aside>
      )}

      {narrationPlan && (
        <details className="narrationStudio resultDetailCard">
          <summary className="resultDetailSummary">
            <span aria-hidden="true">声</span>
            <p>
              <strong>AIナレーション・台本・投稿文を調整</strong>
              <small>声の雰囲気、読み方、環境音・BGMの音量も変更できます</small>
            </p>
            <i aria-hidden="true">⌄</i>
          </summary>
          <div className="narrationStudioHeading">
            <div>
              <p className="eyebrow">AI音声の調整</p>
              <h2>声と投稿文を、あなたらしく整える</h2>
            </div>
            <span>公開動画への透かしなし</span>
          </div>
          <div className="resultNarrationCutMode">
            <div>
              <span>映像の仕上げ方</span>
              <strong>
                {narrationAutoCutEnabled
                  ? "AI音声に合わせて短く編集"
                  : "元動画を保ち、AI音声で伝える"}
              </strong>
              <small>ここで変更しても、AI処理の残り回数は減らず、追加料金も発生しません。</small>
            </div>
            <div className="resultNarrationCutActions">
              <button
                type="button"
                className={!narrationAutoCutEnabled ? "active" : ""}
                aria-pressed={!narrationAutoCutEnabled}
                disabled={isMediaBusy}
                onClick={() => void handleNarrationCutModeChange(false)}
              >
                <strong>元動画のまま</strong>
                <small>映像・順番・長さを変更しない</small>
              </button>
              <button
                type="button"
                className={narrationAutoCutEnabled ? "active" : ""}
                aria-pressed={narrationAutoCutEnabled}
                disabled={isMediaBusy}
                onClick={() => void handleNarrationCutModeChange(true)}
              >
                <strong>短く自動編集</strong>
                <small>AI音声の尺へ映像をつなぎ直す</small>
              </button>
            </div>
          </div>
          <div className="narrationStudioGrid">
            <div className="narrationScriptEditor">
              <label>
                <span>ナレーション台本</span>
                <textarea
                  ref={narrationDraftTextareaRef}
                  value={narrationDraft}
                  rows={6}
                  maxLength={2_000}
                  disabled={isMediaBusy}
                  onChange={(event) => {
                    setNarrationDraft(event.target.value);
                    clearNarrationCorrectionCandidate();
                  }}
                />
              </label>
              <div
                className={`pronunciationEditor${usePronunciationCorrections && pronunciationValidation.error ? " hasError" : ""}`}
              >
                <div className="pronunciationEditorHeading">
                  <div>
                    <strong>漢字の読み方</strong>
                    <small>必要なときだけ設定</small>
                  </div>
                  <span
                    className={
                      !usePronunciationCorrections
                        ? ""
                        : pronunciationValidation.error
                        ? "hasError"
                        : hasPendingPronunciationChanges
                          ? "isPending"
                          : pronunciationEntryCount
                            ? "isApplied"
                            : ""
                    }
                  >
                    {!usePronunciationCorrections
                      ? "修正なし"
                      : pronunciationValidation.error
                      ? "入力を確認"
                      : hasPendingPronunciationChanges
                        ? "音声への反映待ち"
                        : pronunciationEntryCount
                          ? `${pronunciationEntryCount}件 反映済み`
                          : "必要なときだけ"}
                  </span>
                </div>
                <p>
                  AIが漢字を読み間違えた場合だけ使います。テロップの文字は変わりません。
                </p>
                <div
                  className="pronunciationModeChoice"
                  role="group"
                  aria-label="漢字の読み方を修正するか選択"
                >
                  <button
                    type="button"
                    className={!usePronunciationCorrections ? "active" : ""}
                    aria-pressed={!usePronunciationCorrections}
                    disabled={isMediaBusy}
                    onClick={disableNarrationPronunciationCorrections}
                  >
                    <strong>読み方はそのままでOK</strong>
                    <small>設定せず次へ進む</small>
                  </button>
                  <button
                    type="button"
                    className={usePronunciationCorrections ? "active" : ""}
                    aria-pressed={usePronunciationCorrections}
                    disabled={isMediaBusy}
                    onClick={enableNarrationPronunciationCorrections}
                  >
                    <strong>読み間違いを直す</strong>
                    <small>AI音声の読みだけ変更</small>
                  </button>
                </div>

                {usePronunciationCorrections && (
                  <div className="pronunciationCorrectionFlow">
                    <div className="pronunciationQuickStart">
                      <div>
                        <span>かんたん入力</span>
                        <strong>上の台本で、読み間違えた言葉を選択</strong>
                        <small>
                          選択後にボタンを押すと、下の入力欄へ自動で入ります。直接入力しても大丈夫です。
                        </small>
                      </div>
                      <button
                        type="button"
                        disabled={isMediaBusy}
                        onClick={addSelectedNarrationPronunciationTerm}
                      >
                        選択した言葉を追加
                      </button>
                    </div>
                    <div className="pronunciationExampleLine">
                      <span>入力例</span>
                      <p>
                        テロップは <strong>御厨</strong> のまま、AI音声では
                        <strong> みくりや</strong> と読みます。
                      </p>
                    </div>
                    <div className="pronunciationRows">
                      {narrationPronunciationRows.map((row, index) => {
                        const matchCount =
                          pronunciationMatchCounts.get(row.id) ?? 0;
                        const rowIsComplete = Boolean(
                          row.surface.trim() && row.reading.trim(),
                        );
                        const statusId = `pronunciation-status-${row.id}`;
                        return (
                          <div
                            className={`pronunciationRow${row.surface.trim() && matchCount === 0 ? " hasNoMatch" : ""}`}
                            key={row.id}
                          >
                            <label>
                              <span>テロップに表示されている言葉</span>
                              <input
                                type="text"
                                value={row.surface}
                                maxLength={50}
                                disabled={isMediaBusy}
                                aria-label={`${index + 1}件目のテロップに表示されている言葉`}
                                aria-describedby={statusId}
                                aria-invalid={Boolean(
                                  row.surface.trim() && matchCount === 0,
                                )}
                                placeholder="例：御厨"
                                onChange={(event) =>
                                  updateNarrationPronunciationRow(
                                    row.id,
                                    "surface",
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                            <span
                              className="pronunciationArrow"
                              aria-hidden="true"
                            >
                              →
                            </span>
                            <label>
                              <span>AI音声での読み（ひらがな）</span>
                              <input
                                type="text"
                                value={row.reading}
                                maxLength={80}
                                disabled={isMediaBusy}
                                aria-label={`${index + 1}件目のAI音声での読み`}
                                aria-describedby={statusId}
                                aria-invalid={Boolean(
                                  pronunciationValidation.error &&
                                    (row.surface.trim() || row.reading.trim()),
                                )}
                                placeholder="例：みくりや"
                                onChange={(event) =>
                                  updateNarrationPronunciationRow(
                                    row.id,
                                    "reading",
                                    event.target.value,
                                  )
                                }
                              />
                            </label>
                            <button
                              type="button"
                              className="pronunciationRemove"
                              disabled={
                                isMediaBusy ||
                                (narrationPronunciationRows.length === 1 &&
                                  !row.surface &&
                                  !row.reading)
                              }
                              aria-label={`${index + 1}件目の読み方を削除`}
                              onClick={() =>
                                removeNarrationPronunciationRow(row.id)
                              }
                            >
                              削除
                            </button>
                            <small
                              id={statusId}
                              className={`pronunciationRowStatus${rowIsComplete && matchCount > 0 ? " isMatched" : row.surface.trim() && matchCount === 0 ? " hasError" : ""}`}
                            >
                              {rowIsComplete && matchCount > 0
                                ? `✓ テロップ「${row.surface.trim()}」／音声「${row.reading.trim()}」（${matchCount}か所）`
                                : row.surface.trim() && matchCount === 0
                                  ? "上の台本に見つかりません。台本と同じ文字を入力してください"
                                  : row.surface.trim() || row.reading.trim()
                                    ? "2つの欄を入力してください"
                                    : "まず、読み間違えた言葉を入力してください"}
                            </small>
                          </div>
                        );
                      })}
                    </div>
                    <div className="pronunciationActions">
                      <button
                        type="button"
                        disabled={isMediaBusy || !canAddPronunciationRow}
                        onClick={addNarrationPronunciationRow}
                      >
                        ＋ 別の言葉も修正する
                      </button>
                      <span>最大20件</span>
                    </div>
                    <small
                      className="pronunciationHelp"
                      role={pronunciationValidation.error ? "alert" : undefined}
                    >
                      {pronunciationValidation.error ||
                        "同じ言葉が台本に複数ある場合は、すべて同じ読み方になります。"}
                    </small>
                    <div className="pronunciationResultExplanation">
                      <strong>テロップの漢字は変わりません</strong>
                      <small>AI音声で聞こえる読み方だけを変更します。</small>
                    </div>
                    <p className="pronunciationCostNote">
                      ここへ入力するだけではAI処理の残り回数は減りません。下の生成ボタンを押し、AI音声が完成したときだけ1回分を使います。
                    </p>
                  </div>
                )}
              </div>
              <div className="voiceStylePicker">
                {NARRATION_STYLES.map((style) => (
                  <button
                    type="button"
                    key={style.id}
                    data-style={style.id}
                    className={
                      draftNarrationStyle === style.id ? "active" : ""
                    }
                    aria-pressed={draftNarrationStyle === style.id}
                    onClick={() => {
                      setDraftNarrationStyle(style.id);
                      clearNarrationCorrectionCandidate();
                    }}
                    disabled={isMediaBusy}
                  >
                    <strong>{style.label}</strong>
                    <small>{style.note}</small>
                  </button>
                ))}
              </div>
              <div className="resultAudioMix">
                <OriginalAudioMixControl
                  value={narrationOriginalAudio}
                  onChange={updateNarrationOriginalAudio}
                  disabled={isMediaBusy}
                />
              </div>
              <div
                className={`narrationGenerationQuota${narrationGenerationsRemaining <= 1 ? " isLow" : ""}${narrationGenerationLimitReached ? " isExhausted" : ""}`}
                aria-live="polite"
              >
                <div>
                  <strong>AI処理の利用回数</strong>
                  <span>
                    残り <b>{narrationGenerationsRemaining}</b> / {narrationGenerationLimit}回
                  </span>
                </div>
                <small>
                  {describeAiOperationQuota(
                    usageBucket,
                    narrationGenerationLimit,
                  )}
                  初回のAI台本とAI音声はまとめて1回です。作成後のAI音声の作り直し、文字起こし、高精度再解析は、正常に完了するたびに1回分を使います。失敗・内部の分割処理・自動尺調整では追加消費しません。
                </small>
                {narrationGenerationLimitReached && (
                  <p>
                    現在の編集内容はそのままプレビュー・書き出しできます。新たに作る場合は「別の動画を作る」から開始してください。
                  </p>
                )}
              </div>
              <button
                type="button"
                className="quietButton regenerateVoice"
                disabled={
                  isMediaBusy ||
                  Boolean(pronunciationValidation.error) ||
                  narrationGenerationLimitReached ||
                  !hasPendingNarrationChanges
                }
                onClick={() => void handleNarrationRegeneration()}
              >
                {isRegeneratingNarration
                  ? "AI音声を再生成中…"
                  : narrationGenerationLimitReached
                    ? "AI処理の上限に達しました"
                    : hasPendingNarrationChanges
                      ? "変更内容をAI音声に反映（AI処理1回）"
                      : "変更は反映済み"}
              </button>
              <p
                className={`narrationVoicePreviewStatus${hasPendingNarrationChanges ? " isPending" : ""}`}
                role="status"
              >
                {hasPendingNarrationChanges
                  ? `下の試聴は変更前の「${NARRATION_STYLES.find((item) => item.id === narrationStyle)?.label}」です。生成ボタンを押すと選択した声へ変わります。`
                  : `下の試聴には「${NARRATION_STYLES.find((item) => item.id === narrationStyle)?.label}」が反映されています。`}
              </p>
              <audio
                ref={narrationSampleAudioRef}
                className="narrationAudio"
                src={narrationAudioUrl}
                controls
                preload="metadata"
                onPlay={(event) => {
                  if (isExportingRef.current || isMediaBusy) {
                    event.currentTarget.pause();
                    return;
                  }
                  stopNarrationCorrectionComparisonAudio();
                  pausePreviewTransport();
                }}
              />
              <p className="naturalNarrationNote">
                声を動画尺に合わせて引き伸ばさず、自然な1倍速で再生・書き出しします。読み方を直す場合も、動画分析はやり直しません。
              </p>
              <div className="intonationEditor">
                <div className="intonationEditorHeading">
                  <div>
                    <strong>声の抑揚を一文だけ直す</strong>
                    <small>気になる部分だけ生成して、採用前に聴き比べ</small>
                  </div>
                  <span>部分修正</span>
                </div>
                <p>
                  イントネーションや語尾が不自然な一文を選び、直し方を指定してください。テロップの文字とほかの音声は変わりません。
                </p>
                <label className="intonationSentencePicker">
                  <span>1. 直したい一文</span>
                  <select
                    value={selectedNarrationSegmentIndex}
                    disabled={isMediaBusy || !narrationSegments.length}
                    onChange={(event) =>
                      selectNarrationCorrectionSegment(
                        Number(event.target.value),
                      )
                    }
                  >
                    {narrationSegments.map((segment, index) => (
                      <option key={`${index}-${segment.text}`} value={index}>
                        {index + 1}. {segment.text}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset className="intonationPresetPicker">
                  <legend>2. どのように直すか</legend>
                  <div>
                    {NARRATION_DELIVERY_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={preset.id}
                        className={
                          narrationDeliveryPreset === preset.id ? "active" : ""
                        }
                        aria-pressed={narrationDeliveryPreset === preset.id}
                        disabled={isMediaBusy}
                        onClick={() =>
                          selectNarrationDeliveryPreset(preset.id)
                        }
                      >
                        <strong>{preset.label}</strong>
                        <small>{preset.note}</small>
                      </button>
                    ))}
                  </div>
                </fieldset>
                {narrationDeliveryPreset === "emphasis" && (
                  <label className="intonationEmphasisInput">
                    <span>強調したい言葉</span>
                    <input
                      type="text"
                      maxLength={40}
                      value={narrationEmphasisText}
                      disabled={isMediaBusy}
                      aria-invalid={!narrationEmphasisIsValid}
                      placeholder="選んだ一文にある言葉を入力"
                      onChange={(event) => {
                        setNarrationEmphasisText(event.target.value);
                        clearNarrationCorrectionCandidate();
                      }}
                    />
                    <small>
                      {narrationEmphasisIsValid
                        ? `例：${selectedNarrationSegment?.text
                            .replace(/[。！？!?]/g, "")
                            .slice(0, 12) || "おすすめ"}`
                        : "選んだ一文と同じ表記で入力してください。"}
                    </small>
                  </label>
                )}
                {hasPendingNarrationChanges && (
                  <p className="intonationPendingNotice" role="status">
                    台本・読み方・声の変更がまだ音声へ反映されていません。先に上の「変更内容をAI音声に反映」を押してください。
                  </p>
                )}
                <button
                  type="button"
                  className="quietButton generateIntonationCorrection"
                  disabled={
                    isMediaBusy ||
                    hasPendingNarrationChanges ||
                    narrationGenerationLimitReached ||
                    !selectedNarrationSegment ||
                    !narrationEmphasisIsValid
                  }
                  onClick={() =>
                    void handleNarrationCorrectionGeneration()
                  }
                >
                  {isGeneratingNarrationCorrection
                    ? "この一文を修正中…"
                    : narrationGenerationLimitReached
                      ? "AI処理の上限に達しました"
                      : narrationCorrectionCandidate
                        ? "別の修正候補を生成（AI処理1回）"
                        : "この一文の修正候補を生成（AI処理1回）"}
                </button>
                {narrationCorrectionCandidate && (
                  <div className="intonationComparison">
                    <div className="intonationComparisonHeading">
                      <div>
                        <span>修正候補ができました</span>
                        <strong>
                          {
                            NARRATION_DELIVERY_PRESETS.find(
                              (preset) =>
                                preset.id ===
                                narrationCorrectionCandidate.deliveryPreset,
                            )?.label
                          }
                        </strong>
                      </div>
                      <small>前後を含めて確認できます</small>
                    </div>
                    <div className="intonationCompareAudios">
                      <label>
                        <span>修正前</span>
                        <audio
                          ref={(audio) => {
                            narrationCorrectionAudioRefs.current[0] = audio;
                          }}
                          src={
                            narrationCorrectionCandidate.originalPreviewUrl
                          }
                          controls
                          preload="metadata"
                          onPlay={(event) => {
                            pausePreviewTransport();
                            narrationSampleAudioRef.current?.pause();
                            stopNarrationCorrectionComparisonAudio(
                              event.currentTarget,
                            );
                          }}
                        />
                      </label>
                      <label>
                        <span>修正後</span>
                        <audio
                          ref={(audio) => {
                            narrationCorrectionAudioRefs.current[1] = audio;
                          }}
                          src={
                            narrationCorrectionCandidate.correctedPreviewUrl
                          }
                          controls
                          preload="metadata"
                          onPlay={(event) => {
                            pausePreviewTransport();
                            narrationSampleAudioRef.current?.pause();
                            stopNarrationCorrectionComparisonAudio(
                              event.currentTarget,
                            );
                          }}
                        />
                      </label>
                    </div>
                    <div className="intonationComparisonActions">
                      <button
                        type="button"
                        className="mainCta"
                        disabled={isMediaBusy}
                        onClick={handleNarrationCorrectionApply}
                      >
                        この修正版を採用
                      </button>
                      <button
                        type="button"
                        className="quietButton"
                        disabled={isMediaBusy}
                        onClick={clearNarrationCorrectionCandidate}
                      >
                        採用せず閉じる
                      </button>
                    </div>
                    <p>
                      採用・破棄・聴き直しでは、AI処理の残り回数は減りません。
                    </p>
                  </div>
                )}
                <p className="intonationCostNote">
                  候補の生成が正常に完了したときだけAI処理を1回使用します。音声全体は作り直しません。
                </p>
              </div>
            </div>
            <div className="postCaptionEditor">
              <label>
                <span>Instagram投稿文</span>
                <textarea
                  rows={6}
                  maxLength={1_200}
                  value={narrationPlan.socialCaption}
                  onChange={(event) =>
                    setNarrationPlan({
                      ...narrationPlan,
                      socialCaption: event.target.value,
                    })
                  }
                />
              </label>
              <div className="fixedDisclosure">
                <span>投稿時に自動追加</span>
                <strong>{NARRATION_DISCLOSURE_TEXT}</strong>
                <small>
                  動画へは焼き込まず、投稿文にだけ自然に添えます。
                </small>
              </div>
              <button
                type="button"
                className="mainCta copyPostCaption"
                onClick={() => void copyPostCaption()}
              >
                <span>開示文つき投稿文をコピー</span>
                <i>→</i>
              </button>
            </div>
          </div>
        </details>
      )}

      <div className="resultGrid">
        <div className="previewPanel">
          <div className="previewTop">
            <div className="modeSwitch">
              <button
                className={!captionsVisible ? "active" : ""}
                aria-pressed={!captionsVisible}
                onClick={() =>
                  narrationPlan
                    ? setNarrationCaptionsEnabled(false)
                    : setSpokenCaptionsEnabled(false)
                }
              >
                テロップなし
              </button>
              <button
                className={captionsVisible ? "active" : ""}
                aria-pressed={captionsVisible}
                disabled={
                  isMediaBusy ||
                  (needsSpokenCaptionAnalysis && narrationGenerationLimitReached)
                }
                onClick={() =>
                  narrationPlan
                    ? setNarrationCaptionsEnabled(true)
                    : setSpokenCaptionsEnabled(true)
                }
              >
                {needsSpokenCaptionAnalysis
                  ? narrationGenerationLimitReached
                    ? "AI処理の上限に達しました"
                    : "音声解析してテロップを追加（AI処理1回）"
                  : "テロップあり"}
              </button>
            </div>
            <span>仕上がりプレビュー</span>
          </div>

          <section
            className="postingReadinessPanel"
            aria-labelledby="posting-readiness-heading"
          >
            <div className="postingReadinessHeading">
              <span aria-hidden="true">✓</span>
              <div>
                <strong id="posting-readiness-heading">投稿前チェック</strong>
                <small>追加のAI処理なしで確認します</small>
              </div>
            </div>
            <ul>
              {postingReadinessChecks.map((check) => (
                <li className={check.status} key={check.id}>
                  <span aria-hidden="true">
                    {check.status === "pass"
                      ? "✓"
                      : check.status === "warning"
                        ? "!"
                        : "…"}
                  </span>
                  <div>
                    <strong>{check.label}</strong>
                    <small>{check.detail}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {captionsVisible && (
          <>
          <CaptionStylePicker
            profile={captionProfile}
            setProfile={setCaptionProfile}
            goal={goal}
            disabled={isMediaBusy}
            compact
          />
          {unreadableCaptionCount > 0 && (
            <p className="captionReadabilityNotice" role="status">
              読み切りにくい速さのテロップが{unreadableCaptionCount}件あります。
              テロップを短くするか、その場面を長めに残すと読みやすくなります。
            </p>
          )}
          <div className="captionIdentityPanel">
            <button
              className="captionIdentitySummary"
              type="button"
              aria-expanded={isCaptionDesignerOpen}
              disabled={isMediaBusy}
              onClick={() =>
                setIsCaptionDesignerOpen((current) => !current)
              }
            >
              <span
                className={`identityMonogram ${tone}`}
                style={captionStyle}
                aria-hidden="true"
              >
                Aa
              </span>
              <span>
                <small>色とブランド名</small>
                <strong>
                  {captionProfile.brandName || "ブランド名なし"}
                  ・{captionProfile.accentColor.toUpperCase()}
                </strong>
              </span>
              <i>{isCaptionDesignerOpen ? "閉じる" : "調整する"}</i>
            </button>

            {isCaptionDesignerOpen && (
              <div className="captionIdentityControls">
                <label className="identityControl brandNameControl">
                  <span>屋号・ブランド名 <small>任意</small></span>
                  <input
                    type="text"
                    maxLength={30}
                    value={captionProfile.brandName}
                    placeholder="例：emota studio"
                    disabled={isMediaBusy}
                    onChange={(event) =>
                      setCaptionProfile({
                        ...captionProfile,
                        brandName: event.target.value,
                      })
                    }
                  />
                </label>

                <div className="identityControl">
                  <span>ブランドカラー</span>
                  <div className="accentChoices">
                    {CAPTION_ACCENT_PRESETS.map((color) => (
                      <button
                        aria-label={`ブランドカラー ${color}`}
                        className={
                          captionProfile.accentColor === color
                            ? "active"
                            : ""
                        }
                        key={color}
                        type="button"
                        disabled={isMediaBusy}
                        style={{ backgroundColor: color }}
                        onClick={() =>
                          setCaptionProfile({
                            ...captionProfile,
                            accentColor: color,
                          })
                        }
                      />
                    ))}
                    <label className="customAccent">
                      <input
                        aria-label="好きなブランドカラー"
                        type="color"
                        disabled={isMediaBusy}
                        value={captionProfile.accentColor}
                        onChange={(event) =>
                          setCaptionProfile({
                            ...captionProfile,
                            accentColor: event.target.value,
                          })
                        }
                      />
                      好きな色
                    </label>
                  </div>
                </div>
                <p>
                  設定はこの端末に保存され、ログイン中はアカウントにも引き継がれます。追加のAI利用料はかかりません。
                </p>
              </div>
            )}
          </div>
          </>
          )}

          <div className={`resultVideo ${previewMode}`}>
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                preload="metadata"
                tabIndex={0}
                aria-label="自動編集後の動画プレビュー"
                onClick={() => void togglePlayback()}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    void togglePlayback();
                  }
                }}
                onLoadedMetadata={(event) => {
                  const sourceDuration = event.currentTarget.duration;
                  const sourceWidth = event.currentTarget.videoWidth;
                  const sourceHeight = event.currentTarget.videoHeight;
                  setSourceDuration(
                    Number.isFinite(sourceDuration) && sourceDuration > 0
                      ? sourceDuration
                      : 0,
                  );
                  setSourceVideoDimensions(
                    Number.isFinite(sourceWidth) &&
                      sourceWidth > 0 &&
                      Number.isFinite(sourceHeight) &&
                      sourceHeight > 0
                      ? { width: sourceWidth, height: sourceHeight }
                      : null,
                  );
                  if (
                    editRanges[0] &&
                    event.currentTarget.currentTime <
                      editRanges[0].start
                  ) {
                    event.currentTarget.currentTime =
                      editRanges[0].start;
                    setCurrentTime(editRanges[0].start);
                  }
                }}
                onTimeUpdate={(event) =>
                  handleVideoTimeUpdate(event.currentTarget)
                }
                onSeeking={(event) => {
                  if (isExportingRef.current) return;
                  const internalSeek = previewInternalSeekRef.current;
                  const isExpectedInternalSeek =
                    internalSeek &&
                    Math.abs(
                      event.currentTarget.currentTime - internalSeek.target,
                    ) <= 0.12;
                  if (isExpectedInternalSeek) return;
                  cancelPreviewSeek();
                  previewHoldingFinalFrameRef.current = false;
                  if (previewPlaybackReadyRef.current) {
                    pausePreviewTransport("seeking");
                  }
                }}
                onSeeked={(event) => {
                  setCurrentTime(event.currentTarget.currentTime);
                }}
                onPlay={() => {
                  if (!isExportingRef.current && !narrationPlan) {
                    setIsPlaying(true);
                    setPreviewTransportState("playing");
                  }
                }}
                onPause={() => {
                  if (previewHoldingFinalFrameRef.current) return;
                  if (isExportingRef.current) return;
                  if (
                    narrationPlan &&
                    previewPlaybackReadyRef.current &&
                    !previewContinuousCutSeekRef.current
                  ) {
                    previewOperationRef.current += 1;
                    previewPlaybackReadyRef.current = false;
                    stopPreviewNarrationSource();
                    setIsPlaying(false);
                    setPreviewTransportState("paused");
                  } else if (!narrationPlan) {
                    setIsPlaying(false);
                    setPreviewTransportState("paused");
                  }
                }}
                onEnded={() => {
                  if (previewHoldingFinalFrameRef.current) return;
                  if (isExportingRef.current) return;
                  if (narrationPlan) finishPreviewAtEnd();
                  else pausePreviewTransport("ended");
                }}
              />
            ) : (
              <div className="resultSample">
                <CreatorFigure variant={previewMode} />
              </div>
            )}
            <canvas
              ref={captionPreviewCanvasRef}
              className="resultCaptionCanvas"
              aria-hidden="true"
            />
            {captionsVisible && activeCaption && (
              <span className="visuallyHidden" aria-live="polite">
                {activeCaption.text}
              </span>
            )}
            <span className="videoState">
              {captionsVisible ? "テロップON" : "テロップOFF"}
            </span>
            <span className="outputRange">
              {narrationPlan
                ? narrationAutoCutEnabled
                  ? `${length}秒以内版`
                  : "元動画をノーカット"
                : spokenCutMode === "auto"
                  ? `約${length}秒版`
                  : spokenCutMode === "manual"
                    ? "手動カット版"
                    : "元動画をノーカット"}
              ・実尺{formatCaptionClock(editDuration)}
            </span>
          </div>

          <div className="timelinePreview">
            <div className="previewTransportButtons">
              <button
                className="transportButton"
                type="button"
                onClick={() =>
                  void seekToEditedTime(
                    previewDisplayTime - 5,
                    isPlaying,
                  )
                }
                disabled={isMediaBusy || editDuration <= 0}
                aria-label="5秒戻る"
              >
                −5
              </button>
              <button
                className="playButton"
                type="button"
                onClick={() => void togglePlayback()}
                disabled={isMediaBusy || editDuration <= 0}
                aria-label={isPlaying ? "一時停止" : "再生"}
              >
                {previewTransportState === "loading" ? "…" : isPlaying ? "Ⅱ" : "▶"}
              </button>
              <button
                className="transportButton"
                type="button"
                onClick={() =>
                  void seekToEditedTime(
                    previewDisplayTime + 5,
                    isPlaying,
                  )
                }
                disabled={isMediaBusy || editDuration <= 0}
                aria-label="5秒進む"
              >
                +5
              </button>
            </div>
            <div className="timelineScrubberWrap">
              <input
                className="timelineScrubber"
                type="range"
                min={0}
                max={Math.max(editDuration, 0.01)}
                step={0.05}
                value={Math.min(previewDisplayTime, Math.max(editDuration, 0.01))}
                disabled={isMediaBusy || editDuration <= 0}
                aria-label="仕上がり動画の再生位置"
                aria-valuetext={`${formatCaptionClock(previewDisplayTime)} / ${formatCaptionClock(editDuration)}`}
                style={
                  {
                    "--preview-progress": `${previewProgress}%`,
                  } as CSSProperties
                }
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  beginPreviewScrub();
                }}
                onChange={(event) =>
                  updatePreviewScrub(Number(event.currentTarget.value))
                }
                onPointerUp={() => void finishPreviewScrub()}
                onPointerCancel={() => void finishPreviewScrub()}
                onLostPointerCapture={() => void finishPreviewScrub()}
                onKeyDown={(event) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "Home",
                      "End",
                      "PageUp",
                      "PageDown",
                    ].includes(event.key)
                  ) {
                    beginPreviewScrub();
                  }
                }}
                onKeyUp={() => void finishPreviewScrub()}
                onBlur={() => void finishPreviewScrub()}
              />
              <div className="timelineStatus">
                <span
                  className={
                    narrationPlan
                      ? "previewAudioStatus active"
                      : "previewAudioStatus"
                  }
                  aria-live="polite"
                >
                  {previewStatusLabel}
                </span>
                <span>
                  {formatCaptionClock(previewDisplayTime)} /{" "}
                  {formatCaptionClock(editDuration)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <details className="editPanel resultDetailCard">
          <summary className="resultDetailSummary">
            <span aria-hidden="true">字</span>
            <p>
              <strong>
                {narrationPlan ? "テロップと区間を確認" : "テロップ・カットを調整"}
              </strong>
              <small>必要なところだけ開いて変更できます</small>
            </p>
            <i aria-hidden="true">⌄</i>
          </summary>
          <div className="editPanelHeading">
            <div>
              <p className="eyebrow">テロップ編集</p>
              <h2>
                {narrationPlan
                  ? narrationCaptionsEnabled
                    ? "音声とテロップを確認"
                    : "AIナレーションを確認"
                  : spokenCutMode !== "none"
                    ? "残す区間を選ぶ"
                    : spokenCaptionsEnabled
                      ? "テロップを確認"
                      : "元動画を確認"}
              </h2>
            </div>
            <span>プレビューへ自動反映</span>
          </div>
          <p className="editHelp">
            {narrationPlan
              ? narrationCaptionsEnabled
                ? "テロップはAI音声と同期しています。内容を変えるときは、上の台本を編集して「AI音声を作り直す」ボタンを押してください。"
                : "テロップは付けない設定です。内容を変えるときは、上の台本を編集して「AI音声を作り直す」ボタンを押してください。"
              : spokenCutMode !== "none"
                ? "使わない区間を「カット」にすると、同じ時間の映像・元音声・テロップが仕上がり動画から外れます。元動画は変更されず、いつでも戻せます。"
                : spokenCaptionsEnabled
                  ? "元動画はカットせず、冒頭から最後まで使います。下の文字はテロップへ反映されます。"
                  : "元動画はカットせず、テロップも重ねません。文字起こしデータは字幕ファイルとして保存できます。"}
          </p>
          {!narrationPlan && spokenCutMode !== "none" && (
            <>
              <div className="captionCutToolbar">
                <span aria-live="polite">
                  <strong>{keptLines.length}</strong>区間を残す
                  <i aria-hidden="true">/</i>
                  <strong>{removedCount}</strong>区間をカット
                  <i aria-hidden="true">/</i>
                  仕上がり <strong>{formatCaptionClock(editDuration)}</strong>
                  {spokenCutMode === "manual" && <em>目安 {length}秒</em>}
                </span>
                <button
                  type="button"
                  onClick={resetCaptionCuts}
                  disabled={!hasCutChanges || isMediaBusy}
                >
                  最初の編集に戻す
                </button>
              </div>
              {spokenCutMode === "auto" && (
                <div className="automaticEditSummary" role="status">
                  <div>
                    <strong>おまかせ編集の判断</strong>
                    <span>すべて後から変更できます</span>
                  </div>
                  <ul>
                    {automaticSilenceSummary.count > 0 && (
                      <li>
                        長い無音を{automaticSilenceSummary.count}か所、約
                        {Math.round(automaticSilenceSummary.totalSeconds * 10) / 10}
                        秒分整えています
                      </li>
                    )}
                    {removedCount > 0 ? (
                      <li>各カットの理由を下の区間ごとに表示しています</li>
                    ) : (
                      <li>話の内容はカットせず、そのまま残しています</li>
                    )}
                  </ul>
                </div>
              )}
            </>
          )}
          <div className="transcriptList">
            {transcript.map((line) => {
              const cutReason = cutReasonById.get(line.id);
              return (
              <div
                className={`transcriptLine ${line.removed ? "removed" : ""} ${line.accent ? "accent" : ""}`}
                key={line.id}
              >
                <div className="captionEditor">
                  <button
                    className="captionTime"
                    disabled={isMediaBusy}
                    onClick={() =>
                      narrationPlan
                        ? seekToEditedTime(
                            sourceTimeToEditedTime(editRanges, line.start),
                          )
                        : seekTo(line.start)
                    }
                    type="button"
                  >
                    元動画{" "}
                    {formatCaptionClock(line.start)}–
                    {formatCaptionClock(line.end)}
                  </button>
                  <input
                    value={line.text}
                    onChange={(event) => updateLine(line.id, event.target.value)}
                    disabled={line.removed || isMediaBusy}
                    readOnly={Boolean(narrationPlan)}
                    aria-label={`元動画${formatCaptionClock(line.start)}から${formatCaptionClock(line.end)}のテロップ`}
                    onFocus={() =>
                      captionEditStartTextRef.current.set(line.id, line.text)
                    }
                    onBlur={() => finishLineEdit(line.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                <div className="captionLineControls">
                  {line.removed ? (
                    <span className="captionCutStatus">カット中</span>
                  ) : (
                    line.accent && (
                      <span className="captionAccentStatus">強調</span>
                    )
                  )}
                  {!narrationPlan && spokenCutMode !== "none" && (
                    <button
                      type="button"
                      className="captionCutToggle"
                      onClick={() => toggleLine(line.id)}
                      disabled={isMediaBusy}
                      aria-pressed={line.removed}
                      aria-label={
                        line.removed
                          ? `元動画${formatCaptionClock(line.start)}から${formatCaptionClock(line.end)}の区間を仕上がり動画へ戻す`
                          : `元動画${formatCaptionClock(line.start)}から${formatCaptionClock(line.end)}の映像・元音声・テロップを仕上がりからカット`
                      }
                    >
                      <span aria-hidden="true">
                        {line.removed ? "↶" : "✂"}
                      </span>
                      {line.removed ? "元に戻す" : "この区間をカット"}
                    </button>
                  )}
                </div>
                {line.removed && cutReason && (
                  <div className={`captionCutReason ${cutReason.code}`}>
                    <strong>{cutReason.label}</strong>
                    <small>{cutReason.detail}</small>
                  </div>
                )}
              </div>
              );
            })}
          </div>
          <div className="cutSummary">
            <div>
              <span>
                {narrationPlan
                  ? "映像カット"
                  : spokenCutMode !== "none"
                    ? "カット"
                    : "映像"}
              </span>
              <strong>
                {narrationPlan
                  ? narrationAutoCutEnabled
                    ? "自動"
                    : "なし"
                  : spokenCutMode !== "none"
                    ? `${removedCount}区間`
                    : "元動画のまま"}
              </strong>
            </div>
            <div>
              <span>
                {narrationPlan || spokenCutMode === "none" ? "テロップ" : "残す"}
              </span>
              <strong>
                {narrationPlan
                  ? narrationCaptionsEnabled
                    ? "あり"
                    : "なし"
                  : spokenCutMode === "none"
                    ? spokenCaptionsEnabled
                      ? "あり"
                      : "なし"
                    : `${keptLines.length}区間`}
              </strong>
            </div>
            <div>
              <span>仕上がり</span>
              <strong>{formatCaptionClock(editDuration)}</strong>
            </div>
          </div>
        </details>
      </div>

      <details className="thumbnailMaker resultDetailCard">
        <summary className="resultDetailSummary">
          <span aria-hidden="true">表</span>
          <p>
            <strong>投稿用の表紙を作る</strong>
            <small>顔・構図・画質から候補を選べます</small>
          </p>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div className="thumbnailMakerHeading">
          <div>
            <p className="eyebrow">表紙を作る</p>
            <h2>動画から、投稿用の表紙をつくる</h2>
            <p>
              顔・構図・画質・場面変化を端末内で確認し、実際の動画フレームから9:16の表紙を生成します。
            </p>
          </div>
          <span>1080 × 1920 JPEG</span>
        </div>

        <div className="thumbnailMakerGrid">
          <div className="thumbnailControls">
            <div className="thumbnailControlGroup">
              <div className="thumbnailControlLabel">
                <span>01</span>
                <strong>表紙に使う場面</strong>
                <small>最大3候補</small>
              </div>
              {isAnalyzingThumbnailFrames && (
                <p className="thumbnailAnalysisStatus" role="status">
                  動画全体から、表紙に向く場面を解析しています…
                </p>
              )}
              {thumbnailAnalysisNote && (
                <p className="thumbnailAnalysisNote">
                  {thumbnailAnalysisNote}
                </p>
              )}
              {thumbnailAnalysisError && (
                <div className="thumbnailAnalysisStatus" role="alert">
                  <p>{thumbnailAnalysisError}</p>
                  <button
                    type="button"
                    className="thumbnailAnalysisRetry"
                    onClick={() =>
                      setThumbnailAnalysisRevision((current) => current + 1)
                    }
                  >
                    候補をもう一度解析
                  </button>
                </div>
              )}
              <div className="thumbnailCandidateList">
                {thumbnailFrameChoices.map((choice, index) => (
                  <button
                    type="button"
                    key={choice.id}
                    className={
                      selectedThumbnailFrame?.id === choice.id
                        ? "active"
                        : ""
                    }
                    aria-pressed={selectedThumbnailFrame?.id === choice.id}
                    disabled={isMediaBusy || isAnalyzingThumbnailFrames}
                    onClick={() => chooseThumbnailCandidate(choice)}
                  >
                    <span className="thumbnailCandidateVisual">
                      {/* Local data URL created from the selected source video. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={choice.previewDataUrl}
                        alt={`${index === 0 ? "おすすめ" : `候補${index + 1}`}の動画フレーム`}
                      />
                      <b>{index === 0 ? "おすすめ" : `候補 ${index + 1}`}</b>
                    </span>
                    <span className="thumbnailCandidateCopy">
                      <strong>{choice.qualityLabel}</strong>
                      <small>
                        動画の {formatCaptionClock(choice.time)} 付近
                        {choice.faceCount > 0
                          ? `・顔${choice.faceCount}件を検出`
                          : ""}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              {selectedThumbnailFrame && sourceVideoDimensions && (
                <div className="thumbnailFocusControls">
                  <p>
                    <strong>切り抜く位置を微調整</strong>
                    <small>顔や主役が中央に来るよう、必要なときだけ動かせます</small>
                  </p>
                  <label>
                    <span>左右</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(
                        0,
                        sourceVideoDimensions.width -
                          selectedThumbnailFrame.crop.width,
                      )}
                      step={1}
                      value={selectedThumbnailFrame.crop.x}
                      disabled={
                        isMediaBusy ||
                        selectedThumbnailFrame.crop.width >=
                          sourceVideoDimensions.width
                      }
                      onChange={(event) =>
                        updateThumbnailCrop("x", Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    <span>上下</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(
                        0,
                        sourceVideoDimensions.height -
                          selectedThumbnailFrame.crop.height,
                      )}
                      step={1}
                      value={selectedThumbnailFrame.crop.y}
                      disabled={
                        isMediaBusy ||
                        selectedThumbnailFrame.crop.height >=
                          sourceVideoDimensions.height
                      }
                      onChange={(event) =>
                        updateThumbnailCrop("y", Number(event.target.value))
                      }
                    />
                  </label>
                  <small>「表紙を生成する」を押すと調整後の位置を確認できます。</small>
                </div>
              )}
            </div>

            <label className="thumbnailTitleControl">
              <span className="thumbnailControlLabel">
                <span>02</span>
                <strong>表紙のタイトル</strong>
                <small>自由に修正できます</small>
              </span>
              <textarea
                rows={2}
                maxLength={36}
                value={thumbnailTitle}
                disabled={isMediaBusy || !selectedThumbnailFrame}
                onChange={(event) => {
                  if (!selectedThumbnailFrame) return;
                  setThumbnailTitleOverrides((current) => ({
                    ...current,
                    [selectedThumbnailFrame.id]: event.target.value,
                  }));
                }}
                placeholder="表紙に表示する言葉"
              />
              <small>{Array.from(thumbnailTitle).length} / 36文字</small>
            </label>

            <div className="thumbnailThemeSummary">
              <span className={`patternSwatch ${tone}`} style={captionStyle}>
                Aa
              </span>
              <p>
                <small>03 デザイン</small>
                <strong>
                  {CAPTION_MOODS.find(
                    (item) => item.id === captionProfile.mood,
                  )?.label ?? "ナチュラル"}
                  を表紙にも反映
                </strong>
              </p>
            </div>

            <button
              type="button"
              className="mainCta thumbnailGenerateButton"
              onClick={() => void generateThumbnail()}
              disabled={
                isMediaBusy ||
                isAnalyzingThumbnailFrames ||
                !file ||
                !selectedThumbnailFrame ||
                !thumbnailTitle.trim()
              }
            >
              <span>
                {isGeneratingThumbnail
                  ? "表紙を生成中…"
                  : readyThumbnailFile
                    ? "この内容で作り直す"
                    : "表紙を生成する"}
              </span>
              <i>{isGeneratingThumbnail ? "●" : "✦"}</i>
            </button>
            {!file && (
              <p className="thumbnailUnavailable">
                実際の動画を選ぶと表紙を生成できます。
              </p>
            )}
          </div>

          <div className="thumbnailPreviewPanel">
            <div className="thumbnailPreviewFrame">
              {thumbnailPreviewUrl ? (
                // This is a short-lived local blob URL, which Next Image cannot optimize.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={thumbnailPreviewUrl}
                  alt="生成した9対16の表紙プレビュー"
                />
              ) : (
                <div className="thumbnailPreviewPlaceholder">
                  <span>9:16</span>
                  <strong>生成した表紙をここで確認</strong>
                  <small>保存前に見た目を確認できます</small>
                </div>
              )}
            </div>
            {readyThumbnailFile && (
              <button
                type="button"
                className="thumbnailSaveButton"
                onClick={() => void saveThumbnail()}
                disabled={isMediaBusy}
              >
                <span>表紙を保存・共有</span>
                <i>↓</i>
              </button>
            )}
          </div>
        </div>
      </details>

      {editedTranscript.some((line) => line.text.trim().length > 0) && (
      <details className="deliverables resultDetailCard">
        <summary className="resultDetailSummary">
          <span aria-hidden="true">文</span>
          <p>
            <strong>字幕テキスト・SRT・VTTを保存</strong>
            <small>動画編集ソフトやWeb動画で使えます</small>
          </p>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div>
          <p className="eyebrow">投稿の準備</p>
          <h2>字幕データを、すぐ使える形式で保存できます。</h2>
        </div>
        <div className="deliverableCards">
          <button onClick={() => void copyTranscript()}>
            <span className="deliverableIcon cover">文</span>
            <p>
              <strong>字幕をコピー</strong>
              <small>修正済みテキスト</small>
            </p>
            <i>→</i>
          </button>
          <button
            onClick={() =>
              downloadText(
                `${exportName}.srt`,
                captionsToSrt(editedTranscript),
                "application/x-subrip",
              )
            }
          >
            <span className="deliverableIcon copy">S</span>
            <p>
              <strong>SRTを保存</strong>
              <small>動画編集ソフト向け</small>
            </p>
            <i>→</i>
          </button>
          <button
            onClick={() =>
              downloadText(
                `${exportName}.vtt`,
                captionsToVtt(editedTranscript),
                "text/vtt",
              )
            }
          >
            <span className="deliverableIcon text">V</span>
            <p>
              <strong>VTTを保存</strong>
              <small>Web動画向け</small>
            </p>
            <i>→</i>
          </button>
        </div>
      </details>
      )}

      {!file && (
        <div className="handoffPrompt">
          <div className="handoffPromptIcon">↑</div>
          <div>
            <p className="eyebrow">自分の動画で試す</p>
            <h2>サンプルではなく、実際の動画でも試せます。</h2>
            <p>
              動画を選ぶと、音声を解析して時刻付きの日本語字幕を自動生成します。
            </p>
          </div>
          <button onClick={chooseVideo}>
            <span>動画を選ぶ</span>
            <i>→</i>
          </button>
        </div>
      )}

      {file && !narrationPlan && (
        <div
          className={`narrationGenerationQuota${narrationGenerationsRemaining <= 1 ? " isLow" : ""}${narrationGenerationLimitReached ? " isExhausted" : ""}`}
          aria-live="polite"
        >
          <div>
            <strong>AI処理の利用回数</strong>
            <span>
              残り <b>{narrationGenerationsRemaining}</b> / {narrationGenerationLimit}回
            </span>
          </div>
          <small>
            {describeAiOperationQuota(
              usageBucket,
              narrationGenerationLimit,
            )}
            文字起こしと高精度再解析が完成するたびに1回分を使います。テロップ・カット・音量・表紙の変更、プレビュー、書き出しでは減りません。
          </small>
          {narrationGenerationLimitReached && (
            <p>
              現在の編集内容はそのままプレビュー・書き出しできます。
            </p>
          )}
        </div>
      )}

      <div className="exportBar">
        <div>
          <span className="exportIcon">▶</span>
          <p>
            <strong>
              {readyExportedVideoFile?.name ?? `${exportName}_${exportSuffix}.mp4`}
            </strong>
            <small className="exportStatus">
              <span className="exportResolutionStatus">
                {!completedVideoSaveAllowed
                  ? "無料体験では編集・プレビューまで利用できます。"
                  : readyExportedVideoFile
                  ? exportedVideoQualityMessage ??
                    "品質確認済みの動画です。元動画の解像度を取得できなかったため、完成動画の実測値だけを表示しています。"
                  : isExporting && exportProgress !== null
                    ? `MP4動画を書き出しています（${Math.round(exportProgress)}%）。${plannedResolutionMessage}`
                    : file
                      ? plannedResolutionMessage
                      : "実際の動画を選ぶと、元動画と完成動画の解像度を表示します。"}
              </span>
              {file && !readyExportedVideoFile && !isExporting && (
                <span className="exportModeNote">
                  {narrationPlan
                    ? `AI音声${narrationCaptionsEnabled ? "とテロップ" : ""}を、${narrationAutoCutEnabled ? "自動編集した映像" : "ノーカット映像"}へまとめます。`
                    : `${spokenCutMode === "auto" ? "音声に合わせてつなぎ直した映像" : spokenCutMode === "manual" ? "自分で選んだ区間の映像" : "ノーカット映像"}${spokenCaptionsEnabled ? "とテロップ" : ""}を、iPhoneで使える動画へまとめます。`}
                </span>
              )}
            </small>
          </p>
        </div>
        <div className="exportActions">
          <button
            className="quietButton"
            onClick={reset}
            disabled={isMediaBusy}
          >
            別の動画を作る
          </button>
          {file &&
            transcript.some((line) => line.text.trim().length > 0) &&
            !usedHighAccuracy &&
            !narrationPlan && (
            <button
              className="quietButton highAccuracyButton"
              onClick={() => void regenerateHighAccuracy()}
              disabled={isMediaBusy || narrationGenerationLimitReached}
            >
              {narrationGenerationLimitReached
                ? "AI処理の上限に達しました"
                : "高精度で再生成（AI処理1回）"}
            </button>
          )}
          {checkoutReturnMessage && (
            <p className="freeExportReturnNote" role="status">
              {checkoutReturnMessage}
            </p>
          )}
          {isExporting && (
            <button
              className="quietButton"
              type="button"
              onClick={cancelVideoExport}
              disabled={isFinalizingExport}
            >
              {isFinalizingExport ? "利用枠を確定中…" : "書き出しを中止"}
            </button>
          )}
          {file && !completedVideoSaveAllowed ? (
            <MonthlyFirstPurchaseOptions
              className="freeExportGate"
              id="free-export-plans"
              source="result"
              mode={audioMode === "narration" ? "narration" : "spoken"}
            >
              <p>
                <strong>続けて保存するなら月額がお得</strong>
                <small>
                  月3本・500円なら、1本ずつ3回購入するより100円お得です。月額にしない場合は、今回だけ1本の購入も選べます。
                </small>
              </p>
              <div>
                <Link
                  className="mainCta"
                  href="/account?checkout=starter"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => markCheckoutStarted("starter")}
                >
                  <span>
                    {STARTER_MONTHLY_PLAN_LABEL}・¥
                    {STARTER_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月（税込）
                  </span>
                  <i>→</i>
                </Link>
                <Link
                  className="quietButton"
                  href="/account?checkout=standard"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => markCheckoutStarted("standard")}
                >
                  {STANDARD_MONTHLY_PLAN_LABEL}・¥
                  {STANDARD_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}／1か月（税込）
                </Link>
              </div>
              <OneTimeRescue
                source="result"
                mode={audioMode === "narration" ? "narration" : "spoken"}
                className="freeExportOneTimeRescue"
              >
                <div>
                  <strong>
                    この1本だけ・¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}（税込）
                  </strong>
                  <small>1回払い・自動更新なし・有効期限なし</small>
                </div>
                <Link
                  className="quietButton"
                  href="/account?checkout=one_time"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => markCheckoutStarted("one_time")}
                >
                  この1本だけ保存する
                </Link>
              </OneTimeRescue>
              <small className="freeExportReturnNote">
                決済は別タブで開きます。購入後、この編集画面へ戻ってください。
                月3本・月7本プランは1か月ごとの自動更新です。動画1本プランは1回払いです。
              </small>
              <button
                className="freeExportRefreshButton"
                type="button"
                onClick={() => void checkPaidExportAccess()}
                disabled={isCheckingPaidExportAccess}
              >
                {isCheckingPaidExportAccess
                  ? "購入状況を確認中…"
                  : "購入済みの方：保存を有効にする（再確認）"}
              </button>
            </MonthlyFirstPurchaseOptions>
          ) : file ? (
            <button
              className="mainCta reviewCta"
              onClick={
                readyExportedVideoFile
                  ? () => void saveExportedVideo()
                  : requestVideoExport
              }
              disabled={isMediaBusy}
            >
              <span>
                {readyExportedVideoFile
                  ? "動画を保存・共有"
                  : isExporting
                  ? "書き出し中…"
                  : narrationPlan
                    ? "AI音声付き動画を書き出す"
                    : spokenCaptionsEnabled
                      ? "テロップ付き動画を書き出す"
                      : "動画を書き出す"}
              </span>
              <i>{isExporting ? "●" : "↓"}</i>
            </button>
          ) : (
            <button className="mainCta reviewCta" onClick={chooseVideo}>
              <span>実際の動画で試す</span>
              <i>→</i>
            </button>
          )}
        </div>
      </div>

      <aside className="resultFeedback" aria-labelledby="resultFeedbackTitle">
        {feedbackSubmitted ? (
          <p role="status">
            <span aria-hidden="true">✓</span>
            ご感想ありがとうございます。今後の品質改善に活用します。
          </p>
        ) : (
          <>
            <div>
              <strong id="resultFeedbackTitle">今回の仕上がりはいかがでしたか？</strong>
              <small>動画・音声・字幕の内容は送信されません。</small>
            </div>
            <div className="resultFeedbackActions">
              <button
                type="button"
                disabled={feedbackSending}
                onClick={() => void submitResultFeedback("helpful", [])}
              >
                <span aria-hidden="true">◎</span> 良かった
              </button>
              <button
                type="button"
                className={feedbackRating === "needs_work" ? "active" : ""}
                aria-expanded={feedbackRating === "needs_work"}
                disabled={feedbackSending}
                onClick={() => setFeedbackRating("needs_work")}
              >
                <span aria-hidden="true">△</span> 改善してほしい
              </button>
            </div>
            {feedbackRating === "needs_work" && (
              <div className="resultFeedbackDetails">
                <span>気になったところを選んでください</span>
                <div>
                  {[
                    ["easy", "操作"],
                    ["quality", "画質"],
                    ["captions", "テロップ"],
                    ["voice", "AI音声"],
                    ["cut", "カット"],
                    ["export", "保存"],
                    ["other", "その他"],
                  ].map(([tag, label]) => {
                    const selected = feedbackTags.includes(tag);
                    return (
                      <button
                        type="button"
                        key={tag}
                        className={selected ? "active" : ""}
                        aria-pressed={selected}
                        onClick={() =>
                          setFeedbackTags((current) =>
                            selected
                              ? current.filter((item) => item !== tag)
                              : current.length < 5
                                ? [...current, tag]
                                : current,
                          )
                        }
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="feedbackSubmit"
                  disabled={feedbackSending || feedbackTags.length === 0}
                  onClick={() =>
                    void submitResultFeedback("needs_work", feedbackTags)
                  }
                >
                  {feedbackSending ? "送信中…" : "匿名で送信"}
                </button>
              </div>
            )}
          </>
        )}
      </aside>

      {showDisclosureConfirm && (
        <div
          className="disclosureModalBackdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowDisclosureConfirm(false);
            }
          }}
        >
          <div
            ref={disclosureDialogRef}
            className="disclosureModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disclosure-title"
            aria-describedby="disclosure-description"
            tabIndex={-1}
          >
            <button
              type="button"
              className="modalClose"
              aria-label="閉じる"
              onClick={() => setShowDisclosureConfirm(false)}
            >
              ×
            </button>
            <p className="eyebrow">保存前の確認</p>
            <h2 id="disclosure-title">投稿時の表示を確認してください</h2>
            <p id="disclosure-description">
              動画には透かしを入れません。代わりに、コピー済みの投稿文へ次の一文を残して投稿してください。
            </p>
            <strong className="modalDisclosureText">
              {NARRATION_DISCLOSURE_TEXT}
            </strong>
            <label className="disclosureCheck">
              <input
                type="checkbox"
                checked={disclosureConfirmed}
                onChange={(event) =>
                  setDisclosureConfirmed(event.target.checked)
                }
              />
              <span>
                投稿時にこの開示文を含めます。
                <a href="/terms" target="_blank" rel="noreferrer">
                  利用規約
                </a>
                を確認しました。
              </span>
            </label>
            <div className="modalActions">
              <button
                type="button"
                className="quietButton"
                onClick={() => setShowDisclosureConfirm(false)}
              >
                戻る
              </button>
              <button
                type="button"
                className="mainCta"
                disabled={!disclosureConfirmed || isRecordingDisclosure}
                onClick={() => void confirmNarrationExport()}
              >
                <span>
                  {isRecordingDisclosure
                    ? "確認中…"
                    : "確認して動画を書き出す"}
                </span>
                <i>↓</i>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CreatorFigure({ variant }: { variant: "before" | "after" }) {
  return (
    <div className={`creatorFigure ${variant}`}>
      <span className="hair" />
      <span className="face">
        <i className="eye left" />
        <i className="eye right" />
        <i className="mouth" />
      </span>
      <span className="body" />
      <span className="hand left" />
      <span className="hand right" />
      {variant === "before" && <i className="hesitation">…</i>}
      {variant === "after" && <i className="idea">!</i>}
    </div>
  );
}
