const MAX_AUDIO_CHUNK_SECONDS = 150;
const TARGET_AUDIO_CHUNK_BYTES = 18 * 1024 * 1024;
const ABSOLUTE_MAX_AUDIO_CHUNK_BYTES = 24 * 1024 * 1024;
const MIN_AUDIO_CHUNK_SECONDS = 10;

type DirectCopyAudioCodec = "aac" | "mp3" | "opus" | "vorbis";

export type TranscriptionAudioChunk = {
  file: File;
  startSeconds: number;
};

export function getDirectCopyAudioOutput(codec: string | null) {
  if (codec === "aac" || codec === "mp3") {
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
  return null;
}

export function getSafeAudioChunkSeconds(bitrate: number | null) {
  if (!bitrate || !Number.isFinite(bitrate) || bitrate <= 0) {
    return MAX_AUDIO_CHUNK_SECONDS;
  }

  return Math.max(
    MIN_AUDIO_CHUNK_SECONDS,
    Math.min(
      MAX_AUDIO_CHUNK_SECONDS,
      Math.floor((TARGET_AUDIO_CHUNK_BYTES * 8) / bitrate),
    ),
  );
}

function safeBaseName(fileName: string) {
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N}_-]+/gu, "_")
      .slice(0, 80) || "video"
  );
}

export async function* extractTranscriptionAudioChunks(
  sourceFile: File,
): AsyncGenerator<TranscriptionAudioChunk> {
  const {
    BlobSource,
    BufferTarget,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Input,
    MP4,
    Mp4OutputFormat,
    Output,
    QTFF,
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

    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      throw new Error("動画に音声が見つかりませんでした。");
    }

    const codec = (await audioTrack.getCodec()) as DirectCopyAudioCodec | null;
    const outputSpec = getDirectCopyAudioOutput(codec);
    if (!outputSpec || !codec) {
      throw new Error("動画の音声形式を直接取り出せませんでした。");
    }

    const duration =
      (await audioTrack.getDurationFromMetadata()) ??
      (await audioTrack.computeDuration());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("動画に音声が見つかりませんでした。");
    }

    const bitrate =
      (await audioTrack.getAverageBitrate()) ??
      (await audioTrack.getBitrate());
    const decoderConfig = await audioTrack.getDecoderConfig();
    if (!decoderConfig) {
      throw new Error("動画の音声設定を読み取れませんでした。");
    }

    const packetSink = new EncodedPacketSink(audioTrack);
    let chunkSeconds = getSafeAudioChunkSeconds(bitrate);
    let chunkStart = 0;
    let chunkNumber = 1;
    const baseName = safeBaseName(sourceFile.name);

    while (chunkStart < duration) {
      const chunkEnd = Math.min(duration, chunkStart + chunkSeconds);
      const target = new BufferTarget();
      const format =
        outputSpec.kind === "mp4"
          ? new Mp4OutputFormat({ fastStart: "in-memory" })
          : new WebMOutputFormat();
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
        target.buffer.byteLength > ABSOLUTE_MAX_AUDIO_CHUNK_BYTES &&
        chunkSeconds > MIN_AUDIO_CHUNK_SECONDS
      ) {
        chunkSeconds = Math.max(
          MIN_AUDIO_CHUNK_SECONDS,
          Math.floor(chunkSeconds / 2),
        );
        continue;
      }
      if (target.buffer.byteLength > ABSOLUTE_MAX_AUDIO_CHUNK_BYTES) {
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
