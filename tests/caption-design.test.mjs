import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CAPTION_PROFILE,
  getCaptionEntranceProgress,
  getCaptionPresentation,
  normalizeCaptionProfile,
  resolveCaptionDesign,
  wrapCaptionLines,
} from "../lib/caption-design.ts";

test("normalizes customer caption profiles safely", () => {
  assert.deepEqual(
    normalizeCaptionProfile({
      mood: "soft",
      accentColor: "#AABBCC",
      brandName: "  emota studio  ",
    }),
    {
      mood: "soft",
      accentColor: "#aabbcc",
      brandName: "emota studio",
    },
  );
  assert.deepEqual(normalizeCaptionProfile(null), DEFAULT_CAPTION_PROFILE);
});

test("resolves an automatic tone from the reel goal without another API call", () => {
  assert.equal(
    resolveCaptionDesign(DEFAULT_CAPTION_PROFILE, "sales").tone,
    "studio",
  );
  assert.equal(
    resolveCaptionDesign(DEFAULT_CAPTION_PROFILE, "reach").tone,
    "mono",
  );
});

test("uses the customer accent color in the resolved palette", () => {
  const design = resolveCaptionDesign(
    { mood: "refined", accentColor: "#5574b8", brandName: "" },
    "follow",
  );
  assert.equal(design.palette.border, "#5574b8");
  assert.equal(design.palette.highlight, "#5574b8");
});

test("wraps Japanese captions into balanced natural lines", () => {
  const lines = wrapCaptionLines(
    "この機能を使うと、動画編集がもっと自然になります",
    14,
    2,
  );
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => Array.from(line).length <= 14));
  assert.match(lines[0], /、$/u);
});

test("selects a richer presentation from caption context", () => {
  assert.equal(getCaptionPresentation({}, 0), "hook");
  assert.equal(
    getCaptionPresentation({ highlight: "80%", accent: true }, 2),
    "metric",
  );
  assert.equal(getCaptionPresentation({ accent: true }, 2), "emphasis");
});

test("caption entrance animation is bounded", () => {
  assert.equal(getCaptionEntranceProgress(1, 1), 0);
  assert.ok(Math.abs(getCaptionEntranceProgress(1.09, 1) - 0.5) < 0.001);
  assert.equal(getCaptionEntranceProgress(2, 1), 1);
});
