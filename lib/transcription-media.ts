import {
  TRANSCRIPTION_AUDIO_CHUNK_SECONDS,
  TRANSCRIPTION_AUDIO_SAMPLE_RATE,
  encodeNormalizedMonoWavSamples,
} from "./audio";

import type { AudioCodec, AudioSample, InputAudioTrack } from "mediabunny";

const MAX_AUDIO_CHUNK_SECONDS = TRANSCRIPTION_AUDIO_CHUNK_SECONDS;
const MAX_NORMALIZED_DECODE_DURATION_SECONDS = 5 * 60;
export const OPENAI_TRANSCRIPTION_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;
export const MIN_AUDIO_CHUNK_BYTES = 2 * 1024 * 1024;
const TARGET_AUDIO_CHUNK_RATIO = 0.75;
const MIN_AUDIO_CHUNK_SECONDS = 1;

export type TranscriptionAudioChunk = {
  file: File;
  startSeconds: number;
};

export function getDirectCopyAudioOutput(codec: string | null) {
  if (
    codec === "aac" ||
    codec === "mp3" ||
    codec === "ac3" ||
    codec === "eac3"
  ) {
    return {
      extension: "m4a",
      kind: "mp4" as const,
      mimeType: "audio/mp4",
    };
  }
  if (codec === "opus" || codec === "vorbis") {
    return {
      extension: "webm",
      kind: "webm" as const,
      mimeType: "audio/webm",
    };
  }
  if (codec === "pcm-s16") {
    return {
      extension: "wav",
      kind: "wav" as const,
      mimeType: "audio/wav",
    };
  }
  return null;
}

export function getAudioCodecPriority(codec: string | null) {
  switch (codec) {
    case "aac":
      return 0;
    case "mp3":
      return 1;
    case "opus":
      return 2;
    case "vorbis":
      return 3;
    case "ac3":
      return 4;
    case "eac3":
      return 5;
    case "pcm-s16":
      return 6;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

export function getSafeAudioChunkSeconds(
  bitrate: number | null,
  maxChunkBytes = DEFAULT_MAX_AUDIO_CHUNK_BYTES,
) {
  if (!bitrate || !Number.isFinite(bitrate) || bitrate <= 0) {
    return MAX_AUDIO_CHUNK_SECONDS;
  }

  const targetChunkBytes =
    Math.max(MIN_AUDIO_CHUNK_BYTES, maxChunkBytes) *
    TARGET_AUDIO_CHUNK_RATIO;

  return Math.max(
    MIN_AUDIO_CHUNK_SECONDS,
    Math.min(
      MAX_AUDIO_CHUNK_SECONDS,
      Math.floor((targetChunkBytes * 8) / bitrate),
    ),
  );
}

export function getNormalizedAudioChunkSeconds(
  maxChunkBytes = DEFAULT_MAX_AUDIO_CHUNK_BYTES,
) {
  const safeBytes = Math.min(
    OPENAI_TRANSCRIPTION_MAX_FILE_BYTES - 1024,
    Math.max(MIN_AUDIO_CHUNK_BYTES, Math.floor(maxChunkBytes)) *
      TARGET_AUDIO_CHUNK_RATIO,
  );
  const pcmBytesPerSecond = TRANSCRIPTION_AUDIO_SAMPLE_RATE * 2;
  return Math.max(
    MIN_AUDIO_CHUNK_SECONDS,
    Math.min(
      MAX_AUDIO_CHUNK_SECONDS,
      Math.floor((safeBytes - 44) / pcmBytesPerSecond),
    ),
  );
}

export function buildNormalizedAudioChunkWindows(
  durationSeconds: number,
  maxChunkBytes = DEFAULT_MAX_AUDIO_CHUNK_BYTES,
) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new RangeError("Audio duration must be a finite positive number.");
  }
  const chunkSeconds = getNormalizedAudioChunkSeconds(maxChunkBytes);
  const windows: Array<{ startSeconds: number; durationSeconds: number }> = [];
  for (let startSeconds = 0; startSeconds < durationSeconds; startSeconds += chunkSeconds) {
    windows.push({
      startSeconds,
      durationSeconds: Math.min(chunkSeconds, durationSeconds - startSeconds),
    });
  }
  return windows;
}

function safeBaseName(fileName: string) {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N}_-]+/gu, "_")
      .slice(0, 80) || "video"
  );
}

type AudioSampleSinkLike = {
  samples(
    startTimestamp?: number,
    endTimestamp?: number,
  ): AsyncGenerator<AudioSample, void, unknown>;
};

function downmixFrame(channels: readonly Float32Array[], frame: number) {
  if (channels.length === 1) return channels[0][frame] ?? 0;
  if (channels.length === 2) {
    return ((channels[0][frame] ?? 0) + (channels[1][frame] ?? 0)) / 2;
  }

  // Multichannel iPhone recordings normally place dialog in L/R/center.
  // Giving those channels priority avoids rear ambience cancelling speech.
  return (
    (channels[0][frame] ?? 0) * 0.35 +
    (channels[1][frame] ?? 0) * 0.35 +
    (channels[2][frame] ?? 0) * 0.3
  );
}

