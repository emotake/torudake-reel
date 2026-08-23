export type PublishingTarget = "instagram" | "youtube" | "both";

export type FinishPreset = "natural" | "story" | "impact";

export const PUBLISHING_TARGETS: ReadonlyArray<{
  id: PublishingTarget;
  label: string;
  shortLabel: string;
  note: string;
}> = [
  {
    id: "both",
    label: "Instagram・YouTube Shorts",
    shortLabel: "両方",
    note: "1本を書き出し、投稿時の文章だけ使い分けます",
  },
  {
    id: "instagram",
    label: "Instagram Reels",
    shortLabel: "Instagram",
    note: "投稿文と表紙までまとめて準備します",
  },
  {
    id: "youtube",
    label: "YouTube Shorts",
    shortLabel: "YouTube",
    note: "100文字以内のタイトルと説明文を準備します",
  },
] as const;

export const FINISH_PRESETS: ReadonlyArray<{
  id: FinishPreset;
  label: string;
  note: string;
  captionMood: "auto" | "vlog" | "bold";
}> = [
  {
    id: "natural",
    label: "自然になじむ",
    note: "日常の空気を残し、読みやすく",
    captionMood: "auto",
  },
  {
    id: "story",
    label: "映像を主役に",
    note: "文字を控えめにしてVlogらしく",
    captionMood: "vlog",
  },
  {
    id: "impact",
    label: "最初に惹きつける",
    note: "短い言葉を強く見せる",
    captionMood: "bold",
  },
] as const;

const INVALID_YOUTUBE_TITLE_CHARACTERS = /[<>]/gu;

function cleanLine(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function trimCharacters(value: string, maximum: number) {
  return Array.from(value).slice(0, maximum).join("");
}

function appendDisclosure(value: string, disclosureText: string) {
  const body = value.trim();
  const disclosure = disclosureText.trim();
  if (!disclosure || body.includes(disclosure)) return body;
  return [body, disclosure].filter(Boolean).join("\n\n");
}

export function buildPublishingCopy({
  titleSource,
  body,
  disclosureText = "",
}: {
  titleSource: string;
  body: string;
  disclosureText?: string;
}) {
  const cleanBody = body.trim();
  const firstBodyLine = cleanBody
    .split(/\r?\n/u)
    .map(cleanLine)
    .find(Boolean) ?? "";
  const rawTitle = cleanLine(titleSource) || firstBodyLine || "ショート動画";
  const youtubeTitle = trimCharacters(
    rawTitle.replace(INVALID_YOUTUBE_TITLE_CHARACTERS, ""),
    100,
  );
  const disclosedBody = appendDisclosure(cleanBody, disclosureText);
  const youtubeDescription = [disclosedBody, "#Shorts"]
    .filter(Boolean)
    .join("\n\n");

  return {
    instagramCaption: disclosedBody,
    youtubeTitle,
    youtubeDescription,
  };
}

export function publishingTargetLabel(target: PublishingTarget) {
  return (
    PUBLISHING_TARGETS.find((item) => item.id === target)?.label ??
    PUBLISHING_TARGETS[0].label
  );
}

export function buildPublishingFormatChecks({
  target,
  durationSeconds,
  width,
  height,
}: {
  target: PublishingTarget;
  durationSeconds: number;
  width?: number | null;
  height?: number | null;
}) {
  const duration = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds)
    : 0;
  const dimensionsKnown =
    Number.isFinite(width) && Number(width) > 0 &&
    Number.isFinite(height) && Number(height) > 0;
  const isSquareOrVertical = dimensionsKnown
    ? Number(height) >= Number(width)
    : null;
  const youtubeSelected = target === "youtube" || target === "both";

  return [
    {
      id: "destination" as const,
      status: "pass" as const,
      label: "投稿先",
      detail: publishingTargetLabel(target),
    },
    {
      id: "shorts-duration" as const,
      status:
        youtubeSelected && duration > 180
          ? ("warning" as const)
          : duration > 0
            ? ("pass" as const)
            : ("pending" as const),
      label: youtubeSelected ? "Shortsの長さ" : "リールの長さ",
      detail:
        youtubeSelected && duration > 180
          ? "YouTube Shortsの3分上限を超えています。"
          : duration > 0
            ? "選択した投稿先へ使える長さです。"
            : "仕上がりの長さを計算しています。",
    },
    {
      id: "shorts-orientation" as const,
      status:
        isSquareOrVertical === null
          ? ("pending" as const)
          : isSquareOrVertical
            ? ("pass" as const)
            : ("warning" as const),
      label: "画面の向き",
      detail:
        isSquareOrVertical === null
          ? "元動画の向きを確認しています。"
          : isSquareOrVertical
            ? "縦または正方形のショート動画です。"
            : "横動画です。投稿前にプレビューで表示範囲を確認してください。",
    },
  ];
}
