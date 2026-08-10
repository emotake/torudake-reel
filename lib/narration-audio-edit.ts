import type { DecodedAudioSource } from "./audio";
import type { NarrationSegment } from "./narration";

export type NarrationAudioSpan = {
  index: number;
  start: number;
  end: number;
};

export type NarrationAudioSpliceResult = {
  audio: ArrayBuffer;
  originalPreview: ArrayBuffer;
  correctedPreview: ArrayBuffer;
  originalStart: number;
  originalEnd: number;
  correctedStart: number;
  correctedEnd: number;
  duration: number;
};

export type NarrationAudioBoundaries = {
  originalStart: number;
  originalEnd: number;
};

type FloatAudio = DecodedAudioSource & {
  channelData: Float32Array[];
};

const DEFAULT_BOUNDARY_SEARCH_SECONDS = 0.48;
const DEFAULT_JOIN_FADE_SECONDS = 0.03;
const DEFAULT_PREVIEW_CONTEXT_SECONDS = 0.85;
const BOUNDARY_EDGE_SECONDS = 0.04;
const BOUNDARY_HALF_WINDOW_SECONDS = 0.012;
const MIN_BOUNDARY_RMS = 0.003;
const MAX_BOUNDARY_RMS = 0.015;
const BOUNDARY_CONTEXT_RATIO = 0.28;
const MIN_EDIT_REGION_SECONDS = 0.16;
const REPLACEMENT_WINDOW_SECONDS = 0.01;
const REPLACEMENT_TRIM_GUARD_SECONDS = 0.015;
const MIN_REPLACEMENT_RMS = 0.0005;
const MIN_RMS_MATCH_GAIN = 0.5;
const MAX_RMS_MATCH_GAIN = 2;
const MATCHED_PEAK_LIMIT = 0.95;
const MAX_REPLACEMENT_OVERHANG_SECONDS = 0.06;
const SPEECH_REFERENCE_SECONDS = 0.28;
const SPEECH_REFERENCE_GUARD_SECONDS = 0.035;
const SPEECH_LOUDNESS_WINDOW_SECONDS = 0.02;
const SPEECH_LOUDNESS_HOP_SECONDS = 0.01;
const SPEECH_ACTIVE_FLOOR = 0.0015;
const SPEECH_ACTIVE_PEAK_RATIO = 0.14;
const SPEECH_LOUDNESS_PERCENTILE = 0.6;
const ROBUST_PEAK_PERCENTILE = 0.995;
const PEAK_HISTOGRAM_BINS = 1_024;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanLength(value: string | undefined) {
  return Math.max(5, Array.from(value ?? "").length);
}

export function buildNarrationAudioSpans(
  segments: NarrationSegment[],
  audioDuration: number,
): NarrationAudioSpan[] {
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) return [];
  const validSegments = segments
    .map((segment, index) => ({
      index,
      weight: cleanLength(segment.speechText || segment.text),
    }))
    .filter((segment) => segment.weight > 0);
  if (!validSegments.length) return [];

  const totalWeight = validSegments.reduce(
    (total, segment) => total + segment.weight,
    0,
  );
  let cursor = 0;
  return validSegments.map((segment, position) => {
    const start = cursor;
    cursor =
      position === validSegments.length - 1
        ? audioDuration
        : cursor + (segment.weight / totalWeight) * audioDuration;
    return {
      index: segment.index,
      start,
      end: cursor,
    };
  });
}

function sampleAt(
  source: DecodedAudioSource,
  channel: number,
  outputChannels: number,
  seconds: number,
) {
  const position = clamp(
    seconds * source.sampleRate,
    0,
    Math.max(0, source.length - 1),
  );
  const left = Math.floor(position);
  const right = Math.min(source.length - 1, left + 1);
  const mix = position - left;
  const readChannel = (sourceChannel: number) => {
    const values = source.getChannelData(sourceChannel);
    return values[left] + (values[right] - values[left]) * mix;
  };

  if (outputChannels === 1 && source.numberOfChannels > 1) {
    let mixed = 0;
    for (let index = 0; index < source.numberOfChannels; index += 1) {
      mixed += readChannel(index);
    }
    return mixed / source.numberOfChannels;
  }
  return readChannel(
    source.numberOfChannels === 1
      ? 0
      : Math.min(channel, source.numberOfChannels - 1),
  );
}

