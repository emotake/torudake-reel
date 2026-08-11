import type { InputAudioTrack } from "mediabunny";

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
  containerMimeType: string | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  codecParameterString: string | null;
  averageBitrate: number | null;
  averageFrameRate: number | null;
  packetCount: number | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  audioTrackPresent: boolean | null;
  audioCodec: string | null;
  audioCodecParameterString: string | null;
  audioDurationSeconds: number | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  audioRms: number | null;
  audioPeak: number | null;
  audioActivityRanges: VideoExportAudioActivityMetric[] | null;
};

export type VideoExportTimedRange = Readonly<{
  start: number;
  end: number;
}>;

export type VideoExportAudioActivityMetric = VideoExportTimedRange & {
  rms: number;
  peak: number;
  activeRatio: number;
  sampledFrames: number;
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
        | "no-audio-track"
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
  | "h264-profile-fallback"
  | "duration-unavailable"
  | "duration-mismatch"
  | "audio-track-unavailable"
  | "audio-track-missing"
  | "audio-codec-unavailable"
  | "audio-codec-compatibility"
  | "audio-duration-unavailable"
  | "audio-duration-mismatch"
  | "audio-audibility-unavailable"
  | "audio-silent"
  | "narration-audibility-unavailable"
  | "narration-audio-missing"
  | "caption-timing-outside-video";

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
  expectedDurationSeconds?: number;
  durationToleranceSeconds?: number;
  requireAudio?: boolean;
  requireCompatibleAudio?: boolean;
  expectedNarrationRanges?: readonly VideoExportTimedRange[];
  captionRanges?: readonly VideoExportTimedRange[];
  minimumAudibleRms?: number;
  minimumNarrationActiveRatio?: number;
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
  /** Expected speech positions in the finalized, edited timeline. */
  expectedNarrationRanges?: readonly VideoExportTimedRange[];
  /** Decode audio to confirm that the encoded track contains audible data. */
  inspectAudioActivity?: boolean;
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
  getPrimaryAudioTrack?(): Promise<VideoQualityInspectableAudioTrack | null>;
};

export type VideoQualityInspectableAudioTrack = {
  getCodec(): Promise<string | null>;
  getCodecParameterString(): Promise<string | null>;
  getDurationFromMetadata(): Promise<number | null>;
  computeDuration(): Promise<number>;
  getNumberOfChannels(): Promise<number>;
  getSampleRate(): Promise<number>;
  canDecode?(): Promise<boolean>;
  inspectActivityRanges?(
    ranges: readonly VideoExportTimedRange[],
  ): Promise<VideoExportAudioActivityMetric[]>;
};

