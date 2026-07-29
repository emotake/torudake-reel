import { env } from "cloudflare:workers";
import { buildCaptionSegments, type RawCaptionSegment } from "../../../lib/captions";
import {
  findTransfer,
  getMediaBucket,
  isSupportedVideo,
  jsonError,
  removeTransfer,
  safeFileName,
} from "../../../lib/transfers";

const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

type WhisperResponse = {
  duration?: number;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
  text?: string;
};

function transcriptionError(status: number) {
  if (status === 401 || status === 403) {
    return "音声認識の認証設定を確認してください。";
  }
  if (status === 413) {
    return "動画が音声認識サービスの上限を超えています。";
  }
  if (status === 429) {
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
    const requestContentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";

    if (requestContentType.includes("application/json")) {
      const payload = (await request.json()) as {
        id?: string;
        code?: string;
      };
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
    if (!isSupportedVideo(file.name, file.type || "video/mp4")) {
      return jsonError("MP4・MOV・M4V・WebMの動画を選んでください。");
    }

    const formData = new FormData();
    formData.set("file", file, safeFileName(file.name));
    formData.set("model", "whisper-1");
    formData.set("language", "ja");
    formData.set("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");
    formData.set(
      "prompt",
      "撮るだけリール。自然な日本語の句読点を使い、固有名詞と話し言葉を正確に文字起こししてください。",
    );

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
      console.error(
        "OpenAI transcription failed",
        response.status,
        response.headers.get("x-request-id"),
      );
      return jsonError(transcriptionError(response.status), response.status);
    }

    const transcription = (await response.json()) as WhisperResponse;
    const rawSegments: RawCaptionSegment[] = (transcription.segments ?? [])
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
    const segments = buildCaptionSegments(rawSegments);

    if (segments.length === 0) {
      return jsonError(
        "音声を字幕にできませんでした。声が聞こえる動画でお試しください。",
        422,
      );
    }

    return Response.json(
      {
        text: transcription.text?.trim() ?? "",
        language: transcription.language ?? "ja",
        duration:
          Number(transcription.duration) || segments.at(-1)?.end || 0,
        segments,
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
