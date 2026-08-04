export type CaptionGoal = "follow" | "sales" | "reach";

export type CaptionTone =
  | "editorial"
  | "cinema"
  | "studio"
  | "glass"
  | "mono"
  | "pop"
  | "signature";

export type CaptionMood = "auto" | "soft" | "refined" | "bold" | "pop";

export type CaptionProfile = {
  mood: CaptionMood;
  accentColor: string;
  brandName: string;
};

export type CaptionPresentation =
  | "hook"
  | "metric"
  | "emphasis"
  | "standard";

export type CaptionDesign = {
  tone: CaptionTone;
  frame: CaptionFrameStyle;
  palette: {
    background: string;
    border: string;
    highlight: string;
    text: string;
    stroke: string;
    label: string;
    fontWeight: number;
  };
};

export type CaptionFrameStyle = {
  fontFamily: string;
  borderPlacement: "left" | "outline" | "bottom" | "none";
  shadow: "soft" | "deep" | "offset" | "warm" | "none";
  highlight: "marker" | "text" | "block";
  cornerRadius: number;
};

export const DEFAULT_CAPTION_PROFILE: CaptionProfile = {
  mood: "auto",
  accentColor: "#e45f4d",
  brandName: "",
};

export const CAPTION_MOODS: {
  id: CaptionMood;
  label: string;
  note: string;
  tone: CaptionTone;
}[] = [
  {
    id: "auto",
    label: "ナチュラル",
    note: "枠付き｜日常・Vlogになじむ",
    tone: "editorial",
  },
  {
    id: "bold",
    label: "インパクト",
    note: "枠付き｜短い言葉を強く届ける",
    tone: "mono",
  },
  {
    id: "soft",
    label: "クリア",
    note: "文字のみ｜くっきり読みやすい",
    tone: "cinema",
  },
  {
    id: "pop",
    label: "ポップ",
    note: "文字のみ｜明るくテンポよく",
    tone: "pop",
  },
  {
    id: "refined",
    label: "シネマ",
    note: "文字のみ｜静かで上質に見せる",
    tone: "signature",
  },
];

export const CAPTION_ACCENT_PRESETS = [
  "#e45f4d",
  "#d5a850",
  "#5f8f82",
  "#5574b8",
  "#9a6fb0",
  "#181818",
] as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MOODS = new Set<CaptionMood>([
  "auto",
  "soft",
  "refined",
  "bold",
  "pop",
]);

export function normalizeCaptionProfile(value: unknown): CaptionProfile {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_CAPTION_PROFILE };
  }
  const candidate = value as Partial<Record<keyof CaptionProfile, unknown>>;
  const mood =
    typeof candidate.mood === "string" &&
    MOODS.has(candidate.mood as CaptionMood)
      ? (candidate.mood as CaptionMood)
      : DEFAULT_CAPTION_PROFILE.mood;
  const accentColor =
    typeof candidate.accentColor === "string" &&
    HEX_COLOR.test(candidate.accentColor.trim())
      ? candidate.accentColor.trim().toLowerCase()
      : DEFAULT_CAPTION_PROFILE.accentColor;
  const brandName =
    typeof candidate.brandName === "string"
      ? Array.from(candidate.brandName.trim()).slice(0, 30).join("")
      : DEFAULT_CAPTION_PROFILE.brandName;
  return { mood, accentColor, brandName };
}

const TONE_PALETTES: Record<
  CaptionTone,
  Omit<CaptionDesign["palette"], "border" | "highlight">
> = {
  editorial: {
    background: "rgba(255,252,248,.96)",
    text: "#162033",
    stroke: "",
    label: "#fff7f0",
    fontWeight: 800,
  },
  cinema: {
    background: "",
    text: "#ffffff",
    stroke: "#10151f",
    label: "#ffffff",
    fontWeight: 800,
  },
  studio: {
    background: "rgba(19,27,40,.94)",
    text: "#ffffff",
    stroke: "",
    label: "#f8e8b8",
    fontWeight: 800,
  },
  glass: {
    background: "rgba(12,28,34,.78)",
    text: "#f8fffd",
    stroke: "",
    label: "#d9fff4",
    fontWeight: 750,
  },
  mono: {
    background: "rgba(248,246,240,.97)",
    text: "#181818",
    stroke: "",
    label: "#ffffff",
    fontWeight: 850,
  },
  pop: {
    background: "",
    text: "#fffdf7",
    stroke: "#172033",
    label: "#ffffff",
    fontWeight: 900,
  },
  signature: {
    background: "",
    text: "#fffaf0",
    stroke: "rgba(18,16,15,.82)",
    label: "#fffaf0",
    fontWeight: 700,
  },
};

