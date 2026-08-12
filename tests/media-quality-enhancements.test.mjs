import assert from "node:assert/strict";
import test from "node:test";

import {
  createNaturalEdit,
  scoreEditPlanVisualEvidence,
} from "../lib/edit-plan.ts";
import { createPortableVideoColorConversionPlan } from "../lib/video-color-space.ts";

function caption(id, start, end, text) {
  return { id, start, end, text, removed: false };
}

test("scores local quality, scene change, and faces without an API call", () => {
  assert.equal(scoreEditPlanVisualEvidence(0, 2), 0);
  assert.equal(
    scoreEditPlanVisualEvidence(0, 2, [
      { time: 1, qualityScore: 1, sceneChangeScore: 1, faceScore: 1 },
    ]),
    1,
  );
  assert.equal(
    scoreEditPlanVisualEvidence(0, 2, [
      { time: 3, qualityScore: 1, sceneChangeScore: 1, faceScore: 1 },
    ]),
    0,
  );
});

test("optional frame evidence can promote clearer scenes in natural edits", () => {
  const source = Array.from({ length: 9 }, (_, index) =>
    caption(
      index + 1,
      index * 3,
      index * 3 + 1.5,
      `場面${index + 1}の内容を紹介します。`,
    ),
  );
  const visualEvidence = source.map((item, index) => ({
    time: item.start + 0.5,
    qualityScore: [2, 5, 8].includes(index) ? 1 : 0,
    sceneChangeScore: [2, 5, 8].includes(index) ? 1 : 0,
  }));
  const edited = createNaturalEdit(source, 5, "follow", {
    visualEvidence,
    visualInfluence: 8,
  });
  const keptIds = new Set(
    edited.filter((item) => !item.removed).map((item) => item.id),
  );

  assert.ok(keptIds.has(3));
  assert.ok(keptIds.has(6));
  assert.ok(keptIds.has(9));
});

test("detects PQ, HLG, P3 and ordinary SDR export paths", () => {
  assert.deepEqual(
    createPortableVideoColorConversionPlan({
      colorSpace: { primaries: "bt2020", transfer: "pq" },
    }),
    {
      sourceKind: "hdr-pq",
      isHighDynamicRange: true,
      isWideGamut: true,
      requiresToneMapping: true,
      outputCanvasColorSpace: "srgb",
      outputKind: "rec709-compatible-sdr",
    },
  );
  assert.equal(
    createPortableVideoColorConversionPlan({
      colorSpace: { primaries: "bt2020", transfer: "hlg" },
    }).sourceKind,
    "hdr-hlg",
  );
  assert.equal(
    createPortableVideoColorConversionPlan({
      colorSpace: { primaries: "smpte432", transfer: "iec61966-2-1" },
    }).sourceKind,
    "wide-gamut-sdr",
  );
  assert.equal(
    createPortableVideoColorConversionPlan({
      colorSpace: { primaries: "bt709", transfer: "bt709" },
    }).sourceKind,
    "sdr",
  );
});
