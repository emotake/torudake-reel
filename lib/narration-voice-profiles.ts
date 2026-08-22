import type { NarrationStyle } from "./narration";

export type NarrationVoiceProfileKey = "classic" | "character-v1";

export type NarrationVoiceStyleProfile = Readonly<{
  realtimeVoice: string;
  legacyVoice: string;
  speed: number;
  speechInstructions: string;
  scriptStyleInstruction: string;
  scriptRules: readonly string[];
  naturalCharactersPerSecond: number;
}>;

export type NarrationVoiceProfile = Readonly<{
  key: NarrationVoiceProfileKey;
  version: string;
  productionReady: boolean;
  activation: "default" | "explicit-flag";
  styles: Readonly<Record<NarrationStyle, NarrationVoiceStyleProfile>>;
}>;

const SHARED_CHARACTER_SAFETY_RULE =
  "実在人物、投稿者、声優、既存キャラクター、地域芸能人の声質、口癖、話速、固有のイントネーション、間合いは模倣しないでください。";
const SHARED_CHARACTER_FACTUAL_RULE =
  "商品情報・効果・価格・実績を誇張せず、映像にない出来事や感情を作らないでください。";

/**
 * The current production behavior. Keep these values stable so an absent or
 * invalid feature flag cannot change an existing user's narration.
 */
