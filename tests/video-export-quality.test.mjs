import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  analyzeVideoExportDecodedFrames,
  assessExportedVideoQuality,
  assessVideoExportQuality,
  explainVideoExportResolution,
  inspectExportedVideoQuality,
  inspectVideoExportQuality,
  meetsTarget1080pResolution,
} from "../lib/video-export-quality.ts";

function qualityMetrics(overrides = {}) {
  return {
    containerMimeType: "video/mp4",
    width: 1080,
    height: 1920,
    codec: "avc",
    codecParameterString: "avc1.640028",
    averageBitrate: 8_000_000,
    averageFrameRate: 30,
    packetCount: 300,
    durationSeconds: 10,
    fileSizeBytes: 10_000_000,
    audioTrackPresent: true,
    audioCodec: "aac",
    audioCodecParameterString: "mp4a.40.2",
    audioDurationSeconds: 10,
    audioChannels: 2,
    audioSampleRate: 48_000,
    audioRms: 0.08,
    audioPeak: 0.6,
    audioActivityRanges: [
      {
        start: 0,
        end: 10,
        rms: 0.08,
        peak: 0.6,
        activeRatio: 0.8,
        sampledFrames: 48_000,
      },
    ],
    ...overrides,
  };
}

test("flags sparse black and frozen boundary frames but exempts intentional black fades", () => {
  const frames = [
    { time: 0.1, luminance: 80, variance: 200, fingerprint: 0.2 },
    { time: 1.93, luminance: 45, variance: 160, fingerprint: 0.4 },
    { time: 2.07, luminance: 45.05, variance: 161, fingerprint: 0.4001 },
    { time: 3, luminance: 0.5, variance: 1, fingerprint: 0.01 },
  ];
  const findings = analyzeVideoExportDecodedFrames(frames, {
    boundarySeconds: [2, 3],
  });
  assert.deepEqual(findings.frozenPairStarts, [1.93]);
  assert.deepEqual(findings.blackFrameTimes, [3]);

  const intentional = analyzeVideoExportDecodedFrames(frames, {
    boundarySeconds: [2, 3],
    allowBlackAtBoundarySeconds: [3],
  });
  assert.deepEqual(intentional.blackFrameTimes, []);
});

test("recognizes portrait, landscape, and square 1080p output", () => {
  assert.equal(
    meetsTarget1080pResolution({ width: 1080, height: 1920 }),
    true,
  );
  assert.equal(
    meetsTarget1080pResolution({ width: 1920, height: 1080 }),
    true,
  );
  assert.equal(
    meetsTarget1080pResolution({ width: 1080, height: 1080 }),
    true,
  );
  assert.equal(
    meetsTarget1080pResolution({ width: 404, height: 720 }),
    false,
  );
  assert.equal(
    meetsTarget1080pResolution({ width: null, height: 1920 }),
    null,
  );
});

test("can require the exact dimensions expected by an export path", () => {
  assert.equal(
    meetsTarget1080pResolution(
      { width: 1080, height: 1440 },
      { minimumShortEdge: 1080, expectedWidth: 1080, expectedHeight: 1920 },
    ),
    false,
  );
});

test("passes a complete full-HD High Profile export", () => {
  assert.deepEqual(assessVideoExportQuality(qualityMetrics()), {
    verdict: "pass",
    meetsTargetResolution: true,
    isComplete: true,
    issues: [],
  });
});

test("fails visibly undersized and critically compressed output", () => {
  const assessment = assessVideoExportQuality(
    qualityMetrics({
      width: 404,
      height: 720,
      averageBitrate: 600_000,
      averageFrameRate: 12,
    }),
  );

  assert.equal(assessment.verdict, "fail");
  assert.equal(assessment.meetsTargetResolution, false);
  assert.deepEqual(
    assessment.issues.map((issue) => issue.code),
    [
      "resolution-below-target",
      "bitrate-critical",
      "frame-rate-critical",
    ],
  );
  assert.equal(
    assessment.issues.find((issue) => issue.code === "bitrate-critical")
      ?.severity,
    "info",
  );
});

test("warns for borderline bitrate, frame rate, and browser fallback codec", () => {
  const assessment = assessVideoExportQuality(
    qualityMetrics({
      codec: "vp9",
      codecParameterString: "vp09.00.10.08",
      averageBitrate: 3_500_000,
      averageFrameRate: 20,
    }),
  );

  assert.equal(assessment.verdict, "warning");
  assert.deepEqual(
    assessment.issues.map((issue) => issue.code),
    [
      "bitrate-below-recommended",
      "frame-rate-below-recommended",
      "codec-compatibility",
    ],
  );
});

