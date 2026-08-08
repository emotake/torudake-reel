import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPortableFrameSchedule,
  canUseWholeFileAudioDecode,
  computePortableVideoDimensions,
  computePortableVideoDrawRect,
  createPortableVideoEncodingSettings,
  getPortableAudioSlicePlacement,
  getPortableEditedDuration,
  HIGH_QUALITY_VIDEO_BITRATE,
  mapPortableEditedTimeToSourceTime,
  normalizePortableFrameRate,
  normalizePortableVideoRanges,
  selectPreferredPortableAudioTrack,
} from "../lib/portable-video-export.ts";

test("uses a high-quality 1080p bitrate without another API request", () => {
  assert.equal(HIGH_QUALITY_VIDEO_BITRATE, 10_000_000);
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
