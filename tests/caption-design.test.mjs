import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTION_MOODS,
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
  assert.equal(
    normalizeCaptionProfile({
      mood: "pop",
      accentColor: "#E45F4D",
      brandName: "",
    }).mood,
    "pop",
  );
  assert.deepEqual(normalizeCaptionProfile(null), DEFAULT_CAPTION_PROFILE);
});

test("offers two framed and three text-only caption styles without another API call", () => {
  assert.equal(CAPTION_MOODS.length, 5);
  assert.deepEqual(
    CAPTION_MOODS.map(({ id, tone }) => [id, tone]),
    [
      ["auto", "editorial"],
      ["bold", "mono"],
      ["soft", "cinema"],
      ["pop", "pop"],
      ["refined", "signature"],
    ],
  );

  for (const goal of ["follow", "sales", "reach"]) {
    assert.equal(
      resolveCaptionDesign(DEFAULT_CAPTION_PROFILE, goal).tone,
      "editorial",
    );
  }

  const resolved = CAPTION_MOODS.map(({ id }) =>
    resolveCaptionDesign({ ...DEFAULT_CAPTION_PROFILE, mood: id }, "follow"),
  );
  assert.equal(
    resolved.filter(
      ({ frame, palette }) =>
        frame.borderPlacement !== "none" && Boolean(palette.background),
    ).length,
    2,
  );
  assert.equal(
    resolved.filter(
      ({ frame, palette }) =>
        frame.borderPlacement === "none" && palette.background === "",
    ).length,
    3,
  );
});

test("exposes the rendering frame used by preview and video export", () => {
  assert.equal(
    resolveCaptionDesign(DEFAULT_CAPTION_PROFILE, "follow").frame
      .borderPlacement,
    "left",
  );
  assert.equal(
    resolveCaptionDesign(
      { ...DEFAULT_CAPTION_PROFILE, mood: "bold" },
      "follow",
    ).frame.highlight,
    "block",
  );

  for (const mood of ["soft", "pop", "refined"]) {
    const design = resolveCaptionDesign(
      { ...DEFAULT_CAPTION_PROFILE, mood },
      "follow",
    );
    assert.equal(design.frame.borderPlacement, "none");
    assert.equal(design.palette.background, "");
    assert.equal(design.frame.highlight, "text");
  }

  assert.match(
    resolveCaptionDesign(
      { ...DEFAULT_CAPTION_PROFILE, mood: "refined" },
      "follow",
    ).frame.fontFamily,
    /Mincho/u,
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
