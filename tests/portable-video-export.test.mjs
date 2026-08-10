import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyPortableAudioCrossfades,
  buildPortableFrameSchedule,
  buildPortableAudioCrossfadePlan,
  buildPortableDuckingEnvelope,
  canUseWholeFileAudioDecode,
  computePortableOriginalNormalizationGain,
  computePortableVideoDimensions,
  computePortableVideoDrawRect,
  createPortableVideoEncodingSettings,
  getPortableAudioSlicePlacement,
  getPortableEqualPowerFadeGain,
  getPortableEditedDuration,
  getPreferredPortableInputAudioTrack,
  HIGH_QUALITY_VIDEO_BITRATE,
  mapPortableEditedTimeToSourceTime,
  measurePortableOriginalAudioNormalization,
  normalizePortableFrameRate,
  normalizePortableVideoRanges,
  detectPortableNarrationActivity,
  PORTABLE_AUDIO_CUT_FADE_SECONDS,
  PORTABLE_NARRATION_DUCKING_RATIO,
  remapPortableNarrationActivity,
  selectPreferredPortableAudioTrack,
} from "../lib/portable-video-export.ts";

test("overlaps adjacent source audio with matching equal-power fades", () => {
  assert.equal(PORTABLE_AUDIO_CUT_FADE_SECONDS, 0.02);
  const fadeIn = Array.from({ length: 33 }, (_, index) =>
    getPortableEqualPowerFadeGain(index / 32, "in"),
  );
  const fadeOut = Array.from({ length: 33 }, (_, index) =>
    getPortableEqualPowerFadeGain(index / 32, "out"),
  );

  assert.equal(fadeIn[0], 0);
  assert.ok(Math.abs(fadeIn.at(-1) - 1) < 1e-12);
  assert.ok(Math.abs(fadeOut[0] - 1) < 1e-12);
  assert.ok(Math.abs(fadeOut.at(-1)) < 1e-12);
  assert.ok([...fadeIn, ...fadeOut].every((gain) => gain >= 0 && gain <= 1));
  assert.ok(
    Math.max(
      ...fadeIn.slice(1).map((gain, index) => Math.abs(gain - fadeIn[index])),
    ) < 0.05,
  );
  const plan = buildPortableAudioCrossfadePlan(
    { when: 0, offset: 1, duration: 2 },
    3.5,
    { when: 2, offset: 4, duration: 3 },
  );
  assert.ok(plan);
  assert.equal(plan.fadeDuration, 0.02);
  assert.equal(plan.overlapStart, 2);
  assert.equal(plan.overlapEnd, 2.02);
  assert.equal(plan.outgoing.when + plan.outgoing.duration, 2.02);
  assert.equal(plan.incoming.when, 2);
  assert.ok(
    Math.abs(
      Math.min(
      plan.outgoing.when + plan.outgoing.duration,
      plan.incoming.when + plan.incoming.duration,
      ) - Math.max(plan.outgoing.when, plan.incoming.when) - plan.fadeDuration,
    ) < 1e-12,
    "the two real slices overlap for the full fade window",
  );

  const equalPower = fadeIn.map((gain, index) =>
    Math.hypot(gain, fadeOut[index]),
  );
  assert.ok(equalPower.every((gain) => Math.abs(gain - 1) < 1e-6));
  assert.equal(
    buildPortableAudioCrossfadePlan(
      { when: 0, offset: 0, duration: 2 },
      2,
      { when: 2, offset: 0, duration: 2 },
    ),
    null,
    "a source with no safe outgoing tail is never repeated",
  );
});

