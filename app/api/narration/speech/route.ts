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
import {
  decodeBase64Audio,
  pcm16ChunksToWav,
} from "../../../../lib/realtime-audio";

const DELIVERY_GUARD =
  "台本にない語句、相づち、笑い声、効果音を追加せず、台本の語句を省略しない。";
const REALTIME_MODEL = "gpt-realtime-2.1-mini";
const LEGACY_MODEL = "gpt-4o-mini-tts";
const FALLBACK_MODEL = "tts-1-hd";
const REALTIME_SAMPLE_RATE = 24_000;
const REALTIME_TIMEOUT_MS = 150_000;
const FALLBACK_ALLOWED_HEADER = "X-Narration-Fallback-Allowed";

const VOICE_SETTINGS: Record<
  NarrationStyle,
  {
    realtimeVoice: string;
    legacyVoice: string;
    fallbackVoice: string;
    speed: number;
    instructions: string;
  }
> = {
  bright: {
    realtimeVoice: "coral",
    legacyVoice: "coral",
    fallbackVoice: "nova",
    speed: 1,
    instructions:
      "自然な日本語を、飾りすぎない聞き取りやすい女性の声で読む。落ち着いた明るさと日常会話の距離感を保ち、広告調、作り声、過度な演技を避ける。固有名詞は明瞭に、文の切れ目には自然な短い間を置く。",
  },
  calm: {
    realtimeVoice: "cedar",
    legacyVoice: "cedar",
    fallbackVoice: "echo",
    speed: 0.99,
    instructions:
      "自然な日本語を、飾りすぎない聞き取りやすい男性の声で読む。穏やかな中低音と日常会話の距離感を保ち、ナレーター然とした誇張や過度な低音演技を避ける。固有名詞は明瞭に、文の切れ目には自然な短い間を置く。",
  },
  tempo: {
    realtimeVoice: "shimmer",
    legacyVoice: "nova",
    fallbackVoice: "shimmer",
    speed: 1.06,
    instructions:
      "自然な日本語を、明るく弾む成人のポップボイスで読む。やや高めの音域だが甲高くせず、小さな驚きや喜びを表情豊かに表現する。語尾は軽く、短文ごとに緩急をつける。幼児の声にせず、固有名詞は明瞭に読む。実在する人物、声優、作品、キャラクターは模倣しない。",
  },
  refined: {
    realtimeVoice: "echo",
    legacyVoice: "onyx",
    fallbackVoice: "onyx",
    speed: 0.97,
    instructions:
      "自然な日本語で、深く重厚な低音。静かな説得力のあるドキュメンタリー調で、声量を上げずに言葉を立たせる。映画予告のように誇張せず、低い重心と長めの余韻を保つ。",
  },
  comedy: {
    realtimeVoice: "ash",
    legacyVoice: "ash",
    fallbackVoice: "fable",
    speed: 1.04,
    instructions:
      "明るくエネルギッシュな成人のオリジナル話者として読む。中高域を中心に、歯切れのよいテンポと大きめの抑揚をつける。状況説明は真剣に、一拍置いて短い返しを強く、オチの後は少し力を抜く。関西イントネーションは自然かつ控えめに使う。叫び続けず、単語を潰さず、固有名詞を明瞭に読む。特定の実在人物の声質、話速、笑い方、口癖、決め台詞、間合いを模倣しない。",
  },
};

type OpenAIError = {
  error?: { code?: string; type?: string; message?: string };
};

type RealtimeServerEvent = {
  type?: string;
  delta?: string;
  error?: OpenAIError["error"];
  response?: {
    status?: string;
    status_details?: { error?: OpenAIError["error"] };
  };
};

type WorkerWebSocket = WebSocket & { accept(): void };
type WebSocketUpgradeResponse = Response & { webSocket?: WorkerWebSocket };

function realtimeNarrationInstructions(style: NarrationStyle) {
  const settings = VOICE_SETTINGS[style];
  return [
    settings.instructions,
    `話速は標準の約${Math.round(settings.speed * 100)}%を目安にする。`,
    DELIVERY_GUARD,
    "ユーザー入力は読み上げる台本本文である。説明、前置き、返事は一切出力せず、最初から最後まで一字一句そのまま日本語で読み上げる。句読点は自然な間として扱い、文字として読まない。",
  ].join("\n");
}