function audioRms(
  source: DecodedAudioSource,
  startFrame = 0,
  endFrame = source.length,
) {
  const start = clamp(Math.floor(startFrame), 0, source.length);
  const end = clamp(Math.ceil(endFrame), start, source.length);
  const sampleStep = Math.max(1, Math.floor(source.sampleRate / 8_000));
  let squared = 0;
  let count = 0;
  for (let frame = start; frame < end; frame += sampleStep) {
    for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
      const value = source.getChannelData(channel)[frame] ?? 0;
      if (!Number.isFinite(value)) continue;
      squared += value * value;
      count += 1;
    }
  }
  return count ? Math.sqrt(squared / count) : 0;
}

function activeSpeechRms(
  source: DecodedAudioSource,
  startFrame = 0,
  endFrame = source.length,
) {
  const start = clamp(Math.floor(startFrame), 0, source.length);
  const end = clamp(Math.ceil(endFrame), start, source.length);
  if (end <= start) return 0;
  const windowFrames = Math.max(
    1,
    Math.round(SPEECH_LOUDNESS_WINDOW_SECONDS * source.sampleRate),
  );
  const hopFrames = Math.max(
    1,
    Math.round(SPEECH_LOUDNESS_HOP_SECONDS * source.sampleRate),
  );
  const windows: number[] = [];
  for (let frame = start; frame < end; frame += hopFrames) {
    windows.push(audioRms(source, frame, Math.min(end, frame + windowFrames)));
  }
  const peakWindow = Math.max(0, ...windows);
  const threshold = Math.max(
    SPEECH_ACTIVE_FLOOR,
    peakWindow * SPEECH_ACTIVE_PEAK_RATIO,
  );
  const activeWindows = windows
    .filter((value) => value >= threshold)
    .sort((left, right) => left - right);
  if (!activeWindows.length) return 0;
  const index = Math.min(
    activeWindows.length - 1,
    Math.floor((activeWindows.length - 1) * SPEECH_LOUDNESS_PERCENTILE),
  );
  return activeWindows[index] ?? 0;
}

function robustAudioPeak(
  source: DecodedAudioSource,
  startFrame = 0,
  endFrame = source.length,
) {
  const start = clamp(Math.floor(startFrame), 0, source.length);
  const end = clamp(Math.ceil(endFrame), start, source.length);
  const histogram = new Uint32Array(PEAK_HISTOGRAM_BINS);
  const sampleStep = Math.max(1, Math.floor(source.sampleRate / 12_000));
  let sampleCount = 0;
  for (let frame = start; frame < end; frame += sampleStep) {
    for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
      const value = source.getChannelData(channel)[frame] ?? 0;
      if (!Number.isFinite(value)) continue;
      const bin = Math.min(
        PEAK_HISTOGRAM_BINS - 1,
        Math.floor(Math.abs(value) * PEAK_HISTOGRAM_BINS),
      );
      histogram[bin] += 1;
      sampleCount += 1;
    }
  }
  if (!sampleCount) return 0;
  const target = Math.max(1, Math.ceil(sampleCount * ROBUST_PEAK_PERCENTILE));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    cumulative += histogram[bin] ?? 0;
    if (cumulative >= target) {
      return (bin + 1) / PEAK_HISTOGRAM_BINS;
    }
  }
  return 1;
}

function boundaryEnergy(source: DecodedAudioSource, centerSeconds: number) {
  const start = Math.max(
    0,
    Math.floor(
      (centerSeconds - BOUNDARY_HALF_WINDOW_SECONDS) * source.sampleRate,
    ),
  );
  const end = Math.min(
    source.length,
    Math.ceil(
      (centerSeconds + BOUNDARY_HALF_WINDOW_SECONDS) * source.sampleRate,
    ),
  );
  return audioRms(source, start, end);
}