const TONE_FRAMES: Record<CaptionTone, CaptionFrameStyle> = {
  editorial: {
    fontFamily: '"Noto Sans JP", "Yu Gothic", sans-serif',
    borderPlacement: "left",
    shadow: "soft",
    highlight: "marker",
    cornerRadius: 0.28,
  },
  cinema: {
    fontFamily: '"Noto Sans JP", "Yu Gothic", sans-serif',
    borderPlacement: "none",
    shadow: "deep",
    highlight: "text",
    cornerRadius: 0,
  },
  studio: {
    fontFamily: '"Noto Sans JP", "Yu Gothic", sans-serif',
    borderPlacement: "bottom",
    shadow: "deep",
    highlight: "text",
    cornerRadius: 0.1,
  },
  glass: {
    fontFamily: '"Noto Sans JP", "Yu Gothic", sans-serif',
    borderPlacement: "outline",
    shadow: "deep",
    highlight: "text",
    cornerRadius: 0.32,
  },
  mono: {
    fontFamily: '"Noto Sans JP", "Yu Gothic", sans-serif',
    borderPlacement: "outline",
    shadow: "offset",
    highlight: "block",
    cornerRadius: 0.08,
  },
  pop: {
    fontFamily:
      '"Hiragino Maru Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif',
    borderPlacement: "none",
    shadow: "offset",
    highlight: "text",
    cornerRadius: 0,
  },
  signature: {
    fontFamily: '"Yu Mincho", "Hiragino Mincho ProN", Georgia, serif',
    borderPlacement: "none",
    shadow: "warm",
    highlight: "text",
    cornerRadius: 0,
  },
};

const MOOD_TONES: Record<CaptionMood, CaptionTone> = Object.fromEntries(
  CAPTION_MOODS.map((mood) => [mood.id, mood.tone]),
) as Record<CaptionMood, CaptionTone>;

export function resolveCaptionDesign(
  profile: CaptionProfile,
  _goal: CaptionGoal,
): CaptionDesign {
  void _goal;
  const normalized = normalizeCaptionProfile(profile);
  const tone = MOOD_TONES[normalized.mood];
  const base = TONE_PALETTES[tone];
  return {
    tone,
    frame: TONE_FRAMES[tone],
    palette: {
      ...base,
      border: normalized.accentColor,
      highlight: normalized.accentColor,
    },
  };
}

const BREAK_AFTER = /[、。！？!?…）」』】]$/u;
const SOFT_BREAK_AFTER =
  /(は|が|を|に|で|と|へ|から|まで|より|なら|ので|けど|です|ます)$/u;

function findNaturalBreak(characters: string[], start: number, target: number) {
  const max = Math.min(characters.length, start + target + 3);
  const min = Math.min(max, start + Math.max(5, target - 4));
  let best = Math.min(characters.length, start + target);
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let end = min; end <= max; end += 1) {
    const fragment = characters.slice(start, end).join("");
    const distance = Math.abs(end - (start + target));
    const score =
      (BREAK_AFTER.test(fragment) ? 10 : SOFT_BREAK_AFTER.test(fragment) ? 4 : 0) -
      distance;
    if (score > bestScore) {
      best = end;
      bestScore = score;
    }
  }
  return Math.max(start + 1, best);
}

export function wrapCaptionLines(
  text: string,
  maxCharacters = 14,
  maxLines = 2,
) {
  const characters = Array.from(text.trim());
  if (characters.length <= maxCharacters) return [characters.join("")];

  const lines: string[] = [];
  let start = 0;
  while (start < characters.length && lines.length < maxLines) {
    const remaining = characters.length - start;
    const slots = maxLines - lines.length;
    const target = Math.min(
      maxCharacters,
      Math.max(1, Math.ceil(remaining / slots)),
    );
    const end =
      lines.length === maxLines - 1
        ? Math.min(characters.length, start + maxCharacters)
        : findNaturalBreak(characters, start, target);
    let line = characters.slice(start, end).join("").trim();
    start = end;
    if (lines.length === maxLines - 1 && start < characters.length && line) {
      line = `${Array.from(line).slice(0, Math.max(1, maxCharacters - 1)).join("")}…`;
      start = characters.length;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function getCaptionPresentation(
  caption: { accent?: boolean; highlight?: string },
  keptIndex: number,
): CaptionPresentation {
  if (keptIndex === 0) return "hook";
  if (caption.highlight && /\d/u.test(caption.highlight)) return "metric";
  if (caption.accent || caption.highlight) return "emphasis";
  return "standard";
}

export function getCaptionEntranceProgress(
  currentTime: number,
  captionStart: number,
) {
  return Math.max(0, Math.min(1, (currentTime - captionStart) / 0.18));
}
