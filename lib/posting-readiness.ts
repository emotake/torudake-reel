export type PostingReadinessStatus = "pass" | "warning" | "pending";

export type PostingReadinessCheck = Readonly<{
  id: "duration" | "captions" | "resolution" | "media";
  label: string;
  status: PostingReadinessStatus;
  detail: string;
}>;

export type PostingReadinessInput = Readonly<{
  durationSeconds: number;
  captionsEnabled: boolean;
  unreadableCaptionCount: number;
  outputWidth?: number | null;
  outputHeight?: number | null;
  exportVerified: boolean;
  exportQualityMessage?: string | null;
}>;

function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes > 0
    ? `${minutes}分${String(remainder).padStart(2, "0")}秒`
    : `${remainder}秒`;
}

/**
 * Builds the customer-facing posting checklist from values already calculated
 * by the editor. It is deterministic and never invokes an external service.
 */
export function buildPostingReadinessChecklist(
  input: PostingReadinessInput,
): PostingReadinessCheck[] {
  const duration = Number.isFinite(input.durationSeconds)
    ? Math.max(0, input.durationSeconds)
    : 0;
  const unreadableCaptionCount = Number.isFinite(input.unreadableCaptionCount)
    ? Math.max(0, Math.floor(input.unreadableCaptionCount))
    : 0;
  const width = Number(input.outputWidth);
  const height = Number(input.outputHeight);
  const dimensionsKnown =
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const shortEdge = dimensionsKnown ? Math.min(width, height) : 0;

  const captionCheck: PostingReadinessCheck = !input.captionsEnabled
    ? {
        id: "captions",
        label: "テロップ",
        status: "pass",
        detail: "テロップなしの設定です。",
      }
    : unreadableCaptionCount === 0
      ? {
          id: "captions",
          label: "テロップ",
          status: "pass",
          detail: "表示時間と読みやすさを確認済みです。",
        }
      : {
          id: "captions",
          label: "テロップ",
          status: "warning",
          detail: `読み切りにくい可能性があるテロップが${unreadableCaptionCount}件あります。`,
        };

  const resolutionCheck: PostingReadinessCheck = !dimensionsKnown
    ? {
        id: "resolution",
        label: "画面サイズ",
        status: "pending",
        detail: "元動画の解像度を確認しています。",
      }
    : shortEdge >= 720
      ? {
          id: "resolution",
          label: "画面サイズ",
          status: "pass",
          detail: `${Math.round(width)}×${Math.round(height)}で書き出す予定です。`,
        }
      : {
          id: "resolution",
          label: "画面サイズ",
          status: "warning",
          detail: `${Math.round(width)}×${Math.round(height)}です。画質は元動画の解像度に準じます。`,
        };

  return [
    {
      id: "duration",
      label: "動画の長さ",
      status: duration > 0 ? "pass" : "pending",
      detail:
        duration > 0
          ? `仕上がりは約${formatDuration(duration)}です。`
          : "仕上がりの長さを計算しています。",
    },
    captionCheck,
    resolutionCheck,
    input.exportVerified
      ? {
          id: "media",
          label: "映像と音声",
          status: "pass",
          detail:
            input.exportQualityMessage?.trim() ||
            "黒画面・静止・音声トラックを確認済みです。",
        }
      : {
          id: "media",
          label: "映像と音声",
          status: "pending",
          detail: "書き出し時に黒画面・静止・音声トラックを自動確認します。",
        },
  ];
}
