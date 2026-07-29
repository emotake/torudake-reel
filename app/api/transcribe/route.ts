import { env } from "cloudflare:workers";
import {
  buildCaptionSegments,
  type RawCaptionSegment,
} from "../../../lib/captions";
import {
  alignRefinedTextToSegments,
  getTranscriptionQualityReasons,
} from "../../../lib/transcription-quality";
import {
  findTransfer,
  getMediaBucket,
  isSupportedTranscriptionMedia,
  isSupportedVideo,
  jsonError,
  removeTransfer,
  safeFileName,
} from "../../../lib/transfers";

const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

type TranscriptionResponse = {
  duration?: number;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    speaker?: string;
    text?: string;
  }>;
  text?: string;
};

type OpenAIErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
};

type TranscriptionCallResult =
  | {
      ok: true;
      transcription: TranscriptionResponse;
    }
  | {
      ok: false;
      error?: OpenAIErrorResponse["error"];
      requestId: string | null;
      status: number;
    };

const HIGH_ACCURACY_PROMPT =
  "日本語のInstagramリール用動画です。聞こえた日本語を省略せず、言い換えず、固有名詞・数字・商品名をできるだけ正確に文字起こししてください。";

function getRawSegments(transcription: TranscriptionResponse) {
  const transcriptionText = transcription.text?.trim() ?? "";
  const transcriptionDuration = Number(transcription.duration);
  const segments: RawCaptionSegment[] = (transcription.segments ?? [])
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: segment.text?.trim() ?? "",
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start &&
        Boolean(segment.text),
    );

  if (
    segments.length === 0 &&
    transcriptionText &&
    Number.isFinite(transcriptionDuration) &&
    transcriptionDuration > 0
  ) {
    segments.push({
      start: 0,
      end: transcriptionDuration,
      text: transcriptionText,
    });
  }

  return segments;
}

async function requestTranscription(
  apiKey: string,
  file: File,
  mode: "timed" | "refine",
): Promise<TranscriptionCallResult> {
  const formData = new FormData();
  formData.set("file", file, safeFileName(file.name));
  formData.set(
    "model",
    mode === "timed"
      ? "gpt-4o-transcribe-diarize"
      : "gpt-4o-transcribe",
  );
  formData.set("language", "ja");
  formData.set(
    "response_format",
    mode === "timed" ? "diarized_json" : "json",
  );
  formData.set("chunking_strategy", "auto");
  formData.set("temperature", "0");
  if (mode === "refine") {
    formData.set("prompt", HIGH_ACCURACY_PROMPT);
  }

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorResponse = (await response
      .json()
      .catch(() => null)) as OpenAIErrorResponse | null;
    return {
      ok: false,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      error: errorResponse?.error,
    };
  }

  return {
    ok: true,
    transcription: (await response.json()) as TranscriptionResponse,
  };
}

