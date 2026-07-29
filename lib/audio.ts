export const TRANSCRIPTION_AUDIO_SAMPLE_RATE = 16_000;
export const TRANSCRIPTION_AUDIO_CHUNK_SECONDS = 25;
const NORMALIZATION_TARGET_RMS = 0.16;
const NORMALIZATION_PEAK_LIMIT = 0.92;
const NORMALIZATION_MAX_GAIN = 6;
const SILENCE_RMS_THRESHOLD = 0.0005;

export type DecodedAudioSource = {
  duration: number;
  getChannelData(channel: number): Float32Array;
  length: number;
  numberOfChannels: number;
  sampleRate: number;
};

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function pcm16(sample: number) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

export function encodeMonoWavChunk(
  source: DecodedAudioSource,
  startSeconds: number,
  durationSeconds: number,
  targetSampleRate = TRANSCRIPTION_AUDIO_SAMPLE_RATE,
) {
  if (
    source.numberOfChannels <= 0 ||
    source.length <= 0 ||
    source.sampleRate <= 0 ||
    targetSampleRate <= 0 ||
    durationSeconds <= 0
  ) {
    throw new Error("音声データが正しくありません。");
  }

  const sourceStart = Math.min(
    source.length,
    Math.max(0, Math.floor(startSeconds * source.sampleRate)),
  );
  const sourceEnd = Math.min(
    source.length,
    Math.max(sourceStart, Math.ceil((startSeconds + durationSeconds) * source.sampleRate)),
  );
  const sourceLength = sourceEnd - sourceStart;
  if (sourceLength <= 0) {
    throw new Error("音声データが空です。");
  }

  const outputSamples = Math.max(
    1,
    Math.ceil((sourceLength / source.sampleRate) * targetSampleRate),
  );
  const bytesPerSample = 2;
  const dataSize = outputSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from(
    { length: source.numberOfChannels },
    (_, channel) => source.getChannelData(channel),
  );
  const sourceStep = sourceLength / outputSamples;
  const monoSamples = new Float32Array(outputSamples);
  let peak = 0;
  let squaredTotal = 0;

  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = sourceStart + index * sourceStep;
    const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(source.length - 1, leftIndex + 1);
    const mix = sourcePosition - leftIndex;
    let sample = 0;

    for (const channel of channels) {
      sample +=
        channel[leftIndex] + (channel[rightIndex] - channel[leftIndex]) * mix;
    }
    sample /= channels.length;
    monoSamples[index] = sample;
    peak = Math.max(peak, Math.abs(sample));
    squaredTotal += sample * sample;
  }

  const rms = Math.sqrt(squaredTotal / outputSamples);
  const rmsGain =
    rms > SILENCE_RMS_THRESHOLD ? NORMALIZATION_TARGET_RMS / rms : 1;
  const peakGain = peak > 0 ? NORMALIZATION_PEAK_LIMIT / peak : 1;
  const gain = Math.max(
    0.25,
    Math.min(NORMALIZATION_MAX_GAIN, rmsGain, peakGain),
  );

  for (let index = 0; index < outputSamples; index += 1) {
    view.setInt16(
      44 + index * bytesPerSample,
      pcm16(monoSamples[index] * gain),
      true,
    );
  }

  return buffer;
}
