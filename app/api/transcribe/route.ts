import { env } from "cloudflare:workers";
import { buildCaptionSegments, type RawCaptionSegment } from "../../../lib/captions";
import { isSupportedVideo, jsonError, safeFileName } from "../../../lib/transfers";

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

    const requestData = await request.formData();
    const file = requestData.get("file");

    if (!(file instanceof File) || file.size <= 0) {
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
  }
}
