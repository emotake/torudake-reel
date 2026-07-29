"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  remapCaptionsToEditedTimeline,
  sourceTimeToEditedTime,
} from "../lib/edit-plan";
import {
  encodeMonoWavChunk,
  TRANSCRIPTION_AUDIO_CHUNK_SECONDS,
} from "../lib/audio";

type Stage = "start" | "setup" | "processing" | "result" | "transfer";
type Goal = "follow" | "sales" | "reach";
type Tone =
  | "editorial"
  | "cinema"
  | "studio"
  | "glass"
  | "mono"
  | "signature";
type PreviewMode = "before" | "after";
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

function RichCaptionText({ caption }: { caption: TranscriptLine }) {
  const text = caption.text.trim();
  const highlight = caption.highlight?.trim() ?? "";
  const highlightIndex = highlight ? text.indexOf(highlight) : -1;

  if (highlightIndex < 0) return <>{text}</>;

  return (
    <>
      {text.slice(0, highlightIndex)}
      <strong>{highlight}</strong>
      {text.slice(highlightIndex + highlight.length)}
    </>
  );
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

async function reserveVideoUsage(selectedFile: File) {
  const response = await fetch("/api/usage/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceDurationSeconds: await getVideoDurationSeconds(selectedFile),
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  if (response.status === 401) {
    window.location.href =
      "/signin-with-chatgpt?return_to=%2Faccount%3Fcontinue%3Dediting";
    throw new ApiRequestError(
      "続けるにはアカウントへのログインが必要です。",
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

const goals: { id: Goal; icon: string; title: string; note: string }[] = [
  { id: "follow", icon: "＋", title: "フォローを増やす", note: "結論を先に見せる" },
  { id: "sales", icon: "↗", title: "商品を紹介する", note: "信頼とCTAを重視" },
  { id: "reach", icon: "◎", title: "まず見てもらう", note: "テンポと冒頭を重視" },
];

const tones: { id: Tone; title: string; note: string }[] = [
  { id: "editorial", title: "エディトリアル", note: "余白を生かした上品な誌面調" },
  { id: "cinema", title: "シネマ", note: "映像を隠さない映画字幕" },
  { id: "studio", title: "スタジオ", note: "端正で信頼感のある番組調" },
  { id: "glass", title: "グラス", note: "透明感のあるモダンな帯" },
  { id: "mono", title: "モノクロ", note: "余計な色を省いたミニマル" },
  { id: "signature", title: "シグネチャー", note: "温度感のあるブランド調" },
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
  const [tone, setTone] = useState<Tone>("editorial");
  const [length, setLength] = useState(60);
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

  const keptLines = useMemo(
    () => transcript.filter((line) => !line.removed),
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
    usageReservationRef.current = null;
    setStage("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function useSample() {
    setFile(null);
    setEditError("");
    setUsedHighAccuracy(false);
    setIsHighAccuracyRun(false);
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
    <main className="siteShell">
      <header className="topbar">
        <button className="brand" onClick={reset} aria-label="トップへ戻る">
          <span className="brandIcon">
            <span />
            <i>▶</i>
          </span>
          <span className="brandText">
            撮るだけリール
            <small>ひとり喋り動画専用</small>
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
          tone={tone}
          setTone={setTone}
          length={length}
          setLength={setLength}
          chooseAnother={() => inputRef.current?.click()}
          startEditing={() => startEditing(false)}
          error={editError}
        />
      )}

      {stage === "processing" && (
        <Processing
          file={file}
          progress={progress}
          highAccuracy={isHighAccuracyRun}
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
          tone={tone}
          setTone={setTone}
          length={length}
          notify={notify}
          reset={reset}
          openTransfer={openTransferWithCurrentVideo}
          regenerateHighAccuracy={() => startEditing(true)}
          usedHighAccuracy={usedHighAccuracy}
        />
      )}

      <footer>
        <div>
          <strong>撮るだけリール</strong>
          <span>話して送るだけ。カット・テロップ・表紙まで自動。</span>
        </div>
        <div className="footerLinks">
          <a href="#how">使い方</a>
          <a href="#price">料金</a>
          <span>プライバシー</span>
          <span>利用規約</span>
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
            日本語のひとり喋り動画専用
          </p>
          <h1>
            話して送るだけ。
            <br />
            <em>編集は、もうしない。</em>
          </h1>
          <p className="heroLead">
            無音カット、言い淀み除去、テロップ、ズーム、表紙まで。
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
            <em>話す・選ぶ・確認する。</em>
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
            <h3>AIが全部整える</h3>
            <p>無音、言い淀み、字幕、ズームをまとめて処理。</p>
            <small>日本語の自然な「間」を残す</small>
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
              日本語の言い淀みと自然な間を分ける
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
            <h3>月5本プラン</h3>
            <strong>
              ¥1,480<small>/月</small>
            </strong>
            <span>1本あたり296円</span>
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
                : "月5本プランを始める"}
            </button>
          </article>
          <article>
            <p>ONE TIME</p>
            <h3>1本だけ</h3>
            <strong>¥480</strong>
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

function SetupWorkspace({
  file,
  videoUrl,
  goal,
  setGoal,
  tone,
  setTone,
  length,
  setLength,
  chooseAnother,
  startEditing,
  error,
}: {
  file: File | null;
  videoUrl: string;
  goal: Goal;
  setGoal: (goal: Goal) => void;
  tone: Tone;
  setTone: (tone: Tone) => void;
  length: number;
  setLength: (length: number) => void;
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
          <p>3つ選ぶだけで、カットとテロップの方針が決まります。</p>
        </div>
        <span>STEP 1 / 3</span>
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
              <strong>{file?.name ?? "sample_talking_video.mp4"}</strong>
              <small>
                {file ? `${Math.max(file.size / 1024 / 1024, 0.1).toFixed(1)} MB` : "18.4 MB"}・縦動画
              </small>
            </p>
            <button onClick={chooseAnother}>変更</button>
          </div>
          <div className="localNote">
            <span>●</span>
            iPhoneのMOVや25MBを超える動画は、端末内で音声だけを取り出して字幕を生成します（最大500MB）。
          </div>
        </aside>

        <div className="setupForm">
          <fieldset>
            <legend>
              <span>01</span>
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
              <span>02</span>
              テロップのパターン
            </legend>
            <div className="optionCards three toneCards">
              {tones.map((item) => (
                <button
                  key={item.id}
                  className={tone === item.id ? "selected" : ""}
                  onClick={() => setTone(item.id)}
                >
                  <span className={`tonePreview ${item.id}`}>
                    <small>言葉が</small>
                    <strong>きちんと届く</strong>
                  </span>
                  <strong>{item.title}</strong>
                  <small>{item.note}</small>
                  <b>{tone === item.id ? "✓" : ""}</b>
                </button>
              ))}
            </div>
            <p className="optionCostNote">
              デザイン変更は端末内で行うため、API利用量は増えません。
            </p>
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
                  <small>
                    {item === 30 ? "短く強く" : item === 60 ? "おすすめ" : "しっかり解説"}
                  </small>
                </button>
              ))}
            </div>
            <p className="optionCostNote">
              自然に短くするため元動画全体を1度だけ文字起こしします。構成判定は端末内で行い、追加のAI呼び出しはしません。
            </p>
          </fieldset>

          <div className="editSummary">
            <div>
              <span>今回の編集方針</span>
              <p>
                <strong>{goals.find((item) => item.id === goal)?.title}</strong>
                ・{tones.find((item) => item.id === tone)?.title}・{length}秒
              </p>
            </div>
            <button className="mainCta" onClick={startEditing}>
              <span>この設定で自動編集する</span>
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
}: {
  file: File | null;
  progress: number;
  highAccuracy: boolean;
}) {
  const steps = [
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
            {highAccuracy ? "言葉を高精度で確認し、" : "音量と発話区間を整え、"}
            話の流れを保った短い動画へ再構成しています。
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
  tone,
  setTone,
  length,
  notify,
  reset,
  openTransfer,
  regenerateHighAccuracy,
  usedHighAccuracy,
}: {
  file: File | null;
  videoUrl: string;
  previewMode: PreviewMode;
  setPreviewMode: (mode: PreviewMode) => void;
  transcript: TranscriptLine[];
  setTranscript: (lines: TranscriptLine[]) => void;
  keptLines: TranscriptLine[];
  tone: Tone;
  setTone: (tone: Tone) => void;
  length: number;
  notify: (message: string) => void;
  reset: () => void;
  openTransfer: () => void;
  regenerateHighAccuracy: () => Promise<void>;
  usedHighAccuracy: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isGeneratingThumbnail, setIsGeneratingThumbnail] = useState(false);
  const editRanges = useMemo(
    () => buildEditRanges(transcript),
    [transcript],
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
  const activeCaption =
    keptLines.find(
      (line) => currentTime >= line.start && currentTime < line.end,
    ) ?? (!videoUrl ? keptLines[0] : undefined);
  const exportName =
    file?.name.replace(/\.[^.]+$/, "") ?? "sample_talking_video";
  const removedCount = transcript.filter((line) => line.removed).length;

  function toggleLine(id: number) {
    setTranscript(
      transcript.map((line) =>
        line.id === id ? { ...line, removed: !line.removed } : line,
      ),
    );
  }

  function updateLine(id: number, text: string) {
    const highlight = selectCaptionHighlight(text);
    setTranscript(
      transcript.map((line) =>
        line.id === id
          ? { ...line, text, highlight, accent: Boolean(highlight) }
          : line,
      ),
    );
  }

  function seekTo(seconds: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(
      0,
      Math.min(seconds, sourceDuration || seconds),
    );
    setCurrentTime(video.currentTime);
  }

  function seekToEditedTime(seconds: number) {
    seekTo(
      editedTimeToSourceTime(
        editRanges,
        Math.max(0, Math.min(seconds, editDuration)),
      ),
    );
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
    if (currentRangeIndex >= 0) {
      setCurrentTime(video.currentTime);
      return;
    }

    moveToNextKeptRange(video);
  }

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) {
      notify("実際の動画を選ぶと再生できます");
      return;
    }
    if (editRanges.length === 0) {
      notify("残す文を1つ以上選んでください");
      return;
    }
    if (video.paused) {
      const isInsideKeptRange = editRanges.some(
        (range) =>
          video.currentTime >= range.start &&
          video.currentTime < range.end - 0.05,
      );
      if (!isInsideKeptRange) {
        const nextRange =
          editRanges.find(
            (range) => range.start > video.currentTime + 0.01,
          ) ?? editRanges[0];
        video.currentTime = nextRange.start;
        setCurrentTime(nextRange.start);
      }
      await video.play();
    } else {
      video.pause();
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

  async function generateThumbnail() {
    const video = videoRef.current;
    if (!video || !file || isGeneratingThumbnail) {
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
      wasPlaying: !video.paused,
    };
    setIsGeneratingThumbnail(true);

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

      const palettes: Record<
        Tone,
        {
          panel: string;
          border: string;
          text: string;
          accent: string;
          label: string;
        }
      > = {
        editorial: {
          panel: "rgba(255,252,248,.96)",
          border: "#e45f4d",
          text: "#162033",
          accent: "#d94f3b",
          label: "#fff7f0",
        },
        cinema: {
          panel: "rgba(11,16,24,.7)",
          border: "rgba(255,255,255,.7)",
          text: "#ffffff",
          accent: "#f4d57a",
          label: "#ffffff",
        },
        studio: {
          panel: "rgba(19,27,40,.94)",
          border: "#d5a850",
          text: "#ffffff",
          accent: "#ffd26a",
          label: "#f8e8b8",
        },
        glass: {
          panel: "rgba(12,28,34,.82)",
          border: "#8fe3cc",
          text: "#f8fffd",
          accent: "#9ff3dc",
          label: "#d9fff4",
        },
        mono: {
          panel: "rgba(248,246,240,.97)",
          border: "#181818",
          text: "#181818",
          accent: "#181818",
          label: "#ffffff",
        },
        signature: {
          panel: "rgba(255,243,229,.96)",
          border: "#bf9660",
          text: "#3e2d28",
          accent: "#d95a48",
          label: "#fff7ed",
        },
      };
      const palette = palettes[tone];
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
      context.fillText("撮るだけリール", 112, 111);

      const sourceText = coverCaption.text.trim();
      const characters = Array.from(sourceText);
      const lines: string[] = [];
      const charactersPerLine = 12;
      for (
        let index = 0;
        index < Math.min(characters.length, charactersPerLine * 3);
        index += charactersPerLine
      ) {
        const line = characters
          .slice(index, index + charactersPerLine)
          .join("");
        lines.push(
          index + charactersPerLine >= charactersPerLine * 3 &&
            characters.length > charactersPerLine * 3
            ? `${line.slice(0, -1)}…`
            : line,
        );
      }

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
        "話して送るだけ・自動動画編集",
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
      video.currentTime = previous.currentTime;
      if (previous.wasPlaying) void video.play();
      setIsGeneratingThumbnail(false);
    }
  }

  async function exportCaptionedVideo() {
    const video = videoRef.current;
    if (!video || !file || isExporting) return;
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
      notify("残す文を1つ以上選んでください");
      return;
    }

    const capturableVideo = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const captureVideoStream =
      capturableVideo.captureStream ?? capturableVideo.mozCaptureStream;

    if (
      typeof MediaRecorder === "undefined" ||
      typeof HTMLCanvasElement.prototype.captureStream !== "function" ||
      !captureVideoStream
    ) {
      notify("このブラウザは動画書き出しに対応していません");
      return;
    }

    setIsExporting(true);
    const previous = {
      currentTime: video.currentTime,
      muted: video.muted,
      volume: video.volume,
      loop: video.loop,
      wasPlaying: !video.paused,
    };
    let animationFrame = 0;
    let keepDrawing = true;
    let sourceStream: MediaStream | null = null;

    try {
      video.pause();
      video.loop = false;
      video.muted = false;
      video.currentTime = playableRanges[0].start;
      await new Promise<void>((resolve) => {
        if (
          video.readyState >= 2 &&
          Math.abs(video.currentTime - playableRanges[0].start) < 0.03
        ) {
          resolve();
          return;
        }
        video.addEventListener("seeked", () => resolve(), { once: true });
      });

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1080;
      canvas.height = video.videoHeight || 1920;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("動画の描画を開始できませんでした。");

      const drawFrame = () => {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const caption = transcript.find(
          (line) =>
            !line.removed &&
            line.text.trim() &&
            video.currentTime >= line.start &&
            video.currentTime < line.end,
        );

        if (caption) {
          const captionPalette: Record<
            Tone,
            {
              background: string;
              border: string;
              highlight: string;
              text: string;
              stroke: string;
              fontWeight: number;
            }
          > = {
            editorial: {
              background: "rgba(255,252,248,.96)",
              border: "#e45f4d",
              highlight: "#d94f3b",
              text: "#162033",
              stroke: "",
              fontWeight: 800,
            },
            cinema: {
              background: "",
              border: "",
              highlight: "#f4d57a",
              text: "#ffffff",
              stroke: "#10151f",
              fontWeight: 800,
            },
            studio: {
              background: "rgba(19,27,40,.94)",
              border: "#d5a850",
              highlight: "#ffd26a",
              text: "#ffffff",
              stroke: "",
              fontWeight: 800,
            },
            glass: {
              background: "rgba(12,28,34,.78)",
              border: "#8fe3cc",
              highlight: "#9ff3dc",
              text: "#f8fffd",
              stroke: "",
              fontWeight: 750,
            },
            mono: {
              background: "rgba(248,246,240,.97)",
              border: "#181818",
              highlight: "#181818",
              text: "#181818",
              stroke: "",
              fontWeight: 850,
            },
            signature: {
              background: "rgba(255,243,229,.96)",
              border: "#bf9660",
              highlight: "#d95a48",
              text: "#3e2d28",
              stroke: "",
              fontWeight: 750,
            },
          };
          const palette = captionPalette[tone];
          const fontSize = Math.max(26, Math.min(64, canvas.width * 0.052));
          const horizontalPadding = fontSize * (tone === "cinema" ? 0.32 : 0.72);
          const verticalPadding = fontSize * (tone === "cinema" ? 0.18 : 0.44);
          const maxTextWidth = canvas.width * 0.82;
          const charactersPerLine = Math.max(
            8,
            Math.floor(maxTextWidth / fontSize),
          );
          const characters = Array.from(caption.text.trim());
          const lines: string[] = [];
          for (let index = 0; index < characters.length; index += charactersPerLine) {
            lines.push(characters.slice(index, index + charactersPerLine).join(""));
          }

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
          const boxHeight = lines.length * lineHeight + verticalPadding * 2;
          const boxX = (canvas.width - boxWidth) / 2;
          const boxY = canvas.height - boxHeight - canvas.height * 0.08;
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
          const highlight = caption.highlight?.trim() ?? "";
          context.textAlign = "left";
          lines.forEach((line, index) => {
            const lineY =
              boxY + verticalPadding + lineHeight * (index + 0.5);
            const highlightIndex = highlight
              ? line.indexOf(highlight)
              : -1;
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
            let textX =
              canvas.width / 2 - context.measureText(line).width / 2;

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
        }

        if (keepDrawing) {
          animationFrame = window.requestAnimationFrame(drawFrame);
        }
      };

      const outputStream = canvas.captureStream(30);
      sourceStream = captureVideoStream.call(capturableVideo);
      sourceStream
        .getAudioTracks()
        .forEach((track) => outputStream.addTrack(track));

      const preferredMimeTypes = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ];
      const mimeType =
        preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) ??
        "";
      const recorder = new MediaRecorder(
        outputStream,
        mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined,
      );
      const chunks: BlobPart[] = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.addEventListener(
          "error",
          () => reject(new Error("動画の書き出しに失敗しました。")),
          { once: true },
        );
      });
      const ended = new Promise<void>((resolve) => {
        let rangeIndex = 0;
        const finishNaturalEdit = () => {
          const currentRange = playableRanges[rangeIndex];
          if (
            !video.ended &&
            video.currentTime < currentRange.end - 0.03
          ) {
            return;
          }

          if (rangeIndex < playableRanges.length - 1) {
            rangeIndex += 1;
            video.currentTime = playableRanges[rangeIndex].start;
            return;
          }

          video.removeEventListener(
            "timeupdate",
            finishNaturalEdit,
          );
          video.removeEventListener("ended", finishNaturalEdit);
          resolve();
        };
        video.addEventListener("timeupdate", finishNaturalEdit);
        video.addEventListener("ended", finishNaturalEdit);
      });

      recorder.start(1000);
      drawFrame();
      await video.play();
      await ended;
      video.pause();
      keepDrawing = false;
      recorder.stop();
      await stopped;

      const output = new Blob(chunks, {
        type: recorder.mimeType || "video/webm",
      });
      if (!output.size) throw new Error("書き出した動画が空でした。");

      const url = URL.createObjectURL(output);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${exportName}_captioned.webm`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("字幕付き動画を書き出しました");
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "動画の書き出しに失敗しました",
      );
    } finally {
      keepDrawing = false;
      window.cancelAnimationFrame(animationFrame);
      sourceStream?.getTracks().forEach((track) => track.stop());
      video.pause();
      video.loop = previous.loop;
      video.muted = previous.muted;
      video.volume = previous.volume;
      video.currentTime = previous.currentTime;
      if (previous.wasPlaying) void video.play();
      setIsExporting(false);
    }
  }

  return (
    <section className="resultPage">
      <div className="resultHeading">
        <div>
          <p className="completePill">
            <span>✓</span>
            {usedHighAccuracy
              ? "高精度の文字起こしで仕上げました"
              : "全体の自動編集が完了しました"}
          </p>
          <h1>話の流れを残して、自然な長さにつなぎ直しました。</h1>
          <p>
            元動画全体から、言い淀み・重複・長い間を外し、文の切れ目で再構成しています。
          </p>
        </div>
        <div className="timeSaved">
          <span>仕上がり時間</span>
          <strong>{formatCaptionClock(editDuration)}</strong>
          <small>全体から約{length}秒へ自動構成</small>
        </div>
      </div>

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

          <div
            className="captionPatternPicker"
            aria-label="テロップのパターン"
          >
            <span>テロップ</span>
            {tones.map((item) => (
              <button
                className={tone === item.id ? "active" : ""}
                key={item.id}
                onClick={() => setTone(item.id)}
                type="button"
              >
                <i className={`patternSwatch ${item.id}`}>Aa</i>
                {item.title}
              </button>
            ))}
            <small>切り替えてもAPI利用量は増えません</small>
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
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
              />
            ) : (
              <div className="resultSample">
                <CreatorFigure variant={previewMode} />
              </div>
            )}
            {previewMode === "after" && activeCaption && (
              <div
                className={`resultCaption ${tone}`}
                key={activeCaption.id}
              >
                <RichCaptionText caption={activeCaption} />
              </div>
            )}
            <span className="videoState">
              {previewMode === "after" ? "字幕ON" : "字幕OFF"}
            </span>
            <span className="outputRange">
              約{length}秒版・実尺{formatCaptionClock(editDuration)}
            </span>
          </div>

          <div className="timelinePreview">
            <button
              className="playButton"
              onClick={() => void togglePlayback()}
              aria-label={isPlaying ? "一時停止" : "再生"}
            >
              {isPlaying ? "Ⅱ" : "▶"}
            </button>
            <div
              role="slider"
              tabIndex={0}
              aria-label="自動編集後の再生位置"
              aria-valuemin={0}
              aria-valuemax={Math.max(1, Math.round(editDuration))}
              aria-valuenow={Math.round(editedCurrentTime)}
              onClick={(event) => {
                const bounds =
                  event.currentTarget.getBoundingClientRect();
                const ratio =
                  (event.clientX - bounds.left) /
                  Math.max(bounds.width, 1);
                seekToEditedTime(ratio * editDuration);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  seekToEditedTime(editedCurrentTime - 2);
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  seekToEditedTime(editedCurrentTime + 2);
                }
              }}
            >
              {keptLines.map((line) => (
                <i
                  key={line.id}
                  className="kept"
                  style={{ flex: Math.max(line.end - line.start, 0.2) }}
                />
              ))}
              <b
                style={{
                  left: `${Math.min(100, (editedCurrentTime / Math.max(editDuration, 0.1)) * 100)}%`,
                }}
              />
            </div>
            <span>
              {formatCaptionClock(editedCurrentTime)} /{" "}
              {formatCaptionClock(editDuration)}
            </span>
          </div>
        </div>

        <aside className="editPanel">
          <div className="editPanelHeading">
            <div>
              <p className="eyebrow">TEXT EDIT</p>
              <h2>文字でカットを確認</h2>
            </div>
            <span>自動保存</span>
          </div>
          <p className="editHelp">
            グレーの文は自動カット候補です。左のボタンで動画へ戻す・外すを切り替えられます。
          </p>
          <div className="transcriptList">
            {transcript.map((line) => (
              <div
                className={`transcriptLine ${line.removed ? "removed" : ""} ${line.accent ? "accent" : ""}`}
                key={line.id}
              >
                <button
                  onClick={() => toggleLine(line.id)}
                  aria-label={line.removed ? "この文を戻す" : "この文を削除する"}
                >
                  {line.removed ? "↶" : "✓"}
                </button>
                <div className="captionEditor">
                  <button
                    className="captionTime"
                    onClick={() => seekTo(line.start)}
                    type="button"
                  >
                    {line.removed ? "元動画 " : ""}
                    {formatCaptionClock(line.start)}–
                    {formatCaptionClock(line.end)}
                  </button>
                  <input
                    value={line.text}
                    onChange={(event) => updateLine(line.id, event.target.value)}
                    disabled={line.removed}
                  />
                </div>
                {line.accent && !line.removed && <span>強調</span>}
              </div>
            ))}
          </div>
          <div className="cutSummary">
            <div>
              <span>自動カット</span>
              <strong>{removedCount}枚</strong>
            </div>
            <div>
              <span>表示中</span>
              <strong>{keptLines.length}枚</strong>
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
            disabled={isGeneratingThumbnail}
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
            <strong>{exportName}_captioned.webm</strong>
            <small>
              {file
                ? "編集した字幕を動画へ焼き付けて保存します"
                : "実際の動画を選ぶと書き出せます"}
            </small>
          </p>
        </div>
        <div className="exportActions">
          <button className="quietButton" onClick={reset}>
            別の動画を作る
          </button>
          {file && !usedHighAccuracy && (
            <button
              className="quietButton highAccuracyButton"
              onClick={() => void regenerateHighAccuracy()}
            >
              高精度で再生成
            </button>
          )}
          {file ? (
            <button
              className="mainCta reviewCta"
              onClick={() => void exportCaptionedVideo()}
              disabled={isExporting}
            >
              <span>{isExporting ? "書き出し中…" : "字幕付き動画を書き出す"}</span>
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
