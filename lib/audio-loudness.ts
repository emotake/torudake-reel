const BS1770_OFFSET_DB = -0.691;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_DB = -10;
const BLOCK_SECONDS = 0.4;
const BLOCK_STEP_SECONDS = 0.1;
const DEFAULT_TARGET_LUFS = -16;
const DEFAULT_TRUE_PEAK_LIMIT_DBTP = -1;

type BiquadCoefficients = Readonly<{
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}>;

type BiquadState = {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

export type AudioLoudnessMeasurement = Readonly<{
  /** BS.1770-style integrated programme loudness after absolute/relative gates. */
  integratedLufs: number | null;
  ungatedLufs: number | null;
  gatedMeanSquare: number;
  ungatedMeanSquare: number;
  samplePeak: number;
  /** Four-times cubic inter-sample peak estimate, expressed as a linear gain. */
  truePeak: number;
  gatedBlockCount: number;
  totalBlockCount: number;
  durationSeconds: number;
}>;

export type AudioLoudnessRange = Readonly<{
  startFrame?: number;
  endFrame?: number;
}>;

function finiteSample(value: number | undefined) {
  return Number.isFinite(value) ? value ?? 0 : 0;
}

function meanSquareToLufs(meanSquare: number) {
  return meanSquare > 0
    ? BS1770_OFFSET_DB + 10 * Math.log10(meanSquare)
    : null;
}

function lufsToMeanSquare(lufs: number) {
  return 10 ** ((lufs - BS1770_OFFSET_DB) / 10);
}

/** Coefficients from the BS.1770 K-weighting analogue prototypes. */
function createKWeightingCoefficients(sampleRate: number) {
  const shelfFrequency = 1681.974450955533;
  const shelfGainDb = 3.999843853973347;
  const shelfQ = 0.7071752369554196;
  const shelfK = Math.tan((Math.PI * shelfFrequency) / sampleRate);
  const shelfVh = 10 ** (shelfGainDb / 20);
  const shelfVb = shelfVh ** 0.4996667741545416;
  const shelfDenominator =
    1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: BiquadCoefficients = {
    b0:
      (shelfVh + (shelfVb * shelfK) / shelfQ + shelfK * shelfK) /
      shelfDenominator,
    b1: (2 * (shelfK * shelfK - shelfVh)) / shelfDenominator,
    b2:
      (shelfVh - (shelfVb * shelfK) / shelfQ + shelfK * shelfK) /
      shelfDenominator,
    a1: (2 * (shelfK * shelfK - 1)) / shelfDenominator,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfDenominator,
  };

  const highPassFrequency = 38.13547087602444;
  const highPassQ = 0.5003270373238773;
  const highPassK = Math.tan((Math.PI * highPassFrequency) / sampleRate);
  const highPassDenominator =
    1 + highPassK / highPassQ + highPassK * highPassK;
  const highPass: BiquadCoefficients = {
    // BS.1770's RLB stage intentionally keeps these feed-forward terms at
    // unity instead of normalising them by the denominator.
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (highPassK * highPassK - 1)) / highPassDenominator,
    a2:
      (1 - highPassK / highPassQ + highPassK * highPassK) /
      highPassDenominator,
  };
  return { shelf, highPass };
}

function filterSample(
  input: number,
  coefficients: BiquadCoefficients,
  state: BiquadState,
) {
  const output =
    coefficients.b0 * input +
    coefficients.b1 * state.x1 +
    coefficients.b2 * state.x2 -
    coefficients.a1 * state.y1 -
    coefficients.a2 * state.y2;
  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;
  return Number.isFinite(output) ? output : 0;
}

function channelWeight(channel: number, channelCount: number) {
  if (channelCount <= 2) return 1;
  // Web Audio's common 5.1 order is L, R, C, LFE, SL, SR. BS.1770 excludes
  // LFE and gives the surrounds +1.5 dB. Mono/stereo (the export norm) stay 1.
  if (channel === 3) return 0;
  if (channel >= 4) return 10 ** (1.5 / 10);
  return 1;
}

function cubicInterpolate(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  position: number,
) {
  const squared = position * position;
  const cubed = squared * position;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * position +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * squared +
      (-p0 + 3 * p1 - 3 * p2 + p3) * cubed)
  );
}

/**
 * Lightweight 4x inter-sample peak estimate. Cubic interpolation can expose
 * peaks between PCM samples while remaining fast enough for on-device export.
 */