test("keeps independent fade lengths on both sides of a middle clip", () => {
  const ranges = [
    [
      {
        buffer: { duration: 1.005 },
        placement: { when: 0, offset: 0, duration: 1 },
        fadeIn: false,
        fadeOut: false,
      },
    ],
    [
      {
        buffer: { duration: 4 },
        placement: { when: 1, offset: 0, duration: 2 },
        fadeIn: false,
        fadeOut: false,
      },
    ],
    [
      {
        buffer: { duration: 2 },
        placement: { when: 3, offset: 0, duration: 2 },
        fadeIn: false,
        fadeOut: false,
      },
    ],
  ];

  applyPortableAudioCrossfades(ranges);

  assert.ok(Math.abs(ranges[0][0].fadeOutDuration - 0.005) < 1e-12);
  assert.ok(Math.abs(ranges[1][0].fadeInDuration - 0.005) < 1e-12);
  assert.equal(ranges[1][0].fadeOutDuration, 0.02);
  assert.equal(ranges[2][0].fadeInDuration, 0.02);
  assert.equal(ranges[1][0].placement.when, 1);
  assert.equal(ranges[1][0].placement.duration, 2.02);
  assert.equal(ranges[2][0].placement.when, 3);
  assert.equal(
    Math.max(
      ranges[0][0].placement.when + ranges[0][0].placement.duration,
      ranges[1][0].placement.when + ranges[1][0].placement.duration,
      ranges[2][0].placement.when + ranges[2][0].placement.duration,
    ),
    5,
    "crossfades must not extend the edited program duration",
  );
});

test("normalizes original audio locally while preserving peak headroom", () => {
  const quietGain = computePortableOriginalNormalizationGain(0.02, 0.12);
  const hotGain = computePortableOriginalNormalizationGain(0.4, 0.98);

  assert.equal(quietGain, 1.8);
  assert.ok(hotGain < 1);
  assert.ok(0.98 * hotGain <= 0.9 + 1e-12);
  assert.equal(computePortableOriginalNormalizationGain(0, 0), 1);
  assert.equal(typeof measurePortableOriginalAudioNormalization, "function");
});

test("detects narration locally and ducks 8% and 12% source audio proportionally", () => {
  const sampleRate = 1_000;
  const narration = new Float32Array(2_000);
  narration.fill(0.24, 500, 1_200);
  const activity = detectPortableNarrationActivity(
    [narration],
    sampleRate,
    2,
  );
  assert.equal(activity.length, 1);
  assert.ok(activity[0].start <= 0.5 && activity[0].end >= 1.2);

  const eightPercent = buildPortableDuckingEnvelope(activity, 0.08, 2);
  const twelvePercent = buildPortableDuckingEnvelope(activity, 0.12, 2);
  const eightDucked = Math.min(...eightPercent.map((point) => point.gain));
  const twelveDucked = Math.min(...twelvePercent.map((point) => point.gain));
  assert.ok(Math.abs(eightDucked - 0.08 * PORTABLE_NARRATION_DUCKING_RATIO) < 1e-12);
  assert.ok(Math.abs(twelveDucked - 0.12 * PORTABLE_NARRATION_DUCKING_RATIO) < 1e-12);
  assert.ok(Math.abs(twelveDucked / eightDucked - 1.5) < 1e-12);
  assert.deepEqual(buildPortableDuckingEnvelope(activity, 0, 2), [
    { time: 0, gain: 0 },
    { time: 2, gain: 0 },
  ]);
});

test("stays ducked when narration remains active through the final sample", () => {
  const envelope = buildPortableDuckingEnvelope(
    [{ start: 0.2, end: 2 }],
    1,
    2,
  );

  assert.deepEqual(envelope, [
    { time: 0, gain: 1 },
    { time: 0.12000000000000001, gain: 1 },
    { time: 0.2, gain: PORTABLE_NARRATION_DUCKING_RATIO },
    { time: 2, gain: PORTABLE_NARRATION_DUCKING_RATIO },
  ]);
});

