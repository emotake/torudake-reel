import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPublishingCopy,
  buildPublishingFormatChecks,
  FINISH_PRESETS,
  PUBLISHING_TARGETS,
} from "../lib/publishing-targets.ts";

test("supports Instagram, YouTube Shorts, and a shared export", () => {
  assert.deepEqual(
    PUBLISHING_TARGETS.map(({ id }) => id),
    ["both", "instagram", "youtube"],
  );
});

test("builds platform copy locally and keeps the YouTube title within 100 characters", () => {
  const result = buildPublishingCopy({
    titleSource: `<${"あ".repeat(120)}>`,
    body: "今日の散歩をまとめました。",
    disclosureText: "※AI音声です。",
  });

  assert.equal(Array.from(result.youtubeTitle).length, 100);
  assert.doesNotMatch(result.youtubeTitle, /[<>]/u);
  assert.match(result.instagramCaption, /※AI音声です。/u);
  assert.match(result.youtubeDescription, /#Shorts/u);
});

test("offers three finish presets without another AI request", () => {
  assert.deepEqual(
    FINISH_PRESETS.map(({ id, captionMood }) => [id, captionMood]),
    [
      ["natural", "auto"],
      ["story", "vlog"],
      ["impact", "bold"],
    ],
  );
});

test("warns when a YouTube Short exceeds three minutes or is horizontal", () => {
  const checks = buildPublishingFormatChecks({
    target: "youtube",
    durationSeconds: 181,
    width: 1920,
    height: 1080,
  });

  assert.equal(checks.find(({ id }) => id === "shorts-duration")?.status, "warning");
  assert.equal(checks.find(({ id }) => id === "shorts-orientation")?.status, "warning");
});