const ALL_METRICS: VideoExportQualityMetric[] = [
  "containerMimeType",
  "width",
  "height",
  "codec",
  "codecParameterString",
  "averageBitrate",
  "averageFrameRate",
  "packetCount",
  "durationSeconds",
  "fileSizeBytes",
  "audioTrackPresent",
  "audioCodec",
  "audioCodecParameterString",
  "audioDurationSeconds",
  "audioChannels",
  "audioSampleRate",
  "audioRms",
  "audioPeak",
  "audioActivityRanges",
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

async function readAudioDurationSeconds(
  track: VideoQualityInspectableAudioTrack,
) {
  const metadataDuration = finiteOrNull(
    await safelyRead(() => track.getDurationFromMetadata()),
  );
  if (metadataDuration !== null) return metadataDuration;
  return finiteOrNull(await safelyRead(() => track.computeDuration()));
}

function normalizeTimedRanges(
  ranges: readonly VideoExportTimedRange[] | undefined,
  duration: number,
) {
  if (!ranges || ranges.length === 0) return [];
  return ranges
    .map((range) => ({
      start: Math.max(0, Math.min(duration, range.start)),
      end: Math.max(0, Math.min(duration, range.end)),
    }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.end - range.start >= 0.04,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .slice(0, 100);
}

function buildAudioInspectionRanges(
  duration: number,
  expectedRanges: readonly VideoExportTimedRange[] | undefined,
) {
  const normalized = normalizeTimedRanges(expectedRanges, duration);
  if (normalized.length > 0) return normalized;
  if (duration <= 30) return [{ start: 0, end: duration }];

  const probeDuration = Math.min(5, duration / 3);
  const middleStart = Math.max(
    probeDuration,
    duration / 2 - probeDuration / 2,
  );
  return [
    { start: 0, end: probeDuration },
    {
      start: middleStart,
      end: Math.min(duration, middleStart + probeDuration),
    },
    { start: Math.max(0, duration - probeDuration), end: duration },
  ];
}

type MutableAudioRangeMeasurement = {
  start: number;
  end: number;
  sumSquares: number;
  peak: number;
  sampledFrames: number;
  windowSquares: Float64Array;
  windowSamples: Uint32Array;
};

const AUDIO_ACTIVITY_WINDOW_SECONDS = 0.02;
const MAX_ANALYZED_FRAMES_PER_RANGE = 240_000;

function createAudioRangeMeasurement(
  range: VideoExportTimedRange,
): MutableAudioRangeMeasurement {
  const windowCount = Math.max(
    1,
    Math.ceil((range.end - range.start) / AUDIO_ACTIVITY_WINDOW_SECONDS),
  );
  return {
    ...range,
    sumSquares: 0,
    peak: 0,
    sampledFrames: 0,
    windowSquares: new Float64Array(windowCount),
    windowSamples: new Uint32Array(windowCount),
  };
}

function finishAudioRangeMeasurement(
  measurement: MutableAudioRangeMeasurement,
): VideoExportAudioActivityMetric {
  let activeWindows = 0;
  let measuredWindows = 0;
  for (let index = 0; index < measurement.windowSamples.length; index += 1) {
    const count = measurement.windowSamples[index];
    if (count === 0) continue;
    measuredWindows += 1;
    const rms = Math.sqrt(measurement.windowSquares[index] / count);
    if (rms >= 0.0035) activeWindows += 1;
  }
  return {
    start: measurement.start,
    end: measurement.end,
    rms:
      measurement.sampledFrames > 0
        ? Math.sqrt(measurement.sumSquares / measurement.sampledFrames)
        : 0,
    peak: measurement.peak,
    activeRatio: measuredWindows > 0 ? activeWindows / measuredWindows : 0,
    sampledFrames: measurement.sampledFrames,
  };
}

async function inspectDecodedAudioActivity(
  media: typeof import("mediabunny"),
  audioTrack: InputAudioTrack,
  ranges: readonly VideoExportTimedRange[],
) {
  if (!(await audioTrack.canDecode())) return null;
  const measurements = ranges.map(createAudioRangeMeasurement);
  if (measurements.length === 0) return [];
  const firstTimestamp = measurements[0].start;
  const lastTimestamp = measurements.at(-1)!.end;
  const sink = new media.AudioSampleSink(audioTrack);

  for await (const audioSample of sink.samples(firstTimestamp, lastTimestamp)) {
    try {
      const sampleStart = audioSample.timestamp;
      const sampleEnd = audioSample.timestamp + audioSample.duration;
      for (const measurement of measurements) {
        const overlapStart = Math.max(measurement.start, sampleStart);
        const overlapEnd = Math.min(measurement.end, sampleEnd);
        if (overlapEnd <= overlapStart) continue;
        const startFrame = Math.max(
          0,
          Math.floor((overlapStart - sampleStart) * audioSample.sampleRate),
        );
        const endFrame = Math.min(
          audioSample.numberOfFrames,
          Math.ceil((overlapEnd - sampleStart) * audioSample.sampleRate),
        );
        const frameCount = Math.max(0, endFrame - startFrame);
        if (frameCount === 0) continue;
        const estimatedFrames = Math.max(
          1,
          Math.ceil(
            (measurement.end - measurement.start) * audioSample.sampleRate,
          ),
        );
        const stride = Math.max(
          1,
          Math.ceil(estimatedFrames / MAX_ANALYZED_FRAMES_PER_RANGE),
        );
        for (
          let channel = 0;
          channel < audioSample.numberOfChannels;
          channel += 1
        ) {
          const samples = new Float32Array(frameCount);
          audioSample.copyTo(samples, {
            planeIndex: channel,
            format: "f32-planar",
            frameOffset: startFrame,
            frameCount,
          });
          for (let frame = 0; frame < frameCount; frame += stride) {
            const value = samples[frame];
            if (!Number.isFinite(value)) continue;
            const square = value * value;
            measurement.sumSquares += square;
            measurement.peak = Math.max(measurement.peak, Math.abs(value));
            measurement.sampledFrames += 1;
            const absoluteTime =
              sampleStart + (startFrame + frame) / audioSample.sampleRate;
            const windowIndex = Math.min(
              measurement.windowSamples.length - 1,
              Math.max(
                0,
                Math.floor(
                  (absoluteTime - measurement.start) /
                    AUDIO_ACTIVITY_WINDOW_SECONDS,
                ),
              ),
            );
            measurement.windowSquares[windowIndex] += square;
            measurement.windowSamples[windowIndex] += 1;
          }
        }
      }
    } finally {
      audioSample.close();
    }
  }

  return measurements.map(finishAudioRangeMeasurement);
}

function summarizeAudioActivity(
  ranges: readonly VideoExportAudioActivityMetric[] | null,
) {
  if (!ranges || ranges.length === 0) {
    return { rms: null, peak: null };
  }
  let sumSquares = 0;
  let sampledFrames = 0;
  let peak = 0;
  for (const range of ranges) {
    sumSquares += range.rms * range.rms * range.sampledFrames;
    sampledFrames += range.sampledFrames;
    peak = Math.max(peak, range.peak);
  }
  return {
    rms: sampledFrames > 0 ? Math.sqrt(sumSquares / sampledFrames) : null,
    peak: sampledFrames > 0 ? peak : null,
  };
}

function inspectAudioBufferActivity(
  buffer: AudioBuffer,
  ranges: readonly VideoExportTimedRange[],
) {
  return ranges.map((range) => {
    const measurement = createAudioRangeMeasurement(range);
    const startFrame = Math.max(0, Math.floor(range.start * buffer.sampleRate));
    const endFrame = Math.min(
      buffer.length,
      Math.ceil(range.end * buffer.sampleRate),
    );
    const frameCount = Math.max(0, endFrame - startFrame);
    const stride = Math.max(
      1,
      Math.ceil(frameCount / MAX_ANALYZED_FRAMES_PER_RANGE),
    );
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let frame = startFrame; frame < endFrame; frame += stride) {
        const value = samples[frame];
        if (!Number.isFinite(value)) continue;
        const square = value * value;
        measurement.sumSquares += square;
        measurement.peak = Math.max(measurement.peak, Math.abs(value));
        measurement.sampledFrames += 1;
        const absoluteTime = frame / buffer.sampleRate;
        const windowIndex = Math.min(
          measurement.windowSamples.length - 1,
          Math.max(
            0,
            Math.floor(
              (absoluteTime - measurement.start) /
                AUDIO_ACTIVITY_WINDOW_SECONDS,
            ),
          ),
        );
        measurement.windowSquares[windowIndex] += square;
        measurement.windowSamples[windowIndex] += 1;
      }
    }
    return finishAudioRangeMeasurement(measurement);
  });
}

async function inspectBlobAudioActivityWithWebAudio(
  source: Blob,
  ranges: readonly VideoExportTimedRange[],
) {
  if (source.size > 96 * 1024 * 1024 || typeof window === "undefined") {
    return null;
  }
  const AudioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  const context = new AudioContextConstructor();
  try {
    const buffer = await context.decodeAudioData(await source.arrayBuffer());
    return inspectAudioBufferActivity(buffer, ranges);
  } finally {
    await context.close().catch(() => undefined);
  }
}

function getUnavailableMetrics(metrics: VideoExportQualityMetrics) {
  return ALL_METRICS.filter((metric) => metrics[metric] === null);
}

/**
 * Reads the encoded result without decoding or modifying it. This function is
 * deliberately non-throwing so callers can show a precise validation error.
 * A caller offering a download must still require a successful inspection;
 * an unreadable result is not treated as a valid completed video.
 */
export async function inspectVideoExportQuality(
  source: Blob | VideoQualityInspectableInput,
  options: VideoExportQualityInspectionOptions = {},
): Promise<VideoExportQualityInspection> {
  let input: VideoQualityInspectableInput | null = null;
  let ownedInput: { dispose?: () => void } | null = null;
  let mediaModule: typeof import("mediabunny") | null = null;
  const fileSizeBytes = isBlobLike(source)
    ? finiteOrNull(source.size, true)
    : null;
  const containerMimeType =
    isBlobLike(source) && typeof source.type === "string" && source.type
      ? source.type.toLowerCase()
      : null;

  try {
    if (isInspectableInput(source)) {
      input = source;
    } else if (isBlobLike(source)) {
      try {
        mediaModule = await import("mediabunny");
      } catch {
        return {
          status: "unsupported-environment",
          metrics: null,
          unavailableMetrics: [...ALL_METRICS],
          message: "この環境では完成動画の品質を確認できませんでした。",
        };
      }

      const createdInput = new mediaModule.Input({
        source: new mediaModule.BlobSource(source),
        formats: mediaModule.ALL_FORMATS,
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

    const audioTrack = input.getPrimaryAudioTrack
      ? await safelyRead(() => input!.getPrimaryAudioTrack!())
      : null;
    let audioCodec: string | null = null;
    let audioCodecParameterString: string | null = null;
    let audioDurationSeconds: number | null = null;
    let audioChannels: number | null = null;
    let audioSampleRate: number | null = null;
    let audioActivityRanges: VideoExportAudioActivityMetric[] | null = null;
    if (audioTrack) {
      [
        audioCodec,
        audioCodecParameterString,
        audioDurationSeconds,
        audioChannels,
        audioSampleRate,
      ] = await Promise.all([
        safelyRead(() => audioTrack.getCodec()).then((value) =>
          typeof value === "string" && value ? value : null,
        ),
        safelyRead(() => audioTrack.getCodecParameterString()).then((value) =>
          typeof value === "string" && value ? value : null,
        ),
        readAudioDurationSeconds(audioTrack),
        safelyRead(() => audioTrack.getNumberOfChannels()).then((value) =>
          finiteOrNull(value),
        ),
        safelyRead(() => audioTrack.getSampleRate()).then((value) =>
          finiteOrNull(value),
        ),
      ]);

      if (
        options.inspectAudioActivity !== false &&
        audioDurationSeconds !== null
      ) {
        const activityRanges = buildAudioInspectionRanges(
          audioDurationSeconds,
          options.expectedNarrationRanges,
        );
        if (audioTrack.inspectActivityRanges) {
          audioActivityRanges = await safelyRead(() =>
            audioTrack.inspectActivityRanges!(activityRanges),
          );
        } else if (mediaModule) {
          audioActivityRanges = await safelyRead(() =>
            inspectDecodedAudioActivity(
              mediaModule!,
              audioTrack as InputAudioTrack,
              activityRanges,
            ),
          );
        }
        if (audioActivityRanges === null && isBlobLike(source)) {
          audioActivityRanges = await safelyRead(() =>
            inspectBlobAudioActivityWithWebAudio(source, activityRanges),
          );
        }
      }
    }

    const audioLevel = summarizeAudioActivity(audioActivityRanges);

    const metrics: VideoExportQualityMetrics = {
      containerMimeType,
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
      audioTrackPresent: Boolean(audioTrack),
      audioCodec,
      audioCodecParameterString,
      audioDurationSeconds,
      audioChannels,
      audioSampleRate,
      audioRms: audioLevel.rms,
      audioPeak: audioLevel.peak,
      audioActivityRanges,
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

function isCompatibleAudioCodec(
  codec: string | null,
  parameterString: string | null,
  containerMimeType: string | null,
) {
  const values = [codec, parameterString]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  const isAac = values.some(
    (value) => value === "aac" || value.startsWith("mp4a.40"),
  );
  const isOpus = values.some((value) => value === "opus");
  const isVorbis = values.some((value) => value === "vorbis");
  const isMp3 = values.some(
    (value) => value === "mp3" || value.includes("mp4a.69") || value.includes("mp4a.6b"),
  );
  if (containerMimeType?.includes("webm")) return isOpus || isVorbis;
  if (containerMimeType?.includes("mp4") || containerMimeType?.includes("quicktime")) {
    return isAac || isMp3;
  }
  return isAac || isOpus || isVorbis || isMp3;
}

function getDurationTolerance(
  expectedDurationSeconds: number,
  configuredTolerance: number | undefined,
) {
  if (
    typeof configuredTolerance === "number" &&
    Number.isFinite(configuredTolerance) &&
    configuredTolerance >= 0
  ) {
    return configuredTolerance;
  }
  return Math.max(0.35, Math.min(1.5, expectedDurationSeconds * 0.015));
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
    requireAudio: false,
    requireCompatibleAudio: true,
    minimumAudibleRms: 0.0025,
    minimumNarrationActiveRatio: 0.08,
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

  const expectedDuration = finiteOrNull(target.expectedDurationSeconds);
  if (expectedDuration !== null) {
    if (metrics.durationSeconds === null) {
      issues.push({
        code: "duration-unavailable",
        severity: "error",
        message: "完成動画の長さを確認できませんでした。",
      });
    } else {
      const tolerance = getDurationTolerance(
        expectedDuration,
        target.durationToleranceSeconds,
      );
      if (Math.abs(metrics.durationSeconds - expectedDuration) > tolerance) {
        issues.push({
          code: "duration-mismatch",
          severity: "error",
          message: `完成動画が予定の長さ（約${Math.round(expectedDuration)}秒）と一致しません。`,
        });
      }
    }
  }

  if (target.requireAudio) {
    if (metrics.audioTrackPresent === null) {
      issues.push({
        code: "audio-track-unavailable",
        severity: "error",
        message: "完成動画の音声トラックを確認できませんでした。",
      });
    } else if (!metrics.audioTrackPresent) {
      issues.push({
        code: "audio-track-missing",
        severity: "error",
        message: "完成動画に音声が入っていません。",
      });
    } else {
      const hasAudioCodec =
        metrics.audioCodec !== null ||
        metrics.audioCodecParameterString !== null;
      if (!hasAudioCodec) {
        issues.push({
          code: "audio-codec-unavailable",
          severity: "error",
          message: "完成動画の音声形式を確認できませんでした。",
        });
      } else if (
        target.requireCompatibleAudio &&
        !isCompatibleAudioCodec(
          metrics.audioCodec,
          metrics.audioCodecParameterString,
          metrics.containerMimeType,
        )
      ) {
        issues.push({
          code: "audio-codec-compatibility",
          severity: "error",
          message: "完成動画の音声形式がiPhoneやSNS投稿に適していません。",
        });
      }

      if (metrics.audioDurationSeconds === null) {
        issues.push({
          code: "audio-duration-unavailable",
          severity: "error",
          message: "完成動画の音声の長さを確認できませんでした。",
        });
      } else if (
        metrics.durationSeconds !== null &&
        Math.abs(metrics.audioDurationSeconds - metrics.durationSeconds) >
          getDurationTolerance(metrics.durationSeconds, target.durationToleranceSeconds)
      ) {
        issues.push({
          code: "audio-duration-mismatch",
          severity: "error",
          message: "映像と音声の長さが一致していません。",
        });
      }

      if (metrics.audioRms === null) {
        issues.push({
          code: "audio-audibility-unavailable",
          severity: "error",
          message: "完成動画の音声が聞こえる状態か確認できませんでした。",
        });
      } else if (metrics.audioRms < (target.minimumAudibleRms ?? 0.0025)) {
        issues.push({
          code: "audio-silent",
          severity: "error",
          message: "完成動画の音声が無音に近い状態です。",
        });
      }
    }
  }

  const expectedNarrationRanges = target.expectedNarrationRanges ?? [];
  if (expectedNarrationRanges.length > 0) {
    const measuredRanges = metrics.audioActivityRanges;
    if (!measuredRanges || measuredRanges.length < expectedNarrationRanges.length) {
      issues.push({
        code: "narration-audibility-unavailable",
        severity: "error",
        message: "AIナレーションが完成動画へ入ったことを確認できませんでした。",
      });
    } else {
      const minimumRms = target.minimumAudibleRms ?? 0.0025;
      const minimumActiveRatio = target.minimumNarrationActiveRatio ?? 0.08;
      const missingNarration = measuredRanges.some(
        (range, index) => {
          const expected = expectedNarrationRanges[index];
          if (!expected) return false;
          const expectedDurationForRange = expected.end - expected.start;
          if (expectedDurationForRange < 0.12) return false;
          return (
            range.sampledFrames === 0 ||
            range.rms < minimumRms ||
            range.activeRatio < minimumActiveRatio
          );
        },
      );
      if (missingNarration) {
        issues.push({
          code: "narration-audio-missing",
          severity: "error",
          message: "AIナレーションが聞こえない区間があります。書き出し結果は保存できません。",
        });
      }
    }
  }

  const captionRanges = target.captionRanges ?? [];
  if (captionRanges.length > 0) {
    const duration = metrics.durationSeconds;
    const tolerance = duration === null
      ? 0
      : getDurationTolerance(duration, target.durationToleranceSeconds);
    const invalidCaptionRange =
      duration === null ||
      captionRanges.some(
        (range) =>
          !Number.isFinite(range.start) ||
          !Number.isFinite(range.end) ||
          range.start < -tolerance ||
          range.end <= range.start ||
          range.end > duration + tolerance,
      );
    if (invalidCaptionRange) {
      issues.push({
        code: "caption-timing-outside-video",
        severity: "error",
        message: "テロップの表示時間と完成動画の長さが一致していません。",
      });
    }
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
    hasCodec &&
    (expectedDuration === null || metrics.durationSeconds !== null) &&
    (!target.requireAudio ||
      (metrics.audioTrackPresent === true &&
        metrics.audioDurationSeconds !== null &&
        metrics.audioRms !== null));

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
  targetOverrides: Partial<VideoExportQualityTarget> = {},
): VideoExportQualityAssessment {
  if (inspection.status !== "ok") {
    return {
      verdict: "fail",
      meetsTargetResolution: null,
      isComplete: false,
      issues: [
        {
          code: "resolution-unavailable",
          severity: "error",
          message: inspection.message,
        },
      ],
    };
  }

  return assessVideoExportQuality(inspection.metrics, {
    expectedWidth: expectedDimensions?.width,
    expectedHeight: expectedDimensions?.height,
    ...targetOverrides,
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
