import { env } from "cloudflare:workers";
import {
  attachCaptionWordTimings,
  buildCaptionSegments,
  buildCaptionSegmentsFromWords,
  type RawCaptionSegment,
  type RawCaptionWord,
} from "../../../lib/captions";
import {
  alignRefinedTextToSegments,
  getTranscriptionQualityReasons,
  isRefinedTranscriptComplete,
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
import {
  abandonMeteredAiOperation,
  authorizeMeteredAiOperation,
  completeMeteredAiOperation,
  type AuthorizedMeteredAiOperation,
} from "../../../lib/billing-store";
import {
  recordMeteredAiTranscriptionDuration,
} from "../../../lib/operator-usage";
import { getUsagePrincipal } from "../../../lib/operator-access";
import { isUsageEnforcementEnabled } from "../../../lib/usage-enforcement";
import {
  createUpstreamAbortSignal,
  parseFormDataBodyWithLimit,
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../lib/request-safety";
import {
  productDurationBucket,
  productUpstreamErrorCode,
  recordServerProductEvent,
} from "../../../lib/product-analytics";
import {
  buildAsrVocabularyPrompt,
  sanitizeAsrUserDictionary,
} from "../../../lib/asr-user-dictionary";

const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPTION_JSON_BYTES = 64 * 1024;
const MAX_TRANSCRIPTION_MULTIPART_BYTES =
  MAX_TRANSCRIPTION_BYTES + 512 * 1024;
const TRANSCRIPTION_REQUEST_TIMEOUT_MS = 45_000;
const TRANSCRIPTION_RETRY_DELAY_MS = 350;

function aiOperationQuotaHeaders(limit: number, remaining: number) {
  const normalizedRemaining = Math.max(0, Math.min(limit, remaining));
  return {
    "X-AI-Operation-Limit": String(limit),
    "X-AI-Operations-Remaining": String(normalizedRemaining),
    // Keep these during the transition so an already-open editor can still
    // display the shared allowance after the server is deployed.
    "X-Narration-Generation-Limit": String(limit),
    "X-Narration-Generations-Remaining": String(normalizedRemaining),
  };
}

function meteredJsonError(
  message: string,
  status: number,
  authorization:
    | Awaited<ReturnType<typeof authorizeMeteredAiOperation>>
    | null,
) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(authorization?.successfulLimit
          ? aiOperationQuotaHeaders(
              authorization.successfulLimit,
              authorization.remaining ?? authorization.successfulLimit,
            )
          : {}),
      },
    },
  );
}

type TranscriptionResponse = {
  duration?: number;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    speaker?: string;
    text?: string;
  }>;
  words?: Array<{
    start?: number;
    end?: number;
    word?: string;
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
      requestId: string | null;
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

function getRawWords(transcription: TranscriptionResponse) {
  return (transcription.words ?? [])
    .map((word) => ({
      start: Number(word.start),
      end: Number(word.end),
      word: word.word?.trim() ?? "",
    }))
    .filter(
      (word): word is RawCaptionWord =>
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start &&
        Boolean(word.word),
    );
}

async function requestTranscription(
  apiKey: string,
  file: File,
  mode: "timed" | "timed-fallback" | "refine",
  requestSignal: AbortSignal,
  asrDictionary: readonly string[] = [],
): Promise<TranscriptionCallResult> {
  const formData = new FormData();
  const isWhisperTimedPrimary = mode === "timed";
  const isDiarizedTimedFallback = mode === "timed-fallback";
  formData.set("file", file, safeFileName(file.name));
  formData.set(
    "model",
    isWhisperTimedPrimary
      ? "whisper-1"
      : isDiarizedTimedFallback
        ? "gpt-4o-transcribe-diarize"
        : "gpt-4o-transcribe",
  );
  formData.set("language", "ja");
  formData.set(
    "response_format",
    isWhisperTimedPrimary
      ? "verbose_json"
      : isDiarizedTimedFallback
        ? "diarized_json"
        : "json",
  );
  formData.set("temperature", "0");
  if (isWhisperTimedPrimary) {
    formData.append("timestamp_granularities[]", "segment");
    formData.append("timestamp_granularities[]", "word");
  }
  if (isDiarizedTimedFallback) {
    formData.set("chunking_strategy", "auto");
  }
  if (!isDiarizedTimedFallback) {
    const prompt = buildAsrVocabularyPrompt(
      mode === "refine" ? HIGH_ACCURACY_PROMPT : null,
      asrDictionary,
    );
    if (prompt) formData.set("prompt", prompt);
  }

  const upstreamAbort = createUpstreamAbortSignal(
    requestSignal,
    TRANSCRIPTION_REQUEST_TIMEOUT_MS,
  );
  let response: Response;

  try {
    response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: upstreamAbort.signal,
      },
    );
  } catch (error) {
    return {
      ok: false,
      status: upstreamAbort.didTimeOut() ? 504 : requestSignal.aborted ? 499 : 502,
      requestId: null,
      error: {
        code: upstreamAbort.didTimeOut()
          ? "request_timeout"
          : requestSignal.aborted
            ? "request_aborted"
            : "request_failed",
        type: "transcription_request_error",
        message:
          error instanceof Error
            ? error.message
            : "The transcription request failed.",
      },
    };
  } finally {
    upstreamAbort.cleanup();
  }

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
    requestId: response.headers.get("x-request-id"),
    transcription: (await response.json()) as TranscriptionResponse,
  };
}