function transcriptionError(
  status: number,
  openAIError?: OpenAIErrorResponse["error"],
) {
  if (status === 401 || status === 403) {
    return "音声認識の認証設定を確認してください。";
  }
  if (status === 413) {
    return "動画が音声認識サービスの上限を超えています。";
  }
  if (status === 429) {
    const errorDetail = [
      openAIError?.code,
      openAIError?.type,
      openAIError?.message,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (
      errorDetail.includes("insufficient_quota") ||
      errorDetail.includes("current quota") ||
      errorDetail.includes("billing")
    ) {
      return "音声認識のAPI利用枠が不足しています。OpenAI APIのクレジットを追加してから、もう一度お試しください。";
    }
    return "音声認識が混み合っています。少し待ってからもう一度お試しください。";
  }
  return "音声認識に失敗しました。時間をおいてもう一度お試しください。";
}

export async function POST(request: Request) {
  let temporaryTransfer:
    | Awaited<ReturnType<typeof findTransfer>>
    | undefined = undefined;

  try {
    const apiKey = (
      env as unknown as {
        OPENAI_API_KEY?: string;
      }
    ).OPENAI_API_KEY?.trim();

    if (!apiKey) {
      return jsonError(
        "音声認識の準備が完了していません。管理者にご連絡ください。",
        503,
      );
    }

    let file: File | null = null;
    let requestHighAccuracy = false;
    const requestContentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";

    if (requestContentType.includes("application/json")) {
      const payload = (await request.json()) as {
        id?: string;
        code?: string;
        quality?: string;
      };
      requestHighAccuracy = payload.quality === "high";
      const id = payload.id?.trim() ?? "";
      const code = payload.code?.trim() ?? "";
      if (!id || !code) {
        return jsonError("字幕生成用の動画情報が正しくありません。");
      }

      const transfer = await findTransfer(id, code);
      if (!transfer || transfer.status === "deleted") {
        return jsonError("字幕生成用の動画が見つかりません。", 404);
      }
      if (transfer.status !== "complete" || transfer.expiresAt < Date.now()) {
        return jsonError("動画のアップロードが未完了または期限切れです。", 410);
      }

      const authenticatedEmail =
        request.headers.get("oai-authenticated-user-email")?.trim() ?? "";
      if (
        transfer.ownerEmail &&
        transfer.ownerEmail.toLowerCase() !== authenticatedEmail.toLowerCase()
      ) {
        return jsonError("この動画を字幕生成に使用する権限がありません。", 403);
      }
      if (transfer.size > MAX_TRANSCRIPTION_BYTES) {
        return jsonError(
          "字幕の自動生成は25MBまでです。動画を短くするか圧縮してお試しください。",
          413,
        );
      }
      if (!isSupportedVideo(transfer.fileName, transfer.contentType)) {
        return jsonError("MP4・MOV・M4V・WebMの動画を選んでください。");
      }

      temporaryTransfer = transfer;
      const storedObject = await getMediaBucket().get(transfer.objectKey);
      if (!storedObject) {
        return jsonError("字幕生成用の動画を読み込めませんでした。", 410);
      }
      if (
        storedObject.size <= 0 ||
        storedObject.size > MAX_TRANSCRIPTION_BYTES
      ) {
        return jsonError(
          "字幕の自動生成は25MBまでです。動画を短くするか圧縮してお試しください。",
          413,
        );
      }

      const fileBytes = await new Response(storedObject.body).arrayBuffer();
      file = new File([fileBytes], transfer.fileName, {
        type: transfer.contentType || "video/mp4",
      });
    } else {
      const requestData = await request.formData();
      const uploadedFile = requestData.get("file");
      requestHighAccuracy = requestData.get("quality") === "high";
      if (uploadedFile instanceof File) {
        file = uploadedFile;
      }
    }

    if (!file || file.size <= 0) {
      return jsonError("字幕を付ける動画を選んでください。");
    }
    if (file.size > MAX_TRANSCRIPTION_BYTES) {
      return jsonError(
        "字幕の自動生成は25MBまでです。動画を短くするか圧縮してお試しください。",
        413,
      );
    }
    if (!isSupportedTranscriptionMedia(file.name, file.type || "video/mp4")) {
      return jsonError("対応している動画または音声ファイルを選んでください。");
    }

    const timedResult = await requestTranscription(apiKey, file, "timed");
    if (!timedResult.ok) {
      console.error(
        "OpenAI transcription failed",
        timedResult.status,
        timedResult.requestId,
        timedResult.error?.code,
        timedResult.error?.type,
      );
      return jsonError(
        transcriptionError(timedResult.status, timedResult.error),
        timedResult.status,
      );
    }

    const transcription = timedResult.transcription;
    let transcriptionText = transcription.text?.trim() ?? "";
    const transcriptionDuration = Number(transcription.duration);
    let rawSegments = getRawSegments(transcription);
    const qualityReasons = getTranscriptionQualityReasons(transcriptionText);
    const shouldRefine =
      requestHighAccuracy ||
      (transcriptionText.length > 0 && qualityReasons.length > 0);
    let refined = false;

    if (shouldRefine) {
      const refineResult = await requestTranscription(apiKey, file, "refine");
      if (refineResult.ok) {
        const refinedText = refineResult.transcription.text?.trim() ?? "";
        if (refinedText) {
          rawSegments = alignRefinedTextToSegments(refinedText, rawSegments);
          transcriptionText = refinedText;
          refined = true;
        }
      } else {
        console.error(
          "OpenAI high-accuracy transcription failed",
          refineResult.status,
          refineResult.requestId,
          refineResult.error?.code,
          refineResult.error?.type,
        );
      }
    }

    const segments = buildCaptionSegments(rawSegments, 14);

    if (segments.length === 0) {
      return Response.json(
        {
          text: transcriptionText,
          language: transcription.language ?? "ja",
          duration:
            Number.isFinite(transcriptionDuration) &&
            transcriptionDuration > 0
              ? transcriptionDuration
              : 0,
          segments: [],
          silent: true,
          refined,
        },
        {
          headers: {
            "Cache-Control": "private, no-store",
          },
        },
      );
    }

    return Response.json(
      {
        text: transcriptionText,
        language: transcription.language ?? "ja",
        duration:
          transcriptionDuration || segments.at(-1)?.end || 0,
        segments,
        refined,
        refinementReason: requestHighAccuracy
          ? "requested"
          : qualityReasons[0],
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    console.error("transcription route failed", error);
    return jsonError(
      "動画を読み取れませんでした。もう一度お試しください。",
      500,
    );
  } finally {
    if (temporaryTransfer) {
      await removeTransfer(temporaryTransfer).catch((cleanupError) => {
        console.error("temporary transcription upload cleanup failed", cleanupError);
      });
    }
  }
}
