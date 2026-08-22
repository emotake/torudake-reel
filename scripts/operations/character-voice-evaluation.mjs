import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_URL = new URL(
  "./data/character-voice-evaluation-v1.json",
  import.meta.url,
);

export const evaluationData = Object.freeze(
  JSON.parse(await readFile(DATA_URL, "utf8")),
);

export const OPENAI_REALTIME_MINI_PRICING = Object.freeze({
  model: "gpt-realtime-2.1-mini",
  checkedOn: "2026-08-23",
  perMillionTokensUsd: Object.freeze({
    textInput: 0.6,
    cachedTextInput: 0.06,
    textOutput: 2.4,
    audioInput: 10,
    cachedAudioInput: 0.3,
    audioOutput: 20,
  }),
  assistantAudioTokensPerSecond: 20,
  sources: Object.freeze([
    "https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini",
    "https://developers.openai.com/api/docs/guides/realtime-costs",
  ]),
});

const EVALUATION_HEADERS = Object.freeze([
  "評価者ID",
  "サンプルID",
  "想定カテゴリ",
  "台本ID",
  "台本文",
  "自然さ(1-5)",
  "聞き取りやすさ(1-5)",
  "耳に残る度(1-5)",
  "インパクト(1-5)",
  "狙いとの一致(1-5)",
  "他候補との違い(1-5)",
  "聞こえたカテゴリ(pop/high_tension/neutral/不明)",
  "誤読(なし/あり)",
  "誤読内容",
  "脱落(なし/あり)",
  "脱落内容",
  "追加(なし/あり)",
  "追加内容",
  "語尾切れ(なし/あり)",
  "音割れ・歪み(なし/あり)",
  "もう一度使いたい(はい/いいえ)",
  "自由記述",
]);

function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function profileById(profileId) {
  const profile = evaluationData.profiles.find(({ id }) => id === profileId);
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  return profile;
}

function scriptById(scriptId) {
  const script = evaluationData.qaScripts.find(({ id }) => id === scriptId);
  if (!script) throw new Error(`Unknown QA script: ${scriptId}`);
  return script;
}

function voiceEntry(profile, voice) {
  return profile.candidates.find((entry) => entry.voice === voice);
}

function validateFinalist(profileId, voice) {
  const profile = profileById(profileId);
  const entry = voiceEntry(profile, voice);
  if (!entry || entry.role !== "candidate") {
    const choices = profile.candidates
      .filter(({ role }) => role === "candidate")
      .map(({ voice: candidate }) => candidate)
      .join(", ");
    throw new Error(`${profileId} finalist must be one of: ${choices}`);
  }
  return entry;
}

