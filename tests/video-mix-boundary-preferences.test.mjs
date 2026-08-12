import test from "node:test";
import assert from "node:assert/strict";
import {
  getVideoMixBoundaryPreferenceKeys,
  pruneVideoMixBoundaryTransitionPreferences,
  resolveVideoMixBoundaryTransitions,
} from "../lib/video-mix-boundary-preferences.ts";

const sources = [
  {
    id: "first:file",
    clips: [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ],
  },
  {
    id: "second/file",
    clips: [{ start: 1, end: 3 }],
  },
];

test("creates one stable preference key for every finished-video boundary", () => {
  const keys = getVideoMixBoundaryPreferenceKeys(sources);
  assert.deepEqual(keys, [
    "first%3Afile:0>first%3Afile:1",
    "first%3Afile:1>second%2Ffile:0",
  ]);

  const movedRanges = [
    {
      ...sources[0],
      clips: [
        { start: 0.5, end: 2.5 },
        { start: 4.5, end: 6.5 },
      ],
    },
    sources[1],
  ];
  assert.deepEqual(getVideoMixBoundaryPreferenceKeys(movedRanges), keys);
});

test("uses the global style only where no individual override exists", () => {
  const keys = getVideoMixBoundaryPreferenceKeys(sources);
  assert.deepEqual(
    resolveVideoMixBoundaryTransitions(
      sources,
      { [keys[1]]: "wipe-left" },
      "crossfade",
    ),
    ["crossfade", "wipe-left"],
  );
});

test("prunes a removed cut without moving its preference to another boundary", () => {
  const keys = getVideoMixBoundaryPreferenceKeys(sources);
  const nextSources = [
    { ...sources[0], clips: [sources[0].clips[0]] },
    sources[1],
  ];
  assert.deepEqual(
    pruneVideoMixBoundaryTransitionPreferences(nextSources, {
      [keys[0]]: "flash",
      [keys[1]]: "slide-left",
    }),
    {},
  );
});

test("does not resurrect an old boundary choice when a removed cut is added again", () => {
  const keys = getVideoMixBoundaryPreferenceKeys(sources);
  const oneCutSources = [
    { ...sources[0], clips: [sources[0].clips[0]] },
    sources[1],
  ];
  const pruned = pruneVideoMixBoundaryTransitionPreferences(oneCutSources, {
    [keys[0]]: "flash",
    [keys[1]]: "slide-left",
  });

  assert.deepEqual(pruned, {});
  assert.deepEqual(
    resolveVideoMixBoundaryTransitions(sources, pruned, "crossfade"),
    ["crossfade", "crossfade"],
  );
});

test("keeps source and clip order authoritative regardless of preferences", () => {
  const keys = getVideoMixBoundaryPreferenceKeys(sources);
  const resolved = resolveVideoMixBoundaryTransitions(
    sources,
    {
      [keys[0]]: "slide-left",
      [keys[1]]: "fade-black",
    },
    "cut",
  );
  assert.deepEqual(resolved, ["slide-left", "fade-black"]);
  assert.deepEqual(
    sources.flatMap((source) =>
      source.clips.map((clip) => [source.id, clip.start, clip.end]),
    ),
    [
      ["first:file", 0, 2],
      ["first:file", 4, 6],
      ["second/file", 1, 3],
    ],
  );
});
