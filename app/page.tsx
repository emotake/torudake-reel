"use client";

import {
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
  selectCaptionHighlight,
  type CaptionSegment,
} from "../lib/captions";
import {
  buildEditRanges,
  createNaturalEdit,
  editedTimeToSourceTime,
  getEditedDuration,
  isIncludedCaption,
  remapCaptionsToEditedTimeline,
  setCaptionCut,
  sourceTimeToEditedTime,
} from "../lib/edit-plan";
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
  LIGHT_MONTHLY_PRICE_JPY,
  LIGHT_MONTHLY_VIDEO_LIMIT,
  ONE_TIME_PRICE_JPY,
} from "../lib/billing-policy";
import {
  buildDisclosedPostCaption,
  buildNarrationTimeline,
  DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT,
  getNarrationBufferSlice,
  getNarrationMixLevels,
  getNarrationPlaybackRate,
  MAX_NARRATION_ORIGINAL_AUDIO_PERCENT,
  NARRATION_DISCLOSURE_TEXT,
  NARRATION_STYLES,
  NARRATION_TERMS_VERSION,
  splitNarrationScript,
  type NarrationPlan,
  type NarrationOriginalAudioLevel,
  type NarrationStyle,
  type VideoAudioMode,
} from "../lib/narration";

type Stage = "start" | "setup" | "processing" | "result" | "transfer";
type Goal = CaptionGoal;
type PreviewMode = "before" | "after";
type PreviewTransportState =
  | "paused"
  | "loading"
  | "playing"
  | "seeking"
  | "ended";
type TransferStatus = "idle" | "uploading" | "done" | "error";

type UploadedPart = {
  partNumber: number;
  etag: string;
};

type TransferReceipt = {
  id: string;
  code: string;
  expiresAt: number;
};

type TranscriptLine = CaptionSegment;

type ApiPayload = {
  error?: string;
};

type TranscriptionResult = {
  refined: boolean;
  segments: TranscriptLine[];
};

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const DIRECT_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
const MAX_EDIT_VIDEO_BYTES = 500 * 1024 * 1024;
const NARRATION_DURATION_TOLERANCE_SECONDS = 0.08;

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

function RichCaptionText({
  caption,
  maxCharacters = 14,
}: {
  caption: TranscriptLine;
  maxCharacters?: number;
}) {
  const highlight = caption.highlight?.trim() ?? "";
  const lines = wrapCaptionLines(caption.text, maxCharacters, 2);

  return lines.map((line, lineIndex) => {
    const highlightIndex = highlight ? line.indexOf(highlight) : -1;
    return (
      <span className="captionLine" key={`${caption.id}-${lineIndex}`}>
        {highlightIndex < 0 ? (
          line
        ) : (
          <>
            {line.slice(0, highlightIndex)}
            <strong>{highlight}</strong>
            {line.slice(highlightIndex + highlight.length)}
          </>
        )}
      </span>
    );
  });
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
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const responseText = (await response.text()).trim();
    throw new ApiRequestError(
      response.status === 413
        ? "動画の送信サイズが上限を超えました。動画を短くするか圧縮してお試しください。"
        : responseText || fallbackMessage,
      response.status,
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
    );
  }
  return payload;
}

async function uploadVideoInChunks(
  selectedFile: File,
  controller: AbortController,
  onProgress: (progress: number) => void,
) {
  let activeReceipt: TransferReceipt | null = null;

  try {
    const initResponse = await fetch("/api/transfers/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: selectedFile.name,
        contentType: selectedFile.type || "video/mp4",
        size: selectedFile.size,
      }),
      signal: controller.signal,
    });
    const initData = await readApiResponse<
      ApiPayload & {
        id?: string;
        code?: string;
        uploadId?: string;
        chunkSize?: number;
        expiresAt?: number;
      }
    >(initResponse, "アップロードを開始できませんでした。");

    if (
      !initData.id ||
      !initData.code ||
      !initData.uploadId ||
      !initData.chunkSize ||
      !initData.expiresAt
    ) {
      throw new Error("アップロードの準備情報が正しくありません。");
    }

    activeReceipt = {
      id: initData.id,
      code: initData.code,
      expiresAt: initData.expiresAt,
    };

    const partCount = Math.ceil(selectedFile.size / initData.chunkSize);
    const uploadedParts: UploadedPart[] = [];
    let uploadedBytes = 0;

    for (let startPart = 1; startPart <= partCount; startPart += 3) {
      const batch = Array.from(
        { length: Math.min(3, partCount - startPart + 1) },
        (_, index) => startPart + index,
      );

      const results = await Promise.all(
        batch.map(async (partNumber) => {
          const start = (partNumber - 1) * initData.chunkSize!;
          const end = Math.min(start + initData.chunkSize!, selectedFile.size);
          const response = await fetch(
            `/api/transfers/${encodeURIComponent(initData.id!)}/part?partNumber=${partNumber}&uploadId=${encodeURIComponent(initData.uploadId!)}&code=${encodeURIComponent(initData.code!)}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(end - start),
              },
              body: selectedFile.slice(start, end),
              signal: controller.signal,
            },
          );
          const data = await readApiResponse<
            ApiPayload & {
              partNumber?: number;
              etag?: string;
            }
          >(response, "動画の送信中にエラーが発生しました。");
          if (!data.partNumber || !data.etag) {
            throw new Error("アップロード結果が正しくありません。");
          }
          return {
            part: { partNumber: data.partNumber, etag: data.etag },
            bytes: end - start,
          };
        }),
      );

      results.forEach((result) => {
        uploadedParts.push(result.part);
        uploadedBytes += result.bytes;
      });
      onProgress(
        Math.min(96, Math.round((uploadedBytes / selectedFile.size) * 95)),
      );
    }

    const completeResponse = await fetch(
      `/api/transfers/${encodeURIComponent(initData.id)}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: initData.code,
          uploadId: initData.uploadId,
          parts: uploadedParts.sort((a, b) => a.partNumber - b.partNumber),
        }),
        signal: controller.signal,
      },
    );
    await readApiResponse<ApiPayload>(
      completeResponse,
      "アップロードを確定できませんでした。",
    );
    onProgress(100);
    return activeReceipt;
  } catch (error) {
    if (activeReceipt) {
      await fetch(
        `/api/transfers/${encodeURIComponent(activeReceipt.id)}?code=${encodeURIComponent(activeReceipt.code)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function transcribeMediaFile(
  mediaFile: File,
  highAccuracy = false,
  usageReservationId: string | null = null,
): Promise<TranscriptionResult> {
  const formData = new FormData();
  formData.set("file", mediaFile, mediaFile.name);
  if (usageReservationId) {
    formData.set("usageReservationId", usageReservationId);
  }
  if (highAccuracy) {
    formData.set("quality", "high");
  }
  const response = await fetch("/api/transcribe", {
    method: "POST",
    body: formData,
  });
  const payload = await readApiResponse<
    ApiPayload & {
      refined?: boolean;
      segments?: TranscriptLine[];
      silent?: boolean;
    }
  >(response, "字幕を生成できませんでした。もう一度お試しください。");

  if (payload.silent) {
    return { segments: [], refined: Boolean(payload.refined) };
  }
  if (!payload.segments?.length) {
    throw new Error("字幕を生成できませんでした。もう一度お試しください。");
  }
  return {
    segments: payload.segments,
    refined: Boolean(payload.refined),
  };
}

async function transcribeLargeVideo(
  selectedFile: File,
  onProgress: (progress: number) => void,
  highAccuracy = false,
  usageReservationId: string | null = null,
): Promise<TranscriptionResult> {
  let extractionDetail = "";
  try {
    onProgress(8);
    const {
      DEFAULT_MAX_AUDIO_CHUNK_BYTES,
      MIN_AUDIO_CHUNK_BYTES,
      extractTranscriptionAudioChunks,
    } = await import("../lib/transcription-media");
    let maxChunkBytes = DEFAULT_MAX_AUDIO_CHUNK_BYTES;

    while (maxChunkBytes >= MIN_AUDIO_CHUNK_BYTES) {
      try {
        const mergedSegments: TranscriptLine[] = [];
        let completedChunks = 0;
        let refined = false;

        for await (const chunk of extractTranscriptionAudioChunks(
          selectedFile,
          { maxChunkBytes },
        )) {
          onProgress(Math.min(84, 14 + completedChunks * 6));
          const chunkResult = await transcribeMediaFile(
            chunk.file,
            highAccuracy,
            usageReservationId,
          );
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
          return { segments: mergedSegments, refined };
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
    onProgress(8);
    const sourceBytes = await selectedFile.arrayBuffer();
    onProgress(14);
    decodedAudio = await audioContext.decodeAudioData(sourceBytes);
  } catch {
    throw new Error(
      `動画から音声を取り出せませんでした。音声抽出の詳細：${
        extractionDetail || "ブラウザーが動画の音声形式に対応していません"
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
  const baseName =
    selectedFile.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "_") ||
    "video";

  for (let index = 0; index < chunkCount; index += 1) {
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
    );
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
  return { segments: mergedSegments, refined };
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

async function extractNarrationFrames(selectedFile: File, count = 6) {
  const objectUrl = URL.createObjectURL(selectedFile);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
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
    const frames: string[] = [];
    const frameCount = Math.max(3, Math.min(8, count));

    for (let index = 0; index < frameCount; index += 1) {
      const ratio = frameCount === 1 ? 0.5 : 0.06 + (index / (frameCount - 1)) * 0.88;
      const time = Math.min(Math.max(0, duration - 0.05), duration * ratio);
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
      frames.push(canvas.toDataURL("image/jpeg", 0.7));
    }
    return { duration, frames };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
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
  timingScale,
  previousScript,
}: {
  frames: string[];
  brief: string;
  goal: Goal;
  length: number;
  style: NarrationStyle;
  sourceDuration: number;
  usageReservationId: string | null;
  timingScale?: number;
  previousScript?: string;
}) {
  const response = await fetch("/api/narration/script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      frames,
      brief,
      goal,
      length,
      style,
      sourceDuration,
      usageReservationId,
      timingScale,
      previousScript,
    }),
  });
  return readApiResponse<ApiPayload & NarrationPlan>(
    response,
    "AIナレーションの台本を作成できませんでした。",
  );
}

