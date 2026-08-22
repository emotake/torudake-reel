import assert from "node:assert/strict";
import test from "node:test";

import { buildPostingReadinessChecklist } from "../lib/posting-readiness.ts";

test("builds a local pre-export checklist without claiming pending checks passed", () => {
  const checks = buildPostingReadinessChecklist({
    durationSeconds: 29.6,
    captionsEnabled: true,
    unreadableCaptionCount: 2,
    outputWidth: 1080,
    outputHeight: 1920,
    exportVerified: false,
  });

  assert.deepEqual(
    checks.map(({ id, status }) => ({ id, status })),
    [
      { id: "duration", status: "pass" },
      { id: "captions", status: "warning" },
      { id: "resolution", status: "pass" },
      { id: "media", status: "pending" },
    ],
  );
  assert.match(checks[0].detail, /約30秒/);
  assert.match(checks[1].detail, /2件/);
  assert.match(checks[3].detail, /書き出し時/);
});

test("marks the completed media check only after validated export", () => {
  const checks = buildPostingReadinessChecklist({
    durationSeconds: 72,
    captionsEnabled: false,
    unreadableCaptionCount: 0,
    outputWidth: 540,
    outputHeight: 960,
    exportVerified: true,
    exportQualityMessage: "完成動画の品質を確認できました。",
  });

  assert.equal(checks.find((item) => item.id === "captions")?.status, "pass");
  assert.equal(checks.find((item) => item.id === "resolution")?.status, "warning");
  assert.deepEqual(checks.find((item) => item.id === "media"), {
    id: "media",
    label: "映像と音声",
    status: "pass",
    detail: "完成動画の品質を確認できました。",
  });
});