function stableBlindId({ phase, profileId, voice, scriptId, take }, seed) {
  const digest = createHash("sha256")
    .update(`${seed}|${phase}|${profileId}|${voice}|${scriptId}|${take}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `CV-${digest}`;
}

export function buildEvaluationPlan({
  phase = "screening",
  takes,
  popFinalist,
  highTensionFinalist,
  seed = evaluationData.version,
} = {}) {
  if (!new Set(["screening", "validation"]).has(phase)) {
    throw new Error("phase must be screening or validation.");
  }
  const resolvedTakes = takes ?? (phase === "screening" ? 1 : 2);
  if (!Number.isSafeInteger(resolvedTakes) || resolvedTakes < 1 || resolvedTakes > 5) {
    throw new Error("takes must be an integer between 1 and 5.");
  }

  const scriptIds =
    phase === "screening"
      ? evaluationData.screeningScriptIds
      : evaluationData.qaScripts.map(({ id }) => id);
  const voicesByProfile = new Map();

  if (phase === "screening") {
    for (const profile of evaluationData.profiles) {
      voicesByProfile.set(profile.id, profile.candidates);
    }
  } else {
    validateFinalist("pop", popFinalist);
    validateFinalist("high_tension", highTensionFinalist);
    for (const [profileId, finalist] of [
      ["pop", popFinalist],
      ["high_tension", highTensionFinalist],
    ]) {
      const profile = profileById(profileId);
      const control = profile.candidates.find(({ role }) => role === "control");
      voicesByProfile.set(profileId, [
        voiceEntry(profile, finalist),
        control,
      ]);
    }
  }

  const rows = [];
  for (const profile of evaluationData.profiles) {
    for (const voice of voicesByProfile.get(profile.id)) {
      for (const scriptId of scriptIds) {
        const script = scriptById(scriptId);
        for (let take = 1; take <= resolvedTakes; take += 1) {
          const row = {
            sampleId: stableBlindId(
              {
                phase,
                profileId: profile.id,
                voice: voice.voice,
                scriptId,
                take,
              },
              seed,
            ),
            phase,
            profileId: profile.id,
            profileLabel: profile.label,
            voice: voice.voice,
            candidateRole: voice.role,
            scriptId,
            scriptLabel: script.label,
            text: script.text,
            expectedSeconds: script.expectedSeconds,
            readingCheckpoints: script.readingCheckpoints,
            take,
          };
          rows.push(row);
        }
      }
    }
  }

  rows.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  return Object.freeze({
    version: evaluationData.version,
    phase,
    takes: resolvedTakes,
    rows: Object.freeze(rows),
  });
}

export function estimateRealtimeMiniCost({
  sampleCount,
  outputSeconds,
  promptTokensPerSample = 1_000,
  transcriptTokensPerSecond = 4,
  usdToJpy = 150,
  contingencyPercent = 15,
} = {}) {
  for (const [label, value] of Object.entries({
    sampleCount,
    outputSeconds,
    promptTokensPerSample,
    transcriptTokensPerSecond,
    usdToJpy,
    contingencyPercent,
  })) {
    assertFiniteNonNegative(value, label);
  }
  if (!Number.isSafeInteger(sampleCount)) {
    throw new Error("sampleCount must be an integer.");
  }

  const textInputTokens = Math.ceil(sampleCount * promptTokensPerSample);
  const textOutputTokens = Math.ceil(outputSeconds * transcriptTokensPerSecond);
  const audioOutputTokens = Math.ceil(
    outputSeconds * OPENAI_REALTIME_MINI_PRICING.assistantAudioTokensPerSecond,
  );
  const prices = OPENAI_REALTIME_MINI_PRICING.perMillionTokensUsd;
  const lineItemsUsd = {
    textInput: (textInputTokens / 1_000_000) * prices.textInput,
    textOutput: (textOutputTokens / 1_000_000) * prices.textOutput,
    audioOutput: (audioOutputTokens / 1_000_000) * prices.audioOutput,
  };
  const baseUsd = Object.values(lineItemsUsd).reduce(
    (total, value) => total + value,
    0,
  );
  const planningUsd = baseUsd * (1 + contingencyPercent / 100);

  return Object.freeze({
    model: OPENAI_REALTIME_MINI_PRICING.model,
    pricingCheckedOn: OPENAI_REALTIME_MINI_PRICING.checkedOn,
    assumptions: Object.freeze({
      sampleCount,
      outputSeconds,
      promptTokensPerSample,
      transcriptTokensPerSecond,
      usdToJpy,
      contingencyPercent,
      note: "概算です。特殊トークン等による小さな差は実際のresponse.done利用量で確認します。",
    }),
    estimatedTokens: Object.freeze({
      textInput: textInputTokens,
      textOutput: textOutputTokens,
      audioOutput: audioOutputTokens,
    }),
    lineItemsUsd: Object.freeze(lineItemsUsd),
    baseUsd,
    baseJpy: baseUsd * usdToJpy,
    planningUsd,
    planningJpy: planningUsd * usdToJpy,
    sources: OPENAI_REALTIME_MINI_PRICING.sources,
  });
}

export function estimatePlanCost(plan, options = {}) {
  const outputSeconds = plan.rows.reduce(
    (total, row) => total + row.expectedSeconds,
    0,
  );
  return estimateRealtimeMiniCost({
    sampleCount: plan.rows.length,
    outputSeconds,
    ...options,
  });
}

function escapeCsv(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
}

function operatorRows(plan) {
  return [
    [
      "サンプルID",
      "段階",
      "カテゴリID",
      "カテゴリ名",
      "内蔵音声",
      "区分",
      "台本ID",
      "台本名",
      "テイク",
      "想定秒数",
      "音声ファイル名",
      "台本文",
      "確認する読み方(JSON)",
    ],
    ...plan.rows.map((row) => [
      row.sampleId,
      row.phase,
      row.profileId,
      row.profileLabel,
      row.voice,
      row.candidateRole,
      row.scriptId,
      row.scriptLabel,
      row.take,
      row.expectedSeconds,
      `${row.sampleId}.wav`,
      row.text,
      JSON.stringify(row.readingCheckpoints),
    ]),
  ];
}

function evaluatorRows(plan) {
  return [
    EVALUATION_HEADERS,
    ...plan.rows.map((row) => [
      "",
      row.sampleId,
      row.profileLabel,
      row.scriptId,
      row.text,
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ]),
  ];
}

function readingReferenceRows(plan) {
  const scripts = new Map();
  for (const row of plan.rows) scripts.set(row.scriptId, row);
  return [
    ["台本ID", "台本名", "台本文", "確認箇所", "期待する読み方"],
    ...[...scripts.values()].flatMap((row) =>
      row.readingCheckpoints.map((checkpoint) => [
        row.scriptId,
        row.scriptLabel,
        row.text,
        checkpoint.surface,
        checkpoint.expected,
      ]),
    ),
  ];
}

function evaluatorGuide(plan) {
  const anchors = evaluationData.ratingScale.anchors;
  return `# キャラクター音声 ブラインド評価

このフォルダーには内蔵音声名を記載していません。先入観を避けるため、運営用フォルダーは評価完了まで開かないでください。

## 評価方法

1. \`audio/${plan.rows[0]?.sampleId ?? "CV-XXXXXXXXXX"}.wav\` のように、採点票と同じサンプルIDの音声を聞きます。
2. 可能なら普段使うスマートフォンの本体スピーカーで、音量を固定して評価します。
3. 1〜5点は次を目安にします。
   - 1: ${anchors["1"]}
   - 3: ${anchors["3"]}
   - 5: ${anchors["5"]}
4. インパクトは「大声か」ではなく、冒頭で耳を引き、重要語と間が印象に残るかで判断します。
5. 誤読、言葉の脱落・勝手な追加、語尾切れ、音割れは、気づいた箇所を必ず記録します。
6. 同じカテゴリの音声を一通り聞いた後、「他候補との違い」を採点します。

## ブラインドを保つための注意

- 音声ファイル名は変更せず、内蔵音声名を推測して記載しません。
- 同一人物が運営用対応表を作り、評価も行う場合は、対応表を開く前に採点を完了します。
- 「ポップキャラクター」と「ハイテンショントーク」の狙いは見せますが、候補名と対照音声は伏せます。

## 合格の目安

- 自然さ 4.0以上、聞き取りやすさ 4.2以上、インパクト 3.8以上、狙いとの一致 4.0以上。
- 指定した読み方の誤読、脱落、追加、語尾切れ、音割れは0件。
- 候補音声は対照音声より「耳に残る度＋インパクト」が高く、自然さの低下が0.3点以内。
`;
}

function packReadme(plan, estimate) {
  return `# キャラクター音声評価パック

- 段階: ${plan.phase}
- サンプル予定数: ${plan.rows.length}
- 想定する音声合計: ${estimate.assumptions.outputSeconds}秒
- 料金上限の検討用概算: 約${Math.ceil(estimate.planningJpy)}円（1 USD = ${estimate.assumptions.usdToJpy}円、予備${estimate.assumptions.contingencyPercent}%込み）

## 重要

このパック作成処理はOpenAI APIを呼びません。音声生成機能、ネットワーク通信、APIキーの読み取りは実装していません。

実際の音声生成は課金を伴う別工程です。費用承認後も、まず \`operator/sample-key.csv\` のうち今回必要な行だけを生成し、出力ファイルをサンプルID（例: \`CV-XXXXXXXXXX.wav\`）へ変更してください。

評価者へ渡すもの:

- \`evaluator/guide.md\`
- \`evaluator/blind-evaluation.csv\`
- \`evaluator/reading-reference.csv\`
- サンプルIDだけを付けた音声ファイル

評価者へ渡さないもの:

- \`operator/sample-key.csv\`（内蔵音声名と対照音声が記載されています）
- \`cost-estimate.json\`
`;
}

export async function writeEvaluationPack({
  outputDirectory,
  plan,
  costOptions = {},
} = {}) {
  if (!outputDirectory) throw new Error("outputDirectory is required.");
  const resolved = path.resolve(outputDirectory);
  const evaluatorDirectory = path.join(resolved, "evaluator");
  const operatorDirectory = path.join(resolved, "operator");
  await Promise.all([
    mkdir(evaluatorDirectory, { recursive: true }),
    mkdir(operatorDirectory, { recursive: true }),
  ]);

  const estimate = estimatePlanCost(plan, costOptions);
  await Promise.all([
    writeFile(
      path.join(operatorDirectory, "sample-key.csv"),
      csv(operatorRows(plan)),
      "utf8",
    ),
    writeFile(
      path.join(evaluatorDirectory, "blind-evaluation.csv"),
      csv(evaluatorRows(plan)),
      "utf8",
    ),
    writeFile(
      path.join(evaluatorDirectory, "reading-reference.csv"),
      csv(readingReferenceRows(plan)),
      "utf8",
    ),
    writeFile(
      path.join(evaluatorDirectory, "guide.md"),
      evaluatorGuide(plan),
      "utf8",
    ),
    writeFile(
      path.join(resolved, "cost-estimate.json"),
      `${JSON.stringify(estimate, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(resolved, "README.md"),
      packReadme(plan, estimate),
      "utf8",
    ),
  ]);
  return Object.freeze({ outputDirectory: resolved, plan, estimate });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numericArgument(argv, name, fallback) {
  const value = argument(argv, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    return {
      help: [
        "Dry planning only; this command never calls OpenAI.",
        "Screening: node scripts/operations/character-voice-evaluation.mjs --output <dir>",
        "Validation: node scripts/operations/character-voice-evaluation.mjs --phase validation --pop-finalist <coral|shimmer|ballad> --high-tension-finalist <ash|verse|echo> --output <dir>",
        "Optional estimates: --usd-jpy 150 --prompt-tokens 1000 --transcript-tokens-per-second 4 --contingency-percent 15",
      ].join("\n"),
    };
  }
  const phase = argument(argv, "--phase") ?? "screening";
  const plan = buildEvaluationPlan({
    phase,
    takes: numericArgument(argv, "--takes", undefined),
    popFinalist: argument(argv, "--pop-finalist"),
    highTensionFinalist: argument(argv, "--high-tension-finalist"),
    seed: argument(argv, "--seed") ?? evaluationData.version,
  });
  const costOptions = {
    usdToJpy: numericArgument(argv, "--usd-jpy", 150),
    promptTokensPerSample: numericArgument(argv, "--prompt-tokens", 1_000),
    transcriptTokensPerSecond: numericArgument(
      argv,
      "--transcript-tokens-per-second",
      4,
    ),
    contingencyPercent: numericArgument(argv, "--contingency-percent", 15),
  };
  const outputDirectory = argument(argv, "--output");
  if (outputDirectory) {
    return writeEvaluationPack({ outputDirectory, plan, costOptions });
  }
  return { plan, estimate: estimatePlanCost(plan, costOptions) };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli()
    .then((result) => {
      if (result.help) {
        console.log(result.help);
        return;
      }
      console.log(
        JSON.stringify(
          {
            mode: "dry-plan-only",
            apiCalled: false,
            phase: result.plan.phase,
            sampleCount: result.plan.rows.length,
            outputDirectory: result.outputDirectory,
            estimatedBaseJpy: result.estimate.baseJpy,
            estimatedPlanningJpy: result.estimate.planningJpy,
          },
          null,
          2,
        ),
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
