import { env } from "cloudflare:workers";
import { authorizeUsageOperation } from "../../../../lib/billing-store";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import {
  isNarrationStyle,
  type NarrationStyle,
} from "../../../../lib/narration";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";

const DELIVERY_GUARD =
  "台本にない語句、相づち、笑い声、効果音を追加せず、台本の語句を省略しない。";

const VOICE_SETTINGS: Record<
  NarrationStyle,
  { voice: string; fallbackVoice: string; speed: number; instructions: string }
> = {
  bright: {
    voice: "coral",
    fallbackVoice: "nova",
    speed: 1,
    instructions:
      "自然な日本語を、飾りすぎない聞き取りやすい女性の声で読む。落ち着いた明るさと日常会話の距離感を保ち、広告調、作り声、過度な演技を避ける。固有名詞は明瞭に、文の切れ目には自然な短い間を置く。",
  },
  calm: {
    voice: "cedar",
    fallbackVoice: "echo",
    speed: 0.99,
    instructions:
      "自然な日本語を、飾りすぎない聞き取りやすい男性の声で読む。穏やかな中低音と日常会話の距離感を保ち、ナレーター然とした誇張や過度な低音演技を避ける。固有名詞は明瞭に、文の切れ目には自然な短い間を置く。",
  },
  tempo: {
    voice: "nova",
    fallbackVoice: "shimmer",
    speed: 1.06,
    instructions:
      "自然な日本語で、明るく高めの萌えアニメキャラクター風。小さな驚きや喜びを大きく表現し、語尾を軽く跳ねさせ、短い文ごとに表情を切り替える。可愛らしいキャラ声にするが甲高く潰さず、幼児の声にはせず、固有名詞を明瞭に読む。実在する声優やキャラクターは模倣しない。",
  },
  refined: {
    voice: "onyx",
    fallbackVoice: "onyx",
    speed: 0.97,
    instructions:
      "自然な日本語で、深く重厚な低音。静かな説得力のあるドキュメンタリー調で、声量を上げずに言葉を立たせる。映画予告のように誇張せず、低い重心と長めの余韻を保つ。",
  },
  comedy: {
    voice: "fable",
    fallbackVoice: "fable",
    speed: 1.02,
    instructions:
      "熱量の高い関西芸人のツッコミ役のように読む。状況説明は標準語または薄い関西弁で妙に真剣に入り、短いツッコミだけ一段強い自然な関西弁で鋭く跳ね、オチの後は急に脱力する。声量・高低・間を大胆に変えるが、叫び続けたり単語を潰したりせず、固有名詞は明瞭に読む。台本の標準語を勝手に関西弁へ変えず、実在する芸人は模倣しない。",
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
            instructions: `${settings.instructions}${DELIVERY_GUARD}`,
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

  if (isUsageEnforcementEnabled()) {
    const { currentUser } = await getUsagePrincipal(request, {
      allowTrial: true,
    });
    const reservationId =
      typeof payload.usageReservationId === "string"
        ? payload.usageReservationId
        : "";
    const authorization =
      currentUser && reservationId
        ? await authorizeUsageOperation(
            currentUser,
            reservationId,
            "narration_speech",
          )
        : null;
    if (!authorization?.allowed) {
      return Response.json(
        {
          error:
            authorization?.reason === "operator_operation_limit"
              ? "この動画でのAI音声生成回数が安全上限に達しました。新しい動画としてやり直してください。"
              : "利用枠を確認できませんでした。動画を選び直してください。",
        },
        {
          status:
            authorization?.reason === "operator_operation_limit"
              ? 429
              : currentUser
                ? 402
                : 401,
        },
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