async function reserveVideoUsage(selectedFile: File) {
  const requestBody = JSON.stringify({
    sourceDurationSeconds: await getVideoDurationSeconds(selectedFile),
    idempotencyKey: crypto.randomUUID(),
  });
  const requestReservation = () =>
    fetch("/api/usage/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });
  let response = await requestReservation();

  if (response.status === 401) {
    const sessionResponse = await fetch("/api/session/trial", {
      method: "POST",
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
      required?: boolean;
      reservationId?: string;
    }
  >(response, "利用枠を確認できませんでした。");
  return payload.required ? (payload.reservationId ?? null) : null;
}

async function updateVideoUsage(
  action: "complete" | "release",
  reservationId: string,
) {
  await fetch(`/api/usage/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId }),
  }).catch(() => undefined);
}

async function requestNarrationSpeech(
  script: string,
  style: NarrationStyle,
  usageReservationId: string | null,
) {
  const response = await fetch("/api/narration/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ script, style, usageReservationId }),
  });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? ((await response.json().catch(() => ({}))) as ApiPayload)
      : {};
    throw new ApiRequestError(
      payload.error || "AI音声を生成できませんでした。もう一度お試しください。",
      response.status,
    );
  }
  const audio = await response.blob();
  if (!audio.size) throw new Error("AI音声を生成できませんでした。");
  return audio;
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

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const transferInputRef = useRef<HTMLInputElement>(null);
  const transferAbortRef = useRef<AbortController | null>(null);
  const usageReservationRef = useRef<string | null>(null);
  const [stage, setStage] = useState<Stage>("start");
  const [goal, setGoal] = useState<Goal>("follow");
  const [captionProfile, setCaptionProfile] = useState<CaptionProfile>(() => {
    if (typeof window === "undefined") return DEFAULT_CAPTION_PROFILE;
    const saved = window.localStorage.getItem("torudake-caption-profile");
    if (!saved) return DEFAULT_CAPTION_PROFILE;
    try {
      return normalizeCaptionProfile(JSON.parse(saved));
    } catch {
      return DEFAULT_CAPTION_PROFILE;
    }
  });
  const [length, setLength] = useState(60);
  const [audioMode, setAudioMode] = useState<VideoAudioMode>("spoken");
  const [narrationStyle, setNarrationStyle] =
    useState<NarrationStyle>("bright");
  const [narrationOriginalAudio, setNarrationOriginalAudio] =
    useState<NarrationOriginalAudioLevel>(
      DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT,
    );
  const [narrationBrief, setNarrationBrief] = useState("");
  const [narrationPlan, setNarrationPlan] = useState<NarrationPlan | null>(
    null,
  );
  const [narrationAudioUrl, setNarrationAudioUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const videoUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : ""),
    [file],
  );
  const [progress, setProgress] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("after");
  const [transcript, setTranscript] =
    useState<TranscriptLine[]>(initialTranscript);
  const [editError, setEditError] = useState("");
  const [isHighAccuracyRun, setIsHighAccuracyRun] = useState(false);
  const [usedHighAccuracy, setUsedHighAccuracy] = useState(false);
  const [toast, setToast] = useState("");
  const [transferFile, setTransferFile] = useState<File | null>(null);
  const [transferStatus, setTransferStatus] =
    useState<TransferStatus>("idle");
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferReceipt, setTransferReceipt] =
    useState<TransferReceipt | null>(null);
  const [transferError, setTransferError] = useState("");
  const [billingBusyPlan, setBillingBusyPlan] = useState<
    "light" | "one_time" | null
  >(null);
  const [billingError, setBillingError] = useState("");

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  useEffect(() => {
    return () => {
      if (narrationAudioUrl) URL.revokeObjectURL(narrationAudioUrl);
    };
  }, [narrationAudioUrl]);

  useEffect(() => {
    void fetch("/api/caption-profile")
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as {
          profile?: unknown;
        };
        if (payload.profile) {
          setCaptionProfile(normalizeCaptionProfile(payload.profile));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      "torudake-caption-profile",
      JSON.stringify(captionProfile),
    );
    const timeout = window.setTimeout(() => {
      void fetch("/api/caption-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: captionProfile }),
      }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [captionProfile]);

  const keptLines = useMemo(
    () => transcript.filter(isIncludedCaption),
    [transcript],
  );

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function chooseFile(selected?: File) {
    if (!selected) return;
    const looksLikeVideo =
      selected.type.startsWith("video/") ||
      /\.(mp4|mov|m4v|webm)$/i.test(selected.name);
    if (!looksLikeVideo) {
      notify("動画ファイルを選んでください");
      return;
    }
    if (selected.size > MAX_EDIT_VIDEO_BYTES) {
      notify("字幕の自動生成は500MBまでです");
      return;
    }
    setFile(selected);
    setEditError("");
    setUsedHighAccuracy(false);
    setIsHighAccuracyRun(false);
    setNarrationPlan(null);
    setNarrationAudioUrl("");
    usageReservationRef.current = null;
    setStage("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function useSample() {
    setFile(null);
    setEditError("");
    setUsedHighAccuracy(false);
    setIsHighAccuracyRun(false);
    setNarrationPlan(null);
    setNarrationAudioUrl("");
    setStage("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startEditing(highAccuracy = false) {
    if (file && file.size > MAX_EDIT_VIDEO_BYTES) {
      setEditError(
        "字幕の自動生成は500MBまでです。動画を短くするか圧縮してお試しください。",
      );
      return;
    }

    setEditError("");
    setIsHighAccuracyRun(highAccuracy);
    setProgress(4);
    setStage("processing");

    let progressTimer: number | undefined;
    let newlyReservedUsage: string | null = null;

    try {
      let nextTranscript = initialTranscript;
      let refined = false;
      if (file && !highAccuracy) {
        newlyReservedUsage = await reserveVideoUsage(file);
        usageReservationRef.current = newlyReservedUsage;
      }
      const usageReservationId = usageReservationRef.current;

      if (file) {
        if (needsBrowserAudioExtraction(file)) {
          const transcriptionResult = await transcribeLargeVideo(
            file,
            setProgress,
            highAccuracy,
            usageReservationId,
          );
          nextTranscript = transcriptionResult.segments;
          refined = transcriptionResult.refined;
        } else {
          const controller = new AbortController();
          const receipt = await uploadVideoInChunks(
            file,
            controller,
            (uploadProgress) => {
              setProgress(Math.max(4, Math.round(uploadProgress * 0.44)));
            },
          );
          setProgress(48);
          progressTimer = window.setInterval(() => {
            setProgress((current) => Math.min(current + 2, 88));
          }, 600);

          const response = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: receipt.id,
              code: receipt.code,
              quality: highAccuracy ? "high" : "standard",
              usageReservationId,
            }),
          });
          const payload = await readApiResponse<
            ApiPayload & {
              refined?: boolean;
              segments?: TranscriptLine[];
            }
          >(response, "字幕を生成できませんでした。もう一度お試しください。");

          if (!payload.segments?.length) {
            throw new Error("字幕を生成できませんでした。もう一度お試しください。");
          }
          nextTranscript = payload.segments;
          refined = Boolean(payload.refined);
        }
      } else {
        progressTimer = window.setInterval(() => {
          setProgress((current) => Math.min(current + 7, 88));
        }, 500);
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }

      nextTranscript = createNaturalEdit(nextTranscript, length, goal);
      if (progressTimer !== undefined) {
        window.clearInterval(progressTimer);
      }
      setTranscript(nextTranscript);
      setUsedHighAccuracy(refined);
      if (newlyReservedUsage) {
        await updateVideoUsage("complete", newlyReservedUsage);
      }
      setProgress(100);
      window.setTimeout(() => {
        setPreviewMode("after");
        setStage("result");
      }, 320);
    } catch (error) {
      if (progressTimer !== undefined) {
        window.clearInterval(progressTimer);
      }
      if (newlyReservedUsage) {
        await updateVideoUsage("release", newlyReservedUsage);
        usageReservationRef.current = null;
      }
      setProgress(0);
      setEditError(
        error instanceof Error
          ? error.message
          : "字幕を生成できませんでした。もう一度お試しください。",
      );
      setStage("setup");
    }
  }

  async function startNarrationEditing() {
    if (!file) {
      setEditError(
        "AIナレーションは実際の動画から場面を読み取って作ります。動画を選んでください。",
      );
      return;
    }

    setEditError("");
    setIsHighAccuracyRun(false);
    setProgress(4);
    setStage("processing");
    let newlyReservedUsage: string | null = null;

    try {
      newlyReservedUsage = await reserveVideoUsage(file);
      usageReservationRef.current = newlyReservedUsage;
      setProgress(14);
      const extracted = await extractNarrationFrames(file);
      setProgress(36);

      let nextPlan = await requestNarrationPlan({
        frames: extracted.frames,
        brief: narrationBrief,
        goal,
        length,
        style: narrationStyle,
        sourceDuration: extracted.duration,
        usageReservationId: newlyReservedUsage,
      });
      setProgress(68);
      let audio = await requestNarrationSpeech(
        nextPlan.script,
        narrationStyle,
        newlyReservedUsage,
      );
      let audioDuration = await getNarrationAudioDuration(audio);
      const maximumDuration = Math.max(
        1,
        Math.min(length, extracted.duration),
      );

      if (
        audioDuration >
        maximumDuration + NARRATION_DURATION_TOLERANCE_SECONDS
      ) {
        setProgress(76);
        const timingScale = Math.max(
          0.55,
          Math.min(0.94, (maximumDuration / audioDuration) * 0.9),
        );
        nextPlan = await requestNarrationPlan({
          frames: extracted.frames,
          brief: narrationBrief,
          goal,
          length,
          style: narrationStyle,
          sourceDuration: extracted.duration,
          usageReservationId: newlyReservedUsage,
          timingScale,
          previousScript: nextPlan.script,
        });
        audio = await requestNarrationSpeech(
          nextPlan.script,
          narrationStyle,
          newlyReservedUsage,
        );
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
      setProgress(90);
      const timeline = buildNarrationTimeline(
        nextPlan.segments,
        extracted.duration,
        length,
        audioDuration,
      );
      if (!timeline.length) {
        throw new Error("AIナレーションのテロップを作成できませんでした。");
      }

      setTranscript(timeline);
      setNarrationPlan(nextPlan);
      setNarrationAudioUrl(URL.createObjectURL(audio));
      setUsedHighAccuracy(true);
      if (newlyReservedUsage) {
        await updateVideoUsage("complete", newlyReservedUsage);
      }
      setProgress(100);
      window.setTimeout(() => {
        setPreviewMode("after");
        setStage("result");
      }, 320);
    } catch (error) {
      if (newlyReservedUsage) {
        await updateVideoUsage("release", newlyReservedUsage);
        usageReservationRef.current = null;
      }
      setProgress(0);
      setEditError(
        error instanceof Error
          ? error.message
          : "AIナレーションを生成できませんでした。もう一度お試しください。",
      );
      setStage("setup");
    }
  }

  async function regenerateNarration(
    script: string,
    style: NarrationStyle,
  ) {
    if (!file || !narrationPlan) return;
    const cleanScript = script.replace(/\s+/g, " ").trim();
    if (!cleanScript) throw new Error("ナレーション台本を入力してください。");
    const audio = await requestNarrationSpeech(
      cleanScript,
      style,
      usageReservationRef.current,
    );
    const audioDuration = await getNarrationAudioDuration(audio);
    const duration = await getVideoDurationSeconds(file);
    const maximumDuration = Math.max(1, Math.min(length, duration));
    if (
      audioDuration >
      maximumDuration + NARRATION_DURATION_TOLERANCE_SECONDS
    ) {
      throw new Error(
        `この台本は約${Math.ceil(audioDuration)}秒です。自然な速さを保つため、${Math.floor(maximumDuration)}秒以内になるよう少し短くしてください。`,
      );
    }
    const segments = splitNarrationScript(cleanScript).map((text, index) => ({
      text,
      emphasis: index === 0,
    }));
    setNarrationStyle(style);
    setNarrationPlan({ ...narrationPlan, script: cleanScript, segments });
    setTranscript(
      buildNarrationTimeline(segments, duration, length, audioDuration),
    );
    setNarrationAudioUrl(URL.createObjectURL(audio));
  }

  function reset() {
    transferAbortRef.current?.abort();
    transferAbortRef.current = null;
    setFile(null);
    setStage("start");
    setProgress(0);
    setPreviewMode("after");
    setTranscript(initialTranscript);
    setEditError("");
    setUsedHighAccuracy(false);
    setIsHighAccuracyRun(false);
    setAudioMode("spoken");
    setNarrationOriginalAudio(DEFAULT_NARRATION_ORIGINAL_AUDIO_PERCENT);
    setNarrationPlan(null);
    setNarrationAudioUrl("");
    usageReservationRef.current = null;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startCheckout(plan: "light" | "one_time") {
    if (billingBusyPlan) return;
    setBillingError("");
    setBillingBusyPlan(plan);
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
        const continuePath = `/account?checkout=${plan}`;
        window.location.href = `/signin-with-chatgpt?return_to=${encodeURIComponent(continuePath)}`;
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
      setBillingError(
        error instanceof Error
          ? error.message
          : "決済画面を開けませんでした。",
      );
      setBillingBusyPlan(null);
    }
  }

  function openTransfer() {
    setStage("transfer");
    setTransferError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openTransferWithCurrentVideo() {
    if (file) {
      chooseTransferFile(file);
    }
    openTransfer();
  }

  function chooseTransferFile(selected?: File) {
    if (!selected) return;
    const looksLikeVideo =
      selected.type.startsWith("video/") ||
      /\.(mp4|mov|m4v|webm)$/i.test(selected.name);
    if (!looksLikeVideo) {
      setTransferError("MP4・MOV・M4V・WebMの動画を選んでください。");
      return;
    }
    if (selected.size > 1024 * 1024 * 1024) {
      setTransferError("動画は1GB以下にしてください。");
      return;
    }
    setTransferFile(selected);
    setTransferStatus("idle");
    setTransferProgress(0);
    setTransferReceipt(null);
    setTransferError("");
  }

  async function startTransfer() {
    if (!transferFile || transferStatus === "uploading") return;

    const controller = new AbortController();
    transferAbortRef.current = controller;
    setTransferStatus("uploading");
    setTransferProgress(1);
    setTransferError("");
    setTransferReceipt(null);

    try {
      const receipt = await uploadVideoInChunks(
        transferFile,
        controller,
        setTransferProgress,
      );
      setTransferReceipt(receipt);
      setTransferStatus("done");
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "アップロードを中止しました。"
          : error instanceof Error
            ? error.message
            : "アップロードに失敗しました。";
      setTransferError(message);
      setTransferStatus("error");
      setTransferReceipt(null);
    } finally {
      transferAbortRef.current = null;
    }
  }

  async function deleteTransfer() {
    if (!transferReceipt) return;
    const response = await fetch(
      `/api/transfers/${encodeURIComponent(transferReceipt.id)}?code=${encodeURIComponent(transferReceipt.code)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      setTransferError("動画を削除できませんでした。");
      return;
    }
    setTransferFile(null);
    setTransferReceipt(null);
    setTransferProgress(0);
    setTransferStatus("idle");
    notify("動画を削除しました");
  }

  return (
    <main className="siteShell" data-build="20260730-trial-session">
      <header className="topbar">
        <button className="brand" onClick={reset} aria-label="トップへ戻る">
          <span className="brandIcon">
            <span />
            <i>▶</i>
          </span>
          <span className="brandText">
            撮るだけリール
            <small>素材動画から、投稿できる1本へ</small>
          </span>
        </button>

        {stage === "start" ? (
          <nav aria-label="メインメニュー">
            <a href="#how">使い方</a>
            <a href="#difference">できること</a>
            <a href="#price">料金</a>
          </nav>
        ) : (
          <div className="workspaceStatus">
            <span className="statusDot" />
            限定プレビュー
          </div>
        )}

        <div className="topActions">
          <a className="accountButton" href="/account">
            アカウント
          </a>
          {stage !== "start" && stage !== "transfer" && (
            <button className="quietButton" onClick={reset}>
              新しく作る
            </button>
          )}
          {stage === "start" && (
            <button className="transferButton" onClick={openTransfer}>
              動画を預ける
            </button>
          )}
          <button
            className="trialButton"
            onClick={() =>
              stage === "start"
                ? inputRef.current?.click()
                : stage === "transfer"
                  ? reset()
                  : notify("保存機能は次の工程で接続します")
            }
          >
            {stage === "transfer" ? "サービスを見る" : "無料で試す"}
          </button>
        </div>
      </header>

      <input
        ref={inputRef}
        className="visuallyHidden"
        type="file"
        accept="video/mp4,video/quicktime,video/webm,video/*"
        onChange={(event) => chooseFile(event.target.files?.[0])}
      />
      <input
        ref={transferInputRef}
        className="visuallyHidden"
        type="file"
        accept="video/mp4,video/quicktime,video/x-m4v,video/webm,video/*"
        onChange={(event) => chooseTransferFile(event.target.files?.[0])}
      />

      {stage === "start" && (
        <Landing
          openPicker={() => inputRef.current?.click()}
          useSample={useSample}
          openTransfer={openTransfer}
          startCheckout={startCheckout}
          billingBusyPlan={billingBusyPlan}
          billingError={billingError}
        />
      )}

      {stage === "transfer" && (
        <TransferPortal
          file={transferFile}
          status={transferStatus}
          progress={transferProgress}
          receipt={transferReceipt}
          error={transferError}
          chooseFile={chooseTransferFile}
          openPicker={() => transferInputRef.current?.click()}
          startUpload={startTransfer}
          cancelUpload={() => transferAbortRef.current?.abort()}
          deleteUpload={deleteTransfer}
          notify={notify}
        />
      )}

      {stage === "setup" && (
        <SetupWorkspace
          file={file}
          videoUrl={videoUrl}
          goal={goal}
          setGoal={setGoal}
          length={length}
          setLength={setLength}
          audioMode={audioMode}
          setAudioMode={setAudioMode}
          narrationStyle={narrationStyle}
          setNarrationStyle={setNarrationStyle}
          narrationOriginalAudio={narrationOriginalAudio}
          setNarrationOriginalAudio={setNarrationOriginalAudio}
          narrationBrief={narrationBrief}
          setNarrationBrief={setNarrationBrief}
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
        />
      )}

      {stage === "result" && (
        <ResultWorkspace
          file={file}
          videoUrl={videoUrl}
          previewMode={previewMode}
          setPreviewMode={setPreviewMode}
          transcript={transcript}
          setTranscript={setTranscript}
          keptLines={keptLines}
          goal={goal}
          captionProfile={captionProfile}
          setCaptionProfile={setCaptionProfile}
          length={length}
          notify={notify}
          reset={reset}
          openTransfer={openTransferWithCurrentVideo}
          regenerateHighAccuracy={() => startEditing(true)}
          usedHighAccuracy={usedHighAccuracy}
          narrationPlan={narrationPlan}
          setNarrationPlan={setNarrationPlan}
          narrationAudioUrl={narrationAudioUrl}
          narrationStyle={narrationStyle}
          narrationOriginalAudio={narrationOriginalAudio}
          setNarrationOriginalAudio={setNarrationOriginalAudio}
          regenerateNarration={regenerateNarration}
        />
      )}

      <footer>
        <div>
          <strong>撮るだけリール</strong>
          <span>動画を選ぶだけ。カット・AI音声・テロップ・表紙まで自動。</span>
        </div>
        <div className="footerLinks">
          <a href="#how">使い方</a>
          <a href="#price">料金</a>
          <span>プライバシー</span>
          <a href="/terms">利用規約</a>
        </div>
        <small>© 2026 撮るだけリール・限定プレビュー</small>
      </footer>

      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          {toast}
        </div>
      )}
    </main>
  );
}

function TransferPortal({
  file,
  status,
  progress,
  receipt,
  error,
  chooseFile,
  openPicker,
  startUpload,
  cancelUpload,
  deleteUpload,
  notify,
}: {
  file: File | null;
  status: TransferStatus;
  progress: number;
  receipt: TransferReceipt | null;
  error: string;
  chooseFile: (file?: File) => void;
  openPicker: () => void;
  startUpload: () => void;
  cancelUpload: () => void;
  deleteUpload: () => void;
  notify: (message: string) => void;
}) {
  const expiresLabel = receipt
    ? new Intl.DateTimeFormat("ja-JP", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(receipt.expiresAt)
    : "";

  async function copyCode() {
    if (!receipt) return;
    await navigator.clipboard.writeText(receipt.code);
    notify("受け渡しコードをコピーしました");
  }

  return (
    <section className="transferPage">
      <div className="transferHeading">
        <div>
          <p className="eyebrow">PRIVATE VIDEO TRANSFER</p>
          <h1>
            テスト動画を、
            <br />
            <em>安全に受け渡す。</em>
          </h1>
          <p>
            この限定ページから動画を預けて、表示されたコードをCodexのチャットへ送ってください。
          </p>
        </div>
        <div className="transferSecurity">
          <span>●</span>
          <p>
            <strong>限定公開ページ</strong>
            受け取り確認後すぐ削除・最長72時間
          </p>
        </div>
      </div>

      <div className="transferLayout">
        <div className="transferCard">
          {status === "done" && receipt ? (
            <div className="transferComplete">
              <span className="completeMark">✓</span>
              <p className="eyebrow">UPLOAD COMPLETE</p>
              <h2>動画をお預かりしました</h2>
              <p className="completeLead">
                下のコードをコピーし、このCodexチャットにそのまま貼り付けてください。
              </p>
              <button className="receiptCode" onClick={copyCode}>
                <span>受け渡しコード</span>
                <strong>{receipt.code}</strong>
                <i>コピー</i>
              </button>
              <div className="nextStep">
                <span>1</span>
                コードをコピー
                <i>→</i>
                <span>2</span>
                チャットへ貼り付け
                <i>→</i>
                <span>3</span>
                こちらで動画を確認
              </div>
              <div className="receiptMeta">
                <span>ファイル</span>
                <strong>{file?.name}</strong>
                <span>保管期限</span>
                <strong>{expiresLabel}</strong>
              </div>
              <button className="deleteTransfer" onClick={deleteUpload}>
                今すぐ動画を削除する
              </button>
            </div>
          ) : (
            <>
              <div
                className={`transferDropzone ${file ? "hasFile" : ""} ${status === "uploading" ? "isUploading" : ""}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (status !== "uploading") {
                    chooseFile(event.dataTransfer.files?.[0]);
                  }
                }}
              >
                {file ? (
                  <>
                    <span className="videoFileIcon">▶</span>
                    <div className="chosenTransferFile">
                      <strong>{file.name}</strong>
                      <span>
                        {(file.size / 1024 / 1024).toFixed(1)} MB・
                        {file.type || "動画"}
                      </span>
                    </div>
                    {status !== "uploading" && (
                      <button onClick={openPicker}>変更</button>
                    )}
                  </>
                ) : (
                  <>
                    <span className="uploadCloud">↑</span>
                    <h2>ここに動画をドロップ</h2>
                    <p>または、端末から動画ファイルを選択</p>
                    <button onClick={openPicker}>動画を選ぶ</button>
                    <small>MP4・MOV・M4V・WebM / 最大1GB</small>
                  </>
                )}
              </div>

              {status === "uploading" && (
                <div className="realUploadProgress" aria-live="polite">
                  <div>
                    <span>暗号化して送信中</span>
                    <strong>{progress}%</strong>
                  </div>
                  <div className="realProgressTrack">
                    <i style={{ width: `${progress}%` }} />
                  </div>
                  <p>画面を閉じずにお待ちください。大きな動画は数分かかります。</p>
                  <button onClick={cancelUpload}>アップロードを中止</button>
                </div>
              )}

              {error && (
                <div className="transferError" role="alert">
                  <span>!</span>
                  <p>
                    <strong>送信できませんでした</strong>
                    {error}
                  </p>
                </div>
              )}

              {status !== "uploading" && (
                <button
                  className="sendVideoButton"
                  disabled={!file}
                  onClick={startUpload}
                >
                  <span>この動画を安全に送る</span>
                  <i>→</i>
                </button>
              )}
            </>
          )}
        </div>

        <aside className="transferGuide">
          <p className="eyebrow">HOW TO SEND</p>
          <h2>受け渡しは3ステップ</h2>
          <ol>
            <li>
              <span>01</span>
              <p>
                <strong>動画を選んで送信</strong>
                分割して送るため、大きなファイルにも対応します。
              </p>
            </li>
            <li>
              <span>02</span>
              <p>
                <strong>表示されたコードをコピー</strong>
                動画そのものをチャットへ添付する必要はありません。
              </p>
            </li>
            <li>
              <span>03</span>
              <p>
                <strong>このチャットにコードを貼る</strong>
                こちらで受け取り、編集テストに使用します。
              </p>
            </li>
          </ol>
          <div className="privacyNote">
            <span>🔒</span>
            <p>
              <strong>動画の取り扱い</strong>
              サービス開発の編集テスト以外には使用しません。受け取り後に削除し、未受け取りでも最長72時間で期限切れになります。
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function Landing({
  openPicker,
  useSample,
  openTransfer,
  startCheckout,
  billingBusyPlan,
  billingError,
}: {
  openPicker: () => void;
  useSample: () => void;
  openTransfer: () => void;
  startCheckout: (plan: "light" | "one_time") => void;
  billingBusyPlan: "light" | "one_time" | null;
  billingError: string;
}) {
  return (
    <>
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow">
            <span>NEW</span>
            素材動画から、投稿できる1本へ
          </p>
          <h1>
            動画を選ぶだけ。
            <br />
            <em>編集は、もうしない。</em>
          </h1>
          <p className="heroLead">
            無音カット、高精度字幕、AIナレーション、テロップ、表紙まで。
            <br />
            撮りっぱなしの動画を、投稿できるリールに仕上げます。
          </p>
          <div className="heroActions">
            <button className="mainCta" onClick={openPicker}>
              <span>動画を選んで無料で試す</span>
              <i>→</i>
            </button>
            <button className="sampleButton" onClick={useSample}>
              サンプルで体験
            </button>
          </div>
          <div className="trustRow">
            <span>✓ サンプル体験は登録不要</span>
            <span>✓ 体験版では動画を送信しません</span>
            <span>✓ スマホ動画対応</span>
          </div>
          <button className="transferLink" onClick={openTransfer}>
            <span>実際のテスト動画を開発者へ送る</span>
            <i>安全な受け渡し画面へ →</i>
          </button>
        </div>

        <div className="heroVisual" aria-label="編集前と編集後のイメージ">
          <div className="visualBadge">
            <strong>38分</strong>
            <span>かかっていた編集が</span>
          </div>
          <div className="phonePair">
            <div className="phone beforePhone">
              <div className="phoneTop" />
              <span className="phoneLabel">BEFORE</span>
              <CreatorFigure variant="before" />
              <div className="waveform">
                {Array.from({ length: 19 }).map((_, index) => (
                  <i key={index} />
                ))}
              </div>
              <div className="pausePins">
                <span />
                <span />
              </div>
              <small>3:42・言い直しあり</small>
            </div>
            <span className="transformArrow">→</span>
            <div className="phone afterPhone">
              <div className="phoneTop" />
              <span className="phoneLabel">AFTER</span>
              <CreatorFigure variant="after" />
              <div className="captionTop">
                続けられる人が
                <strong>最初にやること</strong>
              </div>
              <div className="captionBottom">
                小さく始めるのが
                <strong>一番の近道です</strong>
              </div>
              <div className="cutRail">
                <i />
                <i />
                <i />
              </div>
              <small>0:58・投稿できる状態</small>
            </div>
          </div>
          <div className="visualResult">
            <span>✓</span>
            <p>
              <strong>確認は3分だけ</strong>
              テロップを読んで、気になる所だけ直す
            </p>
          </div>
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
          <p className="eyebrow">HOW IT WORKS</p>
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
            <p>1〜5分の縦動画をそのままアップロード。</p>
            <small>MP4・MOV・スマホ対応 / 最大500MB</small>
          </article>
          <article>
            <span className="stepNo">02</span>
            <div className="stepIcon magicIcon">✦</div>
            <h3>目的に合わせて自動編集</h3>
            <p>映像、音声、字幕、AIナレーションをまとめて設計。</p>
            <small>元の音声があっても、なくても対応</small>
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
          <p className="eyebrow">NOT ANOTHER EDITOR</p>
          <h2>
            編集ソフトではなく、
            <br />
            <em>完成品が返ってくる。</em>
          </h2>
          <p>
            高機能なタイムラインを覚える必要はありません。
            あなたのテロップ、色、テンポを記憶して、2本目からもっと早く仕上げます。
          </p>
          <ul>
            <li>
              <span>✓</span>
              元の音声とAIナレーションを自然に組み合わせる
            </li>
            <li>
              <span>✓</span>
              1行を短く、読みやすい位置で改行する
            </li>
            <li>
              <span>✓</span>
              専門用語と固有名詞をアカウントごとに記憶する
            </li>
          </ul>
        </div>
        <div className="memoryCard">
          <div className="memoryTop">
            <span>MY STYLE</span>
            <i>自動保存</i>
          </div>
          <div className="stylePreview">
            <span className="styleCaption">あなたのテロップ</span>
            <strong>大切な言葉だけ</strong>
            <em>色を変える</em>
          </div>
          <dl>
            <div>
              <dt>カットの速さ</dt>
              <dd>
                <i style={{ width: "66%" }} />
              </dd>
            </div>
            <div>
              <dt>テロップの量</dt>
              <dd>
                <i style={{ width: "82%" }} />
              </dd>
            </div>
            <div>
              <dt>ズームの頻度</dt>
              <dd>
                <i style={{ width: "38%" }} />
              </dd>
            </div>
          </dl>
          <p>2本目からは、設定なしでいつもの仕上がり。</p>
        </div>
      </section>

      <section className="priceSection" id="price">
        <div className="sectionHeading compact">
          <p className="eyebrow">SIMPLE PRICE</p>
          <h2>まず1本、完成を見てから。</h2>
          <p>体験後に、必要な分だけ選べます。</p>
        </div>
        <div className="priceGrid">
          <article>
            <p>FREE PREVIEW</p>
            <h3>無料体験</h3>
            <strong>¥0</strong>
            <span>合計3分または2動画まで</span>
            <ul>
              <li>✓ 自動カット・自動テロップ</li>
              <li>✓ 1動画90秒まで</li>
              <li>✓ 低画質・透かしあり</li>
            </ul>
            <button onClick={openPicker}>無料で動画を試す</button>
          </article>
          <article className="featuredPrice">
            <span className="popular">おすすめ</span>
            <p>LIGHT</p>
            <h3>月{LIGHT_MONTHLY_VIDEO_LIMIT}本プラン</h3>
            <strong>
              ¥{LIGHT_MONTHLY_PRICE_JPY.toLocaleString("ja-JP")}
              <small>/月</small>
            </strong>
            <span>
              {`1本あたり${Math.floor(
                LIGHT_MONTHLY_PRICE_JPY / LIGHT_MONTHLY_VIDEO_LIMIT,
              )}円`}
            </span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>✓ 1080p・透かしなし</li>
              <li>✓ 編集スタイルを記憶</li>
            </ul>
            <button
              onClick={() => startCheckout("light")}
              disabled={billingBusyPlan !== null}
            >
              {billingBusyPlan === "light"
                ? "決済画面を準備中…"
                : `月${LIGHT_MONTHLY_VIDEO_LIMIT}本プランを始める`}
            </button>
          </article>
          <article>
            <p>ONE TIME</p>
            <h3>1本だけ</h3>
            <strong>
              ¥{ONE_TIME_PRICE_JPY.toLocaleString("ja-JP")}
            </strong>
            <span>サブスクなし</span>
            <ul>
              <li>✓ 90秒まで</li>
              <li>✓ 1080p・透かしなし</li>
              <li>✓ 表紙と投稿文つき</li>
            </ul>
            <button
              onClick={() => startCheckout("one_time")}
              disabled={billingBusyPlan !== null}
            >
              {billingBusyPlan === "one_time"
                ? "決済画面を準備中…"
                : "1本購入する"}
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
      </section>

      <section className="bottomCta">
        <div>
          <p className="eyebrow">YOUR NEXT REEL</p>
          <h2>
            撮りっぱなしの動画を、
            <br />
            今日の投稿に。
          </h2>
        </div>
        <button className="mainCta light" onClick={openPicker}>
          <span>動画を選んで無料で試す</span>
          <i>→</i>
        </button>
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
    badge: "会話ありにおすすめ",
    note: "元の声を控えめに残す",
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
      ? "元動画の音は入りません。AIナレーションだけを最も明瞭に聞かせたいときに向いています。"
      : roundedValue <= 8
        ? "元動画に会話がある場合は8%がおすすめです。AIナレーションを主役にしながら、元の雰囲気を薄く残せます。"
        : roundedValue <= 12
          ? "声のない料理・街歩き・作業動画は12%がおすすめです。その場の音が自然に伝わります。"
          : "元動画の音がはっきり残ります。会話がある動画ではAIナレーションと重なりやすいため、仕上がりプレビューで確認してください。";

  return (
    <section
      className="originalAudioMix"
      aria-label="元動画の音量"
    >
      <div className="originalAudioMixHeading">
        <div>
          <strong>元動画の音量</strong>
          <small>
            AIナレーションを100%としたときの、元の声・周りの音・BGM
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
          aria-label="AIナレーションに重ねる元動画の音量"
          aria-valuetext={`${roundedValue}%`}
          disabled={disabled}
        />
      </label>
      <p className="originalAudioAdvice">{advice}</p>
    </section>
  );
}

function SetupWorkspace({
  file,
  videoUrl,
  goal,
  setGoal,
  length,
  setLength,
  audioMode,
  setAudioMode,
  narrationStyle,
  setNarrationStyle,
  narrationOriginalAudio,
  setNarrationOriginalAudio,
  narrationBrief,
  setNarrationBrief,
  chooseAnother,
  startEditing,
  error,
}: {
  file: File | null;
  videoUrl: string;
  goal: Goal;
  setGoal: (goal: Goal) => void;
  length: number;
  setLength: (length: number) => void;
  audioMode: VideoAudioMode;
  setAudioMode: (mode: VideoAudioMode) => void;
  narrationStyle: NarrationStyle;
  setNarrationStyle: (style: NarrationStyle) => void;
  narrationOriginalAudio: NarrationOriginalAudioLevel;
  setNarrationOriginalAudio: (
    percent: NarrationOriginalAudioLevel,
  ) => void;
  narrationBrief: string;
  setNarrationBrief: (brief: string) => void;
  chooseAnother: () => void;
  startEditing: () => Promise<void>;
  error: string;
}) {
  return (
    <section className="workspace">
      <div className="workspaceHeading">
        <div>
          <p className="eyebrow">NEW PROJECT</p>
          <h1>どんなリールにしますか？</h1>
          <p>
            元の音声を活かす編集と、AIナレーションを重ねる編集から選べます。
          </p>
        </div>
        <span>STEP 1 / 2</span>
      </div>

      <div className="setupGrid">
        <aside className="sourceCard">
          <div className="sourcePreview">
            {videoUrl ? (
              <video src={videoUrl} controls muted playsInline />
            ) : (
              <div className="sampleSource">
                <CreatorFigure variant="before" />
                <span>サンプル動画</span>
              </div>
            )}
            <i>RAW</i>
          </div>
          <div className="fileRow">
            <span className="fileIcon">▶</span>
            <p>
              <strong>{file?.name ?? "sample_reel_video.mp4"}</strong>
              <small>
                {file ? `${Math.max(file.size / 1024 / 1024, 0.1).toFixed(1)} MB` : "18.4 MB"}・縦動画
              </small>
            </p>
            <button onClick={chooseAnother}>変更</button>
          </div>
          <div className="localNote">
            <span>●</span>
            {audioMode === "narration"
              ? "会話や周りの音が入った動画にも使えます。代表場面から台本を作り、AIナレーションを重ねます。"
              : "iPhoneのMOVや25MBを超える動画は、端末内で音声だけを取り出して字幕を生成します（最大500MB）。"}
          </div>
        </aside>

        <div className="setupForm">
          <fieldset>
            <legend>
              <span>01</span>
              音声の仕上げ方
            </legend>
            <div className="audioModeCards">
              <button
                type="button"
                className={audioMode === "spoken" ? "selected" : ""}
                onClick={() => setAudioMode("spoken")}
              >
                <i aria-hidden="true">元</i>
                <strong>元の音声を活かす</strong>
                <small>元動画の会話・解説・その場の音から字幕と自然なカット</small>
                <b>{audioMode === "spoken" ? "✓" : ""}</b>
              </button>
              <button
                type="button"
                className={audioMode === "narration" ? "selected" : ""}
                onClick={() => setAudioMode("narration")}
              >
                <i aria-hidden="true">AI</i>
                <strong>AIナレーションモード</strong>
                <small>元の音声の有無を問わず、台本とAI音声を追加</small>
                <b>{audioMode === "narration" ? "✓" : ""}</b>
              </button>
            </div>
          </fieldset>

          <fieldset>
            <legend>
              <span>02</span>
              この動画の目的
            </legend>
            <div className="optionCards three">
              {goals.map((item) => (
                <button
                  key={item.id}
                  className={goal === item.id ? "selected" : ""}
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
              <span>03</span>
              完成する長さ
            </legend>
            <div className="lengthOptions">
              {[30, 60, 90].map((item) => (
                <button
                  key={item}
                  className={length === item ? "selected" : ""}
                  onClick={() => setLength(item)}
                >
                  <strong>{item}</strong>秒
                  {audioMode === "narration" ? "以内" : ""}
                  <small>
                    {item === 30 ? "短く強く" : item === 60 ? "おすすめ" : "しっかり解説"}
                  </small>
                </button>
              ))}
            </div>
            <p className="optionCostNote">
              {audioMode === "narration"
                ? "AI音声は自然な1倍速のまま、選んだ長さ以内に映像とテロップを合わせます。動画は代表場面だけで読み取り、API利用量も抑えます。"
                : "自然に短くするため元動画全体を1度だけ文字起こしします。構成判定は端末内で行い、追加のAI呼び出しはしません。"}
            </p>
          </fieldset>

          {audioMode === "narration" && (
            <fieldset className="narrationSetup">
              <legend>
                <span>04</span>
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

          <div className="autoTelopNote">
            <span aria-hidden="true">Aa</span>
            <div>
              <strong>テロップは内容に合わせて、おまかせ設計</strong>
              <p>
                {audioMode === "narration"
                  ? "ナレーションの文の切れ目に合わせ、音声と同じ内容をリッチなテロップで表示します。"
                  : "冒頭・数字・強調したい言葉を見分けて、見せ方を自動で変えます。完成後にブランドの雰囲気や色も調整できます。"}
              </p>
            </div>
            <small>{audioMode === "narration" ? "API利用あり" : "追加API料金なし"}</small>
          </div>

          <div className="editSummary">
            <div>
              <span>今回の編集方針</span>
              <p>
                <strong>{goals.find((item) => item.id === goal)?.title}</strong>
                ・
                {audioMode === "narration"
                  ? `${NARRATION_STYLES.find((item) => item.id === narrationStyle)?.label}AI音声・元動画の音${Math.round(narrationOriginalAudio)}%`
                  : "おまかせテロップ"}
                ・{length}秒
              </p>
            </div>
            <button className="mainCta" onClick={startEditing}>
              <span>
                {audioMode === "narration"
                  ? "AIナレーション付きで作る"
                  : "この設定で自動編集する"}
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
}: {
  file: File | null;
  progress: number;
  highAccuracy: boolean;
  narration: boolean;
}) {
  const steps = narration
    ? [
        { threshold: 18, label: "場面を選んでいます", note: "動画全体から代表的な場面を抽出" },
        { threshold: 42, label: "構成を考えています", note: "映像の順序と目的から自然な台本を作成" },
        { threshold: 70, label: "AI音声を作っています", note: "選んだ雰囲気で日本語ナレーションを生成" },
        { threshold: 90, label: "字幕を合わせています", note: "文の切れ目で映像とテロップを同期" },
        { threshold: 100, label: "仕上げ中", note: "投稿文とプレビューを準備" },
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
    { threshold: 88, label: "自然に再構成中", note: "文の切れ目で指定時間へ編集" },
    { threshold: 100, label: "仕上げ中", note: "カットと字幕プレビューを準備" },
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
          <span className="orbit two">CUT</span>
          <span className="orbit three">字幕</span>
        </div>

        <div className="processingCopy">
          <p className="eyebrow">AI EDITING</p>
          <h1>投稿できる状態に整えています。</h1>
          <p>
            {file?.name ?? "サンプル動画"}の
            {narration
              ? "場面を読み取り、映像に合う台本・音声・テロップを作っています。"
              : `${highAccuracy ? "言葉を高精度で確認し、" : "音量と発話区間を整え、"}話の流れを保った短い動画へ再構成しています。`}
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
        </div>
      </div>
    </section>
  );
}

function ResultWorkspace({
  file,
  videoUrl,
  previewMode,
  setPreviewMode,
  transcript,
  setTranscript,
  keptLines,
  goal,
  captionProfile,
  setCaptionProfile,
  length,
  notify,
  reset,
  openTransfer,
  regenerateHighAccuracy,
  usedHighAccuracy,
  narrationPlan,
  setNarrationPlan,
  narrationAudioUrl,
  narrationStyle,
  narrationOriginalAudio,
  setNarrationOriginalAudio,
  regenerateNarration,
}: {
  file: File | null;
  videoUrl: string;
  previewMode: PreviewMode;
  setPreviewMode: (mode: PreviewMode) => void;
  transcript: TranscriptLine[];
  setTranscript: (lines: TranscriptLine[]) => void;
  keptLines: TranscriptLine[];
  goal: Goal;
  captionProfile: CaptionProfile;
  setCaptionProfile: (profile: CaptionProfile) => void;
  length: number;
  notify: (message: string) => void;
  reset: () => void;
  openTransfer: () => void;
  regenerateHighAccuracy: () => Promise<void>;
  usedHighAccuracy: boolean;
  narrationPlan: NarrationPlan | null;
  setNarrationPlan: (plan: NarrationPlan | null) => void;
  narrationAudioUrl: string;
  narrationStyle: NarrationStyle;
  narrationOriginalAudio: NarrationOriginalAudioLevel;
  setNarrationOriginalAudio: (
    percent: NarrationOriginalAudioLevel,
  ) => void;
  regenerateNarration: (
    script: string,
    style: NarrationStyle,
  ) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const narrationSampleAudioRef = useRef<HTMLAudioElement>(null);
  const previewNarrationEngineRef = useRef<{
    url: string;
    context: AudioContext;
    gain: GainNode;
    originalGain: GainNode | null;
    mediaSource: MediaElementAudioSourceNode | null;
    buffer: AudioBuffer | null;
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
  const [sourceDuration, setSourceDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTransportState, setPreviewTransportState] =
    useState<PreviewTransportState>("paused");
  const [scrubbedEditedTime, setScrubbedEditedTime] = useState<number | null>(
    null,
  );
  const [isExporting, setIsExporting] = useState(false);
  const isExportingRef = useRef(false);
  const [exportedVideoFile, setExportedVideoFile] = useState<File | null>(null);
  const [exportedVideoRevision, setExportedVideoRevision] = useState<
    string | null
  >(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false);
  const [isCaptionDesignerOpen, setIsCaptionDesignerOpen] = useState(false);
  const [narrationDraft, setNarrationDraft] = useState(
    narrationPlan?.script ?? "",
  );
  const [draftNarrationStyle, setDraftNarrationStyle] =
    useState<NarrationStyle>(narrationStyle);
  const [isRegeneratingNarration, setIsRegeneratingNarration] =
    useState(false);
  const isMediaBusy =
    isExporting ||
    isGeneratingThumbnail ||
    isRegeneratingNarration;
  const [showDisclosureConfirm, setShowDisclosureConfirm] = useState(false);
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false);
  const [isRecordingDisclosure, setIsRecordingDisclosure] = useState(false);
  const [initialCutState] = useState(
    () =>
      new Map(
        transcript.map((line) => [line.id, line.removed] as const),
      ),
  );
  const captionDesign = useMemo(
    () => resolveCaptionDesign(captionProfile, goal),
    [captionProfile, goal],
  );
  const tone = captionDesign.tone;
  const editRanges = useMemo(
    () =>
      buildEditRanges(
        transcript,
        narrationPlan ? { maxJoinGapSeconds: 0.001 } : undefined,
      ),
    [narrationPlan, transcript],
  );
  const previewRanges = useMemo(
    () => buildPreviewRanges(editRanges),
    [editRanges],
  );
  const editedTranscript = useMemo(
    () => remapCaptionsToEditedTimeline(transcript, editRanges),
    [editRanges, transcript],
  );
  const editDuration = getEditedDuration(editRanges);
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
  const activeCaption =
    keptLines.find(
      (line) => currentTime >= line.start && currentTime < line.end,
    ) ?? (!videoUrl ? keptLines[0] : undefined);
  const activeCaptionIndex = activeCaption
    ? keptLines.findIndex((line) => line.id === activeCaption.id)
    : -1;
  const activePresentation = activeCaption
    ? getCaptionPresentation(activeCaption, Math.max(0, activeCaptionIndex))
    : "standard";
  const captionStyle = {
    "--caption-accent": captionDesign.palette.highlight,
    "--caption-border": captionDesign.palette.border,
    "--caption-text": captionDesign.palette.text,
    "--caption-panel": captionDesign.palette.background,
  } as CSSProperties;
  const exportName =
    file?.name.replace(/\.[^.]+$/, "") ?? "sample_reel_video";
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
      }),
    [
      captionProfile,
      file,
      narrationAudioUrl,
      narrationOriginalAudio,
      transcript,
    ],
  );
  const readyExportedVideoFile =
    exportedVideoRevision === exportInputRevision
      ? exportedVideoFile
      : null;
  const removedCount = transcript.filter((line) => line.removed).length;
  const hasCutChanges = transcript.some(
    (line) =>
      initialCutState.get(line.id) !== undefined &&
      initialCutState.get(line.id) !== line.removed,
  );

  function stopPreviewNarrationSource() {
    const engine = previewNarrationEngineRef.current;
    const source = engine?.source;
    if (!engine || !source) return;
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
  }, [isExporting, isPlaying, narrationPlan, previewRanges]);

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

    const nextRanges = buildEditRanges(nextTranscript);
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
    setTranscript(restored);
    const video = videoRef.current;
    if (video) {
      const restoredRanges = buildEditRanges(restored);
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
    notify("カットの選択を最初の自動編集に戻しました");
  }

  function updateLine(id: number, text: string) {
    if (isMediaBusy) return;
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
      engine.originalGain?.gain.setValueAtTime(
        mix.original,
        engine.context.currentTime,
      );
      engine.gain.gain.setValueAtTime(
        mix.narration,
        engine.context.currentTime,
      );
    }
  }

  async function ensurePreviewNarrationEngine(shouldResume = true) {
    if (!narrationAudioUrl) {
      throw new Error("AI音声を読み込めませんでした。");
    }
    let engine = previewNarrationEngineRef.current;
    if (!engine || engine.context.state === "closed") {
      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) {
        throw new Error("このブラウザはAI音声の再生に対応していません。");
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
        source: null as AudioBufferSourceNode | null,
        sourceOffset: 0,
        sourceStartedAt: 0,
        stateChangeHandler: () => undefined,
      };
      createdEngine.stateChangeHandler = () => {
        if (
          previewNarrationEngineRef.current !== createdEngine ||
          createdEngine.context.state !== "suspended" ||
          !createdEngine.source ||
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
      applyNarrationPreviewMix(video, narrationOriginalAudio);
    }

    const resumePromise =
      shouldResume && engine.context.state !== "running"
        ? engine.context.resume()
        : Promise.resolve();
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
      : Promise.resolve(null);
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
    }

    previewHoldingFinalFrameRef.current = false;
    previewPlaybackReadyRef.current = false;
    videoPlayPromise ??= video.play();
    await videoPlayPromise;
    if (previewOperationRef.current !== operation) {
      video.pause();
      return false;
    }
    if (engine) {
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
    if (
      !video.seeking &&
      Math.abs(video.currentTime - target) <= 0.015
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
          Math.abs(video.currentTime - target) <= 0.12
        ) {
          finish(true);
        }
      };
      const handleError = () => finish(false);

      previewInternalSeekRef.current = {
        id,
        target,
        startedAt: performance.now(),
        cancel: () => finish(false),
      };
      video.addEventListener("seeked", inspectPosition);
      video.addEventListener("error", handleError);
      timeout = window.setTimeout(() => {
        finish(
          !video.seeking && Math.abs(video.currentTime - target) <= 0.18,
        );
      }, 2_000);
      try {
        video.currentTime = target;
        window.queueMicrotask(inspectPosition);
      } catch {
        finish(false);
      }
    });
  }

  function moveToNextKeptRange(video: HTMLVideoElement) {
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
      video.currentTime = nextRange.start;
      setCurrentTime(nextRange.start);
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

    moveToNextKeptRange(video);
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

  async function handleNarrationRegeneration() {
    if (isMediaBusy || isExportingRef.current) return;
    pausePreviewTransport();
    narrationSampleAudioRef.current?.pause();
    setIsRegeneratingNarration(true);
    try {
      await regenerateNarration(narrationDraft, draftNarrationStyle);
      notify("AI音声とテロップを更新しました");
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

    const coverCaption =
      keptLines.find((line) => line.accent && line.text.trim()) ??
      keptLines.find((line) => line.text.trim());
    if (!coverCaption) {
      notify("表紙に使う字幕を1つ以上残してください");
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
      const frameTime = Math.max(
        0,
        Math.min(
          coverCaption.start +
            Math.min(0.8, Math.max(0.08, (coverCaption.end - coverCaption.start) / 2)),
          sourceDuration || video.duration || coverCaption.end,
        ),
      );

      if (Math.abs(video.currentTime - frameTime) > 0.03) {
        const sought = new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error("表紙に使う場面を読み込めませんでした。")),
            8000,
          );
          video.addEventListener(
            "seeked",
            () => {
              window.clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
        video.currentTime = frameTime;
        await sought;
      }

      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
        throw new Error("表紙に使う場面を読み込めませんでした。");
      }
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      );

      const canvas = document.createElement("canvas");
      canvas.width = 1080;
      canvas.height = 1920;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("表紙画像を作成できませんでした。");

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      const scale = Math.max(
        canvas.width / sourceWidth,
        canvas.height / sourceHeight,
      );
      const cropWidth = canvas.width / scale;
      const cropHeight = canvas.height / scale;
      context.drawImage(
        video,
        (sourceWidth - cropWidth) / 2,
        (sourceHeight - cropHeight) / 2,
        cropWidth,
        cropHeight,
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
      context.font = '800 30px "Noto Sans JP", "Yu Gothic", sans-serif';
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillText(
        captionProfile.brandName || "撮るだけリール",
        112,
        111,
        278,
      );

      const sourceText = coverCaption.text.trim();
      const lines = wrapCaptionLines(sourceText, 12, 3);

      const fontSize = lines.length >= 3 ? 74 : 82;
      const lineHeight = fontSize * 1.25;
      const panelX = 70;
      const panelWidth = canvas.width - 140;
      const panelHeight = lines.length * lineHeight + 220;
      const panelY = canvas.height - panelHeight - 150;
      context.save();
      context.shadowColor = "rgba(4,10,18,.38)";
      context.shadowBlur = 42;
      context.shadowOffsetY = 18;
      context.fillStyle = palette.panel;
      roundRect(panelX, panelY, panelWidth, panelHeight, 38);
      context.fill();
      context.restore();
      context.lineWidth = tone === "editorial" ? 10 : 5;
      context.strokeStyle = palette.border;
      roundRect(panelX, panelY, panelWidth, panelHeight, 38);
      context.stroke();

      context.fillStyle = palette.accent;
      roundRect(panelX + 52, panelY + 48, 150, 12, 6);
      context.fill();
      context.fillStyle = palette.text;
      context.font = `850 ${fontSize}px "Noto Sans JP", "Yu Gothic", sans-serif`;
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
      context.font = '750 28px "Noto Sans JP", "Yu Gothic", sans-serif';
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
      const url = URL.createObjectURL(output);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${exportName}_cover.jpg`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("表紙画像を保存しました");
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

  function drawCaptionOverlay(
    context: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    sourceTime: number,
  ) {
    const caption = transcript.find(
      (line) =>
        !line.removed &&
        line.text.trim() &&
        sourceTime >= line.start &&
        sourceTime < line.end,
    );

    if (!caption) return;

    const keptIndex = keptLines.findIndex((line) => line.id === caption.id);
    const presentation = getCaptionPresentation(
      caption,
      Math.max(0, keptIndex),
    );
    const palette = captionDesign.palette;
    const presentationScale =
      presentation === "hook"
        ? 1.12
        : presentation === "metric"
          ? 1.08
          : 1;
    const fontSize =
      Math.max(26, Math.min(64, canvas.width * 0.052)) * presentationScale;
    const horizontalPadding = fontSize * (tone === "cinema" ? 0.32 : 0.72);
    const verticalPadding = fontSize * (tone === "cinema" ? 0.18 : 0.44);
    const maxTextWidth = canvas.width * 0.82;
    const charactersPerLine = Math.max(
      8,
      Math.floor(maxTextWidth / fontSize),
    );
    const lines = wrapCaptionLines(caption.text, charactersPerLine, 2);
    const showBrand =
      presentation === "hook" && Boolean(captionProfile.brandName);
    const brandHeight = showBrand ? fontSize * 0.52 : 0;

    context.font = `${palette.fontWeight} ${fontSize}px "Noto Sans JP", "Yu Gothic", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const widestLine = Math.max(
      ...lines.map((line) => context.measureText(line).width),
    );
    const lineHeight = fontSize * 1.25;
    const boxWidth = Math.min(
      canvas.width - horizontalPadding * 2,
      widestLine + horizontalPadding * 2,
    );
    const boxHeight =
      lines.length * lineHeight + verticalPadding * 2 + brandHeight;
    const boxX = (canvas.width - boxWidth) / 2;
    const boxY = canvas.height - boxHeight - canvas.height * 0.08;
    const entrance = getCaptionEntranceProgress(sourceTime, caption.start);
    context.save();
    context.globalAlpha = 0.35 + entrance * 0.65;
    context.translate(0, (1 - entrance) * fontSize * 0.18);
    if (palette.background) {
      context.save();
      context.shadowColor = "rgba(8,15,25,.26)";
      context.shadowBlur = fontSize * 0.4;
      context.shadowOffsetY = fontSize * 0.16;
      context.fillStyle = palette.background;
      context.beginPath();
      context.roundRect(
        boxX,
        boxY,
        boxWidth,
        boxHeight,
        tone === "mono" ? fontSize * 0.08 : fontSize * 0.28,
      );
      context.fill();
      context.restore();
    }
    if (palette.border) {
      context.lineWidth =
        tone === "editorial"
          ? Math.max(3, fontSize * 0.055)
          : Math.max(2, fontSize * 0.035);
      context.strokeStyle = palette.border;
      context.beginPath();
      context.roundRect(
        boxX,
        boxY,
        boxWidth,
        boxHeight,
        tone === "mono" ? fontSize * 0.08 : fontSize * 0.28,
      );
      context.stroke();
    }
    if (showBrand) {
      context.fillStyle = palette.highlight;
      context.font = `750 ${fontSize * 0.34}px "Noto Sans JP", "Yu Gothic", sans-serif`;
      context.textAlign = "left";
      context.fillText(
        captionProfile.brandName,
        boxX + horizontalPadding,
        boxY + verticalPadding * 0.72,
        boxWidth - horizontalPadding * 2,
      );
    }
    const highlight = caption.highlight?.trim() ?? "";
    context.font = `${palette.fontWeight} ${fontSize}px "Noto Sans JP", "Yu Gothic", sans-serif`;
    context.textAlign = "left";
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
              },
              { text: highlight, color: palette.highlight },
              {
                text: line.slice(highlightIndex + highlight.length),
                color: palette.text,
              },
            ]
          : [{ text: line, color: palette.text }];
      let textX = canvas.width / 2 - context.measureText(line).width / 2;

      parts.forEach((part) => {
        if (palette.stroke) {
          context.lineWidth = Math.max(5, fontSize * 0.12);
          context.lineJoin = "round";
          context.strokeStyle = palette.stroke;
          context.strokeText(part.text, textX, lineY);
        }
        context.fillStyle = part.color;
        context.fillText(part.text, textX, lineY);
        textX += context.measureText(part.text).width;
      });
    });
    context.restore();
  }

  async function exportCaptionedVideo(
    preparedAudioContext: AudioContext | null = null,
  ) {
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

    const capturableVideo = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const captureVideoStream =
      capturableVideo.captureStream ?? capturableVideo.mozCaptureStream;

    const usePortableMp4Exporter =
      typeof MediaRecorder === "undefined" ||
      typeof HTMLCanvasElement.prototype.captureStream !== "function";

    isExportingRef.current = true;
    setIsExporting(true);
    setExportedVideoFile(null);
    setExportedVideoRevision(null);
    setExportProgress(0);
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
    let sourceStream: MediaStream | null = null;
    let outputStream: MediaStream | null = null;
    let exportAudioContext: AudioContext | null = preparedAudioContext;
    let exportNarrationBuffer: AudioBuffer | null = null;
    let exportNarrationGain: GainNode | null = null;
    let exportOriginalAudioSource: AudioNode | null = null;
    let exportOriginalGain: GainNode | null = null;
    let exportLimiter: DynamicsCompressorNode | null = null;
    let activeExportNarrationSource: AudioBufferSourceNode | null = null;
    let exportPreviewOriginalGain: GainNode | null = null;
    let exportPreviewOriginalGainValue = 1;
    let shouldCloseExportAudioContext = true;
    let recorder: MediaRecorder | null = null;
    const seekExportMedia = async (
      media: HTMLMediaElement,
      seconds: number,
    ): Promise<void> => {
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
        const timeout = window.setTimeout(fail, 8_000);
        media.addEventListener(eventName, finish, { once: true });
        media.addEventListener("error", fail, { once: true });
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
      if (usePortableMp4Exporter) {
        let portableNarrationBuffer: AudioBuffer | null = null;
        if (narrationPlan && narrationAudioUrl) {
          if (!exportAudioContext) {
            exportAudioContext = await createRunningNarrationAudioContext();
          }
          const narrationResponse = await fetch(narrationAudioUrl);
          if (!narrationResponse.ok) {
            throw new Error("AI音声を読み込めませんでした。");
          }
          portableNarrationBuffer = await exportAudioContext.decodeAudioData(
            await narrationResponse.arrayBuffer(),
          );
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
          drawCaption: ({ context, canvas, sourceTime }) => {
            drawCaptionOverlay(context, canvas, sourceTime);
          },
          onProgress: (progress) => setExportProgress(progress * 100),
        });
        if (!output.size) throw new Error("書き出した動画が空でした。");
        const completedFile = new File(
          [output],
          `${exportName}_captioned.mp4`,
          { type: "video/mp4" },
        );
        setExportProgress(100);
        setExportedVideoFile(completedFile);
        setExportedVideoRevision(exportInputRevision);
        notify("動画ができました。下の「動画を保存・共有」を押してください");
        return;
      }

      video.pause();
      video.loop = false;
      video.muted = false;
      await seekExportMedia(video, playableRanges[0].start);

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1080;
      canvas.height = video.videoHeight || 1920;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("動画の描画を開始できませんでした。");

      const drawFrame = () => {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        drawCaptionOverlay(context, canvas, video.currentTime);

        if (keepDrawing) {
          animationFrame = window.requestAnimationFrame(drawFrame);
        }
      };

      outputStream = canvas.captureStream(30);
      const liveOutputStream = outputStream;
      if (narrationPlan && narrationAudioUrl) {
        const previewEngine = await ensurePreviewNarrationEngine(true);
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
        if (!exportAudioContext) {
          exportAudioContext = await createRunningNarrationAudioContext();
        }
        try {
          exportOriginalAudioSource =
            exportAudioContext.createMediaElementSource(video);
        } catch {
          if (captureVideoStream) {
            sourceStream = captureVideoStream.call(capturableVideo);
            const audioTracks = sourceStream.getAudioTracks();
            if (audioTracks.length) {
              exportOriginalAudioSource = exportAudioContext.createMediaStreamSource(
                new MediaStream(audioTracks),
              );
            }
          }
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
        exportOriginalGain.gain.value = narrationPlan
          ? getNarrationMixLevels(narrationOriginalAudio).original
          : 1;
        exportOriginalAudioSource
          .connect(exportOriginalGain)
          .connect(exportLimiter);
      }

      if (narrationPlan && narrationAudioUrl) {
        if (!exportNarrationBuffer) {
        try {
          const narrationResponse = await fetch(narrationAudioUrl);
          if (!narrationResponse.ok) throw new Error();
          const narrationBytes = await narrationResponse.arrayBuffer();
          exportNarrationBuffer =
            await exportAudioContext.decodeAudioData(narrationBytes);
        } catch {
          throw new Error("AI音声を読み込めませんでした。");
        }
        }
        if (
          !Number.isFinite(exportNarrationBuffer.duration) ||
          exportNarrationBuffer.duration <= 0
        ) {
          throw new Error("AI音声を読み込めませんでした。");
        }
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
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ];
      const mimeType =
        preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) ??
        "";
      recorder = new MediaRecorder(
        liveOutputStream,
        mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined,
      );
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
          };
          const finish = () => {
            cleanup();
            resolve();
          };
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error(errorMessage));
          }, timeoutMs);
          target.addEventListener(eventName, finish, { once: true });
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
          const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("動画の書き出しに時間がかかりすぎています。"));
          }, timeoutMs);
          video.addEventListener("ended", check);
          video.addEventListener("error", fail, { once: true });
          rangeAnimationFrame = window.requestAnimationFrame(check);
        });

      activeRecorder.start(1000);
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
        const range = playableRanges[rangeIndex];
        if (rangeIndex > 0) await pauseRecorderForSeek();
        await seekExportMedia(video, range.start);
        if (rangeIndex > 0) await resumeRecorderAfterSeek();

        const rangeEnded = waitForRangeEnd(range);
        const rangeDuration = range.end - range.start;
        const narrationSlice = exportNarrationBuffer
          ? getNarrationBufferSlice(
              narrationElapsed,
              rangeDuration,
              exportNarrationBuffer.duration,
            )
          : null;
        if (
          narrationSlice &&
          exportAudioContext &&
          exportNarrationGain &&
          exportNarrationBuffer
        ) {
          activeExportNarrationSource =
            exportAudioContext.createBufferSource();
          activeExportNarrationSource.buffer = exportNarrationBuffer;
          activeExportNarrationSource.playbackRate.value =
            getNarrationPlaybackRate();
          activeExportNarrationSource.connect(exportNarrationGain);
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
        if (activeExportNarrationSource) {
          try {
            activeExportNarrationSource.stop();
          } catch {
            // The source may already have stopped at the end of the slice.
          }
          activeExportNarrationSource.disconnect();
          activeExportNarrationSource = null;
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

      const output = new Blob(chunks, {
        type: activeRecorder.mimeType || mimeType || "video/webm",
      });
      if (!output.size) throw new Error("書き出した動画が空でした。");

      const outputType = output.type.toLowerCase();
      const extension = outputType.includes("mp4") ? "mp4" : "webm";
      const completedFile = new File(
        [output],
        `${exportName}_captioned.${extension}`,
        { type: output.type || `video/${extension}` },
      );
      setExportProgress(100);
      setExportedVideoFile(completedFile);
      setExportedVideoRevision(exportInputRevision);
      notify("動画ができました。下の「動画を保存・共有」を押してください");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "動画の書き出しに失敗しました",
      );
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
      sourceStream?.getTracks().forEach((track) => track.stop());
      outputStream?.getTracks().forEach((track) => track.stop());
      if (activeExportNarrationSource) {
        try {
          activeExportNarrationSource.stop();
        } catch {
          // The source may already have stopped after a recorder error.
        }
        activeExportNarrationSource.disconnect();
      }
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
      isExportingRef.current = false;
      await seekVideoBeforePlayback(video, previous.currentTime);
      setCurrentTime(video.currentTime);
      setIsExporting(false);
      setExportProgress(null);
      if (previous.wasPlaying) {
        const operation = previewOperationRef.current + 1;
        previewOperationRef.current = operation;
        await playPreviewFromEditedTime(previous.editedTime, operation).catch(
          () => undefined,
        );
      }
    }
  }

  async function saveExportedVideo() {
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

  function requestVideoExport() {
    if (isMediaBusy || isExportingRef.current) return;
    if (narrationPlan) {
      setDisclosureConfirmed(false);
      setShowDisclosureConfirm(true);
      return;
    }
    void exportCaptionedVideo();
  }

  async function confirmNarrationExport() {
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
              : "全体の自動編集が完了しました"}
          </p>
          <h1>
            {narrationPlan
              ? "映像の流れに合わせて、声とテロップを組み立てました。"
              : "話の流れを残して、自然な長さにつなぎ直しました。"}
          </h1>
          <p>
            {narrationPlan
              ? "台本と声の雰囲気はここで調整できます。公開動画にサービス名や透かしは入りません。"
              : "元動画全体から、言い淀み・重複・長い間を外し、文の切れ目で再構成しています。"}
          </p>
        </div>
        <div className="timeSaved">
          <span>仕上がり時間</span>
          <strong>{formatCaptionClock(editDuration)}</strong>
          <small>
            全体から
            {narrationPlan ? `${length}秒以内` : `約${length}秒`}
            へ自動構成
          </small>
        </div>
      </div>

      {narrationPlan && (
        <section className="narrationStudio">
          <div className="narrationStudioHeading">
            <div>
              <p className="eyebrow">VOICE STUDIO</p>
              <h2>声と投稿文を、あなたらしく整える</h2>
            </div>
            <span>公開動画への透かしなし</span>
          </div>
          <div className="narrationStudioGrid">
            <div className="narrationScriptEditor">
              <label>
                <span>ナレーション台本</span>
                <textarea
                  value={narrationDraft}
                  rows={6}
                  maxLength={2_000}
                  disabled={isMediaBusy}
                  onChange={(event) => setNarrationDraft(event.target.value)}
                />
              </label>
              <div className="voiceStylePicker">
                {NARRATION_STYLES.map((style) => (
                  <button
                    type="button"
                    key={style.id}
                    data-style={style.id}
                    className={
                      draftNarrationStyle === style.id ? "active" : ""
                    }
                    onClick={() => setDraftNarrationStyle(style.id)}
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
              <button
                type="button"
                className="quietButton regenerateVoice"
                disabled={isMediaBusy}
                onClick={() => void handleNarrationRegeneration()}
              >
                {isRegeneratingNarration
                  ? "AI音声を再生成中…"
                  : "この台本と声で再生成"}
              </button>
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
                  pausePreviewTransport();
                }}
              />
              <p className="naturalNarrationNote">
                声を動画尺に合わせて引き伸ばさず、自然な1倍速で再生・書き出しします。
              </p>
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
        </section>
      )}

      <div className="resultGrid">
        <div className="previewPanel">
          <div className="previewTop">
            <div className="modeSwitch">
              <button
                className={previewMode === "before" ? "active" : ""}
                onClick={() => setPreviewMode("before")}
              >
                字幕なし
              </button>
              <button
                className={previewMode === "after" ? "active" : ""}
                onClick={() => setPreviewMode("after")}
              >
                字幕あり
              </button>
            </div>
            <span>仕上がりプレビュー</span>
          </div>

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
                <small>あなたらしいテロップ</small>
                <strong>
                  {CAPTION_MOODS.find(
                    (item) => item.id === captionProfile.mood,
                  )?.label ?? "おまかせ"}
                  ・{captionProfile.brandName || "ブランド名なし"}
                </strong>
              </span>
              <i>{isCaptionDesignerOpen ? "閉じる" : "調整する"}</i>
            </button>

            {isCaptionDesignerOpen && (
              <div className="captionIdentityControls">
                <div className="identityControl">
                  <span>どんな印象にする？</span>
                  <div className="moodChoices">
                    {CAPTION_MOODS.map((item) => (
                      <button
                        className={
                          captionProfile.mood === item.id ? "active" : ""
                        }
                        key={item.id}
                        type="button"
                        title={item.note}
                        disabled={isMediaBusy}
                        onClick={() =>
                          setCaptionProfile({
                            ...captionProfile,
                            mood: item.id,
                          })
                        }
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

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
                  setSourceDuration(
                    Number.isFinite(sourceDuration) && sourceDuration > 0
                      ? sourceDuration
                      : 0,
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
            {previewMode === "after" && activeCaption && (
              <div
                className={`resultCaption ${tone} ${activePresentation}`}
                key={activeCaption.id}
                style={captionStyle}
              >
                {activePresentation === "hook" &&
                  captionProfile.brandName && (
                    <small className="captionBrand">
                      {captionProfile.brandName}
                    </small>
                  )}
                <RichCaptionText caption={activeCaption} />
              </div>
            )}
            <span className="videoState">
              {previewMode === "after" ? "字幕ON" : "字幕OFF"}
            </span>
            <span className="outputRange">
              {narrationPlan ? `${length}秒以内版` : `約${length}秒版`}
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
                aria-label="自動編集後の再生位置"
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

        <aside className="editPanel">
          <div className="editPanelHeading">
            <div>
              <p className="eyebrow">TEXT EDIT</p>
              <h2>
                {narrationPlan
                  ? "音声とテロップを確認"
                  : "残す区間を選ぶ"}
              </h2>
            </div>
            <span>プレビューへ自動反映</span>
          </div>
          <p className="editHelp">
            {narrationPlan
              ? "テロップはAI音声と同期しています。内容を変えるときは、上の台本を編集して「この台本と声で再生成」を押してください。"
              : "使わない区間を「カット」にすると、同じ時間の映像・元音声・テロップが仕上がり動画から外れます。元動画は変更されず、いつでも戻せます。"}
          </p>
          {!narrationPlan && (
            <div className="captionCutToolbar">
              <span aria-live="polite">
                <strong>{keptLines.length}</strong>区間を残す
                <i aria-hidden="true">/</i>
                <strong>{removedCount}</strong>区間をカット
              </span>
              <button
                type="button"
                onClick={resetCaptionCuts}
                disabled={!hasCutChanges || isMediaBusy}
              >
                最初の編集に戻す
              </button>
            </div>
          )}
          <div className="transcriptList">
            {transcript.map((line) => (
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
                  {!narrationPlan && (
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
              </div>
            ))}
          </div>
          <div className="cutSummary">
            <div>
              <span>カット</span>
              <strong>{removedCount}区間</strong>
            </div>
            <div>
              <span>残す</span>
              <strong>{keptLines.length}区間</strong>
            </div>
            <div>
              <span>仕上がり</span>
              <strong>{formatCaptionClock(editDuration)}</strong>
            </div>
          </div>
        </aside>
      </div>

      <div className="deliverables">
        <div>
          <p className="eyebrow">READY TO POST</p>
          <h2>表紙と字幕データを、すぐ使える形式で保存できます。</h2>
        </div>
        <div className="deliverableCards">
          <button
            onClick={() => void generateThumbnail()}
            disabled={isMediaBusy}
          >
            <span className="deliverableIcon thumbnail">表</span>
            <p>
              <strong>
                {isGeneratingThumbnail ? "表紙を生成中…" : "表紙を保存"}
              </strong>
              <small>動画の見せ場から9:16画像</small>
            </p>
            <i>{isGeneratingThumbnail ? "●" : "↓"}</i>
          </button>
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
      </div>

      {!file && (
        <div className="handoffPrompt">
          <div className="handoffPromptIcon">↑</div>
          <div>
            <p className="eyebrow">TRY YOUR VIDEO</p>
            <h2>サンプルではなく、実際の動画でも試せます。</h2>
            <p>
              動画を選ぶと、音声を解析して時刻付きの日本語字幕を自動生成します。
            </p>
          </div>
          <button onClick={openTransfer}>
            <span>動画を選ぶ</span>
            <i>→</i>
          </button>
        </div>
      )}

      <div className="exportBar">
        <div>
          <span className="exportIcon">▶</span>
          <p>
            <strong>
              {readyExportedVideoFile?.name ?? `${exportName}_captioned.mp4`}
            </strong>
            <small>
              {readyExportedVideoFile
                ? "動画の準備ができました。iPhoneでは共有画面から「ビデオを保存」を選べます"
                : isExporting && exportProgress !== null
                  ? `MP4動画を準備しています（${Math.round(exportProgress)}%）`
                  : file
                    ? "編集した字幕と音声をiPhoneで使える動画へまとめます"
                    : "実際の動画を選ぶと書き出せます"}
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
          {file && !usedHighAccuracy && !narrationPlan && (
            <button
              className="quietButton highAccuracyButton"
              onClick={() => void regenerateHighAccuracy()}
              disabled={isMediaBusy}
            >
              高精度で再生成
            </button>
          )}
          {file ? (
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
                    : "字幕付き動画を書き出す"}
              </span>
              <i>{isExporting ? "●" : "↓"}</i>
            </button>
          ) : (
            <button className="mainCta reviewCta" onClick={openTransfer}>
              <span>実際の動画で試す</span>
              <i>→</i>
            </button>
          )}
        </div>
      </div>

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
            className="disclosureModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disclosure-title"
          >
            <button
              type="button"
              className="modalClose"
              aria-label="閉じる"
              onClick={() => setShowDisclosureConfirm(false)}
            >
              ×
            </button>
            <p className="eyebrow">BEFORE EXPORT</p>
            <h2 id="disclosure-title">投稿時の表示を確認してください</h2>
            <p>
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
