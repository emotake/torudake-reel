import { env } from "cloudflare:workers";
import {
  authorizeLeasedUsageOperation,
  findOwnedUsageReservation,
} from "../../../../lib/billing-store";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import {
  consumeOperatorUsageOperation,
  markOperatorUsageOperationSucceeded,
  releaseUsageOperationLease,
  type UsageOperationLease,
} from "../../../../lib/operator-usage";
import {
  isNarrationStyle,
  NARRATION_SPEECH_SUCCESS_LIMIT,
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

function generationQuotaHeaders(remaining: number) {
  return {
    "X-Narration-Generation-Limit": String(NARRATION_SPEECH_SUCCESS_LIMIT),
    "X-Narration-Generations-Remaining": String(
      Math.max(0, Math.min(NARRATION_SPEECH_SUCCESS_LIMIT, remaining)),
    ),
  };
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
    targetDurationSeconds?: unknown;
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
  const requestedTargetDuration = Number(payload.targetDurationSeconds);
  const targetDurationSeconds =
    Number.isFinite(requestedTargetDuration) && requestedTargetDuration > 0
      ? Math.min(90, requestedTargetDuration)
      : 90;
  if (!script || script.length > 2_000 || !isNarrationStyle(payload.style)) {
    return Response.json(
      { error: "台本は1〜2,000文字で入力してください。" },
      { status: 400 },
    );
  }

  let authorizedReservationId: string | null = null;
  let narrationLease: UsageOperationLease | null = null;
  let successfulGenerationsBefore = 0;
  if (isUsageEnforcementEnabled()) {
    const { currentUser } = await getUsagePrincipal(request, {
      allowTrial: true,
    });
    const reservationId =
      typeof payload.usageReservationId === "string"
        ? payload.usageReservationId
        : "";
    if (!currentUser || !reservationId) {
      return Response.json(
        {
          error: "利用枠を確認できませんでした。動画を選び直してください。",
        },
        { status: currentUser ? 402 : 401 },
      );
    }
    const reservation = await findOwnedUsageReservation(
      currentUser,
      reservationId,
    );
    if (!reservation) {
      return Response.json(
        {
          error: "利用枠を確認できませんでした。動画を選び直してください。",
        },
        { status: 402 },
      );
    }
    if (
      script.length >
      narrationScriptCharacterLimit(
        Math.min(reservation.sourceDurationSeconds, targetDurationSeconds, 90),
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
    const authorization = await authorizeLeasedUsageOperation(
      currentUser,
      reservationId,
      "narration_speech",
      { successfulLimit: NARRATION_SPEECH_SUCCESS_LIMIT },
    );
    if (!authorization?.allowed) {
      const hitGenerationLimit =
        authorization?.reason === "operator_success_limit";
      const hitAttemptLimit =
        authorization?.reason === "operator_operation_limit";
      const alreadyProcessing =
        authorization?.reason === "operation_in_progress";
      return Response.json(
        {
          error: hitGenerationLimit
            ? `この動画で作成できるAI音声の上限（${NARRATION_SPEECH_SUCCESS_LIMIT}回）に達しました。現在の音声で仕上げるか、新しい動画として開始してください。`
            : hitAttemptLimit
              ? "この動画でのAI音声生成回数が安全上限に達しました。現在の音声で仕上げるか、新しい動画として開始してください。"
              : alreadyProcessing
                ? "この動画のAI音声はすでに生成中です。完了するまで少しお待ちください。"
                : "利用枠を確認できませんでした。動画を選び直してください。",
        },
        {
          status: hitGenerationLimit || hitAttemptLimit
            ? 429
            : alreadyProcessing
              ? 409
              : 402,
          headers:
            hitGenerationLimit || hitAttemptLimit
              ? generationQuotaHeaders(0)
              : undefined,
        },
      );
    }
    authorizedReservationId = authorization.reservation.id;
    narrationLease = authorization.lease;
    successfulGenerationsBefore = authorization.successfulCount;
  }

  try {
    let response = await requestSpeech(apiKey, script, payload.style);
    let fallbackModel = false;
    if (!response.ok) {
      const firstError = (await response
        .clone()
        .json()
        .catch(() => ({}))) as OpenAIError;
      const detail = `${firstError.error?.code ?? ""} ${firstError.error?.type ?? ""} ${firstError.error?.message ?? ""}`;
      if (
        (response.status === 400 ||
          response.status === 404 ||
          response.status === 410) &&
        /model|voice|deprecated|not.found/i.test(detail)
      ) {
        if (
          authorizedReservationId &&
          !(await consumeOperatorUsageOperation(
            authorizedReservationId,
            "narration_speech",
          ))
        ) {
          return Response.json(
            {
              error:
                "この動画でのAI音声生成回数が安全上限に達しました。現在の音声で仕上げるか、新しい動画として開始してください。",
            },
            {
              status: 429,
              headers: generationQuotaHeaders(0),
            },
          );
        }
        response = await requestSpeech(apiKey, script, payload.style, true);
        fallbackModel = true;
      }
    }

    if (!response.ok) {
      const errorPayload = (await response
        .json()
        .catch(() => ({}))) as OpenAIError;
      console.error(
        "OpenAI narration speech failed",
        response.status,
        response.headers.get("x-request-id"),
        errorPayload.error?.code,
        errorPayload.error?.type,
      );
      return Response.json(
        { error: speechError(response.status, errorPayload) },
        {
          status: response.status,
          headers: authorizedReservationId
            ? generationQuotaHeaders(
                NARRATION_SPEECH_SUCCESS_LIMIT - successfulGenerationsBefore,
              )
            : undefined,
        },
      );
    }

    const audio = await response.arrayBuffer();
    if (!audio.byteLength) {
      return Response.json(
        { error: "AI音声を生成できませんでした。もう一度お試しください。" },
        {
          status: 502,
          headers: authorizedReservationId
            ? generationQuotaHeaders(
                NARRATION_SPEECH_SUCCESS_LIMIT - successfulGenerationsBefore,
              )
            : undefined,
        },
      );
    }
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
        ...(authorizedReservationId
          ? generationQuotaHeaders(
              NARRATION_SPEECH_SUCCESS_LIMIT -
                successfulGenerationsBefore -
                1,
            )
          : {}),
      },
    });
  } finally {
    if (narrationLease) {
      await releaseUsageOperationLease(narrationLease).catch(() => undefined);
    }
  }
}