export const CLASSIC_NARRATION_VOICE_PROFILE: NarrationVoiceProfile = {
  key: "classic",
  version: "2026-08-23-japanese-v5",
  productionReady: true,
  activation: "default",
  styles: {
    bright: {
      realtimeVoice: "marin",
      legacyVoice: "marin",
      speed: 1,
      speechInstructions:
        "話者像: 親しみやすく、聞き手のすぐそばで話す自然な成人女性。\n声質とトーン: 温かくクリア。落ち着いた明るさと日常会話の距離感を保ち、息漏れ、作り声、広告調の誇張を避ける。\n話速と間: 急がず、意味のまとまりごとに短く自然な間を置く。重要語だけをやさしく強調し、語尾を不自然に伸ばさない。\n発音: 固有名詞と文頭を明瞭にし、機械的に一語ずつ区切らない。",
      scriptStyleInstruction:
        "自然な女性の話し言葉。飾らず親しく、標準語で分かりやすく伝える",
      scriptRules: [],
      naturalCharactersPerSecond: 4.7,
    },
    calm: {
      realtimeVoice: "cedar",
      legacyVoice: "cedar",
      speed: 0.99,
      speechInstructions:
        "話者像: 穏やかで信頼感があり、丁寧に案内する自然な成人男性。\n声質とトーン: 聞き取りやすい中低音。近すぎない落ち着いた距離感を保ち、過度な低音演技、芝居がかったナレーター調、息の多い話し方を避ける。\n話速と間: 少しゆとりを持ち、結論の前後に短い間を置く。一定の一本調子にせず、重要語だけを控えめに立たせる。\n発音: 固有名詞と数字を明瞭にし、語尾まで自然に言い切る。",
      scriptStyleInstruction:
        "自然な男性の話し言葉。落ち着いた標準語で、要点を素直に伝える",
      scriptRules: [],
      naturalCharactersPerSecond: 4.5,
    },
    comedy: {
      realtimeVoice: "cedar",
      legacyVoice: "cedar",
      speed: 1,
      speechInstructions:
        "話者像: 休日のお出かけや楽しかった体験を、友人へいきいきと伝える親しみやすい成人男性。\n声質とトーン: 若々しく明るく、自然な笑顔が伝わるクリアな声。楽しさは出すが、怒鳴り声、司会者の煽り、芝居がかった演技、過度な巻き舌は避ける。声を張り上げず、歯擦音や息を強く当てない。\n話速と間: 軽快に進めるが、句読点と意味のまとまりには自然な間を置く。重要語へ自然にアクセントを置き、単語や語尾を引き伸ばさない。\n発音: 固有名詞、数字、助詞を落とさず、勢いがあっても一語ずつ聞き取れるようにする。実在人物、投稿者、声優、既存キャラクター、地域芸能人の声、口癖、固有のイントネーションを模倣しない。",
      scriptStyleInstruction:
        "20代らしい活気と華やかさのある男性の話し言葉。クラブや音楽イベントの高揚感を感じる軽快なテンポで、フレンドリーかつ明瞭に伝える",
      scriptRules: [
        "「明るい男性」は、20代のクラブカルチャーや音楽イベントを思わせる、社交的で自信のある語り口にしてください。",
        "冒頭3秒以内に要点を置き、短い文と自然な緩急でテンポよく伝えてください。自然な口語と弾みのある言い回しを使い、映像に合う軽いノリを取り入れてください。",
        "無理な若者言葉、ギャル語、内輪ノリ、煽り文句を連発せず、初めて見る人にも意味が伝わる台本にしてください。",
        SHARED_CHARACTER_SAFETY_RULE,
        SHARED_CHARACTER_FACTUAL_RULE,
      ],
      naturalCharactersPerSecond: 4.9,
    },
    party: {
      realtimeVoice: "marin",
      legacyVoice: "marin",
      speed: 1,
      speechInstructions:
        "話者像: 友人とのお出かけやおすすめの場所を、楽しそうに共有する親しみやすい成人女性。\n声質とトーン: 若々しく明るく、自然な笑顔と前向きさが伝わるクリアな声。豊かな抑揚はつけるが、幼いアニメ声、鼻にかかった作り声、叫び声、過度な流行語の演技は避ける。声を張り上げず、歯擦音や息を強く当てない。\n話速と間: 軽快に進めるが、句読点と意味のまとまりには自然な間を置く。語尾には軽い弾みをつけるが引き伸ばさない。\n発音: 固有名詞、数字、助詞を落とさず、勢いがあっても一語ずつ聞き取れるようにする。実在人物、投稿者、声優、既存キャラクターの声、口癖、固有のイントネーションを模倣しない。",
      scriptStyleInstruction:
        "20代らしい活気と華やかさのある女性の話し言葉。クラブや音楽イベントの高揚感を感じる軽快なテンポで、親しみやすく自信をもって伝える",
      scriptRules: [
        "「明るい女性」は、20代のギャル系ファッションやクラブカルチャーを思わせる、華やかで自信と親しみやすさのある語り口にしてください。",
        "冒頭3秒以内に要点を置き、短い文と自然な緩急でテンポよく伝えてください。自然な口語と弾みのある言い回しを使い、映像に合う軽いノリを取り入れてください。",
        "無理な若者言葉、ギャル語、内輪ノリ、煽り文句を連発せず、初めて見る人にも意味が伝わる台本にしてください。",
        SHARED_CHARACTER_SAFETY_RULE,
        SHARED_CHARACTER_FACTUAL_RULE,
      ],
      naturalCharactersPerSecond: 4.9,
    },
  },
};

/**
 * Selected production profile. It is deliberately activated only when
 * NARRATION_VOICE_PROFILE is set exactly to "character-v1", so operations can
 * return to the classic profile without changing code or stored style IDs.
 */
