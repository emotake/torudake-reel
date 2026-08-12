import assert from "node:assert/strict";
import test from "node:test";

import {
  VIDEO_COMPOSITION_DEFAULT_TRANSITION_DURATIONS,
  VIDEO_COMPOSITION_MAX_SOURCES,
  buildVideoCompositionFrameSchedule,
  createVideoCompositionPlan,
  getVideoCompositionTransitionVisual,
  normalizeVideoCompositionTransition,
} from "../lib/video-composition.ts";

function source(id, duration, clips, fileSize = 1024) {
  return { id, duration, clips, fileSize };
}

test("preserves source order and chronological clip order", () => {
  const plan = createVideoCompositionPlan({
    sources: [
      source("third-take", 20, [
        { start: 3, end: 5 },
        { start: 12, end: 15 },
      ]),
      source("first-take", 10, [{ start: 1, end: 4 }]),
    ],
    transition: "crossfade",
  });

  assert.deepEqual(plan.sources.map((item) => item.id), [
    "third-take",
    "first-take",
  ]);
  assert.deepEqual(
    plan.clips.map((clip) => [clip.sourceId, clip.start, clip.end]),
    [
      ["third-take", 3, 5],
      ["third-take", 12, 15],
      ["first-take", 1, 4],
    ],
  );
  assert.equal(plan.duration, 8);
  assert.equal(plan.boundaries.length, 2);
  assert.equal(plan.boundaries[0].editedTime, 2);
  assert.equal(plan.boundaries[1].editedTime, 5);
});
test("requires one or two non-overlapping forward clips per source", () => {
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: [source("a", 10, [])],
      }),
    /between 1 and 2 clips/,
  );
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: [
          source("a", 10, [
            { start: 5, end: 8 },
            { start: 4, end: 6 },
          ]),
        ],
      }),
    /chronological and non-overlapping/,
  );
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: [source("a", 10, [{ start: 8, end: 12 }])],
      }),
    /beyond its source duration/,
  );
});

test("enforces five sources, 500MB, 300 source seconds, and 90 output seconds", () => {
  assert.equal(VIDEO_COMPOSITION_MAX_SOURCES, 5);
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: Array.from({ length: 6 }, (_, index) =>
          source(String(index), 2, [{ start: 0, end: 1 }]),
        ),
      }),
    /between 1 and 5 sources/,
  );
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: [
          source(
            "large",
            5,
            [{ start: 0, end: 1 }],
            500 * 1024 * 1024 + 1,
          ),
        ],
      }),
    /500MB or less/,
  );
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: [
          source("a", 151, [{ start: 0, end: 1 }]),
          source("b", 150, [{ start: 0, end: 1 }]),
        ],
      }),
    /300 seconds or less/,
  );
  assert.throws(
    () =>
      createVideoCompositionPlan({
        sources: [
          source("a", 100, [
            { start: 0, end: 50 },
            { start: 55, end: 96 },
          ]),
        ],
      }),
    /90 seconds or less/,
  );
});

test("uses the specified global transition defaults", () => {
  assert.deepEqual(VIDEO_COMPOSITION_DEFAULT_TRANSITION_DURATIONS, {
    cut: 0,
    crossfade: 0.3,
    "fade-black": 0.4,
    "fade-white": 0.4,
    flash: 0.22,
    "wipe-left": 0.38,
    "slide-left": 0.42,
    "zoom-dissolve": 0.45,
  });
  assert.deepEqual(normalizeVideoCompositionTransition("cut"), {
    type: "cut",
    duration: 0,
  });
  assert.deepEqual(normalizeVideoCompositionTransition("crossfade"), {
    type: "crossfade",
    duration: 0.3,
  });
  assert.deepEqual(normalizeVideoCompositionTransition("fade-white"), {
    type: "fade-white",
    duration: 0.4,
  });
  assert.deepEqual(
    normalizeVideoCompositionTransition({ type: "crossfade", duration: 0.18 }),
    { type: "crossfade", duration: 0.18 },
  );
});

test("builds one monotonic 30fps schedule across ordered sources", () => {
  const plan = createVideoCompositionPlan({
    sources: [
      source("one", 8, [{ start: 1, end: 2 }]),
      source("two", 8, [{ start: 4, end: 5 }]),
    ],
    transition: "cut",
  });
  const schedule = buildVideoCompositionFrameSchedule(plan);

  assert.equal(schedule.length, 60);
  assert.equal(schedule[0].sourceId, "one");
  assert.equal(schedule[0].sourceTime, 1);
  assert.equal(schedule[30].sourceId, "two");
  assert.equal(schedule[30].sourceTime, 4);
  assert.ok(
    schedule.every(
      (frame, index) =>
        index === 0 || frame.editedTime > schedule[index - 1].editedTime,
    ),
  );
  assert.equal(
    schedule.at(-1).editedTime + schedule.at(-1).duration,
    plan.duration,
  );
});

