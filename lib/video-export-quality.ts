export const DEFAULT_VIDEO_EXPORT_QUALITY_TARGET = {
  minimumShortEdge: 1080,
  targetBitrate: 10_000_000,
  minimumBitrate: 4_000_000,
  criticalBitrate: 2_000_000,
  targetFrameRate: 30,
  minimumFrameRate: 23.5,
  criticalFrameRate: 15,
} as const;

export type VideoExportQualityMetrics = {
  width: number | null;
  height: number | null;
  codec: string | null;
  codecParameterString: string | null;
  averageBitrate: number | null;
  averageFrameRate: number | null;
  packetCount: number | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
};

export type VideoExportQualityMetric = keyof VideoExportQualityMetrics;

export type VideoExportQualityInspection =
  | {
      status: "ok";
      metrics: VideoExportQualityMetrics;
      unavailableMetrics: VideoExportQualityMetric[];
      message: string;
    }
  | {
      status:
        | "unsupported-environment"
        | "unreadable-file"
        | "no-video-track"
        | "analysis-failed";
      metrics: null;
      unavailableMetrics: VideoExportQualityMetric[];
      message: string;
    };

export type VideoExportQualityIssueCode =
  | "resolution-unavailable"
  | "resolution-below-target"
  | "bitrate-unavailable"
  | "bitrate-critical"
  | "bitrate-below-recommended"
  | "frame-rate-unavailable"
  | "frame-rate-critical"
  | "frame-rate-below-recommended"
  | "codec-unavailable"
  | "codec-compatibility"
  | "h264-profile-fallback";

export type VideoExportQualityIssue = {
  code: VideoExportQualityIssueCode;
  severity: "info" | "warning" | "error";
  message: string;
};

export type VideoExportQualityTarget = {
  minimumShortEdge: number;
  targetBitrate: number;
  minimumBitrate: number;
  criticalBitrate: number;
  targetFrameRate: number;
  minimumFrameRate: number;
  criticalFrameRate: number;
  expectedWidth?: number;
  expectedHeight?: number;
  requireH264?: boolean;
  preferH264HighProfile?: boolean;
  /** Opt in only when a fixed-bitrate encoder is used. VBR is advisory. */
  useBitrateForVerdict?: boolean;
};

export type VideoExportQualityAssessment = {
  verdict: "pass" | "warning" | "fail" | "unknown";
  meetsTargetResolution: boolean | null;
  isComplete: boolean;
  issues: VideoExportQualityIssue[];
};

export type VideoExportQualityInspectionOptions = {
  /**
   * Limits packet scanning when a quick estimate is sufficient. By default,
   * every packet is inspected so the returned bitrate covers the whole video.
   */
  packetSampleCount?: number;
};

type PacketStatsLike = {
  packetCount: number;
  averagePacketRate: number;
  averageBitrate: number;
};

export type VideoQualityInspectableTrack = {
  getDisplayWidth(): Promise<number>;
  getDisplayHeight(): Promise<number>;
  getCodec(): Promise<string | null>;
  getCodecParameterString(): Promise<string | null>;
  getDurationFromMetadata(): Promise<number | null>;
  computeDuration(): Promise<number>;
  computePacketStats(
    targetPacketCount?: number,
  ): Promise<PacketStatsLike>;
};

export type VideoQualityInspectableInput = {
  canRead(): Promise<boolean>;
  getPrimaryVideoTrack(): Promise<VideoQualityInspectableTrack | null>;
};

const ALL_METRICS: VideoExportQualityMetric[] = [
  "width",
  "height",
  "codec",
  "codecParameterString",
  "averageBitrate",
  "averageFrameRate",
  "packetCount",
  "durationSeconds",
  "fileSizeBytes",
];

function isBlobLike(source: unknown): source is Blob {
  if (!source || typeof source !== "object") {
    return false;
  }

  const candidate = source as Partial<Blob>;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.slice === "function" &&
    typeof candidate.arrayBuffer === "function"
  );
}

function isInspectableInput(
  source: unknown,
): source is VideoQualityInspectableInput {
  if (!source || typeof source !== "object") {
    return false;
  }

  const candidate = source as Partial<VideoQualityInspectableInput>;
  return (
    typeof candidate.canRead === "function" &&
    typeof candidate.getPrimaryVideoTrack === "function"
  );
}