test("remaps narration activity for preview offsets, rates, and boundaries", () => {
  assert.deepEqual(
    remapPortableNarrationActivity(
      [
        { start: 0.5, end: 1.2 },
        { start: 1.8, end: 2.6 },
        { start: 2.5, end: 2.8 },
      ],
      1,
      2,
      0.75,
    ),
    [
      { start: 0, end: 0.09999999999999998 },
      { start: 0.4, end: 0.75 },
    ],
  );
  assert.deepEqual(
    remapPortableNarrationActivity(
      [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ],
      1,
      1,
      1,
    ),
    [],
    "activity touching only the exact slice boundaries has zero duration",
  );
  assert.deepEqual(remapPortableNarrationActivity([], 0, 1, 0), []);
  assert.throws(
    () => remapPortableNarrationActivity([], 0, 0, 1),
    /positive playbackRate/,
  );
});

test("uses a high-quality 1080p bitrate without another API request", () => {
  assert.equal(HIGH_QUALITY_VIDEO_BITRATE, 10_000_000);
});

test("loads the AAC encoder extension when an iPhone lacks native AAC encoding", async () => {
  const [source, packageJson] = await Promise.all([
    readFile(new URL("../lib/portable-video-export.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.equal(
    packageJson.dependencies["@mediabunny/aac-encoder"],
    "1.51.0",
  );
  assert.match(source, /import\("@mediabunny\/aac-encoder"\)/);
  assert.match(source, /registerAacEncoder\(\)/);
  assert.match(source, /ensurePortableAacEncoding\(media/);
});

test("registers the AAC extension as a real Mediabunny encoding capability", async () => {
  const [{ canEncodeAudio }, { registerAacEncoder }] = await Promise.all([
    import("mediabunny"),
    import("@mediabunny/aac-encoder"),
  ]);
  const settings = {
    numberOfChannels: 1,
    sampleRate: 48_000,
    bitrate: 128_000,
  };

  registerAacEncoder();

  assert.equal(await canEncodeAudio("aac", settings), true);
});

test("preflights the exact frame rate with quality-focused VBR settings", () => {
  assert.deepEqual(
    createPortableVideoEncodingSettings(1080, 1920, 10_000_000, 30),
    {
      width: 1080,
      height: 1920,
      bitrate: 10_000_000,
      framerate: 30,
      bitrateMode: "variable",
      latencyMode: "quality",
      contentHint: "detail",
    },
  );
});

test("does not use the memory-heavy whole-file audio fallback for large videos", () => {
  assert.equal(canUseWholeFileAudioDecode(96 * 1024 * 1024), true);
  assert.equal(canUseWholeFileAudioDecode(96 * 1024 * 1024 + 1), false);
});

test("prefers a decodable AAC fallback over iPhone spatial primary audio", () => {
  const spatialTrack = { id: "spatial" };
  const compatibleTrack = { id: "compatible" };

  assert.equal(
    selectPreferredPortableAudioTrack([
      {
        track: spatialTrack,
        codec: "eac3",
        decodable: false,
        primary: true,
      },
      {
        track: compatibleTrack,
        codec: "aac",
        decodable: true,
        primary: false,
      },
    ]),
    compatibleTrack,
  );
});

test("keeps the primary track as the browser decode fallback", () => {
  const primaryTrack = { id: "primary" };
  const secondaryTrack = { id: "secondary" };

  assert.equal(
    selectPreferredPortableAudioTrack([
      {
        track: primaryTrack,
        codec: "eac3",
        decodable: false,
        primary: true,
      },
      {
        track: secondaryTrack,
        codec: null,
        decodable: false,
        primary: false,
      },
    ]),
    primaryTrack,
  );
});

test("normalizes, clamps, sorts, and merges playable ranges", () => {
  assert.deepEqual(
    normalizePortableVideoRanges(
      [
        { start: 20, end: 25 },
        { start: 10, end: 15 },
        { start: -3, end: 5 },
        { start: 4, end: 11 },
        { start: 30, end: 31 },
      ],
      22,
    ),
    [
      { start: 0, end: 15 },
      { start: 20, end: 22 },
    ],
  );
});

test("writes standard full-HD frames for every source orientation", () => {
  assert.deepEqual(computePortableVideoDimensions(2160, 3840), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(computePortableVideoDimensions(3840, 2160), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(computePortableVideoDimensions(404, 720), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(computePortableVideoDimensions(1080, 1080), {
    width: 1080,
    height: 1080,
  });
});

test("uses the compatible iPhone audio track for both measurement and export", async () => {
  const spatialTrack = {
    id: "spatial",
    getCodec: async () => "eac3",
    canDecode: async () => false,
  };
  const compatibleTrack = {
    id: "compatible",
    getCodec: async () => "aac",
    canDecode: async () => true,
  };
  const input = {
    getAudioTracks: async () => [spatialTrack, compatibleTrack],
    getPrimaryAudioTrack: async () => spatialTrack,
  };

  assert.equal(
    await getPreferredPortableInputAudioTrack(input),
    compatibleTrack,
  );
});

test("centers a source frame without stretching it", () => {
  assert.deepEqual(computePortableVideoDrawRect(1920, 1080, 1920, 1080), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });

  const portrait = computePortableVideoDrawRect(404, 720, 1080, 1920);
  assert.equal(portrait.y, 0);
  assert.ok(portrait.x > 0 && portrait.x < 2);
  assert.equal(portrait.height, 1920);
});

test("caps output at 30fps", () => {
  assert.equal(normalizePortableFrameRate(), 30);
  assert.equal(normalizePortableFrameRate(60), 30);
  assert.equal(normalizePortableFrameRate(24), 24);
});

test("maps a cut timeline onto monotonically increasing source timestamps", () => {
  const ranges = [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
  ];
  const schedule = buildPortableFrameSchedule(ranges, 2);

  assert.deepEqual(schedule, [
    { frameIndex: 0, editedTime: 0, sourceTime: 0, duration: 0.5 },
    { frameIndex: 1, editedTime: 0.5, sourceTime: 0.5, duration: 0.5 },
    { frameIndex: 2, editedTime: 1, sourceTime: 3, duration: 0.5 },
    { frameIndex: 3, editedTime: 1.5, sourceTime: 3.5, duration: 0.5 },
  ]);
  assert.equal(getPortableEditedDuration(ranges), 2);
  assert.equal(mapPortableEditedTimeToSourceTime(ranges, 1.25), 3.25);
});

test("adds a short visual dissolve after a cut without changing duration", () => {
  const schedule = buildPortableFrameSchedule(
    [
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ],
    30,
  );
  const transitionFrames = schedule.filter(
    (frame) => frame.blendFromSourceTime !== undefined,
  );

  assert.equal(schedule.at(-1).editedTime + schedule.at(-1).duration, 2);
  assert.ok(transitionFrames.length >= 1);
  assert.ok(
    transitionFrames.every(
      (frame) =>
        frame.editedTime >= 1 &&
        frame.editedTime < 1.08 &&
        frame.blendFromSourceTime > 0.9 &&
        frame.blendFromSourceTime < 1 &&
        frame.blendProgress > 0 &&
        frame.blendProgress < 1,
    ),
  );
});

test("keeps the final partial frame at the exact edited duration", () => {
  assert.deepEqual(
    buildPortableFrameSchedule([{ start: 2, end: 2.4 }], 2),
    [
      {
        frameIndex: 0,
        editedTime: 0,
        sourceTime: 2,
        duration: 0.3999999999999999,
      },
    ],
  );
});

test("places only the overlapping source audio on the edited timeline", () => {
  const range = { start: 10, end: 12 };

  assert.deepEqual(
    getPortableAudioSlicePlacement(range, 5, 9.5, 1),
    { when: 5, offset: 0.5, duration: 0.5 },
  );
  assert.deepEqual(
    getPortableAudioSlicePlacement(range, 5, 11.75, 1),
    { when: 6.75, offset: 0, duration: 0.25 },
  );
  assert.equal(
    getPortableAudioSlicePlacement(range, 5, 12.5, 1),
    null,
  );
});
