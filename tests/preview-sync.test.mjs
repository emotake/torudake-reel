import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPreviewRanges,
  decideNarrationPreviewAction,
  resolveEditedPreviewPosition,
} from "../lib/preview-sync.ts";

const previewRanges = buildPreviewRanges([
  { start: 0, end: 5 },
  { start: 10, end: 15 },
  { start: 22, end: 25 },
]);

test("maps an exact edited boundary to the next source range", () => {
  assert.deepEqual(resolveEditedPreviewPosition(previewRanges, 5), {
    rangeIndex: 1,
    sourceTime: 10,
    editedTime: 5,
    ended: false,
  });
  assert.equal(
    resolveEditedPreviewPosition(previewRanges, 10).sourceTime,
    22,
  );
});

test("seeks only the video when continuous narration crosses a cut", () => {
  const action = decideNarrationPreviewAction(
    previewRanges,
    5.02,
    4.99,
    false,
  );
  assert.equal(action.type, "seek-video");
  assert.equal(action.position.rangeIndex, 1);
  assert.ok(action.position.sourceTime > 10);
});

test("does not repeat an internal cut seek while it is in flight", () => {
  const action = decideNarrationPreviewAction(
    previewRanges,
    5.08,
    4.99,
    true,
  );
  assert.equal(action.type, "wait");
});

test("tolerates small clock drift without seeking narration or video", () => {
  const action = decideNarrationPreviewAction(
    previewRanges,
    6.06,
    11,
    false,
    0.12,
  );
  assert.equal(action.type, "stay");
});

test("corrects accumulated drift by moving the video to the audio clock", () => {
  const action = decideNarrationPreviewAction(
    previewRanges,
    6.25,
    11,
    false,
    0.12,
  );
  assert.equal(action.type, "seek-video");
  assert.equal(action.position.sourceTime, 11.25);
});

test("ends cleanly at the final edited boundary", () => {
  const action = decideNarrationPreviewAction(
    previewRanges,
    13,
    25,
    false,
  );
  assert.equal(action.type, "end");
  assert.equal(action.position.sourceTime, 25);
});

test("does not confuse adjacent ranges whose drift margins overlap", () => {
  const closeRanges = buildPreviewRanges([
    { start: 0, end: 5 },
    { start: 5.03, end: 10 },
  ]);
  const action = decideNarrationPreviewAction(
    closeRanges,
    5,
    5.03,
    false,
  );
  assert.equal(action.type, "stay");
});

test("handles empty and invalid ranges without seeking", () => {
  const emptyRanges = buildPreviewRanges([
    { start: 2, end: 2 },
    { start: Number.NaN, end: 4 },
  ]);
  const action = decideNarrationPreviewAction(
    emptyRanges,
    Number.NaN,
    0,
    false,
  );
  assert.equal(action.type, "end");
  assert.equal(action.position.sourceTime, 0);
});

test("scrubs forward and backward across cuts without retaining stale position", () => {
  const scrubRanges = buildPreviewRanges([
    { start: 3, end: 7 },
    { start: 12, end: 18 },
    { start: 30, end: 34 },
  ]);

  assert.deepEqual(resolveEditedPreviewPosition(scrubRanges, 0), {
    rangeIndex: 0,
    sourceTime: 3,
    editedTime: 0,
    ended: false,
  });
  assert.equal(
    resolveEditedPreviewPosition(scrubRanges, 6.5).sourceTime,
    14.5,
  );
  assert.equal(
    resolveEditedPreviewPosition(scrubRanges, 12.5).sourceTime,
    32.5,
  );
  assert.equal(
    resolveEditedPreviewPosition(scrubRanges, 1.25).sourceTime,
    4.25,
  );
});

test("clamps a rewind before the beginning to the first playable frame", () => {
  const ranges = buildPreviewRanges([
    { start: 8, end: 11 },
    { start: 20, end: 24 },
  ]);

  assert.deepEqual(resolveEditedPreviewPosition(ranges, -20), {
    rangeIndex: 0,
    sourceTime: 8,
    editedTime: 0,
    ended: false,
  });
});

test("clamps a seek past the end and reports a stopped final frame", () => {
  const ranges = buildPreviewRanges([
    { start: 8, end: 11 },
    { start: 20, end: 24 },
  ]);

  assert.deepEqual(resolveEditedPreviewPosition(ranges, 200), {
    rangeIndex: 1,
    sourceTime: 24,
    editedTime: 7,
    ended: true,
  });
});

test("uses the narration clock as the source of truth after a large user seek", () => {
  const ranges = buildPreviewRanges([
    { start: 0, end: 5 },
    { start: 10, end: 15 },
    { start: 22, end: 25 },
  ]);

  const forward = decideNarrationPreviewAction(
    ranges,
    11.5,
    1.5,
    false,
  );
  assert.equal(forward.type, "seek-video");
  assert.equal(forward.position.sourceTime, 23.5);

  const backward = decideNarrationPreviewAction(
    ranges,
    2.25,
    23.5,
    false,
  );
  assert.equal(backward.type, "seek-video");
  assert.equal(backward.position.sourceTime, 2.25);
});
