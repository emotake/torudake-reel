import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OPENAI_REALTIME_MINI_PRICING,
  buildEvaluationPlan,
  estimatePlanCost,
  estimateRealtimeMiniCost,
  evaluationData,
  runCli,
  writeEvaluationPack,
} from "../scripts/operations/character-voice-evaluation.mjs";

const source = await readFile(
  new URL(
    "../scripts/operations/character-voice-evaluation.mjs",
    import.meta.url,
  ),
  "utf8",
);

test("defines the approved candidate and control voices", () => {
  const profiles = Object.fromEntries(
    evaluationData.profiles.map((profile) => [profile.id, profile]),
  );
  assert.deepEqual(
    profiles.pop.candidates.map(({ voice }) => voice),
    ["coral", "shimmer", "ballad", "marin"],
  );
  assert.equal(profiles.pop.candidates.at(-1).role, "control");
  assert.deepEqual(
    profiles.high_tension.candidates.map(({ voice }) => voice),
    ["ash", "verse", "echo", "cedar"],
  );
  assert.equal(profiles.high_tension.candidates.at(-1).role, "control");
  for (const profile of evaluationData.profiles) {
    assert.match(profile.goal, /インパクト|印象/u);
    assert.ok(profile.avoid.some((item) => item.includes("模倣")));
  }
});

test("Japanese QA scripts cover every required pronunciation and pacing risk", () => {
  const coverage = new Set(
    evaluationData.qaScripts.flatMap((script) => script.coverage),
  );
  for (const requirement of [
    "数字",
    "日時",
    "助数詞",
    "英字",
    "カタカナ",
    "長音",
    "促音",
    "撥音",
    "固有語",
    "短いオチ",
    "30秒長文",
  ]) {
    assert.ok(coverage.has(requirement), `missing QA coverage: ${requirement}`);
  }
  const longform = evaluationData.qaScripts.find(
    ({ id }) => id === "longform_30s",
  );
  assert.equal(longform.expectedSeconds, 30);
  for (const script of evaluationData.qaScripts) {
    assert.ok(script.text.length > 0);
    assert.ok(script.readingCheckpoints.length > 0);
    for (const checkpoint of script.readingCheckpoints) {
      assert.ok(checkpoint.surface.length > 0);
      assert.ok(checkpoint.expected.length > 0);
    }
  }
});

test("uses a token-saving two-stage plan", () => {
  const screening = buildEvaluationPlan();
  assert.equal(screening.phase, "screening");
  assert.equal(screening.takes, 1);
  assert.equal(screening.rows.length, 8 * 3);
  assert.equal(new Set(screening.rows.map(({ sampleId }) => sampleId)).size, 24);

  const validation = buildEvaluationPlan({
    phase: "validation",
    popFinalist: "coral",
    highTensionFinalist: "ash",
  });
  assert.equal(validation.takes, 2);
  assert.equal(
    validation.rows.length,
    4 * evaluationData.qaScripts.length * 2,
  );
  assert.throws(
    () =>
      buildEvaluationPlan({
        phase: "validation",
        popFinalist: "marin",
        highTensionFinalist: "ash",
      }),
    /pop finalist/u,
  );
});

test("estimates the documented realtime mini token rates without a request", () => {
  assert.equal(OPENAI_REALTIME_MINI_PRICING.perMillionTokensUsd.textInput, 0.6);
  assert.equal(OPENAI_REALTIME_MINI_PRICING.perMillionTokensUsd.textOutput, 2.4);
  assert.equal(OPENAI_REALTIME_MINI_PRICING.perMillionTokensUsd.audioOutput, 20);
  assert.equal(OPENAI_REALTIME_MINI_PRICING.assistantAudioTokensPerSecond, 20);

  const estimate = estimateRealtimeMiniCost({
    sampleCount: 1,
    outputSeconds: 30,
    promptTokensPerSample: 1_000,
    transcriptTokensPerSecond: 0,
    usdToJpy: 150,
    contingencyPercent: 0,
  });
  assert.equal(estimate.estimatedTokens.audioOutput, 600);
  assert.ok(Math.abs(estimate.lineItemsUsd.audioOutput - 0.012) < 1e-12);
  assert.ok(Math.abs(estimate.lineItemsUsd.textInput - 0.0006) < 1e-12);
  assert.ok(Math.abs(estimate.baseJpy - 1.89) < 1e-12);
});

test("writes a blind evaluator pack and keeps the voice key separate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "torudake-voice-eval-"));
  const plan = buildEvaluationPlan();
  const result = await writeEvaluationPack({
    outputDirectory: root,
    plan,
    costOptions: { usdToJpy: 150 },
  });
  assert.equal(result.plan.rows.length, 24);
  assert.equal(estimatePlanCost(plan).assumptions.sampleCount, 24);

  const blindSheet = await readFile(
    path.join(root, "evaluator", "blind-evaluation.csv"),
    "utf8",
  );
  const operatorKey = await readFile(
    path.join(root, "operator", "sample-key.csv"),
    "utf8",
  );
  const guide = await readFile(
    path.join(root, "evaluator", "guide.md"),
    "utf8",
  );
  for (const metric of [
    "自然さ",
    "聞き取りやすさ",
    "耳に残る度",
    "インパクト",
    "他候補との違い",
    "誤読",
    "脱落",
    "追加",
    "語尾切れ",
    "音割れ・歪み",
  ]) {
    assert.match(blindSheet, new RegExp(metric, "u"));
  }
  for (const voice of [
    "coral",
    "shimmer",
    "ballad",
    "marin",
    "ash",
    "verse",
    "echo",
    "cedar",
  ]) {
    assert.doesNotMatch(blindSheet, new RegExp(voice, "u"));
    assert.match(operatorKey, new RegExp(voice, "u"));
  }
  assert.match(guide, /先入観を避ける/u);
});

test("evaluation tooling has no API execution path or secret access", async () => {
  assert.doesNotMatch(source, /api\.openai\.com/u);
  assert.doesNotMatch(source, /OPENAI_API_KEY/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /--execute/u);
  const result = await runCli([]);
  assert.equal(result.plan.phase, "screening");
  assert.ok(result.estimate.planningJpy > 0);
});
