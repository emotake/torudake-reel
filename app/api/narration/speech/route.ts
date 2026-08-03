import { env } from "cloudflare:workers";
import { authorizeUsageOperation } from "../../../../lib/billing-store";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { markOperatorUsageOperationSucceeded } from "../../../../lib/operator-usage";
import {
  isNarrationStyle,
  type NarrationStyle,
} from "../../../../lib/narration";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";
import { narrationScriptCharacterLimit } from "../../../../lib/usage-duration";

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
      "自然な日本語を、明るく弾む成人のポップボイスで読む。やや高めの音域だが甲高くせず、小さな驚きや喜びを表情豊かに表現する。語尾は軽く、短文ごとに緩急をつける。幼児の声にせず、固有名詞は明瞭に読む。実在する人物、声優、作品、キャラクターは模倣しない。",
  },
  refined: {
    voice: "onyx",
    fallbackVoice: "onyx",
    speed: 0.97,
    instructions:
      "自然な日本語で、深く重厚な低音。静かな説得力のあるドキュメンタリー調で、声量を上げずに言葉を立たせる。映画予告のように誇張せず、低い重心と長めの余韻を保つ。",
  },
  comedy: {
    voice: "ash",
    fallbackVoice: "fable",
    speed: 1.04,
    instructions:
      "明るくエネルギッシュな成人のオリジナル話者として読む。中高域を中心に、歯切れのよいテンポと大きめの抑揚をつける。状況説明は真剣に、一拍置いて短い返しを強く、オチの後は少し力を抜く。関西イントネーションは自然かつ控えめに使う。叫び続けず、単語を潰さず、固有名詞を明瞭に読む。特定の実在人物の声質、話速、笑い方、口癖、決め台詞、間合いを模倣しない。",
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

  let authorizedReservationId: string | null = null;
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
    if (
      script.length >
      narrationScriptCharacterLimit(
        authorization.reservation.sourceDurationSeconds,
      )
    ) {
      return Response.json(
        {
          error:
            "ナレーション原稿が動画の長さに対して長すぎます。原稿を短くして、もう一度お試しください。",
        },
        { status: 400 },
      );
    }
    authorizedReservationId = authorization.reservation.id;
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
  if (
    authorizedReservationId &&
    !(await markOperatorUsageOperationSucceeded(
      authorizedReservationId,
      "narration_speech",
    ))
  ) {
    return Response.json(
      { error: "利用記録を確定できませんでした。もう一度お試しください。" },
      { status: 500 },
    );
  }
  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, no-store",
      "X-Narration-Model": fallbackModel ? "tts-1-hd" : "gpt-4o-mini-tts",
    },
  });
}