export function estimateTruePeak4x(
  channels: readonly Float32Array[],
  range: AudioLoudnessRange = {},
) {
  const maximumFrames = channels.reduce(
    (maximum, channel) => Math.max(maximum, channel.length),
    0,
  );
  const startFrame = Math.max(
    0,
    Math.min(maximumFrames, Math.floor(range.startFrame ?? 0)),
  );
  const endFrame = Math.max(
    startFrame,
    Math.min(maximumFrames, Math.ceil(range.endFrame ?? maximumFrames)),
  );
  let samplePeak = 0;
  let truePeak = 0;

  for (const channel of channels) {
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const p1 = finiteSample(channel[frame]);
      samplePeak = Math.max(samplePeak, Math.abs(p1));
      truePeak = Math.max(truePeak, Math.abs(p1));
      if (frame + 1 >= endFrame) continue;
      const p0 = finiteSample(channel[frame - 1] ?? p1);
      const p2 = finiteSample(channel[frame + 1]);
      const p3 = finiteSample(channel[frame + 2] ?? p2);
      for (const phase of [0.25, 0.5, 0.75]) {
        truePeak = Math.max(
          truePeak,
          Math.abs(cubicInterpolate(p0, p1, p2, p3, phase)),
        );
      }
    }
  }

  return { samplePeak, truePeak };
}

/**
 * Measures integrated loudness using K-weighting, 400 ms blocks at 75%
 * overlap, the -70 LUFS absolute gate and the -10 LU relative gate. It is a
 * browser-safe approximation of BS.1770/EBU R128 rather than a certification
 * meter, but its gain decisions are materially more stable than raw RMS.
 */
export function measureAudioLoudness(
  channels: readonly Float32Array[],
  sampleRate: number,
  range: AudioLoudnessRange = {},
): AudioLoudnessMeasurement {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000) {
    throw new RangeError("sampleRate must be a finite value of at least 8000 Hz.");
  }
  const maximumFrames = channels.reduce(
    (maximum, channel) => Math.max(maximum, channel.length),
    0,
  );
  const startFrame = Math.max(
    0,
    Math.min(maximumFrames, Math.floor(range.startFrame ?? 0)),
  );
  const endFrame = Math.max(
    startFrame,
    Math.min(maximumFrames, Math.ceil(range.endFrame ?? maximumFrames)),
  );
  const frameCount = endFrame - startFrame;
  const peaks = estimateTruePeak4x(channels, { startFrame, endFrame });
  if (channels.length === 0 || frameCount === 0) {
    return {
      integratedLufs: null,
      ungatedLufs: null,
      gatedMeanSquare: 0,
      ungatedMeanSquare: 0,
      ...peaks,
      gatedBlockCount: 0,
      totalBlockCount: 0,
      durationSeconds: 0,
    };
  }

  const blockFrames = Math.max(1, Math.round(BLOCK_SECONDS * sampleRate));
  const stepFrames = Math.max(1, Math.round(BLOCK_STEP_SECONDS * sampleRate));
  const energyRing = new Float64Array(blockFrames);
  const coefficients = createKWeightingCoefficients(sampleRate);
  const filterStates = channels.map(() => ({
    shelf: { x1: 0, x2: 0, y1: 0, y2: 0 },
    highPass: { x1: 0, x2: 0, y1: 0, y2: 0 },
  }));
  const blockEnergies: number[] = [];
  let runningEnergy = 0;
  let ringIndex = 0;
  let processedFrames = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    let frameEnergy = 0;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const state = filterStates[channelIndex];
      const shelfOutput = filterSample(
        finiteSample(channels[channelIndex][frame]),
        coefficients.shelf,
        state.shelf,
      );
      const weighted = filterSample(
        shelfOutput,
        coefficients.highPass,
        state.highPass,
      );
      frameEnergy +=
        weighted *
        weighted *
        channelWeight(channelIndex, channels.length);
    }

    runningEnergy += frameEnergy - energyRing[ringIndex];
    energyRing[ringIndex] = frameEnergy;
    ringIndex = (ringIndex + 1) % blockFrames;
    processedFrames += 1;
    if (
      processedFrames >= blockFrames &&
      (processedFrames - blockFrames) % stepFrames === 0
    ) {
      blockEnergies.push(Math.max(0, runningEnergy / blockFrames));
    }
  }
  if (processedFrames < blockFrames) {
    blockEnergies.push(Math.max(0, runningEnergy / processedFrames));
  }

  const ungatedMeanSquare =
    blockEnergies.reduce((total, energy) => total + energy, 0) /
    Math.max(1, blockEnergies.length);
  const absoluteGate = lufsToMeanSquare(ABSOLUTE_GATE_LUFS);
  const aboveAbsoluteGate = blockEnergies.filter(
    (energy) => energy >= absoluteGate,
  );
  const preliminaryMeanSquare =
    aboveAbsoluteGate.reduce((total, energy) => total + energy, 0) /
    Math.max(1, aboveAbsoluteGate.length);
  const preliminaryLufs = meanSquareToLufs(preliminaryMeanSquare);
  const relativeGate =
    preliminaryLufs === null
      ? Number.POSITIVE_INFINITY
      : lufsToMeanSquare(preliminaryLufs + RELATIVE_GATE_DB);
  const finalGate = Math.max(absoluteGate, relativeGate);
  const gatedBlocks = blockEnergies.filter((energy) => energy >= finalGate);
  const gatedMeanSquare =
    gatedBlocks.reduce((total, energy) => total + energy, 0) /
    Math.max(1, gatedBlocks.length);

  return {
    integratedLufs:
      gatedBlocks.length > 0 ? meanSquareToLufs(gatedMeanSquare) : null,
    ungatedLufs: meanSquareToLufs(ungatedMeanSquare),
    gatedMeanSquare: gatedBlocks.length > 0 ? gatedMeanSquare : 0,
    ungatedMeanSquare,
    ...peaks,
    gatedBlockCount: gatedBlocks.length,
    totalBlockCount: blockEnergies.length,
    durationSeconds: frameCount / sampleRate,
  };
}