async function createNormalizedDecodedChunk(
  sink: AudioSampleSinkLike,
  startSeconds: number,
  durationSeconds: number,
) {
  const outputLength = Math.max(
    1,
    Math.ceil(durationSeconds * TRANSCRIPTION_AUDIO_SAMPLE_RATE),
  );
  const mono = new Float32Array(outputLength);
  let copiedFrames = 0;

  for await (const sample of sink.samples(
    startSeconds,
    startSeconds + durationSeconds,
  )) {
    try {
      const channels = Array.from(
        { length: sample.numberOfChannels },
        (_, channel) => {
          const plane = new Float32Array(sample.numberOfFrames);
          sample.copyTo(plane, {
            planeIndex: channel,
            format: "f32-planar",
          });
          return plane;
        },
      );
      const sampleStart = sample.timestamp;
      const sampleEnd = sample.timestamp + sample.duration;
      const outputStart = Math.max(
        0,
        Math.ceil(
          (sampleStart - startSeconds) * TRANSCRIPTION_AUDIO_SAMPLE_RATE,
        ),
      );
      const outputEnd = Math.min(
        outputLength,
        Math.ceil(
          (sampleEnd - startSeconds) * TRANSCRIPTION_AUDIO_SAMPLE_RATE,
        ),
      );

      for (let outputIndex = outputStart; outputIndex < outputEnd; outputIndex += 1) {
        const outputTime =
          startSeconds + outputIndex / TRANSCRIPTION_AUDIO_SAMPLE_RATE;
        const sourcePosition = (outputTime - sampleStart) * sample.sampleRate;
        if (sourcePosition < 0 || sourcePosition >= sample.numberOfFrames) continue;
        const left = Math.floor(sourcePosition);
        const right = Math.min(sample.numberOfFrames - 1, left + 1);
        const mix = sourcePosition - left;
        const leftValue = downmixFrame(channels, left);
        const rightValue = downmixFrame(channels, right);
        mono[outputIndex] = leftValue + (rightValue - leftValue) * mix;
        copiedFrames += 1;
      }
    } finally {
      sample.close();
    }
  }

  if (copiedFrames === 0) {
    throw new Error("動画の音声トラックをデコードできませんでした。");
  }
  return encodeNormalizedMonoWavSamples(mono);
}

async function collectNormalizedDecodedChunks(
  audioTrack: InputAudioTrack,
  duration: number,
  maxChunkBytes: number,
  baseName: string,
  AudioSampleSink: new (track: InputAudioTrack) => AudioSampleSinkLike,
) {
  if (duration > MAX_NORMALIZED_DECODE_DURATION_SECONDS) return null;
  const sink = new AudioSampleSink(audioTrack);
  const chunks: TranscriptionAudioChunk[] = [];

  for (const [index, window] of buildNormalizedAudioChunkWindows(
    duration,
    maxChunkBytes,
  ).entries()) {
    const wav = await createNormalizedDecodedChunk(
      sink,
      window.startSeconds,
      window.durationSeconds,
    );
    if (wav.byteLength > maxChunkBytes) {
      throw new Error("正規化した音声データが送信上限を超えました。");
    }
    chunks.push({
      file: new File(
        [wav],
        `${baseName}-audio-${String(index + 1).padStart(2, "0")}.wav`,
        { type: "audio/wav" },
      ),
      startSeconds: window.startSeconds,
    });
  }
  return chunks;
}