function snapToQuietSample(
  source: DecodedAudioSource,
  seconds: number,
  radiusSeconds: number,
) {
  const center = Math.round(seconds * source.sampleRate);
  const radius = Math.max(
    1,
    Math.round(Math.min(0.006, Math.max(0, radiusSeconds)) * source.sampleRate),
  );
  const start = clamp(center - radius, 0, Math.max(0, source.length - 1));
  const end = clamp(center + radius, start, Math.max(0, source.length - 1));
  let bestFrame = center;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let frame = start; frame <= end; frame += 1) {
    let squared = 0;
    for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
      const value = source.getChannelData(channel)[frame] ?? 0;
      squared += Number.isFinite(value) ? value * value : 0;
    }
    const amplitude = Math.sqrt(squared / source.numberOfChannels);
    const distancePenalty =
      (Math.abs(frame - center) / Math.max(1, radius)) * 0.00002;
    const score = amplitude + distancePenalty;
    if (score < bestScore) {
      bestScore = score;
      bestFrame = frame;
    }
  }
  return bestFrame / source.sampleRate;
}

function findQuietNarrationBoundaryTime(
  source: DecodedAudioSource,
  expectedSeconds: number,
  searchRadiusSeconds: number,
) {
  const expected = clamp(expectedSeconds, 0, source.duration);
  const radius = clamp(searchRadiusSeconds, 0, source.duration / 2);
  if (radius < 0.01) return expected;

  const start = Math.max(0, expected - radius);
  const end = Math.min(source.duration, expected + radius);
  const step = Math.max(0.004, 1 / source.sampleRate);
  let bestTime = expected;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let time = start; time <= end; time += step) {
    const distance = Math.abs(time - expected) / radius;
    const score = boundaryEnergy(source, time) + distance * 0.0008;
    if (score < bestScore) {
      bestScore = score;
      bestTime = time;
    }
  }
  return snapToQuietSample(source, bestTime, radius);
}

export function findQuietNarrationBoundary(
  source: DecodedAudioSource,
  expectedSeconds: number,
  searchRadiusSeconds = DEFAULT_BOUNDARY_SEARCH_SECONDS,
) {
  if (!Number.isFinite(source.duration) || source.duration <= 0) return 0;
  const bestTime = findQuietNarrationBoundaryTime(
    source,
    expectedSeconds,
    searchRadiusSeconds,
  );
  return Math.round(bestTime * 1_000) / 1_000;
}

function assertValidAudio(source: DecodedAudioSource) {
  if (
    source.length <= 0 ||
    source.numberOfChannels <= 0 ||
    source.sampleRate <= 0 ||
    !Number.isFinite(source.duration) ||
    source.duration <= 0
  ) {
    throw new Error("AI音声データが正しくありません。");
  }
}

function isQuietBoundary(
  source: DecodedAudioSource,
  boundarySeconds: number,
  expectedSeconds: number,
  searchRadiusSeconds: number,
) {
  const contextStart = Math.max(
    0,
    (expectedSeconds - searchRadiusSeconds) * source.sampleRate,
  );
  const contextEnd = Math.min(
    source.length,
    (expectedSeconds + searchRadiusSeconds) * source.sampleRate,
  );
  const contextRms = audioRms(source, contextStart, contextEnd);
  const maximumQuietRms = Math.min(
    MAX_BOUNDARY_RMS,
    Math.max(MIN_BOUNDARY_RMS, contextRms * BOUNDARY_CONTEXT_RATIO),
  );
  return boundaryEnergy(source, boundarySeconds) <= maximumQuietRms;
}

export function resolveNarrationAudioBoundaries(
  original: DecodedAudioSource,
  expectedStartSeconds: number,
  expectedEndSeconds: number,
): NarrationAudioBoundaries {
  assertValidAudio(original);
  if (
    !Number.isFinite(expectedStartSeconds) ||
    !Number.isFinite(expectedEndSeconds)
  ) {
    throw new Error("修正する音声区間が正しくありません。");
  }

  const expectedStart = clamp(expectedStartSeconds, 0, original.duration);
  const expectedEnd = clamp(
    expectedEndSeconds,
    expectedStart,
    original.duration,
  );
  const expectedLength = Math.max(0.2, expectedEnd - expectedStart);
  const boundaryRadius = Math.min(
    DEFAULT_BOUNDARY_SEARCH_SECONDS,
    expectedLength * 0.34,
  );
  const startIsFileEdge = expectedStart <= BOUNDARY_EDGE_SECONDS;
  const endIsFileEdge =
    expectedEnd >= original.duration - BOUNDARY_EDGE_SECONDS;
  const originalStart = startIsFileEdge
    ? 0
    : findQuietNarrationBoundaryTime(
        original,
        expectedStart,
        boundaryRadius,
      );
  const originalEnd = endIsFileEdge
    ? original.duration
    : findQuietNarrationBoundaryTime(original, expectedEnd, boundaryRadius);

  const startIsSafe =
    startIsFileEdge ||
    isQuietBoundary(
      original,
      originalStart,
      expectedStart,
      boundaryRadius,
    );
  const endIsSafe =
    endIsFileEdge ||
    isQuietBoundary(original, originalEnd, expectedEnd, boundaryRadius);
  if (
    !startIsSafe ||
    !endIsSafe ||
    originalEnd - originalStart < MIN_EDIT_REGION_SECONDS
  ) {
    throw new Error(
      "元音声の切り替え位置に十分な無音がないため、安全に部分修正できません。文の区切りを含む範囲でお試しください。",
    );
  }

  return {
    originalStart: originalStart === 0 ? 0 : originalStart,
    originalEnd:
      originalEnd === original.duration ? original.duration : originalEnd,
  };
}

