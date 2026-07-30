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
    speed: 1.02,
    instructions:
      "自然な日本語で、明るく親しみやすく。広告の読み上げにせず、友人へ話すように。文の切れ目に短い間を入れる。",
  },
  calm: {
    voice: "marin",
    fallbackVoice: "shimmer",
    speed: 0.94,
    instructions:
      "自然な日本語で、やさしく落ち着いた声。急がず、情景が伝わる余韻を作る。抑揚は控えめだが単調にしない。",
  },
  tempo: {
    voice: "cedar",
    fallbackVoice: "alloy",
    speed: 1.08,
    instructions:
      "自然な日本語で、軽快で歯切れよく。冒頭に勢いを出し、短文ごとにリズムを変える。過剰に煽らない。",
  },
  refined: {
    voice: "sage",
    fallbackVoice: "onyx",
    speed: 0.98,
    instructions:
      "自然な日本語で、上品で洗練された声。低めのテンションで信頼感を出し、語尾まで明瞭に読む。",
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
      (response.status === 400 || response.status === 404) &&
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