export async function* extractTranscriptionAudioChunks(
  sourceFile: File,
  options: { maxChunkBytes?: number } = {},
): AsyncGenerator<TranscriptionAudioChunk> {
  const {
    BlobSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    AudioSampleSink,
    Input,
    MP4,
    Mp4OutputFormat,
    Output,
    QTFF,
    WavOutputFormat,
    WEBM,
    WebMOutputFormat,
  } = await import("mediabunny");

  const input = new Input({
    source: new BlobSource(sourceFile),
    formats: [MP4, QTFF, WEBM],
  });

  try {
    if (!(await input.canRead())) {
      throw new Error("動画の形式を読み取れませんでした。");
    }

    const audioTracks = await input.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error("動画に音声が見つかりませんでした。");
    }

    const audioCandidates = await Promise.all(
      audioTracks.map(async (track) => {
        const codec = (await track
          .getCodec()
          .catch(() => null)) as AudioCodec | null;
        return {
          canDecode: await track.canDecode().catch(() => false),
          codec,
          track,
        };
      }),
    );
    const selectedAudio = audioCandidates
      .filter(
        (candidate) =>
          candidate.canDecode || getDirectCopyAudioOutput(candidate.codec),
      )
      .sort(
        (left, right) => {
          if (left.canDecode !== right.canDecode) {
            return left.canDecode ? -1 : 1;
          }
          return (
            getAudioCodecPriority(left.codec) -
            getAudioCodecPriority(right.codec)
          );
        },
      )[0];
    if (!selectedAudio) {
      throw new Error(
        "互換音声トラックが見つかりませんでした（空間オーディオのみの動画には未対応です）。",
      );
    }

    const { canDecode, codec, track: audioTrack } = selectedAudio;
    const duration =
      (await audioTrack.getDurationFromMetadata()) ??
      (await audioTrack.computeDuration());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("動画に音声が見つかりませんでした。");
    }

    const maxChunkBytes = Math.max(
      MIN_AUDIO_CHUNK_BYTES,
      Math.floor(options.maxChunkBytes ?? DEFAULT_MAX_AUDIO_CHUNK_BYTES),
    );
    const baseName = safeBaseName(sourceFile.name);

    if (canDecode) {
      try {
        const normalizedChunks = await collectNormalizedDecodedChunks(
          audioTrack,
          duration,
          maxChunkBytes,
          baseName,
          AudioSampleSink,
        );
        if (normalizedChunks?.length) {
          for (const chunk of normalizedChunks) yield chunk;
          return;
        }
      } catch (error) {
        // No request has been sent yet: all normalized chunks are prepared
        // before yielding, so direct-copy fallback cannot duplicate billing.
        console.warn(
          "Local audio normalization failed; using a larger direct-copy chunk.",
          error,
        );
      }
    }

    const outputSpec = getDirectCopyAudioOutput(codec);
    if (!outputSpec || !codec) {
      throw new Error("動画の音声形式を直接取り出せませんでした。");
    }

    const bitrate =
      (await audioTrack.getAverageBitrate()) ??
      (await audioTrack.getBitrate());
    const decoderConfig = await audioTrack.getDecoderConfig();
    if (!decoderConfig) {
      throw new Error("動画の音声設定を読み取れませんでした。");
    }

    const packetSink = new EncodedPacketSink(audioTrack);
    let chunkSeconds = getSafeAudioChunkSeconds(bitrate, maxChunkBytes);
    let chunkStart = 0;
    let chunkNumber = 1;

    while (chunkStart < duration) {
      const chunkEnd = Math.min(duration, chunkStart + chunkSeconds);
      const target = new BufferTarget();
      const format =
        outputSpec.kind === "mp4"
          ? new Mp4OutputFormat({ fastStart: "in-memory" })
          : outputSpec.kind === "webm"
            ? new WebMOutputFormat()
            : new WavOutputFormat();
      const output = new Output({ format, target });
      const packetSource = new EncodedAudioPacketSource(codec);
      output.addAudioTrack(packetSource);

      let firstPacket = await packetSink.getPacket(chunkStart);
      if (!firstPacket) {
        firstPacket = await packetSink.getFirstPacket();
      } else if (firstPacket.timestamp < chunkStart) {
        firstPacket = await packetSink.getNextPacket(firstPacket);
      }
      if (!firstPacket) break;

      let endPacket = await packetSink.getPacket(chunkEnd);
      if (endPacket && endPacket.timestamp < chunkEnd) {
        endPacket = await packetSink.getNextPacket(endPacket);
      }

      const packetOffset = firstPacket.timestamp;
      let wrotePacket = false;
      await output.start();
      for await (const packet of packetSink.packets(
        firstPacket,
        endPacket ?? undefined,
      )) {
        const adjustedPacket = packet.clone({
          timestamp: Math.max(0, packet.timestamp - packetOffset),
        });
        await packetSource.add(
          adjustedPacket,
          wrotePacket ? undefined : { decoderConfig },
        );
        wrotePacket = true;
      }
      packetSource.close();
      await output.finalize();

      if (!wrotePacket) {
        throw new Error("動画の音声トラックが空でした。");
      }
      if (!target.buffer || target.buffer.byteLength === 0) {
        throw new Error("動画の音声トラックが空でした。");
      }

      if (
        target.buffer.byteLength > maxChunkBytes &&
        chunkSeconds > MIN_AUDIO_CHUNK_SECONDS
      ) {
        chunkSeconds = Math.max(
          MIN_AUDIO_CHUNK_SECONDS,
          Math.floor(chunkSeconds / 2),
        );
        continue;
      }
      if (target.buffer.byteLength > maxChunkBytes) {
        throw new Error("動画の音声データが大きすぎます。");
      }

      yield {
        file: new File(
          [target.buffer],
          `${baseName}-audio-${String(chunkNumber).padStart(2, "0")}.${
            outputSpec.extension
          }`,
          { type: outputSpec.mimeType },
        ),
        startSeconds: packetOffset,
      };

      chunkStart = chunkEnd;
      chunkNumber += 1;
    }
  } finally {
    input.dispose();
  }
}