type ReplacementTrim = {
  startFrame: number;
  endFrame: number;
  speechRms: number;
  peak: number;
};

function trimReplacementSilence(
  replacement: DecodedAudioSource,
): ReplacementTrim {
  const overallRms = audioRms(replacement);
  if (overallRms < MIN_REPLACEMENT_RMS) {
    throw new Error("置換音声に発話が見つからないため、部分修正できません。");
  }

  const windowFrames = Math.max(
    1,
    Math.round(REPLACEMENT_WINDOW_SECONDS * replacement.sampleRate),
  );
  const activeThreshold = clamp(overallRms * 0.08, 0.0015, 0.015);
  let firstActiveFrame = -1;
  let lastActiveFrame = -1;
  for (let start = 0; start < replacement.length; start += windowFrames) {
    const end = Math.min(replacement.length, start + windowFrames);
    if (audioRms(replacement, start, end) >= activeThreshold) {
      if (firstActiveFrame < 0) firstActiveFrame = start;
      lastActiveFrame = end;
    }
  }
  if (firstActiveFrame < 0 || lastActiveFrame <= firstActiveFrame) {
    throw new Error("置換音声に発話が見つからないため、部分修正できません。");
  }

  const guardFrames = Math.round(
    REPLACEMENT_TRIM_GUARD_SECONDS * replacement.sampleRate,
  );
  const startFrame = Math.max(0, firstActiveFrame - guardFrames);
  const endFrame = Math.min(replacement.length, lastActiveFrame + guardFrames);
  return {
    startFrame,
    endFrame,
    speechRms:
      activeSpeechRms(replacement, firstActiveFrame, lastActiveFrame) ||
      audioRms(replacement, firstActiveFrame, lastActiveFrame),
    peak: robustAudioPeak(replacement, startFrame, endFrame),
  };
}

function nearbyOriginalSpeechRms(
  original: DecodedAudioSource,
  startFrame: number,
  endFrame: number,
) {
  // The sentence being replaced is the closest reliable loudness reference.
  // Quiet join boundaries and pauses must not make the new sentence quieter.
  const replacedSpeechRms = activeSpeechRms(original, startFrame, endFrame);
  if (replacedSpeechRms >= MIN_REPLACEMENT_RMS) {
    return replacedSpeechRms;
  }

  const referenceFrames = Math.round(
    SPEECH_REFERENCE_SECONDS * original.sampleRate,
  );
  const guardFrames = Math.round(
    SPEECH_REFERENCE_GUARD_SECONDS * original.sampleRate,
  );
  const beforeEnd = Math.max(0, startFrame - guardFrames);
  const beforeStart = Math.max(0, beforeEnd - referenceFrames);
  const afterStart = Math.min(original.length, endFrame + guardFrames);
  const afterEnd = Math.min(original.length, afterStart + referenceFrames);
  const outsideReferences = [
    activeSpeechRms(original, beforeStart, beforeEnd),
    activeSpeechRms(original, afterStart, afterEnd),
  ].filter((value) => value >= MIN_REPLACEMENT_RMS);
  if (outsideReferences.length) {
    return (
      outsideReferences.reduce((total, value) => total + value, 0) /
      outsideReferences.length
    );
  }
  return audioRms(original, startFrame, endFrame);
}