function finiteOrNull(value: unknown, allowZero = false) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    return null;
  }
  return value;
}

async function safelyRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function readDurationSeconds(track: VideoQualityInspectableTrack) {
  const metadataDuration = finiteOrNull(
    await safelyRead(() => track.getDurationFromMetadata()),
  );
  if (metadataDuration !== null) {
    return metadataDuration;
  }

  return finiteOrNull(await safelyRead(() => track.computeDuration()));
}

function getUnavailableMetrics(metrics: VideoExportQualityMetrics) {
  return ALL_METRICS.filter((metric) => metrics[metric] === null);
}

/**
 * Reads the encoded result without decoding or modifying it. This function is
 * deliberately non-throwing so a diagnostic failure can never invalidate a
 * successfully exported video.
 */
export async function inspectVideoExportQuality(
  source: Blob | VideoQualityInspectableInput,
  options: VideoExportQualityInspectionOptions = {},
): Promise<VideoExportQualityInspection> {
  let input: VideoQualityInspectableInput | null = null;
  let ownedInput: { dispose?: () => void } | null = null;
  const fileSizeBytes = isBlobLike(source)
    ? finiteOrNull(source.size, true)
    : null;

  try {
    if (isInspectableInput(source)) {
      input = source;
    } else if (isBlobLike(source)) {
      let media: typeof import("mediabunny");
      try {
        media = await import("mediabunny");
      } catch {
        return {
          status: "unsupported-environment",
          metrics: null,
          unavailableMetrics: [...ALL_METRICS],
          message: "この環境では完成動画の品質を確認できませんでした。",
        };
      }

      const createdInput = new media.Input({
        source: new media.BlobSource(source),
        formats: media.ALL_FORMATS,
      });
      input = createdInput;
      ownedInput = createdInput;
    } else {
      return {
        status: "unsupported-environment",
        metrics: null,
        unavailableMetrics: [...ALL_METRICS],
        message: "完成動画の品質確認に対応していない入力です。",
      };
    }

    if (!(await input.canRead())) {
      return {
        status: "unreadable-file",
        metrics: null,
        unavailableMetrics: [...ALL_METRICS],
        message: "完成動画の形式を読み取れませんでした。動画自体はそのまま利用できます。",
      };
    }

    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      return {
        status: "no-video-track",
        metrics: null,
        unavailableMetrics: [...ALL_METRICS],
        message: "完成ファイルに映像トラックが見つかりませんでした。",
      };
    }

    const requestedPacketCount = options.packetSampleCount;
    const packetSampleCount =
      typeof requestedPacketCount === "number" &&
      Number.isFinite(requestedPacketCount) &&
      requestedPacketCount > 0
        ? Math.floor(requestedPacketCount)
        : undefined;

    const [width, height, codec, codecParameterString, durationSeconds, stats] =
      await Promise.all([
        safelyRead(() => track.getDisplayWidth()),
        safelyRead(() => track.getDisplayHeight()),
        safelyRead(() => track.getCodec()),
        safelyRead(() => track.getCodecParameterString()),
        readDurationSeconds(track),
        safelyRead(() => track.computePacketStats(packetSampleCount)),
      ]);

    const metrics: VideoExportQualityMetrics = {
      width: finiteOrNull(width),
      height: finiteOrNull(height),
      codec: typeof codec === "string" && codec.length > 0 ? codec : null,
      codecParameterString:
        typeof codecParameterString === "string" &&
        codecParameterString.length > 0
          ? codecParameterString
          : null,
      averageBitrate: finiteOrNull(stats?.averageBitrate),
      averageFrameRate: finiteOrNull(stats?.averagePacketRate),
      packetCount: finiteOrNull(stats?.packetCount, true),
      durationSeconds,
      fileSizeBytes,
    };

    return {
      status: "ok",
      metrics,
      unavailableMetrics: getUnavailableMetrics(metrics),
      message:
        getUnavailableMetrics(metrics).length === 0
          ? "完成動画の品質を確認できました。"
          : "完成動画を確認できましたが、一部の品質情報は取得できませんでした。",
    };
  } catch {
    return {
      status: "analysis-failed",
      metrics: null,
      unavailableMetrics: [...ALL_METRICS],
      message: "完成動画の品質確認に失敗しました。動画自体はそのまま利用できます。",
    };
  } finally {
    if (ownedInput?.dispose) {
      try {
        ownedInput.dispose();
      } catch {
        // Quality inspection must never make an otherwise valid export fail.
      }
    }
  }
}

