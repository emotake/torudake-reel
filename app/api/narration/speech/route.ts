import { env } from "cloudflare:workers";
import {
  abandonMeteredAiOperation,
  authorizeMeteredAiOperation,
  completeMeteredAiOperation,
  findOwnedUsageReservation,
  type AuthorizedMeteredAiOperation,
} from "../../../../lib/billing-store";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { verifyInitialNarrationToken } from "../../../../lib/narration-initial";
import {
  normalizeNarrationStyle,
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
const JAPANESE_LANGUAGE_AND_ACCENT = `# Language
- 読み上げは最初から最後まで日本語だけにする。
- 英字や外来語が含まれる場合も、日本で一般的な読み方を優先する。

# Accent and Pronunciation
- 日本語を母語とする成人が話す、自然な共通語のアクセントを最初から最後まで保つ。
- 日本語のモーラの長さを保ち、長音、促音、小さい「ゃ・ゅ・ょ」、撥音の「ん」を明瞭に区別する。
- 文節ごとの自然な高低アクセントと息継ぎを使い、英語のように単語の一部だけを強く読むストレスや、母音を曖昧にする発音を避ける。
- 外国語話者が日本語を読むような抑揚、過度な語尾上げ、巻き舌を避ける。`;
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
    realtimeVoice: "marin",
    legacyVoice: "marin",
    fallbackVoice: "nova",
    speed: 1,
    instructions:
      "話者像: 親しみやすく、聞き手のすぐそばで話す自然な成人女性。\n声質とトーン: 温かくクリア。落ち着いた明るさと日常会話の距離感を保ち、息漏れ、作り声、広告調の誇張を避ける。\n話速と間: 急がず、意味のまとまりごとに短く自然な間を置く。重要語だけをやさしく強調し、語尾を不自然に伸ばさない。\n発音: 固有名詞と文頭を明瞭にし、機械的に一語ずつ区切らない。",
  },
  calm: {
    realtimeVoice: "cedar",
    legacyVoice: "cedar",
    fallbackVoice: "echo",
    speed: 0.99,
    instructions:
      "話者像: 穏やかで信頼感があり、丁寧に案内する自然な成人男性。\n声質とトーン: 聞き取りやすい中低音。近すぎない落ち着いた距離感を保ち、過度な低音演技、芝居がかったナレーター調、息の多い話し方を避ける。\n話速と間: 少しゆとりを持ち、結論の前後に短い間を置く。一定の一本調子にせず、重要語だけを控えめに立たせる。\n発音: 固有名詞と数字を明瞭にし、語尾まで自然に言い切る。",
  },
  comedy: {
    realtimeVoice: "ash",
    legacyVoice: "ash",
    fallbackVoice: "fable",
    speed: 1.07,
    instructions:
      "話者像: 20代のクラブや音楽イベントに自然になじむ、社交的で自信のある成人男性。\n声質とトーン: 若々しく明るく、華やかで抜けのよい男性の声。笑顔が伝わる高揚感とノリのよさを出すが、酔った話し方、怒鳴り声、クラブMCの煽り、過度な巻き舌は避ける。\n話速と間: 軽快に進め、短い文の頭を明瞭に立ち上げる。意味のまとまりには短い間を置き、重要語へ自然にアクセントを置く。単語や語尾を引き伸ばさない。\n発音: 固有名詞、数字、助詞を落とさず、勢いがあっても一語ずつ聞き取れるようにする。実在人物、投稿者、声優、既存キャラクター、地域芸能人の声、口癖、固有のイントネーションを模倣しない。",
  },
  party: {
    realtimeVoice: "coral",
    legacyVoice: "coral",
    fallbackVoice: "shimmer",
    speed: 1.07,
    instructions:
      "話者像: 20代のクラブや音楽イベントに自然になじむ、華やかで自信のある成人女性。ギャル系の親しみやすさとポジティブな勢いを感じさせる。\n声質とトーン: 若々しく明るく、きらびやかで抜けのよい女性の声。笑顔と高揚感が伝わる豊かな抑揚をつけるが、幼いアニメ声、鼻にかかった作り声、叫び声、過度なギャル語の演技は避ける。\n話速と間: 軽快に進め、語頭と重要語を気持ちよく立ち上げる。短い文ごとに自然な間を置き、語尾には軽い弾みをつけるが引き伸ばさない。\n発音: 固有名詞、数字、助詞を落とさず、勢いがあっても一語ずつ聞き取れるようにする。実在人物、投稿者、声優、既存キャラクターの声、口癖、固有のイントネーションを模倣しない。",
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
    "# Role and Objective",
    "入力された台本を、聞き取りやすい日本語ナレーションとして正確に読み上げる。",
    JAPANESE_LANGUAGE_AND_ACCENT,
    "# Voice Style",
    settings.instructions,
    "# Pacing",
    `話速は標準の約${Math.round(settings.speed * 100)}%を目安にする。`,
    "# Delivery Rules",
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
            instructions: [
              JAPANESE_LANGUAGE_AND_ACCENT,
              settings.instructions,
              DELIVERY_GUARD,
            ].join("\n"),
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

function aiOperationQuotaHeaders(limit: number, remaining: number) {
  const normalizedRemaining = Math.max(0, Math.min(limit, remaining));
  return {
    "X-AI-Operation-Limit": String(limit),
    "X-AI-Operations-Remaining": String(normalizedRemaining),
    "X-Narration-Generation-Limit": String(limit),
    "X-Narration-Generations-Remaining": String(normalizedRemaining),
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
    aiOperationId?: unknown;
    initialNarration?: unknown;
    narrationBundleToken?: unknown;
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
  const style = normalizeNarrationStyle(payload.style);
  const initialNarration = payload.initialNarration === true;
  if (!script || script.length > 2_000 || !style) {
    return Response.json(
      { error: "台本は1〜2,000文字で入力してください。" },
      { status: 400 },
    );
  }

  let meteredAuthorization: AuthorizedMeteredAiOperation | null = null;
  let meteredAuthorizationSettled = false;
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
    const aiOperationId =
      typeof payload.aiOperationId === "string"
        ? payload.aiOperationId.trim()
        : "";
    if (initialNarration && !aiOperationId) {
      return Response.json(
        { error: "初回ナレーションの処理情報を確認できませんでした。動画を選び直してください。" },
        { status: 400 },
      );
    }
    const narrationBundleToken =
      typeof payload.narrationBundleToken === "string"
        ? payload.narrationBundleToken.trim()
        : "";
    const bundleClaims = initialNarration
      ? await verifyInitialNarrationToken(apiKey, narrationBundleToken, {
          reservationId,
          actionId: aiOperationId,
          script,
          style,
          targetDurationSeconds,
        })
      : null;
    if (initialNarration && !bundleClaims) {
      return Response.json(
        { error: "初回ナレーションの台本情報を確認できませんでした。もう一度最初からお試しください。" },
        { status: 409 },
      );
    }
    const authorization = await authorizeMeteredAiOperation(
      currentUser,
      reservationId,
      initialNarration ? "narration_initial" : "narration_speech",
      aiOperationId || crypto.randomUUID(),
      initialNarration
        ? {
            allowCreate: false,
            continueFromAttemptCounts: [bundleClaims?.n ?? -1],
          }
        : undefined,
    );
    if (!authorization?.allowed) {
      const hitGenerationLimit =
        authorization?.reason === "operator_success_limit";
      const hitAttemptLimit =
        authorization?.reason === "operator_operation_limit" ||
        authorization?.reason === "action_attempt_limit";
      const alreadyProcessing =
        authorization?.reason === "operation_in_progress" ||
        authorization?.reason === "ai_action_capacity";
      const invalidInitialSequence =
        authorization?.reason === "action_not_found" ||
        authorization?.reason === "action_phase_mismatch" ||
        authorization?.reason === "initial_action_used";
      const aiOperationLimit =
        "successfulLimit" in authorization &&
        typeof authorization.successfulLimit === "number"
          ? authorization.successfulLimit
          : 10;
      const remaining =
        "remaining" in authorization &&
        typeof authorization.remaining === "number"
          ? authorization.remaining
          : aiOperationLimit;
      return Response.json(
        {
          error: hitGenerationLimit
            ? `この動画で利用できるAI処理の上限（${aiOperationLimit}回）に達しました。現在の編集内容はそのままプレビュー・書き出しできます。`
            : hitAttemptLimit
              ? "この動画でのAI処理回数が安全上限に達しました。現在の編集内容で仕上げるか、新しい動画として開始してください。"
              : alreadyProcessing
                ? "別のAI処理が進行中です。完了するまで少しお待ちください。"
                : invalidInitialSequence
                  ? "初回ナレーションの処理順を確認できませんでした。もう一度最初からお試しください。"
                : "利用枠を確認できませんでした。動画を選び直してください。",
        },
        {
          status: hitGenerationLimit || hitAttemptLimit
            ? 429
            : alreadyProcessing
              ? 409
              : invalidInitialSequence
                ? 409
              : 402,
          headers:
            "successfulLimit" in authorization &&
            typeof authorization.successfulLimit === "number"
              ? aiOperationQuotaHeaders(aiOperationLimit, remaining)
              : undefined,
        },
      );
    }
    meteredAuthorization = authorization;
  }

  try {
    let response = await requestSpeech(
      apiKey,
      script,
      style,
      false,
      request.signal,
    );
    let selectedModel =
      env.NARRATION_SPEECH_MODE === "legacy" ? LEGACY_MODEL : REALTIME_MODEL;
    if (!response.ok) {
      const safeRealtimeFallback =
        response.headers.get(FALLBACK_ALLOWED_HEADER) === "1";
      if (safeRealtimeFallback) {
        response = await requestSpeech(
          apiKey,
          script,
          style,
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
          headers: meteredAuthorization
            ? aiOperationQuotaHeaders(
                meteredAuthorization.successfulLimit,
                meteredAuthorization.remaining,
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
          headers: meteredAuthorization
            ? aiOperationQuotaHeaders(
                meteredAuthorization.successfulLimit,
                meteredAuthorization.remaining,
              )
            : undefined,
        },
      );
    }
    let completedQuotaHeaders: Record<string, string> = {};
    if (meteredAuthorization) {
      const completion = await completeMeteredAiOperation(
        meteredAuthorization,
      );
      meteredAuthorizationSettled = true;
      if (!completion.completed) {
        return Response.json(
          { error: "利用記録を確定できませんでした。もう一度お試しください。" },
          {
            status: 500,
            headers: aiOperationQuotaHeaders(
              meteredAuthorization.successfulLimit,
              meteredAuthorization.remaining,
            ),
          },
        );
      }
      completedQuotaHeaders = aiOperationQuotaHeaders(
        meteredAuthorization.successfulLimit,
        completion.remaining,
      );
    }
    return new Response(audio, {
      headers: {
        "Content-Type":
          response.headers.get("content-type")?.split(";")[0] || "audio/wav",
        "Cache-Control": "private, no-store",
        "X-Narration-Model": selectedModel,
        ...completedQuotaHeaders,
      },
    });
  } finally {
    if (meteredAuthorization && !meteredAuthorizationSettled) {
      await abandonMeteredAiOperation(meteredAuthorization).catch(
        () => undefined,
      );
    }
  }
}