test("describes crossfade frames for preview/export parity without shortening output", () => {
  const plan = createVideoCompositionPlan({
    sources: [
      source("one", 8, [{ start: 1, end: 2 }]),
      source("two", 8, [{ start: 4, end: 5 }]),
    ],
    transition: "crossfade",
  });
  const schedule = buildVideoCompositionFrameSchedule(plan);
  const transitionFrames = schedule.filter(
    (frame) => frame.transition?.type === "crossfade",
  );

  assert.ok(transitionFrames.length >= 8);
  assert.ok(
    transitionFrames.every(
      (frame) =>
        frame.sourceId === "two" &&
        frame.transition.from.sourceId === "one" &&
        frame.transition.progress > 0 &&
        frame.transition.progress <= 1,
    ),
  );
  assert.equal(
    schedule.at(-1).editedTime + schedule.at(-1).duration,
    2,
  );
});

test("describes both halves of black and white fades", () => {
  for (const type of ["fade-black", "fade-white"]) {
    const schedule = buildVideoCompositionFrameSchedule(
      createVideoCompositionPlan({
        sources: [
          source("one", 8, [{ start: 1, end: 2 }]),
          source("two", 8, [{ start: 4, end: 5 }]),
        ],
        transition: type,
      }),
    );
    const phases = new Set(
      schedule
        .filter((frame) => frame.transition?.type === type)
        .map((frame) => frame.transition.phase),
    );
    assert.deepEqual(phases, new Set(["fade-out", "fade-in"]));
  }
});

test("adds four premium transition schedules without changing order or duration", () => {
  const expectations = new Map([
    ["flash", new Set(["fade-out", "fade-in"])],
    ["wipe-left", new Set(["wipe"])],
    ["slide-left", new Set(["slide"])],
    ["zoom-dissolve", new Set(["zoom-dissolve"])],
  ]);

  for (const [type, expectedPhases] of expectations) {
    const plan = createVideoCompositionPlan({
      sources: [
        source("first", 8, [{ start: 1, end: 2 }]),
        source("second", 8, [{ start: 4, end: 5 }]),
      ],
      transition: type,
    });
    const schedule = buildVideoCompositionFrameSchedule(plan);
    const transitionFrames = schedule.filter(
      (frame) => frame.transition?.type === type,
    );

    assert.ok(transitionFrames.length > 0);
    assert.deepEqual(
      new Set(transitionFrames.map((frame) => frame.transition.phase)),
      expectedPhases,
    );
    assert.deepEqual(plan.sources.map((item) => item.id), ["first", "second"]);
    assert.equal(plan.duration, 2);
    assert.equal(
      schedule.at(-1).editedTime + schedule.at(-1).duration,
      plan.duration,
    );
    assert.ok(
      transitionFrames.every((frame) => {
        const values = Object.values(frame.transition.visual).filter(
          (value) => typeof value === "number",
        );
        return values.every(Number.isFinite);
      }),
    );
  }
});

test("exposes pure normalized visual metadata for preview/export parity", () => {
  const wipe = getVideoCompositionTransitionVisual("wipe-left", "wipe", 0.5);
  assert.ok(wipe.incomingReveal > 0 && wipe.incomingReveal < 1);
  assert.equal(wipe.overlayColor, null);

  const slide = getVideoCompositionTransitionVisual("slide-left", "slide", 0.5);
  assert.ok(slide.incomingOffsetX > 0);
  assert.ok(slide.outgoingOffsetX < 0);

  const zoom = getVideoCompositionTransitionVisual(
    "zoom-dissolve",
    "zoom-dissolve",
    0.5,
  );
  assert.ok(zoom.incomingOpacity > 0 && zoom.incomingOpacity < 1);
  assert.ok(zoom.incomingScale > 1);
  assert.ok(zoom.outgoingScale > 1);

  const flashOut = getVideoCompositionTransitionVisual(
    "flash",
    "fade-out",
    1,
  );
  assert.equal(flashOut.overlayColor, "#fff");
  assert.equal(flashOut.overlayOpacity, 0.82);
});
