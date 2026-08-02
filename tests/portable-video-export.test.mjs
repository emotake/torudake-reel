import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPortableFrameSchedule,
  computePortableVideoDimensions,
  getPortableAudioSlicePlacement,
  getPortableEditedDuration,
  mapPortableEditedTimeToSourceTime,
  normalizePortableFrameRate,
  normalizePortableVideoRanges,
} from "../lib/portable-video-export.ts";

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

test("fits portrait and landscape video into even 1080 by 1920 bounds", () => {
  assert.deepEqual(computePortableVideoDimensions(2160, 3840), {
    width: 1080,
    height: 1920,
  });
  assert.deepEqual(computePortableVideoDimensions(3840, 2160), {
    width: 1080,
    height: 608,
  });
  assert.deepEqual(computePortableVideoDimensions(1079, 1919), {
    width: 1078,
    height: 1918,
  });
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