/** App-facing name used after an export Blob has been finalized. */
export async function inspectExportedVideoQuality(
  source: Blob | VideoQualityInspectableInput,
  options: VideoExportQualityInspectionOptions = {},
) {
  return inspectVideoExportQuality(source, options);
}

/** Returns null when the encoded dimensions could not be inspected. */
export function meetsTarget1080pResolution(
  metrics: Pick<VideoExportQualityMetrics, "width" | "height">,
  target: Pick<
    VideoExportQualityTarget,
    "minimumShortEdge" | "expectedWidth" | "expectedHeight"
  > = DEFAULT_VIDEO_EXPORT_QUALITY_TARGET,
): boolean | null {
  const width = finiteOrNull(metrics.width);
  const height = finiteOrNull(metrics.height);
  if (width === null || height === null) {
    return null;
  }

  if (
    typeof target.expectedWidth === "number" &&
    typeof target.expectedHeight === "number"
  ) {
    return width >= target.expectedWidth && height >= target.expectedHeight;
  }

  return Math.min(width, height) >= target.minimumShortEdge;
}

function isH264Codec(codec: string | null, parameterString: string | null) {
  const values = [codec, parameterString]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  return values.some(
    (value) =>
      value === "avc" ||
      value === "h264" ||
      value.startsWith("avc1") ||
      value.startsWith("avc3"),
  );
}

function isH264HighProfile(parameterString: string | null) {
  if (!parameterString) {
    return null;
  }

  const normalized = parameterString.toLowerCase();
  if (!normalized.startsWith("avc1") && !normalized.startsWith("avc3")) {
    return null;
  }

  const profileHex = normalized.match(/^avc[13][.]([0-9a-f]{2})/)?.[1];
  if (!profileHex) {
    return null;
  }

  return profileHex === "64";
}

/**
 * Pure, deterministic quality judgement. The minimum bitrate is intentionally
 * lower than the 10 Mbps encoder target because variable-bitrate encoders use
 * fewer bits for simple scenes without lowering visible quality.
 */
