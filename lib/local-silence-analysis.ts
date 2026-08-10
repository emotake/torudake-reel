import type { InputAudioTrack } from "mediabunny";
import type { CaptionSegment } from "./captions";
import { buildEditRanges, isIncludedCaption } from "./edit-plan";
import { getPreferredPortableInputAudioTrack } from "./portable-video-export";

export type LocalAudioWindow = Readonly<{
  time: number;
  rms: number;
}>;

export function selectQuietestCutWindow(
  windows: readonly LocalAudioWindow[],
  preferredTime: number,
) {
  const valid = windows.filter(
    (window) =>
      Number.isFinite(window.time) &&
      Number.isFinite(window.rms) &&
      window.rms >= 0,
  );
  if (valid.length === 0) return null;

  const maximumRms = valid.reduce(
    (maximum, window) => Math.max(maximum, window.rms),
    0,
  );
  const quietThreshold = Math.max(0.012, maximumRms * 0.32);
  const quiet = valid
    .filter((window) => window.rms <= quietThreshold)
    .sort(
      (left, right) =>
        left.rms - right.rms ||
        Math.abs(left.time - preferredTime) -
          Math.abs(right.time - preferredTime),
    );
  return quiet[0]?.time ?? null;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function exactWordBounds(caption: CaptionSegment) {
  const duration = caption.end - caption.start;
  const words = (caption.wordTimings ?? [])
    .filter(
      (word) =>
        Number.isFinite(word.startOffset) &&
        Number.isFinite(word.endOffset) &&
        word.startOffset >= 0 &&
        word.endOffset > word.startOffset &&
        word.endOffset <= duration + 0.001,
    )
    .sort((left, right) => left.startOffset - right.startOffset);
  if (words.length === 0) return null;
  return {
    start: caption.start + words[0].startOffset,
    end: caption.start + words.at(-1)!.endOffset,
  };
}

async function findQuietestCutTime(
  media: typeof import("mediabunny"),
  audioTrack: InputAudioTrack,
  start: number,
  end: number,
  preferredTime: number,
  signal?: AbortSignal,
) {
  if (end - start < 0.004) return null;
  const sink = new media.AudioBufferSink(audioTrack);
  const windows: LocalAudioWindow[] = [];

  for await (const wrapped of sink.buffers(start, end)) {
    throwIfAborted(signal);
    const buffer = wrapped.buffer;
    const sampleRate = buffer.sampleRate;
    const firstFrame = Math.max(
      0,
      Math.floor((start - wrapped.timestamp) * sampleRate),
    );
    const lastFrame = Math.min(
      buffer.length,
      Math.ceil((end - wrapped.timestamp) * sampleRate),
    );
    const windowFrames = Math.max(1, Math.round(sampleRate * 0.005));

    for (
      let offset = firstFrame;
      offset < lastFrame;
      offset += windowFrames
    ) {
      const frameEnd = Math.min(lastFrame, offset + windowFrames);
      let sumSquares = 0;
      let sampleCount = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let frame = offset; frame < frameEnd; frame += 1) {
          const sample = samples[frame];
          if (!Number.isFinite(sample)) continue;
          sumSquares += sample * sample;
          sampleCount += 1;
        }
      }
      if (sampleCount === 0) continue;
      windows.push({
        time:
          wrapped.timestamp +
          (offset + (frameEnd - offset) / 2) / sampleRate,
        rms: Math.sqrt(sumSquares / sampleCount),
      });
    }
  }

  return selectQuietestCutWindow(windows, preferredTime);
}

/**
 * Refines the safe word-timestamp handles using the actual local waveform.
 * The search stays inside the already-known non-speech handle, so it can only
 * keep or shorten an edit range and can never cut into a timed word.
 */
export async function refineCaptionCutsWithLocalSilence<
  T extends CaptionSegment,
>(file: File, captions: T[], signal?: AbortSignal): Promise<T[]> {
  let input: InstanceType<(typeof import("mediabunny"))["Input"]> | null = null;
  try {
    throwIfAborted(signal);
    const media = await import("mediabunny");
    input = new media.Input({
      source: new media.BlobSource(file),
      formats: media.ALL_FORMATS,
    });
    if (!(await input.canRead())) return captions;
    const audioTrack = await getPreferredPortableInputAudioTrack(input);
    if (!audioTrack || !(await audioTrack.canDecode())) return captions;

    const ranges = buildEditRanges(captions);
    const kept = captions
      .filter(isIncludedCaption)
      .sort((left, right) => left.start - right.start);
    const updates = new Map<
      number,
      { start?: number; end?: number }
    >();

    for (const range of ranges.slice(0, 12)) {
      throwIfAborted(signal);
      const inside = kept.filter(
        (caption) =>
          caption.end > range.start - 0.001 &&
          caption.start < range.end + 0.001,
      );
      const first = inside[0];
      const last = inside.at(-1);
      if (!first || !last) continue;
      const firstWords = exactWordBounds(first);
      const lastWords = exactWordBounds(last);

      if (firstWords && firstWords.start - range.start >= 0.004) {
        const quietStart = await findQuietestCutTime(
          media,
          audioTrack,
          range.start,
          firstWords.start - 0.002,
          range.start,
          signal,
        );
        if (quietStart !== null) {
          updates.set(first.id, {
            ...updates.get(first.id),
            start: Math.max(range.start, Math.min(first.start, quietStart)),
          });
        }
      }

      if (lastWords && range.end - lastWords.end >= 0.004) {
        const quietEnd = await findQuietestCutTime(
          media,
          audioTrack,
          lastWords.end + 0.002,
          range.end,
          range.end,
          signal,
        );
        if (quietEnd !== null) {
          updates.set(last.id, {
            ...updates.get(last.id),
            end: Math.min(range.end, Math.max(last.end, quietEnd)),
          });
        }
      }
    }

    if (updates.size === 0) return captions;
    return captions.map((caption) => {
      const update = updates.get(caption.id);
      if (!update) return caption;
      const nextStart = update.start ?? caption.start;
      const startShift = caption.start - nextStart;
      return {
        ...caption,
        start: Math.round(nextStart * 1_000) / 1_000,
        end: Math.round((update.end ?? caption.end) * 1_000) / 1_000,
        localSilenceStart:
          update.start !== undefined || caption.localSilenceStart,
        localSilenceEnd: update.end !== undefined || caption.localSilenceEnd,
        wordTimings: caption.wordTimings?.map((word) => ({
          ...word,
          startOffset: word.startOffset + startShift,
          endOffset: word.endOffset + startShift,
        })),
      };
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return captions;
  } finally {
    input?.dispose();
  }
}