test("treats VBR bitrate as advisory unless fixed-bitrate checking is requested", () => {
  const vbrAssessment = assessVideoExportQuality(
    qualityMetrics({ averageBitrate: 600_000 }),
  );
  assert.equal(vbrAssessment.verdict, "pass");
  assert.equal(vbrAssessment.issues[0]?.severity, "info");

  const fixedBitrateAssessment = assessVideoExportQuality(
    qualityMetrics({ averageBitrate: 600_000 }),
    { useBitrateForVerdict: true },
  );
  assert.equal(fixedBitrateAssessment.verdict, "fail");
  assert.equal(fixedBitrateAssessment.issues[0]?.severity, "error");
});

test("reports a Baseline H.264 fallback separately from codec compatibility", () => {
  const assessment = assessVideoExportQuality(
    qualityMetrics({ codecParameterString: "avc1.42E01F" }),
  );

  assert.equal(assessment.verdict, "warning");
  assert.equal(assessment.issues[0]?.code, "h264-profile-fallback");
});

test("does not mistake unavailable measurements for poor quality", () => {
  const assessment = assessVideoExportQuality(
    qualityMetrics({
      width: null,
      height: null,
      codec: null,
      codecParameterString: null,
      averageBitrate: null,
      averageFrameRate: null,
    }),
  );

  assert.equal(assessment.verdict, "unknown");
  assert.equal(assessment.meetsTargetResolution, null);
  assert.equal(assessment.isComplete, false);
  assert.ok(assessment.issues.every((issue) => issue.severity === "info"));
});

