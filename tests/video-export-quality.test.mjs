import assert from "node:assert/strict";
import test from "node:test";

import {
  assessExportedVideoQuality,
  assessVideoExportQuality,
  inspectExportedVideoQuality,
  inspectVideoExportQuality,
  meetsTarget1080pResolution,
} from "../lib/video-export-quality.ts";

function qualityMetrics(overrides = {}) {
  return {
    width: 1080,
    height: 1920,
    codec: "avc",
    codecParameterString: "avc1.640028",
    averageBitrate: 8_000_000,
    averageFrameRate: 30,
    packetCount: 300,
    durationSeconds: 10,
    fileSizeBytes: 10_000_000,
    ...overrides,
  };
}

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
    averageBitrate: 7_500_000,
    averageFrameRate: 29.97,
    packetCount: 120,
    fileSizeBytes: null,
  }));
  assert.deepEqual(result.unavailableMetrics, ["fileSizeBytes"]);
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