export const CHARACTER_V1_NARRATION_VOICE_PROFILE: NarrationVoiceProfile = {
  key: "character-v1",
  version: "2026-08-23-character-v1-selected",
  productionReady: true,
  activation: "explicit-flag",
  styles: {
    bright: CLASSIC_NARRATION_VOICE_PROFILE.styles.bright,
    calm: CLASSIC_NARRATION_VOICE_PROFILE.styles.calm,
    comedy: {
      realtimeVoice: "verse",
      legacyVoice: "verse",
      speed: 1,
      speechInstructions:
        "話者像: ハイテンショントークを、叫ばず聞き取りやすく届ける自然な成人。\n声質とトーン: 明るく芯のある声。冒頭から勢いは出すが、怒鳴り声、司会者の煽り、芝居がかった誇張、過度な巻き舌は避ける。常時大げさにせず、インパクトは要所へ集中する。\n話速と間: 自然な1倍速を保つ。導入は短く素早く入り、要点の直前に一拍置き、結論だけを明瞭に強調する。時間合わせのために早口にしたり、語尾や母音を引き伸ばしたりしない。\n発音: 固有名詞、数字、助詞を落とさず、勢いがあっても一語ずつ聞き取れるようにする。実在人物、投稿者、声優、既存キャラクター、地域芸能人の声、口癖、話速、固有のイントネーション、間合いを模倣しない。",
      scriptStyleInstruction:
        "ハイテンショントーク。叫ばず、大人が聞き取りやすい自然な成人の話し言葉。導入は素早く、要点の直前に一拍置き、結論を明瞭に強調する。常時大げさにせず、勢いは要所へ集中する",
      scriptRules: [
        "「ハイテンショントーク」は、叫び声や常時大げさな言い回しに頼らず、短い導入からすぐ本題へ入ってください。",
        "要点の直前には意味のある短い一拍を作り、結論だけを明瞭に強調してください。テンポ・間・強調は要所へ集中してください。",
        "無理な若者言葉、内輪ノリ、煽り文句を連発せず、初めて見る大人にも意味が伝わる自然な口語にしてください。",
        SHARED_CHARACTER_SAFETY_RULE,
        SHARED_CHARACTER_FACTUAL_RULE,
      ],
      naturalCharactersPerSecond: 4.4,
    },
    party: {
      realtimeVoice: "shimmer",
      legacyVoice: "shimmer",
      speed: 1,
      speechInstructions:
        "話者像: 大人の日常動画にもなじみ、親しみやすさと明るい個性を両立するポップキャラクター。\n声質とトーン: 明るくクリアで、冒頭から違いが伝わる印象を作る。幼児・アニメ調、鼻にかかった作り声、叫び声、過度な広告調は避ける。常時大げさにせず、大人が聞き続けやすい自然さを保つ。\n話速と間: 自然な1倍速を保ち、短い文節ごとに軽快に進める。重要語だけへ小さな弾みをつけ、その他は落ち着かせる。時間合わせのために早口にしたり、語尾や母音を引き伸ばしたりしない。\n発音: 固有名詞、数字、助詞を落とさず、一語ずつ明瞭にする。実在人物、投稿者、声優、既存キャラクターの声、口癖、話速、固有のイントネーション、間合いを模倣しない。",
      scriptStyleInstruction:
        "ポップキャラクター。大人にも使いやすい自然な成人の話し言葉。幼児・アニメ調へ寄せず、冒頭から違いが伝わる明るいインパクトを作る。常時大げさにせず、重要語だけを弾ませて親しみやすく伝える",
      scriptRules: [
        "「ポップキャラクター」は、大人の日常動画にも使いやすい自然な口語にし、幼児・アニメ調へ寄せないでください。",
        "冒頭の短い一文から明るさの違いが伝わる印象を作り、重要語だけを自然に弾ませてください。常時大げさにせず、インパクトは要所へ集中してください。",
        "親しみやすい日常語を使い、無理な若者言葉、内輪ノリ、煽り文句を連発しないでください。",
        SHARED_CHARACTER_SAFETY_RULE,
        SHARED_CHARACTER_FACTUAL_RULE,
      ],
      naturalCharactersPerSecond: 4.5,
    },
  },
};

export const NARRATION_VOICE_PROFILES: Readonly<
  Record<NarrationVoiceProfileKey, NarrationVoiceProfile>
> = {
  classic: CLASSIC_NARRATION_VOICE_PROFILE,
  "character-v1": CHARACTER_V1_NARRATION_VOICE_PROFILE,
};

export function resolveNarrationVoiceProfile(
  configuredValue: unknown,
): NarrationVoiceProfile {
  return configuredValue === "character-v1"
    ? CHARACTER_V1_NARRATION_VOICE_PROFILE
    : CLASSIC_NARRATION_VOICE_PROFILE;
}

export function narrationVoiceProfileLogValue(
  profile: NarrationVoiceProfile,
) {
  return `${profile.key}@${profile.version}`;
}

export function formatNarrationScriptRules(
  styleProfile: NarrationVoiceStyleProfile,
) {
  return styleProfile.scriptRules.length
    ? `\n- ${styleProfile.scriptRules.join("\n- ")}`
    : "";
}