function canUseTimedFallback(
  result: TranscriptionCallResult,
): result is Extract<TranscriptionCallResult, { ok: false }> {
  return !result.ok && result.status >= 500 && result.status <= 599;
}

function shouldRetryTimedPrimary(result: TranscriptionCallResult) {
  if (result.ok) return false;
  if (result.error?.code === "model_error") return false;
  if (result.error?.code === "request_timeout") return false;
  return result.status === 502 || result.status === 503 || result.status === 504;
}

async function requestTimedTranscription(
  apiKey: string,
  file: File,
  requestSignal: AbortSignal,
  asrDictionary: readonly string[] = [],
) {
  let result = await requestTranscription(
    apiKey,
    file,
    "timed",
    requestSignal,
    asrDictionary,
  );

  if (shouldRetryTimedPrimary(result)) {
    await new Promise((resolve) =>
      setTimeout(resolve, TRANSCRIPTION_RETRY_DELAY_MS),
    );
    result = await requestTranscription(
      apiKey,
      file,
      "timed",
      requestSignal,
      asrDictionary,
    );
  }

  if (canUseTimedFallback(result)) {
    console.warn(
      "OpenAI timed transcription fallback activated",
      result.status,
      result.requestId,
      result.error?.code,
      result.error?.type,
    );
    return requestTranscription(
      apiKey,
      file,
      "timed-fallback",
      requestSignal,
      asrDictionary,
    );
  }

  return result;
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
  let meteredAuthorization: AuthorizedMeteredAiOperation | null = null;
  let meteredAuthorizationSettled = false;

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

    const requestContentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";
    const usageEnforcementEnabled = isUsageEnforcementEnabled(request);
    const usagePrincipal = usageEnforcementEnabled
      ? await getUsagePrincipal(request, { allowTrial: true })
      : null;
    if (usageEnforcementEnabled && !usagePrincipal?.currentUser) {
      return jsonError("続けるにはアカウントへのログインが必要です。", 401);
    }

    let file: File | null = null;
    let requestHighAccuracy = false;
    let asrDictionary: string[] = [];
    let usageReservationId = "";
    let aiOperationId = "";
    if (requestContentType.includes("application/json")) {
      let payload: {
        id?: string;
        code?: string;
        quality?: string;
        asrDictionary?: unknown;
        usageReservationId?: string;
        aiOperationId?: string;
      };
      try {
        payload = await parseJsonBodyWithLimit<typeof payload>(
          request,
          MAX_TRANSCRIPTION_JSON_BYTES,
        );
      } catch (error) {
        return jsonError(
          error instanceof RequestBodyTooLargeError
            ? "送信データが大きすぎます。"
            : "字幕生成用の動画情報を読み取れませんでした。",
          error instanceof RequestBodyTooLargeError ? 413 : 400,
        );
      }
      requestHighAccuracy = payload.quality === "high";
      asrDictionary = sanitizeAsrUserDictionary(payload.asrDictionary);
      usageReservationId = payload.usageReservationId?.trim() ?? "";
      aiOperationId = payload.aiOperationId?.trim() ?? "";
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

      const { currentUser: transferPrincipal } = await getUsagePrincipal(
        request,
        { allowTrial: true },
      );
      const authenticatedEmail = transferPrincipal?.email ?? "";
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
      let requestData: FormData;
      try {
        requestData = await parseFormDataBodyWithLimit(
          request,
          MAX_TRANSCRIPTION_MULTIPART_BYTES,
        );
      } catch (error) {
        return jsonError(
          error instanceof RequestBodyTooLargeError
            ? "字幕生成用の動画は25MBまでです。動画を短くするか圧縮してください。"
            : "動画の送信内容を読み取れませんでした。",
          error instanceof RequestBodyTooLargeError ? 413 : 400,
        );
      }
      const uploadedFile = requestData.get("file");
      requestHighAccuracy = requestData.get("quality") === "high";
      asrDictionary = sanitizeAsrUserDictionary(
        requestData.get("asrDictionary"),
      );
      usageReservationId = String(
        requestData.get("usageReservationId") ?? "",
      ).trim();
      aiOperationId = String(requestData.get("aiOperationId") ?? "").trim();
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

    if (usageEnforcementEnabled) {
      const currentUser = usagePrincipal?.currentUser ?? null;
      if (!currentUser) {
        return jsonError("続けるにはアカウントへのログインが必要です。", 401);
      }
      const authorization = usageReservationId
        ? await authorizeMeteredAiOperation(
            currentUser,
            usageReservationId,
            "transcribe",
            aiOperationId || crypto.randomUUID(),
            { continuationMode: "transcription_chunk" },
          )
        : null;
      if (!authorization?.allowed) {
        if (authorization?.reason === "operation_in_progress") {
          return meteredJsonError(
            "この動画の音声認識はすでに処理中です。完了するまで少しお待ちください。",
            409,
            authorization,
          );
        }
        const quotaReached =
          authorization?.reason === "operator_success_limit" ||
          authorization?.reason === "entitlement_ai_limit" ||
          authorization?.reason === "operator_operation_limit" ||
          authorization?.reason === "action_attempt_limit";
        if (quotaReached) {
          return meteredJsonError(
            authorization?.reason === "entitlement_ai_limit"
              ? "この料金プラン・購入枠・無料体験で利用できるAI処理回数に達しました。現在の編集内容はそのまま利用できます。"
              : authorization?.reason === "operator_success_limit"
              ? `この動画で利用できるAI処理の上限（${authorization.successfulLimit}回）に達しました。現在の編集内容はそのまま利用できます。`
              : "この動画でのAI処理回数が安全上限に達しました。新しい動画としてやり直してください。",
            429,
            authorization,
          );
        }
        if (
          authorization?.reason === "action_conflict" ||
          authorization?.reason === "action_failed" ||
          authorization?.reason === "action_expired" ||
          authorization?.reason === "action_already_succeeded"
        ) {
          return meteredJsonError(
            "このAI処理を再開できませんでした。もう一度操作してください。",
            409,
            authorization,
          );
        }
        return meteredJsonError(
          authorization?.reason === "ai_action_capacity" ||
            authorization?.reason === "entitlement_ai_capacity"
            ? authorization?.reason === "entitlement_ai_capacity"
              ? "この料金プラン・購入枠・無料体験のAI処理が別の動画で進行中です。完了してからもう一度お試しください。"
              : "別のAI処理が進行中です。完了してからもう一度お試しください。"
            : "利用枠を確認できませんでした。動画を選び直してください。",
          authorization?.reason === "ai_action_capacity" ||
            authorization?.reason === "entitlement_ai_capacity"
            ? 409
            : 402,
          authorization,
        );
      }
      meteredAuthorization = authorization;
    }

    const timedResult = await requestTimedTranscription(
      apiKey,
      file,
      request.signal,
      asrDictionary,
    );
    if (!timedResult.ok) {
      console.error(
        "OpenAI transcription failed",
        timedResult.status,
        timedResult.requestId,
        timedResult.error?.code,
        timedResult.error?.type,
      );
      await recordServerProductEvent(request, "ai_operation_failed", {
        operation: "transcribe",
        outcome: "failed",
        error_code: productUpstreamErrorCode(timedResult.status),
      });
      return jsonError(
        transcriptionError(timedResult.status, timedResult.error),
        timedResult.status,
      );
    }

    const transcription = timedResult.transcription;
    let transcriptionText = transcription.text?.trim() ?? "";
    const transcriptionDuration = Number(transcription.duration);
    const rawWords = getRawWords(transcription);
    let rawSegments = getRawSegments(transcription);
    if (meteredAuthorization) {
      const observedDuration = Math.max(
        Number.isFinite(transcriptionDuration) && transcriptionDuration > 0
          ? transcriptionDuration
          : 0,
        ...rawSegments.map((segment) => segment.end),
        ...rawWords.map((word) => word.end),
      );
      const observedUsage = await recordMeteredAiTranscriptionDuration(
        meteredAuthorization.action,
        meteredAuthorization.lease,
        observedDuration,
      );
      if (!observedUsage.allowed) {
        return meteredJsonError(
          observedUsage.reason === "duration_exceeded"
            ? "動画の実際の長さが確保した利用枠を超えています。動画を選び直して、もう一度お試しください。"
            : "音声の長さを安全に確認できませんでした。動画を選び直して、もう一度お試しください。",
          observedUsage.reason === "duration_exceeded" ? 402 : 502,
          meteredAuthorization,
        );
      }
    }
    const qualityReasons = getTranscriptionQualityReasons(transcriptionText);
    const shouldRefine =
      requestHighAccuracy ||
      (transcriptionText.length > 0 && qualityReasons.length > 0);
    let refined = false;

    if (shouldRefine) {
      const refineResult = await requestTranscription(
        apiKey,
        file,
        "refine",
        request.signal,
        asrDictionary,
      );
      if (refineResult.ok) {
        const refinedText = refineResult.transcription.text?.trim() ?? "";
        const refinedTextIsComplete =
          isRefinedTranscriptComplete(refinedText, rawSegments) &&
          getTranscriptionQualityReasons(refinedText).length === 0;
        if (refinedText && refinedTextIsComplete) {
          rawSegments = alignRefinedTextToSegments(refinedText, rawSegments);
          transcriptionText = refinedText;
          refined = true;
        } else if (refinedText) {
          console.warn(
            "OpenAI high-accuracy transcription ignored incomplete result",
            refineResult.requestId,
          );
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

    const segments = rawWords.length > 0 && !refined
      ? buildCaptionSegmentsFromWords(rawWords, 14)
      : attachCaptionWordTimings(
          buildCaptionSegments(rawSegments, 14),
          rawWords,
        );

    let completedQuotaHeaders: Record<string, string> = {};
    if (meteredAuthorization) {
      const completion = await completeMeteredAiOperation(
        meteredAuthorization,
      );
      meteredAuthorizationSettled = true;
      if (!completion.completed) {
        return meteredJsonError(
          "利用記録を確定できませんでした。もう一度お試しください。",
          500,
          meteredAuthorization,
        );
      }
      completedQuotaHeaders = aiOperationQuotaHeaders(
        meteredAuthorization.successfulLimit,
        completion.remaining,
      );
    }

    await recordServerProductEvent(request, "ai_operation_succeeded", {
      operation: "transcribe",
      outcome: segments.length === 0 ? "silent" : "completed",
      duration_bucket: productDurationBucket(transcriptionDuration),
    });
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
            ...completedQuotaHeaders,
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
        words: rawWords,
        segments,
        refined,
        refinementReason: refined
          ? requestHighAccuracy
            ? "requested"
            : qualityReasons[0]
          : undefined,
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
          ...completedQuotaHeaders,
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
    if (meteredAuthorization && !meteredAuthorizationSettled) {
      await abandonMeteredAiOperation(meteredAuthorization).catch(
        (cleanupError) => {
          console.error("transcription usage cleanup failed", cleanupError);
        },
      );
    }
    if (temporaryTransfer) {
      await removeTransfer(temporaryTransfer).catch((cleanupError) => {
        console.error("temporary transcription upload cleanup failed", cleanupError);
      });
    }
  }
}