export function combineAudioLoudnessMeasurements(
  measurements: readonly AudioLoudnessMeasurement[],
): AudioLoudnessMeasurement {
  let gatedEnergyTotal = 0;
  let ungatedEnergyTotal = 0;
  let gatedBlockCount = 0;
  let totalBlockCount = 0;
  let samplePeak = 0;
  let truePeak = 0;
  let durationSeconds = 0;

  for (const measurement of measurements) {
    if (measurement.gatedBlockCount > 0) {
      gatedEnergyTotal +=
        measurement.gatedMeanSquare * measurement.gatedBlockCount;
      gatedBlockCount += measurement.gatedBlockCount;
    }
    ungatedEnergyTotal +=
      measurement.ungatedMeanSquare * measurement.totalBlockCount;
    totalBlockCount += measurement.totalBlockCount;
    samplePeak = Math.max(samplePeak, measurement.samplePeak);
    truePeak = Math.max(truePeak, measurement.truePeak);
    durationSeconds += measurement.durationSeconds;
  }

  const gatedMeanSquare =
    gatedBlockCount > 0 ? gatedEnergyTotal / gatedBlockCount : 0;
  const ungatedMeanSquare =
    totalBlockCount > 0 ? ungatedEnergyTotal / totalBlockCount : 0;
  return {
    integratedLufs: meanSquareToLufs(gatedMeanSquare),
    ungatedLufs: meanSquareToLufs(ungatedMeanSquare),
    gatedMeanSquare,
    ungatedMeanSquare,
    samplePeak,
    truePeak,
    gatedBlockCount,
    totalBlockCount,
    durationSeconds,
  };
}

export function computeLoudnessNormalizationGain(
  measurement: Pick<AudioLoudnessMeasurement, "integratedLufs" | "truePeak">,
  options: Readonly<{
    targetLufs?: number;
    truePeakLimitDbtp?: number;
    minimumGain?: number;
    maximumGain?: number;
  }> = {},
) {
  const targetLufs = options.targetLufs ?? DEFAULT_TARGET_LUFS;
  const truePeakLimitDbtp =
    options.truePeakLimitDbtp ?? DEFAULT_TRUE_PEAK_LIMIT_DBTP;
  const minimumGain = options.minimumGain ?? 0.4;
  const maximumGain = options.maximumGain ?? 1.8;
  if (
    !Number.isFinite(targetLufs) ||
    !Number.isFinite(truePeakLimitDbtp) ||
    !Number.isFinite(minimumGain) ||
    !Number.isFinite(maximumGain) ||
    minimumGain < 0 ||
    maximumGain < minimumGain
  ) {
    throw new RangeError("Invalid loudness normalization options.");
  }
  if (
    measurement.integratedLufs === null ||
    !Number.isFinite(measurement.integratedLufs) ||
    !Number.isFinite(measurement.truePeak) ||
    measurement.truePeak < 0
  ) {
    return 1;
  }

  const loudnessGain = 10 ** ((targetLufs - measurement.integratedLufs) / 20);
  const truePeakLimit = 10 ** (truePeakLimitDbtp / 20);
  const peakSafeGain =
    measurement.truePeak > 0
      ? truePeakLimit / measurement.truePeak
      : maximumGain;
  return Math.max(
    0,
    Math.min(maximumGain, Math.max(minimumGain, loudnessGain), peakSafeGain),
  );
}