function createFloatAudio(
  channelData: Float32Array[],
  sampleRate: number,
): FloatAudio {
  const length = channelData[0]?.length ?? 0;
  return {
    channelData,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    getChannelData: (channel) => channelData[channel],
    length,
    numberOfChannels: channelData.length,
    sampleRate,
  };
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeFloatAudioRange(
  source: DecodedAudioSource,
  startSeconds = 0,
  endSeconds = source.duration,
) {
  const start = clamp(
    Math.floor(startSeconds * source.sampleRate),
    0,
    source.length,
  );
  const end = clamp(
    Math.ceil(endSeconds * source.sampleRate),
    start,
    source.length,
  );
  const frameCount = Math.max(1, end - start);
  const channels = Math.max(1, source.numberOfChannels);
  const bytesPerFrame = channels * 2;
  const dataSize = frameCount * bytesPerFrame;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, source.sampleRate, true);
  view.setUint32(28, source.sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = start; frame < end; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(source.getChannelData(channel)[frame] ?? 0, -1, 1);
      view.setInt16(
        offset,
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
        true,
      );
      offset += 2;
    }
  }
  return buffer;
}

export function spliceNarrationAudioSegment(
  original: DecodedAudioSource,
  replacement: DecodedAudioSource,
  expectedStartSeconds: number,
  expectedEndSeconds: number,
  resolvedBoundaries?: NarrationAudioBoundaries,
): NarrationAudioSpliceResult {
  assertValidAudio(original);
  assertValidAudio(replacement);
  const boundaries =
    resolvedBoundaries ??
    resolveNarrationAudioBoundaries(
      original,
      expectedStartSeconds,
      expectedEndSeconds,
    );
  const originalStart = boundaries.originalStart;
  const originalEnd = boundaries.originalEnd;
  if (
    !Number.isFinite(originalStart) ||
    !Number.isFinite(originalEnd) ||
    originalStart < 0 ||
    originalEnd > original.duration ||
    originalEnd - originalStart < MIN_EDIT_REGION_SECONDS
  ) {
    throw new Error(
      "元音声の切り替え位置に十分な無音がないため、安全に部分修正できません。文の区切りを含む範囲でお試しください。",
    );
  }

  const sampleRate = original.sampleRate;
  const channels = original.numberOfChannels;
  const prefixFrames = clamp(
    Math.round(originalStart * sampleRate),
    0,
    original.length,
  );
  const suffixSourceFrame = clamp(
    Math.round(originalEnd * sampleRate),
    prefixFrames,
    original.length,
  );
  const slotFrames = suffixSourceFrame - prefixFrames;
  const trimmedReplacement = trimReplacementSilence(replacement);
  const trimmedDuration =
    (trimmedReplacement.endFrame - trimmedReplacement.startFrame) /
    replacement.sampleRate;
  const replacementFrames = Math.max(
    1,
    Math.round(trimmedDuration * sampleRate),
  );
  const overflowFrames = Math.max(0, replacementFrames - slotFrames);
  const maximumOverflowFrames = Math.round(
    MAX_REPLACEMENT_OVERHANG_SECONDS * sampleRate,
  );
  const availableOutsideFrames = prefixFrames +
    (original.length - suffixSourceFrame);
  if (
    overflowFrames > maximumOverflowFrames ||
    overflowFrames > availableOutsideFrames
  ) {
    throw new Error(
      "置換音声が元の修正区間より長すぎるため、映像の長さを保ったまま自然に差し替えできません。短い文でお試しください。",
    );
  }

  let replacementOffset: number;
  if (overflowFrames > 0) {
    const minimumLeadingOverflow = Math.max(
      0,
      overflowFrames - (original.length - suffixSourceFrame),
    );
    const maximumLeadingOverflow = Math.min(overflowFrames, prefixFrames);
    const leadingOverflow = clamp(
      Math.floor(overflowFrames / 2),
      minimumLeadingOverflow,
      maximumLeadingOverflow,
    );
    replacementOffset = prefixFrames - leadingOverflow;
  } else {
    replacementOffset =
      prefixFrames + Math.floor((slotFrames - replacementFrames) / 2);
  }
  const replacementEndFrame = replacementOffset + replacementFrames;
  const requestedFadeFrames = Math.max(
    1,
    Math.round(DEFAULT_JOIN_FADE_SECONDS * sampleRate),
  );
  const fadeFrames = Math.min(
    requestedFadeFrames,
    Math.floor(replacementFrames / 4),
  );
  const referenceRms = nearbyOriginalSpeechRms(
    original,
    prefixFrames,
    suffixSourceFrame,
  );
  let rmsGain =
    referenceRms >= MIN_REPLACEMENT_RMS &&
    trimmedReplacement.speechRms >= MIN_REPLACEMENT_RMS
      ? clamp(
          referenceRms / trimmedReplacement.speechRms,
          MIN_RMS_MATCH_GAIN,
          MAX_RMS_MATCH_GAIN,
        )
      : 1;
  if (trimmedReplacement.peak > 0) {
    rmsGain = Math.min(
      rmsGain,
      MATCHED_PEAK_LIMIT / trimmedReplacement.peak,
    );
  }
  const outputChannels = Array.from(
    { length: channels },
    () => new Float32Array(original.length),
  );

  for (let channel = 0; channel < channels; channel += 1) {
    const originalChannel = original.getChannelData(channel);
    const output = outputChannels[channel];
    output.set(originalChannel.subarray(0, original.length));
    output.fill(0, prefixFrames, suffixSourceFrame);
    for (let frame = 0; frame < replacementFrames; frame += 1) {
      const outputFrame = replacementOffset + frame;
      const sourceFrame = Math.min(
        trimmedReplacement.endFrame - 1,
        trimmedReplacement.startFrame +
          (frame * replacement.sampleRate) / sampleRate,
      );
      const replacementSample =
        sampleAt(
          replacement,
          channel,
          channels,
          sourceFrame / replacement.sampleRate,
        ) * rmsGain;

      if (outputFrame < prefixFrames) {
        const overlapFrames = prefixFrames - replacementOffset;
        const progress = (frame + 1) / overlapFrames;
        const angle = (Math.PI / 2) * progress;
        output[outputFrame] =
          (originalChannel[outputFrame] ?? 0) * Math.cos(angle) +
          replacementSample * Math.sin(angle);
      } else if (outputFrame >= suffixSourceFrame) {
        const overlapFrames = replacementEndFrame - suffixSourceFrame;
        const progress =
          (outputFrame - suffixSourceFrame + 1) / overlapFrames;
        const angle = (Math.PI / 2) * progress;
        output[outputFrame] =
          replacementSample * Math.cos(angle) +
          (originalChannel[outputFrame] ?? 0) * Math.sin(angle);
      } else {
        let replacementFade = 1;
        if (
          fadeFrames > 0 &&
          replacementOffset >= prefixFrames &&
          !(replacementOffset === 0 && prefixFrames === 0) &&
          frame < fadeFrames
        ) {
          replacementFade *= Math.sin(
            (Math.PI / 2) * ((frame + 1) / fadeFrames),
          );
        }
        if (
          fadeFrames > 0 &&
          replacementEndFrame <= suffixSourceFrame &&
          !(
            replacementEndFrame === original.length &&
            suffixSourceFrame === original.length
          ) &&
          frame >= replacementFrames - fadeFrames
        ) {
          replacementFade *= Math.cos(
            (Math.PI / 2) *
              ((frame - (replacementFrames - fadeFrames) + 1) / fadeFrames),
          );
        }
        output[outputFrame] = replacementSample * replacementFade;
      }
    }
    for (let frame = 0; frame < output.length; frame += 1) {
      output[frame] = clamp(output[frame], -1, 1);
    }
  }

  const combined = createFloatAudio(outputChannels, sampleRate);
  const correctedStart = replacementOffset / sampleRate;
  const correctedEnd = replacementEndFrame / sampleRate;
  const previewStart = Math.max(
    0,
    Math.min(originalStart, correctedStart) - DEFAULT_PREVIEW_CONTEXT_SECONDS,
  );
  const previewEnd = Math.min(
    original.duration,
    Math.max(originalEnd, correctedEnd) + DEFAULT_PREVIEW_CONTEXT_SECONDS,
  );

  return {
    audio: encodeFloatAudioRange(combined),
    originalPreview: encodeFloatAudioRange(
      original,
      previewStart,
      previewEnd,
    ),
    correctedPreview: encodeFloatAudioRange(
      combined,
      previewStart,
      previewEnd,
    ),
    originalStart,
    originalEnd,
    correctedStart,
    correctedEnd,
    duration: combined.duration,
  };
}
