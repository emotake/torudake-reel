import { env } from "cloudflare:workers";
import { findOwnedUsageReservation } from "../../../../lib/billing-store";
import { getCurrentUser } from "../../../../lib/current-user";
import {
  isNarrationStyle,
  type NarrationStyle,
} from "../../../../lib/narration";
import { isBillingConfigured } from "../../../../lib/stripe";

const VOICE_SETTINGS: Record<
  NarrationStyle,
  { voice: string; fallbackVoice: string; speed: number; instructions: string }
> = {
  bright: {
    voice: "coral",
    fallbackVoice: "nova",
    speed: 1,
    instructions:
      "自然な日本語で、明るい中高域の声。笑顔が伝わるように弾ませ、親しい人へ話す距離感で読む。広告調や甲高い作り声にせず、語尾は軽やかに、文の切れ目には自然な短い間を置く。",
  },
  calm: {
    voice: "marin",
    fallbackVoice: "shimmer",
    speed: 0.98,
    instructions:
      "自然な日本語で、息づかいを感じる柔らかな声。聞き手のすぐ近くで物語るように、急がず静かな抑揚をつける。大切な言葉の前後に間を置き、語尾はやさしく余韻を残す。",
  },
  tempo: {
    voice: "cedar",
    fallbackVoice: "alloy",
    speed: 1.04,
    instructions:
      "自然な日本語で、芯のあるクリアな中低音。子音を明瞭にして短文を歯切れよく刻み、冒頭は一段強く引きつける。早口や煽り口調にはせず、要点ごとにリズムを切り替える。",
  },
  refined: {
    voice: "onyx",
    fallbackVoice: "sage",
    speed: 0.97,
    instructions:
      "自然な日本語で、深く重厚な低音。静かな説得力のあるドキュメンタリー調で、声量を上げずに言葉を立たせる。映画予告のように誇張せず、低い重心と長めの余韻を保つ。",
  },
};

type OpenAIError = {
  error?: { code?: string; type?: string; message?: string };
};

async function requestSpeech(
  apiKey: string,
  script: string,
  style: NarrationStyle,
  fallback = false,
) {
  const settings = VOICE_SETTINGS[style];
  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      fallback
        ? {
            model: "tts-1-hd",
            input: script,
            voice: settings.fallbackVoice,
            response_format: "mp3",
            speed: settings.speed,
          }
        : {
            model: "gpt-4o-mini-tts",
            input: script,
            voice: settings.voice,
            response_format: "mp3",
            speed: settings.speed,
            instructions: settings.instructions,
          },
    ),
  });
}

function speechError(status: number, payload: OpenAIError) {
  const detail = `${payload.error?.code ?? ""} ${payload.error?.message ?? ""}`;
  if (status === 429 && /quota|billing|credit/i.test(detail)) {
    return "AI音声のAPI利用枠が不足しています。OpenAI APIのクレジットをご確認ください。";
  }
  if (status === 429) {
    return "AI音声の生成が混み合っています。少し待ってからもう一度お試しください。";
  }
  return "AI音声を生成できませんでした。もう一度お試しください。";
}

export async function POST(request: Request) {
  const apiKey =
    typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (!apiKey) {
    return Response.json(
      { error: "AIナレーションのAPI設定が完了していません。" },
      { status: 503 },
    );
  }

  let payload: {
    script?: unknown;
    style?: unknown;
    usageReservationId?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return Response.json({ error: "台本を読み取れませんでした。" }, { status: 400 });
  }

  const script =
    typeof payload.script === "string"
      ? payload.script.replace(/\s+/g, " ").trim()
      : "";
  if (!script || script.length > 2_000 || !isNarrationStyle(payload.style)) {
    return Response.json(
      { error: "台本は1〜2,000文字で入力してください。" },
      { status: 400 },
    );
  }

  if (isBillingConfigured()) {
    const currentUser = getCurrentUser(request, { allowTrial: true });
    const reservationId =
      typeof payload.usageReservationId === "string"
        ? payload.usageReservationId
        : "";
    if (
      !currentUser ||
      !reservationId ||
      !(await findOwnedUsageReservation(currentUser, reservationId))
    ) {
      return Response.json(
        { error: "利用枠を確認できませんでした。動画を選び直してください。" },
        { status: currentUser ? 402 : 401 },
      );
    }
  }

  let response = await requestSpeech(apiKey, script, payload.style);
  let fallbackModel = false;
  if (!response.ok) {
    const firstError = (await response.clone().json().catch(() => ({}))) as OpenAIError;
    const detail = `${firstError.error?.code ?? ""} ${firstError.error?.type ?? ""} ${firstError.error?.message ?? ""}`;
    if (
      (response.status === 400 ||
        response.status === 404 ||
        response.status === 410) &&
      /model|voice|deprecated|not.found/i.test(detail)
    ) {
      response = await requestSpeech(apiKey, script, payload.style, true);
      fallbackModel = true;
    }
  }

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({}))) as OpenAIError;
    console.error(
      "OpenAI narration speech failed",
      response.status,
      response.headers.get("x-request-id"),
      errorPayload.error?.code,
      errorPayload.error?.type,
    );
    return Response.json(
      { error: speechError(response.status, errorPayload) },
      { status: response.status },
    );
  }

  const audio = await response.arrayBuffer();
  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, no-store",
      "X-Narration-Model": fallbackModel ? "tts-1-hd" : "gpt-4o-mini-tts",
    },
  });
}