test("inspects an existing input without taking ownership of it", async () => {
  let disposed = false;
  const track = {
    async getDisplayWidth() {
      return 1080;
    },
    async getDisplayHeight() {
      return 1920;
    },
    async getCodec() {
      return "avc";
    },
    async getCodecParameterString() {
      return "avc1.640028";
    },
    async getDurationFromMetadata() {
      return 10;
    },
    async computeDuration() {
      throw new Error("metadata should be preferred");
    },
    async computePacketStats(packetCount) {
      assert.equal(packetCount, 120);
      return {
        packetCount: 120,
        averagePacketRate: 29.97,
        averageBitrate: 7_500_000,
      };
    },
  };
  const input = {
    async canRead() {
      return true;
    },
    async getPrimaryVideoTrack() {
      return track;
    },
    dispose() {
      disposed = true;
    },
  };

  const result = await inspectVideoExportQuality(input, {
    packetSampleCount: 120,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.metrics, qualityMetrics({
    containerMimeType: null,
    averageBitrate: 7_500_000,
    averageFrameRate: 29.97,
    packetCount: 120,
    fileSizeBytes: null,
    audioTrackPresent: false,
    audioCodec: null,
    audioCodecParameterString: null,
    audioDurationSeconds: null,
    audioChannels: null,
    audioSampleRate: null,
    audioRms: null,
    audioPeak: null,
    audioActivityRanges: null,
  }));
  assert.deepEqual(result.unavailableMetrics, [
    "containerMimeType",
    "fileSizeBytes",
    "audioCodec",
    "audioCodecParameterString",
    "audioDurationSeconds",
    "audioChannels",
    "audioSampleRate",
    "audioRms",
    "audioPeak",
    "audioActivityRanges",
  ]);
  assert.equal(disposed, false);
});

test("keeps partial metadata when packet scanning is unavailable", async () => {
  const input = {
    async canRead() {
      return true;
    },
    async getPrimaryVideoTrack() {
      return {
        async getDisplayWidth() {
          return 1080;
        },
        async getDisplayHeight() {
          return 1920;
        },
        async getCodec() {
          return "avc";
        },
        async getCodecParameterString() {
          return "avc1.640028";
        },
        async getDurationFromMetadata() {
          return null;
        },
        async computeDuration() {
          return 8;
        },
        async computePacketStats() {
          throw new Error("packet scan not supported");
        },
      };
    },
  };

  const result = await inspectVideoExportQuality(input);

  assert.equal(result.status, "ok");
  assert.equal(result.metrics?.durationSeconds, 8);
  assert.equal(result.metrics?.averageBitrate, null);
  assert.equal(result.metrics?.averageFrameRate, null);
  assert.ok(result.unavailableMetrics.includes("averageBitrate"));
});

test("returns clear non-throwing results for unreadable and broken inputs", async () => {
  const unreadable = await inspectVideoExportQuality({
    async canRead() {
      return false;
    },
    async getPrimaryVideoTrack() {
      throw new Error("must not be called");
    },
  });
  assert.equal(unreadable.status, "unreadable-file");

  const broken = await inspectVideoExportQuality({
    async canRead() {
      throw new Error("parser failed");
    },
    async getPrimaryVideoTrack() {
      return null;
    },
  });
  assert.equal(broken.status, "analysis-failed");
});

test("returns no-video-track without throwing", async () => {
  const result = await inspectVideoExportQuality({
    async canRead() {
      return true;
    },
    async getPrimaryVideoTrack() {
      return null;
    },
  });

  assert.equal(result.status, "no-video-track");
  assert.equal(result.metrics, null);
});

test("provides app-facing inspection and exact-dimension assessment helpers", async () => {
  const input = {
    async canRead() {
      return true;
    },
    async getPrimaryVideoTrack() {
      return {
        async getDisplayWidth() {
          return 1080;
        },
        async getDisplayHeight() {
          return 1440;
        },
        async getCodec() {
          return "avc";
        },
        async getCodecParameterString() {
          return "avc1.640028";
        },
        async getDurationFromMetadata() {
          return 5;
        },
        async computeDuration() {
          return 5;
        },
        async computePacketStats() {
          return {
            packetCount: 150,
            averagePacketRate: 30,
            averageBitrate: 8_000_000,
          };
        },
      };
    },
  };

  const inspection = await inspectExportedVideoQuality(input);
  const assessment = assessExportedVideoQuality(inspection, {
    width: 1080,
    height: 1920,
  });

  assert.equal(inspection.status, "ok");
  assert.equal(assessment.verdict, "fail");
  assert.equal(assessment.meetsTargetResolution, false);
});

test("fails closed when a required audio track or audible signal is missing", () => {
  const missingTrack = assessVideoExportQuality(
    qualityMetrics({
      audioTrackPresent: false,
      audioCodec: null,
      audioCodecParameterString: null,
      audioDurationSeconds: null,
      audioRms: null,
      audioPeak: null,
      audioActivityRanges: null,
    }),
    { requireAudio: true, expectedDurationSeconds: 10 },
  );
  assert.equal(missingTrack.verdict, "fail");
  assert.ok(
    missingTrack.issues.some((issue) => issue.code === "audio-track-missing"),
  );

  const silentTrack = assessVideoExportQuality(
    qualityMetrics({ audioRms: 0.0001, audioPeak: 0.0005 }),
    { requireAudio: true, expectedDurationSeconds: 10 },
  );
  assert.equal(silentTrack.verdict, "fail");
  assert.ok(silentTrack.issues.some((issue) => issue.code === "audio-silent"));
});

test("can require an original audio track without rejecting an intentionally silent track", () => {
  const trackOnly = assessVideoExportQuality(
    qualityMetrics({
      audioTrackPresent: true,
      audioRms: null,
      audioPeak: null,
      audioActivityRanges: null,
    }),
    {
      requireAudioTrack: true,
      requireAudibleAudio: false,
      expectedDurationSeconds: 10,
    },
  );
  assert.equal(trackOnly.verdict, "pass");
  assert.equal(trackOnly.isComplete, true);
  assert.ok(!trackOnly.issues.some((issue) => issue.code === "audio-silent"));

  const missingTrack = assessVideoExportQuality(
    qualityMetrics({
      audioTrackPresent: false,
      audioCodec: null,
      audioCodecParameterString: null,
      audioDurationSeconds: null,
      audioRms: null,
      audioPeak: null,
      audioActivityRanges: null,
    }),
    { requireAudioTrack: true, requireAudibleAudio: false },
  );
  assert.equal(missingTrack.verdict, "fail");
  assert.ok(
    missingTrack.issues.some((issue) => issue.code === "audio-track-missing"),
  );

  const inaudibleTrack = assessVideoExportQuality(
    qualityMetrics({ audioRms: 0.0001, audioPeak: 0.0005 }),
    { requireAudioTrack: true, requireAudibleAudio: true },
  );
  assert.equal(inaudibleTrack.verdict, "fail");
  assert.ok(
    inaudibleTrack.issues.some((issue) => issue.code === "audio-silent"),
  );
});

test("requires AAC-compatible MP4 audio and matching audio/video duration", () => {
  const assessment = assessVideoExportQuality(
    qualityMetrics({
      audioCodec: "pcm-s16",
      audioCodecParameterString: "lpcm",
      audioDurationSeconds: 7,
    }),
    { requireAudio: true, expectedDurationSeconds: 10 },
  );

  assert.equal(assessment.verdict, "fail");
  assert.ok(
    assessment.issues.some(
      (issue) => issue.code === "audio-codec-compatibility",
    ),
  );
  assert.ok(
    assessment.issues.some(
      (issue) => issue.code === "audio-duration-mismatch",
    ),
  );
});

test("detects a missing AI narration range after final encoding", () => {
  const expectedNarrationRanges = [
    { start: 0.5, end: 2.5 },
    { start: 3, end: 5 },
  ];
  const assessment = assessVideoExportQuality(
    qualityMetrics({
      audioActivityRanges: [
        {
          start: 0.5,
          end: 2.5,
          rms: 0.08,
          peak: 0.6,
          activeRatio: 0.7,
          sampledFrames: 20_000,
        },
        {
          start: 3,
          end: 5,
          rms: 0.0002,
          peak: 0.001,
          activeRatio: 0,
          sampledFrames: 20_000,
        },
      ],
    }),
    {
      requireAudio: true,
      expectedDurationSeconds: 10,
      expectedNarrationRanges,
    },
  );

  assert.equal(assessment.verdict, "fail");
  assert.ok(
    assessment.issues.some(
      (issue) => issue.code === "narration-audio-missing",
    ),
  );
});

test("rejects truncated output and captions outside the finalized duration", () => {
  const assessment = assessVideoExportQuality(
    qualityMetrics({ durationSeconds: 8, audioDurationSeconds: 8 }),
    {
      expectedDurationSeconds: 10,
      captionRanges: [{ start: 7.5, end: 9.5 }],
    },
  );

  assert.equal(assessment.verdict, "fail");
  assert.ok(
    assessment.issues.some((issue) => issue.code === "duration-mismatch"),
  );
  assert.ok(
    assessment.issues.some(
      (issue) => issue.code === "caption-timing-outside-video",
    ),
  );
});

test("inspects audio metadata and supplied activity ranges", async () => {
  const expectedNarrationRanges = [{ start: 1, end: 3 }];
  const result = await inspectVideoExportQuality(
    {
      async canRead() {
        return true;
      },
      async getPrimaryVideoTrack() {
        return {
          async getDisplayWidth() { return 1080; },
          async getDisplayHeight() { return 1920; },
          async getCodec() { return "avc"; },
          async getCodecParameterString() { return "avc1.640028"; },
          async getDurationFromMetadata() { return 10; },
          async computeDuration() { return 10; },
          async computePacketStats() {
            return {
              packetCount: 300,
              averagePacketRate: 30,
              averageBitrate: 8_000_000,
            };
          },
        };
      },
      async getPrimaryAudioTrack() {
        return {
          async getCodec() { return "aac"; },
          async getCodecParameterString() { return "mp4a.40.2"; },
          async getDurationFromMetadata() { return 10; },
          async computeDuration() { return 10; },
          async getNumberOfChannels() { return 2; },
          async getSampleRate() { return 48_000; },
          async inspectActivityRanges(ranges) {
            assert.deepEqual(ranges, expectedNarrationRanges);
            return ranges.map((range) => ({
              ...range,
              rms: 0.07,
              peak: 0.5,
              activeRatio: 0.6,
              sampledFrames: 24_000,
            }));
          },
        };
      },
    },
    { expectedNarrationRanges },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.metrics?.audioTrackPresent, true);
  assert.equal(result.metrics?.audioCodec, "aac");
  assert.equal(result.metrics?.audioRms, 0.07);
  assert.equal(result.metrics?.audioActivityRanges?.length, 1);
});

test("treats an unreadable completed container as a failed export", async () => {
  const inspection = await inspectExportedVideoQuality({
    async canRead() { return false; },
    async getPrimaryVideoTrack() { return null; },
  });
  const assessment = assessExportedVideoQuality(inspection, {
    width: 1080,
    height: 1920,
  });

  assert.equal(assessment.verdict, "fail");
  assert.equal(assessment.issues[0]?.severity, "error");
});

test("parses real AAC MOV metadata and rejects a real video without audio", async () => {
  const fixtureRoot = new URL("./fixtures/media/", import.meta.url);
  const aacBytes = await readFile(
    new URL("synthetic-portrait-h264-aac.mov", fixtureRoot),
  );
  const aacInspection = await inspectExportedVideoQuality(
    new Blob([aacBytes], { type: "video/quicktime" }),
    { inspectAudioActivity: false },
  );

  assert.equal(aacInspection.status, "ok");
  assert.equal(aacInspection.metrics?.containerMimeType, "video/quicktime");
  assert.equal(aacInspection.metrics?.codec, "avc");
  assert.equal(aacInspection.metrics?.audioTrackPresent, true);
  assert.equal(aacInspection.metrics?.audioCodec, "aac");
  assert.ok((aacInspection.metrics?.durationSeconds ?? 0) > 1.9);

  const silentBytes = await readFile(
    new URL("silent-portrait.mp4", fixtureRoot),
  );
  const silentInspection = await inspectExportedVideoQuality(
    new Blob([silentBytes], { type: "video/mp4" }),
    { inspectAudioActivity: false },
  );
  const silentAssessment = assessExportedVideoQuality(
    silentInspection,
    { width: 360, height: 640 },
    { requireAudio: true },
  );

  assert.equal(silentAssessment.verdict, "fail");
  assert.ok(
    silentAssessment.issues.some(
      (issue) => issue.code === "audio-track-missing",
    ),
  );
});

test("reports the actual output resolution when source and export meet the target", () => {
  const explanation = explainVideoExportResolution({
    source: { width: 1080, height: 1920 },
    output: { width: 1080, height: 1920 },
    expected: { width: 1080, height: 1920 },
  });

  assert.equal(explanation.cause, "target-met");
  assert.equal(explanation.outputResolutionLabel, "1080×1920");
  assert.equal(explanation.sourceRequiresUpscaling, false);
  assert.equal(explanation.outputMeetsExpectedDimensions, true);
  assert.match(explanation.headline, /完成動画：1080×1920/);
});

test("attributes limited detail to a low-resolution source even after a full-HD export", () => {
  const explanation = explainVideoExportResolution({
    source: { width: 404, height: 720 },
    output: { width: 1080, height: 1920 },
    expected: { width: 1080, height: 1920 },
  });

  assert.equal(explanation.cause, "source-limited");
  assert.equal(explanation.sourceResolutionLabel, "404×720");
  assert.equal(explanation.outputResolutionLabel, "1080×1920");
  assert.equal(explanation.sourceRequiresUpscaling, true);
  assert.equal(explanation.outputMeetsExpectedDimensions, true);
  assert.match(explanation.detail, /元動画（404×720）/);
  assert.match(explanation.detail, /元動画にない細部は.*復元できません/);
});

test("distinguishes a device export limit when the source has sufficient detail", () => {
  const explanation = explainVideoExportResolution({
    source: { width: 1080, height: 1920 },
    output: { width: 720, height: 1280 },
    expected: { width: 1080, height: 1920 },
  });

  assert.equal(explanation.cause, "export-limited");
  assert.equal(explanation.sourceRequiresUpscaling, false);
  assert.equal(explanation.outputMeetsExpectedDimensions, false);
  assert.match(explanation.detail, /端末またはブラウザの書き出し制約/);
});

test("reports both limits instead of blaming only the source when export is also undersized", () => {
  const explanation = explainVideoExportResolution({
    source: { width: 404, height: 720 },
    output: { width: 404, height: 720 },
    expected: { width: 1080, height: 1920 },
  });

  assert.equal(explanation.cause, "source-and-export-limited");
  assert.equal(explanation.sourceRequiresUpscaling, true);
  assert.equal(explanation.outputMeetsExpectedDimensions, false);
  assert.match(explanation.detail, /元動画由来の限界/);
  assert.match(explanation.detail, /目標の1080×1920にも届いていません/);
});

test("does not mislabel landscape or square footage contained in a portrait canvas", () => {
  const landscape = explainVideoExportResolution({
    source: { width: 1920, height: 1080 },
    output: { width: 1080, height: 1920 },
    expected: { width: 1080, height: 1920 },
  });
  const square = explainVideoExportResolution({
    source: { width: 1080, height: 1080 },
    output: { width: 1080, height: 1920 },
    expected: { width: 1080, height: 1920 },
  });

  assert.equal(landscape.cause, "target-met");
  assert.equal(landscape.sourceRequiresUpscaling, false);
  assert.equal(square.cause, "target-met");
  assert.equal(square.sourceRequiresUpscaling, false);
});

test("keeps the cause unknown when source or output dimensions are unavailable", () => {
  const missingSource = explainVideoExportResolution({
    source: { width: null, height: null },
    output: { width: 720, height: 1280 },
    expected: { width: 1080, height: 1920 },
  });
  const missingOutput = explainVideoExportResolution({
    source: { width: 404, height: 720 },
    output: null,
    expected: { width: 1080, height: 1920 },
  });

  assert.equal(missingSource.cause, "unknown");
  assert.equal(missingSource.outputResolutionLabel, "720×1280");
  assert.match(missingSource.detail, /原因を特定できません/);
  assert.equal(missingOutput.cause, "unknown");
  assert.equal(missingOutput.outputResolutionLabel, null);
  assert.match(missingOutput.detail, /完成動画の解像度を端末で確認できなかった/);
});
