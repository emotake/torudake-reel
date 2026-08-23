import { env } from "cloudflare:workers";
import {
  abandonMeteredAiOperation,
  authorizeMeteredAiOperation,
  completeMeteredAiOperation,
  findOwnedUsageReservation,
  getAiEntitlementBudgetForReservation,
  releaseMeteredAiOperation,
  type AuthorizedMeteredAiOperation,
} from "../../../../lib/billing-store";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../../lib/current-user";
import { getUsagePrincipal } from "../../../../lib/operator-access";
import { isValidMeteredAiActionId } from "../../../../lib/operator-usage";
import {
  createInitialNarrationToken,
  verifyInitialNarrationToken,
} from "../../../../lib/narration-initial";
import {
  applyNarrationPronunciationGuide,
  isPublicNarrationStyle,
  normalizeNarrationStyle,
  normalizeNarrationPlan,
  validateNarrationPronunciationGuide,
} from "../../../../lib/narration";
import {
  formatNarrationScriptRules,
  narrationVoiceProfileLogValue,
  resolveNarrationVoiceProfile,
} from "../../../../lib/narration-voice-profiles";
import { isUsageEnforcementEnabled } from "../../../../lib/usage-enforcement";
import { isDurationWithinReservation } from "../../../../lib/usage-duration";
import { validateVideoInputDuration } from "../../../../lib/video-input-policy";
import {
  describeVideoMixNarrationImage,
  ensureVideoMixNarrationSceneAssignments,
  normalizeVideoMixNarrationSceneTimeline,
  videoMixNarrationScenePromptRules,
  type VideoMixNarrationScene,
} from "../../../../lib/video-mix-scene-timeline";
import {
  createUpstreamAbortSignal,
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../../lib/request-safety";
import {
  productDurationBucket,
  productUpstreamErrorCode,
  recordServerProductEvent,
} from "../../../../lib/product-analytics";
import {
  getRequestIdentifiers,
  logOperationalEvent,
  withRequestIdentifier,
} from "../../../../lib/observability";
import { recordProviderUsageBestEffort } from "../../../../lib/provider-usage";

const MAX_FRAME_COUNT = 8;
const MAX_FRAME_LENGTH = 700_000;
const MAX_SCRIPT_REQUEST_BYTES = 6_500_000;
const MAX_PRONUNCIATION_GUIDE_LENGTH = 4_000;
const SCRIPT_REQUEST_TIMEOUT_MS = 45_000;
const NARRATION_SCRIPT_MODEL = "gpt-5.6-luna";
export const NARRATION_RESERVATION_HEADER = "X-Usage-Reservation-Id";
export const NARRATION_ACTION_HEADER = "X-AI-Operation-Id";
const GOALS = new Set(["follow", "sales", "reach"]);
const LENGTHS = new Set([30, 60, 90]);

function aiOperationQuotaHeaders(limit: number, remaining: number) {
  const normalizedRemaining = Math.max(0, Math.min(limit, remaining));
  return {
    "X-AI-Operation-Limit": String(limit),
    "X-AI-Operations-Remaining": String(normalizedRemaining),
    "X-Narration-Generation-Limit": String(limit),
    "X-Narration-Generations-Remaining": String(normalizedRemaining),
  };
}

function meteredResponseHeaders(
  authorization:
    | Awaited<ReturnType<typeof authorizeMeteredAiOperation>>
    | null,
) {
  const limit =
    authorization &&
    "successfulLimit" in authorization &&
    typeof authorization.successfulLimit === "number"
      ? authorization.successfulLimit
      : null;
  if (limit === null) return {};
  return aiOperationQuotaHeaders(
    limit,
    authorization &&
    "remaining" in authorization &&
    typeof authorization.remaining === "number"
      ? authorization.remaining
      : limit,
  );
}

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: string; message?: string; type?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { audio_tokens?: number };
    output_tokens_details?: { audio_tokens?: number };
  };
};

function outputText(payload: OpenAIResponse) {
  if (payload.output_text?.trim()) return payload.output_text.trim();
  return (
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" && item.text)
      .map((item) => item.text)
      .join("")
      .trim() ?? ""
  );
}

