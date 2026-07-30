import { env } from "cloudflare:workers";
import { findOwnedUsageReservation } from "../../../../lib/billing-store";
import { getCurrentUser } from "../../../../lib/current-user";
import {
  isNarrationStyle,
  normalizeNarrationPlan,
  type NarrationStyle,
} from "../../../../lib/narration";
import { isBillingConfigured } from "../../../../lib/stripe";

const MAX_FRAME_COUNT = 8;
const MAX_FRAME_LENGTH = 700_000;
const GOALS = new Set(["follow", "sales", "reach"]);
const LENGTHS = new Set([30, 60, 90]);

const STYLE_INSTRUCTIONS: Record<NarrationStyle, string> = {
  bright: "明るく弾む親近感。短い言葉で友人へ話しかける",
  calm: "近く柔らかな距離感。情景と余韻を大切に物語る",
  tempo: "芯のある明瞭さ。冒頭の引きを強くして短文で刻む",
  refined: "深い低音に合う静かな説得力。簡潔で重みのある語彙を使う",
};

const NATURAL_CHARACTERS_PER_SECOND: Record<NarrationStyle, number> = {
  bright: 4.7,
  calm: 4.2,
  tempo: 5,
  refined: 4.1,
};

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { code?: string; message?: string; type?: string };
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
  const user = getCurrentUser(request);
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
  const apiKey =
    typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (!apiKey) {
    return Response.json(
      { error: "AIナレーションのAPI設定が完了していません。" },
      { status: 503 },
    );
  }

  let payload: {
    frames?: unknown;
    brief?: unknown;
    goal?: unknown;
    length?: unknown;
    style?: unknown;
    sourceDuration?: unknown;
    usageReservationId?: unknown;
    timingScale?: unknown;
    previousScript?: unknown;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
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
  const sourceDuration = Number(payload.sourceDuration);
  const style = payload.style;
  const timingScale =
    payload.timingScale === undefined ? 1 : Number(payload.timingScale);
  const previousScript =
    typeof payload.previousScript === "string"
      ? payload.previousScript.replace(/\s+/g, " ").trim().slice(0, 2_000)
      : "";

  if (
    frames.length === 0 ||
    frames.length > MAX_FRAME_COUNT ||
    !GOALS.has(goal) ||
    !LENGTHS.has(length) ||
    !isNarrationStyle(style) ||
    !Number.isFinite(sourceDuration) ||
    sourceDuration <= 0 ||
    sourceDuration > 60 * 60 ||
    !Number.isFinite(timingScale) ||
    timingScale < 0.55 ||
    timingScale > 1
  ) {
    return Response.json(
      { error: "動画の場面を確認できませんでした。動画を選び直してください。" },
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

  const targetDuration = Math.min(length, Math.floor(sourceDuration));
  const narrationWindow = Math.max(3, targetDuration * 0.88 * timingScale);
  const characterGuide = Math.max(
    18,
    Math.round(narrationWindow * NATURAL_CHARACTERS_PER_SECOND[style]),
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
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "low" }
  > = [
    {
      type: "input_text",
      text: `この縦動画から、日本語のショート動画用AIナレーションを作成してください。元動画に会話や環境音が含まれている場合でも、その上に重ねて自然に成立する独立した台本にしてください。

目的: ${goalInstruction}
声の雰囲気: ${STYLE_INSTRUCTIONS[style]}
完成尺の上限: ${targetDuration}秒
自然な読み上げ時間: 約${Math.round(narrationWindow)}秒
台本の文字数: ${characterMinimum}〜${characterMaximum}字
利用者からの補足: ${userBrief}${timingCorrection}

ルール:
- 添付画像は動画から時系列に抽出した場面です。見える順序を尊重してください。
- 映像や補足から確認できない商品名、効果、価格、所在地、実績を創作しないでください。
- 大げさな断定や不自然な広告調を避け、投稿者の映像に自然になじむ語り口にしてください。
- 尺を埋めるための言い換えや繰り返しを避け、自然な1倍速で読める台本にしてください。
- 最初の1文で引きつけ、最後の1文は映像だけの余韻へ自然につながる短い結びにしてください。
- 元動画の音声内容は提供されないため、会話を引用・推測したり、映像内の人物が実際に話した内容として断定したりしないでください。
- segmentsはテロップ1枚あたり8〜24文字を目安に、文の切れ目で分割してください。
- socialCaptionは投稿本文です。AI音声の開示文はサービス側で固定追加するため、ここには含めないでください。`,
    },
    ...frames.map((frame) => ({
      type: "input_image" as const,
      image_url: frame,
      detail: "low" as const,
    })),
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
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
                  properties: {
                    text: { type: "string" },
                    emphasis: { type: "boolean" },
                  },
                  required: ["text", "emphasis"],
                },
              },
            },
            required: ["title", "script", "socialCaption", "segments"],
          },
        },
      },
    }),
  });
  const responsePayload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) {
    console.error(
      "OpenAI narration script failed",
      response.status,
      response.headers.get("x-request-id"),
      responsePayload.error?.code,
      responsePayload.error?.type,
    );
    return Response.json(
      { error: apiError(response.status, responsePayload) },
      { status: response.status },
    );
  }

  try {
    const plan = normalizeNarrationPlan(JSON.parse(outputText(responsePayload)));
    if (!plan.script || !plan.segments.length) {
      throw new Error("empty narration plan");
    }
    return Response.json(plan, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("OpenAI narration response parse failed", error);
    return Response.json(
      { error: "ナレーション台本を整えられませんでした。もう一度お試しください。" },
      { status: 502 },
    );
  }
}