export function assessVideoExportQuality(
  metrics: VideoExportQualityMetrics,
  targetOverrides: Partial<VideoExportQualityTarget> = {},
): VideoExportQualityAssessment {
  const target: VideoExportQualityTarget = {
    ...DEFAULT_VIDEO_EXPORT_QUALITY_TARGET,
    requireH264: true,
    preferH264HighProfile: true,
    useBitrateForVerdict: false,
    ...targetOverrides,
  };
  const issues: VideoExportQualityIssue[] = [];
  const meetsResolution = meetsTarget1080pResolution(metrics, target);

  if (meetsResolution === null) {
    issues.push({
      code: "resolution-unavailable",
      severity: "info",
      message: "完成動画の解像度を確認できませんでした。",
    });
  } else if (!meetsResolution) {
    issues.push({
      code: "resolution-below-target",
      severity: "error",
      message: "完成動画が縦または横1080pの基準に達していません。",
    });
  }

  if (metrics.averageBitrate === null) {
    issues.push({
      code: "bitrate-unavailable",
      severity: "info",
      message: "完成動画の映像ビットレートを確認できませんでした。",
    });
  } else if (metrics.averageBitrate < target.criticalBitrate) {
    issues.push({
      code: "bitrate-critical",
      severity: target.useBitrateForVerdict ? "error" : "info",
      message:
        "映像ビットレートが低めです。可変ビットレートでは静かな映像ほど数値が下がるため、参考値として扱います。",
    });
  } else if (metrics.averageBitrate < target.minimumBitrate) {
    issues.push({
      code: "bitrate-below-recommended",
      severity: target.useBitrateForVerdict ? "warning" : "info",
      message:
        "映像ビットレートが推奨値を下回っていますが、可変ビットレートのため参考値です。",
    });
  }

  if (metrics.averageFrameRate === null) {
    issues.push({
      code: "frame-rate-unavailable",
      severity: "info",
      message: "完成動画のフレームレートを確認できませんでした。",
    });
  } else if (metrics.averageFrameRate < target.criticalFrameRate) {
    issues.push({
      code: "frame-rate-critical",
      severity: "error",
      message: "映像のコマ数が少なく、動きが不自然になる可能性があります。",
    });
  } else if (metrics.averageFrameRate < target.minimumFrameRate) {
    issues.push({
      code: "frame-rate-below-recommended",
      severity: "warning",
      message: "映像のコマ数が推奨値を下回っています。",
    });
  }

  const hasCodec = metrics.codec !== null || metrics.codecParameterString !== null;
  const h264 = isH264Codec(metrics.codec, metrics.codecParameterString);
  if (!hasCodec) {
    issues.push({
      code: "codec-unavailable",
      severity: "info",
      message: "完成動画の映像形式を確認できませんでした。",
    });
  } else if (target.requireH264 && !h264) {
    issues.push({
      code: "codec-compatibility",
      severity: "warning",
      message: "一部のiPhoneで扱いにくい映像形式になっています。",
    });
  } else if (
    h264 &&
    target.preferH264HighProfile &&
    isH264HighProfile(metrics.codecParameterString) === false
  ) {
    issues.push({
      code: "h264-profile-fallback",
      severity: "warning",
      message: "互換用の映像設定で書き出され、圧縮効率が下がっています。",
    });
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  const hasWarning = issues.some((issue) => issue.severity === "warning");
  const hasAnyMeasuredQuality =
    meetsResolution !== null ||
    metrics.averageBitrate !== null ||
    metrics.averageFrameRate !== null;
  const isComplete =
    meetsResolution !== null &&
    metrics.averageBitrate !== null &&
    metrics.averageFrameRate !== null &&
    hasCodec;

  return {
    verdict: hasError
      ? "fail"
      : hasWarning
        ? "warning"
        : hasAnyMeasuredQuality
          ? "pass"
          : "unknown",
    meetsTargetResolution: meetsResolution,
    isComplete,
    issues,
  };
}

/**
 * Assesses an inspection result and optionally checks the exact canvas size
 * selected by the export route (for example 1080 x 1920 for portrait video).
 */
export function assessExportedVideoQuality(
  inspection: VideoExportQualityInspection,
  expectedDimensions?: { width: number; height: number },
): VideoExportQualityAssessment {
  if (inspection.status !== "ok") {
    return {
      verdict: "unknown",
      meetsTargetResolution: null,
      isComplete: false,
      issues: [
        {
          code: "resolution-unavailable",
          severity: "info",
          message: inspection.message,
        },
      ],
    };
  }

  return assessVideoExportQuality(inspection.metrics, {
    expectedWidth: expectedDimensions?.width,
    expectedHeight: expectedDimensions?.height,
  });
}

export type VideoResolutionDimensions = {
  width: number | null;
  height: number | null;
};

export type VideoExportResolutionCause =
  | "target-met"
  | "source-limited"
  | "export-limited"
  | "source-and-export-limited"
  | "unknown";

export type VideoExportResolutionExplanation = {
  cause: VideoExportResolutionCause;
  sourceResolutionLabel: string | null;
  outputResolutionLabel: string | null;
  expectedResolutionLabel: string | null;
  sourceRequiresUpscaling: boolean | null;
  sourceScaleFactor: number | null;
  outputMeetsExpectedDimensions: boolean | null;
  headline: string;
  detail: string;
};

function normalizeResolutionDimensions(
  dimensions: VideoResolutionDimensions | null,
) {
  if (!dimensions) {
    return null;
  }

  const width = finiteOrNull(dimensions.width);
  const height = finiteOrNull(dimensions.height);
  return width === null || height === null ? null : { width, height };
}

function formatResolutionDimensions(
  dimensions: { width: number; height: number } | null,
) {
  return dimensions
    ? `${Math.round(dimensions.width)}×${Math.round(dimensions.height)}`
    : null;
}

/**
 * Explains whether visible resolution limits come from the source material or
 * from the device/browser export result. Source sufficiency follows the
 * current `contain` render mode: landscape or square footage is not labelled
 * low-resolution merely because it does not share the output aspect ratio.
 */
export function explainVideoExportResolution({
  source,
  output,
  expected,
}: {
  source: VideoResolutionDimensions | null;
  output: VideoResolutionDimensions | null;
  expected: VideoResolutionDimensions;
}): VideoExportResolutionExplanation {
  const sourceDimensions = normalizeResolutionDimensions(source);
  const outputDimensions = normalizeResolutionDimensions(output);
  const expectedDimensions = normalizeResolutionDimensions(expected);
  const sourceResolutionLabel = formatResolutionDimensions(sourceDimensions);
  const outputResolutionLabel = formatResolutionDimensions(outputDimensions);
  const expectedResolutionLabel = formatResolutionDimensions(expectedDimensions);

  const sourceScaleFactor =
    sourceDimensions && expectedDimensions
      ? Math.min(
          expectedDimensions.width / sourceDimensions.width,
          expectedDimensions.height / sourceDimensions.height,
        )
      : null;
  const sourceRequiresUpscaling =
    sourceScaleFactor === null ? null : sourceScaleFactor > 1.001;
  const outputMeetsExpectedDimensions =
    outputDimensions && expectedDimensions
      ? outputDimensions.width >= expectedDimensions.width &&
        outputDimensions.height >= expectedDimensions.height
      : null;

  let cause: VideoExportResolutionCause = "unknown";
  if (
    sourceRequiresUpscaling !== null &&
    outputMeetsExpectedDimensions !== null
  ) {
    if (sourceRequiresUpscaling && !outputMeetsExpectedDimensions) {
      cause = "source-and-export-limited";
    } else if (sourceRequiresUpscaling) {
      cause = "source-limited";
    } else if (!outputMeetsExpectedDimensions) {
      cause = "export-limited";
    } else {
      cause = "target-met";
    }
  }

  const headline = outputResolutionLabel
    ? `完成動画：${outputResolutionLabel}`
    : "完成動画の解像度を確認できませんでした";

  let detail: string;
  switch (cause) {
    case "target-met":
      detail = `SNS投稿向けの${expectedResolutionLabel}へ最適化しました。`;
      break;
    case "source-limited":
      detail = `書き出しサイズを${expectedResolutionLabel}に整えています。映像の細かさは元動画（${sourceResolutionLabel}）の解像度に準じ、元動画にない細部は復元できません。`;
      break;
    case "export-limited":
      detail = `元動画（${sourceResolutionLabel}）には目標解像度に必要な精細さがありますが、この端末での完成動画は${outputResolutionLabel}でした。端末またはブラウザの書き出し制約が影響した可能性があります。`;
      break;
    case "source-and-export-limited":
      detail = `元動画が${sourceResolutionLabel}のため、映像の細かさには元動画由来の限界があります。加えて、完成動画は${outputResolutionLabel}で、目標の${expectedResolutionLabel}にも届いていません。`;
      break;
    default:
      if (!expectedDimensions) {
        detail = "目標解像度を確認できないため、書き出し結果を判定できませんでした。";
      } else if (!outputDimensions) {
        detail = sourceResolutionLabel
          ? `元動画は${sourceResolutionLabel}です。完成動画の解像度を端末で確認できなかったため、書き出し結果は判定できませんでした。`
          : "元動画と完成動画の解像度を確認できなかったため、書き出し結果は判定できませんでした。";
      } else if (!sourceDimensions) {
        detail = outputMeetsExpectedDimensions
          ? `完成動画は目標の${expectedResolutionLabel}で書き出されています。元動画の解像度は確認できませんでした。`
          : `完成動画は${outputResolutionLabel}です。元動画の解像度を確認できないため、低解像度の原因を特定できませんでした。`;
      } else {
        detail = "解像度情報を十分に確認できなかったため、書き出し結果は判定できませんでした。";
      }
  }

  return {
    cause,
    sourceResolutionLabel,
    outputResolutionLabel,
    expectedResolutionLabel,
    sourceRequiresUpscaling,
    sourceScaleFactor,
    outputMeetsExpectedDimensions,
    headline,
    detail,
  };
}