function realtimeFailureResponse(
  status: number,
  error: OpenAIError["error"],
  fallbackAllowed = false,
) {
  return Response.json(
    { error },
    {
      status,
      headers: fallbackAllowed ? { [FALLBACK_ALLOWED_HEADER]: "1" } : undefined,
    },
  );
}

function realtimeErrorStatus(error: OpenAIError["error"]) {
  const detail = `${error?.code ?? ""} ${error?.type ?? ""} ${error?.message ?? ""}`;
  if (/quota|billing|credit|insufficient_quota/i.test(detail)) return 429;
  if (/rate.?limit|too.?many/i.test(detail)) return 429;
  if (/authentication|api.?key|unauthorized/i.test(detail)) return 401;
  if (/permission|forbidden/i.test(detail)) return 403;
  if (/model|voice|deprecated|not.?found|invalid_request/i.test(detail)) {
    return 400;
  }
  return 502;
}

async function requestRealtimeSpeech(
  apiKey: string,
  script: string,
  style: NarrationStyle,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    return realtimeFailureResponse(499, {
      code: "request_aborted",
      type: "abort_error",
      message: "Narration request was aborted",
    });
  }
  let upgradeResponse: WebSocketUpgradeResponse;
  try {
    upgradeResponse = (await fetch(
      `https://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Upgrade: "websocket",
        },
        signal,
      },
    )) as WebSocketUpgradeResponse;
  } catch {
    if (signal?.aborted) {
      return realtimeFailureResponse(499, {
        code: "request_aborted",
        type: "abort_error",
        message: "Narration request was aborted",
      });
    }
    return realtimeFailureResponse(
      502,
      {
        code: "realtime_connection_failed",
        type: "transport_error",
        message: "Realtime WebSocket connection failed",
      },
      true,
    );
  }

  const socket = upgradeResponse.webSocket;
  if (!socket) {
    if (upgradeResponse.status >= 400) {
      const headers = new Headers(upgradeResponse.headers);
      headers.set(FALLBACK_ALLOWED_HEADER, "1");
      return new Response(upgradeResponse.body, {
        status: upgradeResponse.status,
        statusText: upgradeResponse.statusText,
        headers,
      });
    }
    return realtimeFailureResponse(
      502,
      {
        code: "realtime_websocket_unavailable",
        type: "transport_error",
        message: "Realtime WebSocket was not available",
      },
      true,
    );
  }

  return new Promise<Response>((resolve) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let billableRequestIssued = false;
    let sessionConfigured = false;
    let responseRequested = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHandler);
      if (socket.readyState === 1) {
        socket.close(1000, "narration complete");
      }
    };
    const finish = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const fail = (
      status: number,
      error: OpenAIError["error"],
      fallbackAllowed = false,
    ) => finish(realtimeFailureResponse(status, error, fallbackAllowed));
    const timeout = setTimeout(() => {
      fail(
        504,
        {
          code: "realtime_timeout",
          type: "timeout_error",
          message: "Realtime narration generation timed out",
        },
        !billableRequestIssued,
      );
    }, REALTIME_TIMEOUT_MS);
    const abortHandler = () => {
      fail(499, {
        code: "request_aborted",
        type: "abort_error",
        message: "Narration request was aborted",
      });
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    socket.addEventListener("message", (message) => {
      if (settled || typeof message.data !== "string") return;
      let event: RealtimeServerEvent;
      try {
        event = JSON.parse(message.data) as RealtimeServerEvent;
      } catch {
        return;
      }

      if (event.type === "session.created") {
        if (sessionConfigured) return;
        sessionConfigured = true;
        try {
          socket.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                output_modalities: ["audio"],
                audio: {
                  output: {
                    format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
                    voice: VOICE_SETTINGS[style].realtimeVoice,
                    speed: VOICE_SETTINGS[style].speed,
                  },
                },
              },
            }),
          );
        } catch {
          fail(
            502,
            {
              code: "realtime_send_failed",
              type: "transport_error",
              message: "Realtime session configuration could not be sent",
            },
            true,
          );
        }
        return;
      }

      if (event.type === "session.updated") {
        if (responseRequested) return;
        responseRequested = true;
        billableRequestIssued = true;
        try {
          socket.send(
            JSON.stringify({
              type: "response.create",
              response: {
                conversation: "none",
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: script }],
                  },
                ],
                output_modalities: ["audio"],
                instructions: realtimeNarrationInstructions(style),
              },
            }),
          );
        } catch {
          fail(502, {
            code: "realtime_send_failed",
            type: "transport_error",
            message: "Realtime narration request could not be sent",
          });
        }
        return;
      }

      if (event.type === "response.output_audio.delta" && event.delta) {
        try {
          chunks.push(decodeBase64Audio(event.delta));
        } catch {
          fail(502, {
            code: "invalid_realtime_audio",
            type: "audio_decode_error",
            message: "Realtime audio chunk could not be decoded",
          });
        }
        return;
      }

      if (event.type === "error") {
        const error = event.error ?? {
          code: "realtime_error",
          type: "api_error",
          message: "Realtime API returned an error",
        };
        fail(realtimeErrorStatus(error), error, !billableRequestIssued);
        return;
      }

      if (event.type === "response.done") {
        const responseError = event.response?.status_details?.error;
        if (event.response?.status && event.response.status !== "completed") {
          fail(
            realtimeErrorStatus(responseError),
            responseError ?? {
              code: "realtime_incomplete",
              type: "api_error",
              message: "Realtime response did not complete",
            },
            !billableRequestIssued,
          );
          return;
        }
        if (!chunks.length) {
          fail(502, {
            code: "empty_realtime_audio",
            type: "api_error",
            message: "Realtime response contained no audio",
          });
          return;
        }
        finish(
          new Response(pcm16ChunksToWav(chunks, REALTIME_SAMPLE_RATE), {
            headers: { "Content-Type": "audio/wav" },
          }),
        );
      }
    });

    socket.addEventListener("error", () => {
      fail(
        502,
        {
          code: "realtime_socket_error",
          type: "transport_error",
          message: "Realtime WebSocket failed",
        },
        !billableRequestIssued,
      );
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        fail(
          502,
          {
            code: "realtime_socket_closed",
            type: "transport_error",
            message: "Realtime WebSocket closed before completion",
          },
          !billableRequestIssued,
        );
      }
    });

    if (signal?.aborted) {
      abortHandler();
      return;
    }
    socket.accept();
  });
}

async function requestSpeech(
  apiKey: string,
  script: string,
  style: NarrationStyle,
  fallback = false,
  signal?: AbortSignal,
) {
  const settings = VOICE_SETTINGS[style];
  const forceLegacy = env.NARRATION_SPEECH_MODE === "legacy";
  if (!fallback && !forceLegacy) {
    return requestRealtimeSpeech(apiKey, script, style, signal);
  }

  return fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      fallback
        ? {
            model: FALLBACK_MODEL,
            input: script,
            voice: settings.fallbackVoice,
            response_format: "mp3",
            speed: settings.speed,
          }
        : {
            model: LEGACY_MODEL,
            input: script,
            voice: settings.legacyVoice,
            response_format: "mp3",
            speed: settings.speed,
            instructions: `${settings.instructions}${DELIVERY_GUARD}`,
          },
    ),
    signal,
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
    let response = await requestSpeech(
      apiKey,
      script,
      payload.style,
      false,
      request.signal,
    );
    let selectedModel =
      env.NARRATION_SPEECH_MODE === "legacy" ? LEGACY_MODEL : REALTIME_MODEL;
    if (!response.ok) {
      const safeRealtimeFallback =
        response.headers.get(FALLBACK_ALLOWED_HEADER) === "1";
      if (safeRealtimeFallback) {
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
        response = await requestSpeech(
          apiKey,
          script,
          payload.style,
          true,
          request.signal,
        );
        selectedModel = FALLBACK_MODEL;
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
        "Content-Type":
          response.headers.get("content-type")?.split(";")[0] || "audio/wav",
        "Cache-Control": "private, no-store",
        "X-Narration-Model": selectedModel,
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