async function safetyIdentifier(request: Request) {
  const user = await getCurrentUser(request);
  const source =
    user?.email ??
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("user-agent") ??
    "anonymous";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function apiError(status: number, payload: OpenAIResponse) {
  const code = payload.error?.code ?? payload.error?.type ?? "";
  if (status === 429 && /quota|billing|credit/i.test(code + payload.error?.message)) {
    return "AIナレーションのAPI利用枠が不足しています。OpenAI APIのクレジットをご確認ください。";
  }
  if (status === 429) {
    return "AIナレーションが混み合っています。少し待ってからもう一度お試しください。";
  }
  if (status === 401 || status === 403) {
    return "AIナレーションのAPI設定を確認できませんでした。";
  }
  return "動画の内容を読み取れませんでした。もう一度お試しください。";
}

export async function POST(request: Request) {
  const { requestId, correlationId } = getRequestIdentifiers(request);
  const apiKey =
    typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (!apiKey) {
    return Response.json(
      { error: "AIナレーションのAPI設定が完了していません。" },
      { status: 503 },
    );
  }

  const usageEnforcementEnabled = isUsageEnforcementEnabled(request);
  const usagePrincipal = usageEnforcementEnabled
    ? await getUsagePrincipal(request)
    : null;
  if (usageEnforcementEnabled && !usagePrincipal?.currentUser) {
    return authenticationRequired();
  }

  let meteredAuthorization: AuthorizedMeteredAiOperation | null = null;
  let meteredAuthorizationSettled = false;
  let providerOperation: "narration_initial" | "narration_script" =
    "narration_script";

  try {
    let usageHeaderPreflight: Readonly<{
      reservationId: string;
      actionId: string;
    }> | null = null;
    if (usageEnforcementEnabled) {
      const reservationId =
        request.headers.get(NARRATION_RESERVATION_HEADER)?.trim() ?? "";
      const actionId =
        request.headers.get(NARRATION_ACTION_HEADER)?.trim() ?? "";
      // Production usage enforcement requires both bounded identifiers before
      // the multi-megabyte image body is parsed. Local/test bypasses still skip
      // this contract through isUsageEnforcementEnabled(request).
      if (
        !/^[a-zA-Z0-9_-]{8,128}$/.test(reservationId) ||
        !isValidMeteredAiActionId(actionId)
      ) {
        return Response.json(
          {
            error:
              "AI処理の利用情報を確認できませんでした。動画を選び直してください。",
          },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      const currentUser = usagePrincipal?.currentUser ?? null;
      const reservation = currentUser
        ? await findOwnedUsageReservation(currentUser, reservationId)
        : null;
      if (!reservation) {
        return Response.json(
          {
            error:
              "利用枠を確認できませんでした。動画を選び直してください。",
          },
          {
            status: currentUser ? 402 : 401,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
      // Resolve the active entitlement before accepting the large image body,
      // but leave capacity to the atomic authorization below. A succeeded
      // action may legitimately continue the same narration bundle even when
      // that action used the entitlement's final available slot.
      await getAiEntitlementBudgetForReservation(reservation);
      usageHeaderPreflight = { reservationId, actionId };
    }

    let payload: {
      frames?: unknown;
      brief?: unknown;
      goal?: unknown;
      length?: unknown;
      style?: unknown;
      sourceDuration?: unknown;
      usageReservationId?: unknown;
      aiOperationId?: unknown;
      initialNarration?: unknown;
      narrationBundleToken?: unknown;
      timingScale?: unknown;
      previousScript?: unknown;
      pronunciationGuide?: unknown;
      sceneTimeline?: unknown;
    };
  try {
    payload = await parseJsonBodyWithLimit<typeof payload>(
      request,
      MAX_SCRIPT_REQUEST_BYTES,
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "送信データが大きすぎます。動画を選び直してください。" },
        { status: 413 },
      );
    }
    return Response.json({ error: "動画の情報を読み取れませんでした。" }, { status: 400 });
  }

  const frames = Array.isArray(payload.frames)
    ? payload.frames.filter(
        (frame): frame is string =>
          typeof frame === "string" &&
          /^data:image\/jpeg;base64,/i.test(frame) &&
          frame.length <= MAX_FRAME_LENGTH,
      )
    : [];
  const brief =
    typeof payload.brief === "string" ? payload.brief.trim().slice(0, 800) : "";
  const goal = typeof payload.goal === "string" ? payload.goal : "";
  const length = Number(payload.length);
  const sourceDurationResult = validateVideoInputDuration(
    payload.sourceDuration,
  );
  if (!sourceDurationResult.ok) {
    return Response.json(
      {
        error: sourceDurationResult.message,
        code: sourceDurationResult.code,
        maximumSeconds: sourceDurationResult.maximumSeconds,
      },
      { status: 400 },
    );
  }
  const sourceDuration = sourceDurationResult.durationSeconds;
  const style = normalizeNarrationStyle(payload.style);
  const timingScale =
    payload.timingScale === undefined ? 1 : Number(payload.timingScale);
  const previousScript =
    typeof payload.previousScript === "string"
      ? payload.previousScript.replace(/\s+/g, " ").trim().slice(0, 2_000)
      : "";
  if (
    payload.pronunciationGuide !== undefined &&
    typeof payload.pronunciationGuide !== "string"
  ) {
    return Response.json(
      { error: "読み方の指定を確認できませんでした。" },
      { status: 400 },
    );
  }
  const pronunciationGuide =
    typeof payload.pronunciationGuide === "string"
      ? payload.pronunciationGuide.trim()
      : "";
  if (pronunciationGuide.length > MAX_PRONUNCIATION_GUIDE_LENGTH) {
    return Response.json(
      { error: "読み方は20件まで指定できます。" },
      { status: 400 },
    );
  }
  const pronunciationValidation = validateNarrationPronunciationGuide(
    pronunciationGuide,
  );
  if (pronunciationValidation.error) {
    return Response.json(
      { error: pronunciationValidation.error },
      { status: 400 },
    );
  }
  const initialNarration = payload.initialNarration === true;
  providerOperation = initialNarration ? "narration_initial" : "narration_script";
  const suppliedNarrationBundleToken =
    typeof payload.narrationBundleToken === "string"
      ? payload.narrationBundleToken.trim()
      : "";

  if (
    frames.length === 0 ||
    frames.length > MAX_FRAME_COUNT ||
    !GOALS.has(goal) ||
    !LENGTHS.has(length) ||
    !style ||
    !Number.isFinite(timingScale) ||
    timingScale < 0.55 ||
    timingScale > 1
  ) {
    return Response.json(
      { error: "動画の場面を確認できませんでした。動画を選び直してください。" },
      { status: 400 },
    );
  }

  if (!isPublicNarrationStyle(style)) {
    return Response.json(
      {
        error:
          "「ポップキャラクター」は音声品質の調整中です。別の声を選んでください。",
        code: "narration_style_temporarily_unavailable",
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const voiceProfile = resolveNarrationVoiceProfile(
    env.NARRATION_VOICE_PROFILE,
  );
  const voiceStyleProfile = voiceProfile.styles[style];
  const voiceProfileLogValue = narrationVoiceProfileLogValue(voiceProfile);

  let sceneTimeline: readonly VideoMixNarrationScene[] | null = null;
  if (payload.sceneTimeline !== undefined) {
    const sceneTimelineResult = normalizeVideoMixNarrationSceneTimeline(
      payload.sceneTimeline,
      { frameCount: frames.length, durationSeconds: sourceDuration },
    );
    if (!sceneTimelineResult.ok) {
      return Response.json(
        { error: sceneTimelineResult.error },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    sceneTimeline = sceneTimelineResult.scenes;
  }

  let authorizedReservationDuration: number | null = null;
  if (usageEnforcementEnabled) {
    const currentUser = usagePrincipal?.currentUser ?? null;
    const reservationId =
      typeof payload.usageReservationId === "string"
        ? payload.usageReservationId
        : "";
    const aiOperationId =
      typeof payload.aiOperationId === "string"
        ? payload.aiOperationId.trim()
        : "";
    if (
      usageHeaderPreflight &&
      (reservationId !== usageHeaderPreflight.reservationId ||
        aiOperationId !== usageHeaderPreflight.actionId)
    ) {
      return Response.json(
        { error: "AI処理の利用情報が一致しません。動画を選び直してください。" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (initialNarration && !aiOperationId) {
      return Response.json(
        { error: "初回ナレーションの処理情報を確認できませんでした。動画を選び直してください。" },
        { status: 400 },
      );
    }
    const bundleTargetDuration = Math.max(
      1,
      Math.min(90, length, sourceDuration),
    );
    let priorBundleScriptAttempt: 1 | null = null;
    if (initialNarration && previousScript) {
      const claims = await verifyInitialNarrationToken(
        apiKey,
        suppliedNarrationBundleToken,
        {
          reservationId,
          actionId: aiOperationId,
          script: applyNarrationPronunciationGuide(
            previousScript,
            pronunciationGuide,
          ),
          style,
          targetDurationSeconds: bundleTargetDuration,
        },
      );
      if (!claims || claims.n !== 1) {
        return Response.json(
          { error: "初回ナレーションの自動調整情報を確認できませんでした。もう一度最初からお試しください。" },
          { status: 409 },
        );
      }
      priorBundleScriptAttempt = 1;
    } else if (initialNarration && suppliedNarrationBundleToken) {
      return Response.json(
        { error: "初回ナレーションの処理順を確認できませんでした。もう一度最初からお試しください。" },
        { status: 409 },
      );
    }
    const authorization =
      currentUser && reservationId
        ? await authorizeMeteredAiOperation(
            currentUser,
            reservationId,
            initialNarration ? "narration_initial" : "narration_script",
            aiOperationId || crypto.randomUUID(),
            initialNarration
              ? previousScript
                ? {
                    allowCreate: false,
                    continuationMode: "narration_bundle_phase",
                    continueFromAttemptCounts: [
                      (priorBundleScriptAttempt ?? 1) + 1,
                    ],
                  }
                : {
                    continuationMode: "narration_bundle_phase",
                    continueFromAttemptCounts: [],
                  }
              : undefined,
          )
        : null;
    if (!authorization?.allowed) {
      const quotaReached =
        authorization?.reason === "operator_success_limit" ||
        authorization?.reason === "entitlement_ai_limit" ||
        authorization?.reason === "operator_operation_limit" ||
        authorization?.reason === "action_attempt_limit";
      const alreadyProcessing =
        authorization?.reason === "operation_in_progress" ||
        authorization?.reason === "ai_action_capacity" ||
        authorization?.reason === "entitlement_ai_capacity";
      const actionAlreadySucceeded =
        authorization?.reason === "action_already_succeeded";
      const invalidInitialSequence =
        authorization?.reason === "action_not_found" ||
        authorization?.reason === "action_phase_mismatch" ||
        authorization?.reason === "initial_action_used";
      return Response.json(
        {
          error: quotaReached
            ? authorization?.reason === "entitlement_ai_limit"
              ? "この料金プラン・購入枠・無料体験で利用できるAI処理回数に達しました。現在の編集内容はそのまま利用できます。"
              : authorization?.reason === "operator_success_limit"
              ? `この動画で利用できるAI処理の上限（${authorization.successfulLimit}回）に達しました。現在の編集内容はそのまま利用できます。`
              : "この動画でのAI処理回数が安全上限に達しました。新しい動画としてやり直してください。"
            : alreadyProcessing
              ? authorization?.reason === "entitlement_ai_capacity"
                ? "この料金プラン・購入枠・無料体験のAI処理が別の動画で進行中です。完了してからもう一度お試しください。"
                : "別のAI処理が進行中です。完了してからもう一度お試しください。"
              : actionAlreadySucceeded
                ? "このAI処理はすでに完了しています。もう一度生成する場合は、生成ボタンを押し直してください。"
              : invalidInitialSequence
                ? "初回ナレーションの処理順を確認できませんでした。もう一度最初からお試しください。"
              : "利用枠を確認できませんでした。動画を選び直してください。",
        },
        {
          status: quotaReached
            ? 429
            : alreadyProcessing
              ? 409
              : actionAlreadySucceeded
                ? 409
              : invalidInitialSequence
                ? 409
              : currentUser
                ? 402
                : 401,
          headers: meteredResponseHeaders(authorization),
        },
      );
    }
    authorizedReservationDuration =
      authorization.reservation.sourceDurationSeconds;
    meteredAuthorization = authorization;
    if (
      !isDurationWithinReservation(
        sourceDuration,
        authorizedReservationDuration,
      )
    ) {
      return Response.json(
        {
          error:
            "動画の実際の長さが確保した利用枠を超えています。動画を選び直して、もう一度お試しください。",
        },
        { status: 402 },
      );
    }
  }

  const targetDuration = Math.min(length, Math.floor(sourceDuration));
  const narrationWindow = Math.max(3, targetDuration * 0.88 * timingScale);
  const characterGuide = Math.max(
    18,
    Math.round(
      narrationWindow * voiceStyleProfile.naturalCharactersPerSecond,
    ),
  );
  const characterMinimum = Math.max(12, Math.round(characterGuide * 0.9));
  const characterMaximum = Math.max(
    characterMinimum,
    Math.round(characterGuide * 1.08),
  );
  const goalInstruction =
    goal === "sales"
      ? "商品の価値を具体的に伝え、最後に自然な行動提案を置く"
      : goal === "reach"
        ? "冒頭1文で続きを見たくさせ、視覚的な変化に合わせて展開する"
        : "視聴者に親しく話しかけ、最後にフォローしたくなる余韻を作る";
  const userBrief = brief || "補足情報なし。映像で確実に確認できる内容だけを使う。";
  const timingCorrection = previousScript
    ? `\n再調整する元台本: ${previousScript}\n元台本の意味・事実・冒頭の引き・結びを保ち、重複や補足を削って指定文字数へ短くしてください。`
    : "";
  const characterRules = formatNarrationScriptRules(voiceStyleProfile);
  const sceneRules = sceneTimeline
    ? videoMixNarrationScenePromptRules(sceneTimeline)
    : "";
  const sceneCharacterRate =
    voiceStyleProfile.naturalCharactersPerSecond * 0.88 * timingScale;
  const frameContent = frames.flatMap((frame, imageIndex) =>
    sceneTimeline
      ? [
          {
            type: "input_text" as const,
            text: describeVideoMixNarrationImage(
              sceneTimeline,
              imageIndex,
              sceneCharacterRate,
            ),
          },
          {
            type: "input_image" as const,
            image_url: frame,
            detail: "low" as const,
          },
        ]
      : [
          {
            type: "input_image" as const,
            image_url: frame,
            detail: "low" as const,
          },
        ],
  );
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "low" }
  > = [
    {
      type: "input_text",
      text: `この動画から、日本語のショート動画用AIナレーションを作成してください。元動画の話し声をそのまま使うのではなく、映像と利用者の補足に基づいて内容をAIナレーションで伝え直す独立した台本にしてください。環境音やBGMが含まれる場合も、映像の内容に合う台本にしてください。

目的: ${goalInstruction}
声の雰囲気: ${voiceStyleProfile.scriptStyleInstruction}
完成尺の上限: ${targetDuration}秒
自然な読み上げ時間: 約${Math.round(narrationWindow)}秒
台本の文字数: ${characterMinimum}〜${characterMaximum}字
利用者からの補足: ${userBrief}${timingCorrection}

ルール:
- 添付画像は動画から時系列に抽出した場面です。見える順序を尊重してください。
- 映像や補足から確認できない商品名、効果、価格、所在地、実績を創作しないでください。
- 商品情報・効果・価格・実績に関する大げさな断定や、不自然な広告調を避けてください。
- 尺を埋めるための言い換えや繰り返しを避け、自然な1倍速で読める台本にしてください。
- 最初の1文で引きつけ、最後の1文は映像だけの余韻へ自然につながる短い結びにしてください。
- 元動画の音声内容は提供されないため、会話を引用・推測したり、映像内の人物が実際に話した内容として断定したりしないでください。
- segmentsはテロップ1枚あたり8〜24文字を目安に、文の切れ目で分割してください。
- socialCaptionは投稿本文です。AI音声の開示文はサービス側で固定追加するため、ここには含めないでください。${characterRules}${sceneRules}`,
    },
    ...frameContent,
  ];

  const segmentSchemaProperties = {
    text: { type: "string" },
    emphasis: { type: "boolean" },
    ...(sceneTimeline
      ? {
          sceneId: {
            type: "string",
            enum: sceneTimeline.map((scene) => scene.id),
          },
        }
      : {}),
  };
  const segmentSchemaRequired = sceneTimeline
    ? ["text", "emphasis", "sceneId"]
    : ["text", "emphasis"];

  const upstreamAbort = createUpstreamAbortSignal(
    request.signal,
    SCRIPT_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: upstreamAbort.signal,
      body: JSON.stringify({
      model: NARRATION_SCRIPT_MODEL,
      store: false,
      reasoning: { effort: "none" },
      safety_identifier: await safetyIdentifier(request),
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "narration_plan",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              script: { type: "string" },
              socialCaption: { type: "string" },
              segments: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: segmentSchemaProperties,
                  required: segmentSchemaRequired,
                },
              },
            },
            required: ["title", "script", "socialCaption", "segments"],
          },
        },
      },
      }),
    });
  } catch (error) {
    await recordProviderUsageBestEffort({
      provider: "openai",
      model: NARRATION_SCRIPT_MODEL,
      operation: providerOperation,
      outcome: "failure",
    });
    if (upstreamAbort.signal.aborted) {
      return withRequestIdentifier(Response.json(
        {
          error: upstreamAbort.didTimeOut()
            ? "AI台本の生成に時間がかかっています。少し待ってからもう一度お試しください。"
            : "AI台本の生成を中止しました。",
        },
        { status: upstreamAbort.didTimeOut() ? 504 : 499 },
      ), request, requestId);
    }
    logOperationalEvent("error", request, {
      event: "openai_narration_script_request_failed",
      component: "ai",
      operation: initialNarration ? "narration_initial" : "narration_script",
      status: 502,
      outcome: "failed",
      eventType: voiceProfileLogValue,
      errorCode: upstreamAbort.didTimeOut()
        ? "upstream_timeout"
        : "upstream_request_failed",
      requestId,
      correlationId,
      error,
    });
    return withRequestIdentifier(Response.json(
      { error: "AI台本を生成できませんでした。もう一度お試しください。", requestId },
      { status: 502 },
    ), request, requestId);
  } finally {
    upstreamAbort.cleanup();
  }
  const responsePayload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  await recordProviderUsageBestEffort({
    provider: "openai",
    model: NARRATION_SCRIPT_MODEL,
    operation: providerOperation,
    outcome: response.ok ? "success" : "failure",
    inputTokens: responsePayload.usage?.input_tokens,
    outputTokens: responsePayload.usage?.output_tokens,
    inputAudioTokens: responsePayload.usage?.input_tokens_details?.audio_tokens,
    outputAudioTokens: responsePayload.usage?.output_tokens_details?.audio_tokens,
  });
  if (!response.ok) {
    logOperationalEvent("error", request, {
      event: "openai_narration_script_failed",
      component: "ai",
      operation: initialNarration ? "narration_initial" : "narration_script",
      status: response.status,
      outcome: "failed",
      eventType: voiceProfileLogValue,
      errorCode:
        responsePayload.error?.code ?? responsePayload.error?.type ?? null,
      upstreamRequestId: response.headers.get("x-request-id"),
      upstreamStatus: response.status,
      requestId,
      correlationId,
    });
    await recordServerProductEvent(request, "ai_operation_failed", {
      operation: initialNarration ? "narration_initial" : "narration_script",
      outcome: "failed",
      error_code: productUpstreamErrorCode(response.status),
    });
    return withRequestIdentifier(Response.json(
      { error: apiError(response.status, responsePayload), requestId },
      { status: response.status },
    ), request, requestId);
  }

  try {
    const normalizedPlan = normalizeNarrationPlan(
      JSON.parse(outputText(responsePayload)),
    );
    const plan = sceneTimeline
      ? ensureVideoMixNarrationSceneAssignments(normalizedPlan, sceneTimeline)
      : normalizedPlan;
    if (!plan.script || !plan.segments.length) {
      throw new Error("empty narration plan");
    }
    let quotaHeaders: Record<string, string> = {};
    let responseNarrationBundleToken: string | undefined;
    if (meteredAuthorization) {
      if (initialNarration) {
        const scriptAttempt = meteredAuthorization.action.attemptCount;
        if (scriptAttempt !== 1 && scriptAttempt !== 3) {
          await releaseMeteredAiOperation(meteredAuthorization);
          meteredAuthorizationSettled = true;
          return Response.json(
            { error: "初回ナレーションの処理順を確認できませんでした。もう一度最初からお試しください。" },
            { status: 409, headers: meteredResponseHeaders(meteredAuthorization) },
          );
        }
        responseNarrationBundleToken = await createInitialNarrationToken(
          apiKey,
          {
            reservationId: meteredAuthorization.reservation.id,
            actionId: meteredAuthorization.action.actionId,
            script: applyNarrationPronunciationGuide(
              plan.script,
              pronunciationGuide,
            ),
            style,
            targetDurationSeconds: Math.max(
              1,
              Math.min(90, length, sourceDuration),
            ),
          },
          scriptAttempt,
        );
      }
      const completion = await completeMeteredAiOperation(
        meteredAuthorization,
      );
      meteredAuthorizationSettled = true;
      if (!completion.completed) {
        return Response.json(
          { error: "利用記録を確定できませんでした。もう一度お試しください。" },
          {
            status: 500,
            headers: meteredResponseHeaders(meteredAuthorization),
          },
        );
      }
      quotaHeaders = aiOperationQuotaHeaders(
        meteredAuthorization.successfulLimit,
        completion.remaining,
      );
    }
    await recordServerProductEvent(request, "ai_operation_succeeded", {
      operation: initialNarration ? "narration_initial" : "narration_script",
      outcome: "completed",
      voice: style,
      duration_bucket: productDurationBucket(Math.min(length, sourceDuration)),
    });
    logOperationalEvent("info", request, {
      event: "openai_narration_script_succeeded",
      component: "ai",
      operation: initialNarration ? "narration_initial" : "narration_script",
      status: 200,
      outcome: "completed",
      eventType: voiceProfileLogValue,
      requestId,
      correlationId,
    });
    return Response.json(
      responseNarrationBundleToken
        ? { ...plan, narrationBundleToken: responseNarrationBundleToken }
        : plan,
      {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Narration-Voice-Profile": voiceProfile.key,
        "X-Narration-Voice-Profile-Version": voiceProfile.version,
        ...quotaHeaders,
      },
      },
    );
  } catch (error) {
    logOperationalEvent("error", request, {
      event: "openai_narration_script_parse_failed",
      component: "ai",
      operation: initialNarration ? "narration_initial" : "narration_script",
      status: 502,
      outcome: "failed",
      eventType: voiceProfileLogValue,
      errorCode: "invalid_upstream_response",
      upstreamRequestId: response.headers.get("x-request-id"),
      requestId,
      correlationId,
      error,
    });
    return withRequestIdentifier(Response.json(
      { error: "ナレーション台本を整えられませんでした。もう一度お試しください。", requestId },
      { status: 502 },
    ), request, requestId);
  }
  } finally {
    if (meteredAuthorization && !meteredAuthorizationSettled) {
      await abandonMeteredAiOperation(meteredAuthorization).catch(
        (cleanupError) => {
          logOperationalEvent("error", request, {
            event: "narration_script_usage_cleanup_failed",
            component: "ai",
            operation: "release_usage_lease",
            status: 500,
            outcome: "failed",
            errorCode: "usage_cleanup_failed",
            requestId,
            correlationId,
            error: cleanupError,
          });
        },
      );
    }
  }
}
