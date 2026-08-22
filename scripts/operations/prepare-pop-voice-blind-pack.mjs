import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluationData } from "./character-voice-evaluation.mjs";
import {
  computeLoudnessNormalizationGain,
  measureAudioLoudness,
} from "../../lib/audio-loudness.ts";

export const POP_BLIND_PACK_VERSION = "2026-08-23-existing-pop-v3";
export const DEFAULT_BLIND_SEED = "torudake-pop-native-ja-v1";
export const BLIND_TARGET_LUFS = -22.5;
export const BLIND_TRUE_PEAK_LIMIT_DBTP = -3;
export const POP_VOICES = Object.freeze([
  "shimmer",
  "coral",
  "ballad",
  "marin",
]);

const SOURCE_MANIFEST_FILE = path.join(
  "operator",
  "generation-results.json",
);
const EVALUATION_DATA_URL = new URL(
  "./data/character-voice-evaluation-v1.json",
  import.meta.url,
);
const MINIMUM_NORMALIZATION_GAIN = 0.05;
const MAXIMUM_NORMALIZATION_GAIN = 20;
const TRUE_PEAK_HEADROOM_DB = 0.05;
const TRUE_PEAK_EPSILON = 1e-7;
const SCORE_FIELDS = Object.freeze([
  ["naturalness", "日本語の自然さ"],
  ["intonation", "イントネーションの自然さ"],
  ["pitchAccent", "アクセントの自然さ"],
  ["sentenceEnding", "語尾の自然さ"],
  ["pauses", "間の自然さ"],
  ["clarity", "聞き取りやすさ"],
  ["popAppeal", "明るさ・耳に残る度"],
  ["adoption", "この声を使いたい度"],
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function stableDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/u.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function makeCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\u2028", "&#8232;")
    .replaceAll("\u2029", "&#8233;");
}

function javascriptStringLiteral(value) {
  return JSON.stringify(String(value))
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003C")
    .replaceAll(">", "\\u003E")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function scriptById(scriptId) {
  const script = evaluationData.qaScripts.find(({ id }) => id === scriptId);
  if (!script) throw new Error(`Unknown evaluation script: ${scriptId}`);
  return script;
}

function blindId({ seed, sample }) {
  return `PB-${stableDigest(
    `${POP_BLIND_PACK_VERSION}|${seed}|${sample.sampleId}|${sample.voice}|${sample.scriptId}`,
  )
    .slice(0, 8)
    .toUpperCase()}`;
}

function orderKey({ seed, scriptId, blindSampleId }) {
  return stableDigest(
    `${POP_BLIND_PACK_VERSION}|order|${seed}|${scriptId}|${blindSampleId}`,
  );
}

function assertSafeSourceFile(relativeFile) {
  if (typeof relativeFile !== "string" || relativeFile.length === 0) {
    throw new Error("Source sample file path is missing.");
  }
  const normalized = relativeFile.replaceAll("\\", "/");
  if (
    path.isAbsolute(relativeFile) ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Unsafe source sample path: ${relativeFile}`);
  }
  return normalized;
}

function inspectPcm16MonoWav(buffer, label) {
  if (
    buffer.length < 44 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error(`${label} is not a supported WAV file.`);
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buffer.length) {
      throw new Error(`${label} contains a truncated WAV chunk.`);
    }
    if (chunkId === "fmt ") {
      if (chunkLength < 16) throw new Error(`${label} has an invalid fmt chunk.`);
      format = {
        encoding: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      data = { offset: chunkStart, length: chunkLength };
    }
    offset = chunkEnd + (chunkLength % 2);
  }
  if (!format || !data) throw new Error(`${label} is missing WAV audio data.`);
  if (
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 24_000 ||
    format.blockAlign !== 2 ||
    format.bitsPerSample !== 16 ||
    data.length === 0 ||
    data.length % 2 !== 0
  ) {
    throw new Error(`${label} must be 24 kHz mono PCM16 WAV.`);
  }
  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(data.offset + index * 2) / 32_768;
  }
  return { ...format, ...data, samples };
}

function linearToDb(value) {
  return value > 0 ? 20 * Math.log10(value) : null;
}

function writeGainAdjustedWav(source, inspected, gain) {
  const output = Buffer.from(source);
  for (let index = 0; index < inspected.samples.length; index += 1) {
    const adjusted = Math.max(-1, Math.min(32_767 / 32_768, inspected.samples[index] * gain));
    output.writeInt16LE(Math.round(adjusted * 32_768), inspected.offset + index * 2);
  }
  return output;
}

export function normalizeBlindEvaluationWav(buffer, label = "WAV") {
  const inspected = inspectPcm16MonoWav(buffer, label);
  const inputMeasurement = measureAudioLoudness(
    [inspected.samples],
    inspected.sampleRate,
  );
  if (inputMeasurement.integratedLufs === null) {
    throw new Error(`${label} does not contain measurable programme loudness.`);
  }
  const desiredGain = 10 ** (
    (BLIND_TARGET_LUFS - inputMeasurement.integratedLufs) / 20
  );
  const normalizationTruePeakTargetDbtp =
    BLIND_TRUE_PEAK_LIMIT_DBTP - TRUE_PEAK_HEADROOM_DB;
  let appliedGain = computeLoudnessNormalizationGain(inputMeasurement, {
    targetLufs: BLIND_TARGET_LUFS,
    truePeakLimitDbtp: normalizationTruePeakTargetDbtp,
    minimumGain: MINIMUM_NORMALIZATION_GAIN,
    maximumGain: MAXIMUM_NORMALIZATION_GAIN,
  });
  const normalizationTruePeakTarget =
    10 ** (normalizationTruePeakTargetDbtp / 20);
  const truePeakLimit = 10 ** (BLIND_TRUE_PEAK_LIMIT_DBTP / 20);
  let output = null;
  let outputMeasurement = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    output = writeGainAdjustedWav(buffer, inspected, appliedGain);
    const outputInspected = inspectPcm16MonoWav(output, `${label} output`);
    outputMeasurement = measureAudioLoudness(
      [outputInspected.samples],
      outputInspected.sampleRate,
    );
    if (
      outputMeasurement.truePeak <=
      normalizationTruePeakTarget + TRUE_PEAK_EPSILON
    ) {
      break;
    }
    appliedGain *=
      (normalizationTruePeakTarget / outputMeasurement.truePeak) *
      (1 - TRUE_PEAK_EPSILON);
  }
  if (!output || outputMeasurement?.integratedLufs === null) {
    throw new Error(`${label} loudness normalization failed.`);
  }
  if (outputMeasurement.truePeak > truePeakLimit + TRUE_PEAK_EPSILON) {
    throw new Error(`${label} exceeds the true-peak safety limit after normalization.`);
  }
  return {
    buffer: output,
    mastering: {
      algorithm:
        "measureAudioLoudness + computeLoudnessNormalizationGain (lib/audio-loudness.ts)",
      targetIntegratedLufs: BLIND_TARGET_LUFS,
      truePeakLimitDbtp: BLIND_TRUE_PEAK_LIMIT_DBTP,
      quantizationSafetyHeadroomDb: TRUE_PEAK_HEADROOM_DB,
      normalizationTruePeakTargetDbtp,
      inputIntegratedLufs: inputMeasurement.integratedLufs,
      inputTruePeakDbtp: linearToDb(inputMeasurement.truePeak),
      desiredGain,
      appliedGain,
      appliedGainDb: linearToDb(appliedGain),
      limitedByTruePeak: appliedGain + 1e-9 < desiredGain,
      outputIntegratedLufs: outputMeasurement.integratedLufs,
      outputTruePeakDbtp: linearToDb(outputMeasurement.truePeak),
    },
  };
}

function groupLabel(group) {
  return group === "complete_four_voice"
    ? "4候補共通比較"
    : "発音補助比較（利用可能な候補のみ）";
}

function evaluationCsvRows(rows) {
  return [
    [
      "再生順",
      "サンプルID",
      "比較区分",
      "台本ID",
      "台本名",
      "台本文",
      ...SCORE_FIELDS.map(([, label]) => `${label}(1-5)`),
      "気になった語句・箇所",
      "自由記述",
    ],
    ...rows.map((row, index) => [
      index + 1,
      row.blindSampleId,
      groupLabel(row.comparisonGroup),
      row.scriptId,
      row.scriptLabel,
      row.text,
      ...SCORE_FIELDS.map(() => ""),
      "",
      "",
    ]),
  ];
}

function operatorCsvRows(rows) {
  return [
    [
      "再生順",
      "匿名サンプルID",
      "内蔵音声",
      "元サンプルID",
      "台本ID",
      "比較区分",
      "元ファイル",
      "匿名ファイル",
      "元SHA-256",
      "正規化後SHA-256",
      "元LUFS",
      "正規化後LUFS",
      "正規化後true peak(dBTP)",
      "適用ゲイン(dB)",
      "秒数",
      "元生成結果",
    ],
    ...rows.map((row, index) => [
      index + 1,
      row.blindSampleId,
      row.voice,
      row.sourceSampleId,
      row.scriptId,
      row.comparisonGroup,
      row.sourceFile,
      row.evaluatorFile,
      row.sourceSha256,
      row.sha256,
      row.mastering.inputIntegratedLufs,
      row.mastering.outputIntegratedLufs,
      row.mastering.outputTruePeakDbtp,
      row.mastering.appliedGainDb,
      row.durationSeconds,
      row.sourceTranscriptMatchesInput === true ? "台本一致" : "未確認",
    ]),
  ];
}

function scoreControls(row) {
  return SCORE_FIELDS.map(
    ([field, label]) => `
      <fieldset>
        <legend>${escapeHtml(label)}</legend>
        <div class="scale" role="radiogroup" aria-label="${escapeHtml(label)}">
          ${[1, 2, 3, 4, 5]
            .map(
              (score) => `<label><input type="radio" name="${escapeHtml(
                `${row.blindSampleId}-${field}`,
              )}" value="${score}"><span>${score}</span></label>`,
            )
            .join("")}
        </div>
      </fieldset>`,
  ).join("");
}

function evaluatorHtml(rows, seed) {
  const seedLiteral = javascriptStringLiteral(seed);
  const cards = rows
    .map(
      (row, index) => `
      <article class="card" data-sample-id="${escapeHtml(row.blindSampleId)}">
        <div class="card-head">
          <span class="order">${index + 1}</span>
          <div>
            <h2>${escapeHtml(row.blindSampleId)}</h2>
            <p>${escapeHtml(groupLabel(row.comparisonGroup))} · ${escapeHtml(
              row.scriptLabel,
            )}</p>
          </div>
        </div>
        <p class="script">${escapeHtml(row.text)}</p>
        <audio controls preload="metadata" src="${escapeHtml(
          `audio/${row.blindSampleId}.wav`,
        )}"></audio>
        <div class="scores">${scoreControls(row)}</div>
        <label class="wide">気になった語句・箇所
          <input type="text" name="${escapeHtml(
            `${row.blindSampleId}-concern`,
          )}" placeholder="例：『ここから』の語尾が上がる">
        </label>
        <label class="wide">自由記述
          <textarea name="${escapeHtml(
            `${row.blindSampleId}-notes`,
          )}" rows="2"></textarea>
        </label>
      </article>`,
    )
    .join("");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ポップ音声 ブラインド評価</title>
  <style>
    :root{color-scheme:light;--ink:#132033;--muted:#667085;--line:#dfe4ec;--brand:#ff5a44;--paper:#fff;--bg:#f5f7fb}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.65}
    main{width:min(920px,calc(100% - 28px));margin:32px auto 72px}.intro,.card{background:var(--paper);border:1px solid var(--line);border-radius:20px;box-shadow:0 8px 28px rgba(19,32,51,.06)}
    .intro{padding:24px;margin-bottom:20px}.intro h1{margin:0 0 8px;font-size:clamp(24px,6vw,38px)}.intro p{margin:6px 0;color:var(--muted)}.notice{padding:12px 14px;border-radius:12px;background:#fff4ef;color:#94351f;font-weight:700}
    .card{padding:20px;margin:16px 0}.card-head{display:flex;gap:12px;align-items:center}.card-head h2,.card-head p{margin:0}.card-head p{color:var(--muted);font-size:14px}.order{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--ink);color:#fff;font-weight:800}.script{font-size:18px;font-weight:700;background:#f8fafc;padding:12px 14px;border-radius:12px}audio{width:100%;margin:4px 0 14px}
    .scores{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}fieldset{border:1px solid var(--line);border-radius:12px;padding:10px 12px}legend{padding:0 5px;font-weight:700;font-size:14px}.scale{display:flex;justify-content:space-between}.scale input{position:absolute;opacity:0}.scale span{display:grid;place-items:center;width:36px;height:36px;border:1px solid var(--line);border-radius:50%;cursor:pointer}.scale input:checked+span{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:800}.wide{display:block;margin-top:12px;font-weight:700}.wide input,.wide textarea{display:block;width:100%;margin-top:5px;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}.actions{position:sticky;bottom:12px;display:flex;gap:8px;justify-content:flex-end;margin-top:18px}.actions button{border:0;border-radius:999px;padding:12px 18px;background:var(--ink);color:#fff;font-weight:800;box-shadow:0 6px 20px rgba(19,32,51,.18)}.small{font-size:13px;color:var(--muted)}
    @media(max-width:680px){.scores{grid-template-columns:1fr}.card{padding:16px}.scale span{width:40px;height:40px}}
  </style>
</head>
<body>
<main>
  <section class="intro">
    <h1>ポップ音声 ブラインド評価</h1>
    <p class="notice">候補名は伏せています。すべて採点するまで運営用の対応表を開かないでください。</p>
    <p>同じ音量・同じ端末で聞き、日本語として自然かを最優先で評価してください。1＝使えない、3＝意味は通るが違和感あり、5＝そのまま公開したい品質です。</p>
    <p>「発音補助比較」は元データの品質検査で1候補が除外済みのため、最終順位ではなく発音傾向の参考にします。</p>
    <p class="small">並び順シード: ${escapeHtml(seed)} · 音声はこのフォルダー内だけから再生され、外部へ送信されません。</p>
  </section>
  <form id="evaluation-form">${cards}
    <div class="actions"><button type="button" id="save-results">採点結果を保存</button></div>
  </form>
</main>
<script>
  const button = document.getElementById("save-results");
  button.addEventListener("click", () => {
    const form = document.getElementById("evaluation-form");
    const data = new FormData(form);
    const payload = {
      schemaVersion: 1,
      seed: ${seedLiteral},
      savedAt: new Date().toISOString(),
      answers: Object.fromEntries(data.entries()),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\\n"], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "pop-voice-blind-evaluation-results.json";
    link.click();
    URL.revokeObjectURL(url);
  });
</script>
</body>
</html>
`;
}

function evaluatorGuide({ completeScriptIds, supplementalScriptIds }) {
  return `# ポップ音声のブラインド評価

1. \`index.html\` をブラウザで開きます。
2. 同じ端末・同じ音量で、上から順番に聞きます。
3. 特に「イントネーション」「アクセント」「語尾」「間」を採点します。
4. 全サンプルを採点してから「採点結果を保存」を押します。
5. 採点完了までは \`../operator/sample-key.csv\` を開きません。

全音声は評価用コピーだけを ${BLIND_TARGET_LUFS} LUFS、true peak ${BLIND_TRUE_PEAK_LIMIT_DBTP} dBTP以下へローカル正規化しています。音量の大小ではなく、日本語のイントネーション、アクセント、語尾、間を比較してください。サンプルごとに端末音量を変えないでください。

## 比較の扱い

- 4候補共通比較: ${completeScriptIds.join(" / ")}
- 発音補助比較: ${supplementalScriptIds.join(" / ") || "なし"}

4候補共通比較を最終判断の中心にします。発音補助比較は、元データの品質検査で1候補分が除外済みのため参考値です。

この評価パックは既存WAVへローカルの音量調整を行っただけで、API通信・新規音声生成・追加料金はありません。元WAVは変更していません。
`;
}

function readme({ rowCount, completeScriptIds, missingCells, seed }) {
  return `# 既存ポップ音声 無料ブラインド評価パック

- 音声数: ${rowCount}
- 4候補すべてが揃う台本数: ${completeScriptIds.length}
- 利用できない組み合わせ: ${missingCells.length}
- 並び順シード: \`${seed}\`
- 追加API利用: 0回
- 追加料金: 0円
- 評価用の目標音量: ${BLIND_TARGET_LUFS} LUFS
- true peak安全上限: ${BLIND_TRUE_PEAK_LIMIT_DBTP} dBTP

評価者は \`evaluator/index.html\` を開いてください。\`operator\` フォルダーには候補名との対応表があるため、採点完了まで開かないでください。

\`operator/pack-manifest.json\` には、元ファイルと正規化後ファイルのSHA-256、処理前後のLUFS/true peak、欠けている組み合わせ、並び順の再現情報を保存しています。同じ元データとシードなら、匿名IDと再生順は同じになります。元WAVは上書きしません。
`;
}

function sourceSampleIndex(manifest) {
  const index = new Map();
  for (const sample of manifest.samples ?? []) {
    if (sample.profileId !== "pop") continue;
    if (!POP_VOICES.includes(sample.voice)) continue;
    if (!evaluationData.screeningScriptIds.includes(sample.scriptId)) continue;
    const key = `${sample.voice}|${sample.scriptId}`;
    if (index.has(key)) throw new Error(`Duplicate source sample: ${key}`);
    index.set(key, sample);
  }
  return index;
}

function missingCellReason(manifest, voice, scriptId) {
  const excluded = (manifest.excludedSamples ?? []).find(
    (row) =>
      row.profileId === "pop" &&
      row.voice === voice &&
      row.scriptId === scriptId,
  );
  return excluded
    ? { reason: excluded.reason, sourceSampleId: excluded.sampleId }
    : { reason: "not_available", sourceSampleId: null };
}

export async function preparePopVoiceBlindPack({
  sourceDirectory,
  outputDirectory,
  seed = DEFAULT_BLIND_SEED,
} = {}) {
  if (!sourceDirectory) throw new Error("sourceDirectory is required.");
  if (!outputDirectory) throw new Error("outputDirectory is required.");
  if (typeof seed !== "string" || seed.trim().length === 0) {
    throw new Error("seed must be a non-empty string.");
  }

  const sourceRoot = path.resolve(sourceDirectory);
  const outputRoot = path.resolve(outputDirectory);
  if (sourceRoot === outputRoot) {
    throw new Error("Source and output directories must be different.");
  }
  if (await pathExists(outputRoot)) {
    throw new Error(`Refusing to overwrite existing output: ${outputRoot}`);
  }

  const manifestPath = path.join(sourceRoot, SOURCE_MANIFEST_FILE);
  const [manifestBuffer, evaluationDataBuffer] = await Promise.all([
    readFile(manifestPath),
    readFile(EVALUATION_DATA_URL),
  ]);
  const sourceManifestSha256 = sha256(manifestBuffer);
  const currentEvaluationDataSha256 = sha256(evaluationDataBuffer).toUpperCase();
  const sourceManifest = JSON.parse(manifestBuffer.toString("utf8"));
  if (!new Set(["completed", "completed_with_exclusion"]).has(sourceManifest.status)) {
    throw new Error(`Source generation is not complete: ${sourceManifest.status}`);
  }
  if (sourceManifest.phase !== "screening") {
    throw new Error("Source must be a screening pack.");
  }
  if (
    String(sourceManifest.evaluationDataSha256 ?? "").toUpperCase() !==
    currentEvaluationDataSha256
  ) {
    throw new Error(
      "Source evaluationDataSha256 does not match the current evaluation definition.",
    );
  }

  const index = sourceSampleIndex(sourceManifest);
  const missingCells = [];
  const completeScriptIds = evaluationData.screeningScriptIds.filter(
    (scriptId) => POP_VOICES.every((voice) => index.has(`${voice}|${scriptId}`)),
  );
  const supplementalScriptIds = evaluationData.screeningScriptIds.filter(
    (scriptId) => !completeScriptIds.includes(scriptId),
  );
  if (completeScriptIds.length < 1) {
    throw new Error("No script is available for all four pop candidates.");
  }

  const validated = [];
  for (const scriptId of evaluationData.screeningScriptIds) {
    for (const voice of POP_VOICES) {
      const sample = index.get(`${voice}|${scriptId}`);
      if (!sample) {
        missingCells.push({
          voice,
          scriptId,
          ...missingCellReason(sourceManifest, voice, scriptId),
        });
        continue;
      }
      if (sample.transcript?.normalizedMatchesInput !== true) {
        throw new Error(
          `Transcript was not verified against the script for ${sample.sampleId}.`,
        );
      }
      const relativeFile = assertSafeSourceFile(sample.file);
      const sourceFilePath = path.join(sourceRoot, ...relativeFile.split("/"));
      const buffer = await readFile(sourceFilePath);
      inspectPcm16MonoWav(buffer, sample.sampleId);
      const actualSha256 = sha256(buffer);
      if (actualSha256 !== String(sample.sha256).toLowerCase()) {
        throw new Error(`SHA-256 mismatch for ${sample.sampleId}.`);
      }
      if (buffer.length !== sample.bytes) {
        throw new Error(`Byte length mismatch for ${sample.sampleId}.`);
      }
      const normalized = normalizeBlindEvaluationWav(buffer, sample.sampleId);
      const script = scriptById(scriptId);
      const blindSampleId = blindId({ seed, sample });
      validated.push({
        blindSampleId,
        voice,
        sourceSampleId: sample.sampleId,
        sourceFile: relativeFile,
        evaluatorFile: `evaluator/audio/${blindSampleId}.wav`,
        scriptId,
        scriptLabel: script.label,
        text: script.text,
        durationSeconds: sample.durationSeconds,
        sourceSha256: actualSha256,
        sourceBytes: buffer.length,
        sha256: sha256(normalized.buffer),
        bytes: normalized.buffer.length,
        sourceTranscriptMatchesInput: true,
        mastering: normalized.mastering,
        comparisonGroup: completeScriptIds.includes(scriptId)
          ? "complete_four_voice"
          : "supplemental_available_only",
        orderKey: orderKey({ seed, scriptId, blindSampleId }),
        normalizedBuffer: normalized.buffer,
      });
    }
  }

  const blindIds = new Set(validated.map(({ blindSampleId }) => blindSampleId));
  if (blindIds.size !== validated.length) {
    throw new Error("Blind sample ID collision detected.");
  }
  const scriptOrder = [...evaluationData.screeningScriptIds].sort((a, b) =>
    stableDigest(`${seed}|script|${a}`).localeCompare(
      stableDigest(`${seed}|script|${b}`),
    ),
  );
  const scriptRank = new Map(scriptOrder.map((scriptId, index) => [scriptId, index]));
  validated.sort(
    (left, right) =>
      scriptRank.get(left.scriptId) - scriptRank.get(right.scriptId) ||
      left.orderKey.localeCompare(right.orderKey),
  );

  const evaluatorAudio = path.join(outputRoot, "evaluator", "audio");
  const operatorDirectory = path.join(outputRoot, "operator");
  await Promise.all([
    mkdir(evaluatorAudio, { recursive: true }),
    mkdir(operatorDirectory, { recursive: true }),
  ]);
  for (const row of validated) {
    await writeFile(
      path.join(evaluatorAudio, `${row.blindSampleId}.wav`),
      row.normalizedBuffer,
    );
  }

  const publicRows = validated.map((row) => {
    const publicRow = { ...row };
    Reflect.deleteProperty(publicRow, "normalizedBuffer");
    Reflect.deleteProperty(publicRow, "orderKey");
    return publicRow;
  });
  const inputLufs = publicRows.map(
    ({ mastering }) => mastering.inputIntegratedLufs,
  );
  const outputLufs = publicRows.map(
    ({ mastering }) => mastering.outputIntegratedLufs,
  );
  const outputTruePeaks = publicRows.map(
    ({ mastering }) => mastering.outputTruePeakDbtp,
  );
  const loudnessRange = (values) => ({
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    spreadDb: Math.max(...values) - Math.min(...values),
  });
  const manifest = {
    schemaVersion: 1,
    toolVersion: POP_BLIND_PACK_VERSION,
    apiCalled: false,
    networkUsed: false,
    additionalCostJpy: 0,
    seed,
    mastering: {
      targetIntegratedLufs: BLIND_TARGET_LUFS,
      truePeakLimitDbtp: BLIND_TRUE_PEAK_LIMIT_DBTP,
      normalizationTruePeakTargetDbtp:
        BLIND_TRUE_PEAK_LIMIT_DBTP - TRUE_PEAK_HEADROOM_DB,
      quantizationSafetyHeadroomDb: TRUE_PEAK_HEADROOM_DB,
      algorithm:
        "measureAudioLoudness + computeLoudnessNormalizationGain (lib/audio-loudness.ts)",
      sourceIntegratedLufs: loudnessRange(inputLufs),
      outputIntegratedLufs: loudnessRange(outputLufs),
      maximumOutputTruePeakDbtp: Math.max(...outputTruePeaks),
      allOutputsWithinTruePeakLimit: outputTruePeaks.every(
        (value) => value <= BLIND_TRUE_PEAK_LIMIT_DBTP + 1e-6,
      ),
      sourceFilesOverwritten: false,
    },
    selection: {
      profileId: "pop",
      voices: POP_VOICES,
      requestedScriptIds: evaluationData.screeningScriptIds,
      completeScriptIds,
      supplementalScriptIds,
      ordering: "SHA-256(seed, script ID, anonymous sample ID)",
    },
    source: {
      directoryName: path.basename(sourceRoot),
      manifestFile: SOURCE_MANIFEST_FILE.replaceAll("\\", "/"),
      manifestSha256: sourceManifestSha256,
      generationStatus: sourceManifest.status,
      model: sourceManifest.model,
      evaluationDataSha256: sourceManifest.evaluationDataSha256,
      currentEvaluationDataSha256,
    },
    sampleCount: publicRows.length,
    samples: publicRows,
    missingCells,
  };

  await Promise.all([
    writeFile(
      path.join(outputRoot, "evaluator", "index.html"),
      evaluatorHtml(publicRows, seed),
      "utf8",
    ),
    writeFile(
      path.join(outputRoot, "evaluator", "blind-evaluation.csv"),
      makeCsv(evaluationCsvRows(publicRows)),
      "utf8",
    ),
    writeFile(
      path.join(outputRoot, "evaluator", "guide.md"),
      evaluatorGuide({ completeScriptIds, supplementalScriptIds }),
      "utf8",
    ),
    writeFile(
      path.join(operatorDirectory, "sample-key.csv"),
      makeCsv(operatorCsvRows(publicRows)),
      "utf8",
    ),
    writeFile(
      path.join(operatorDirectory, "pack-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(outputRoot, "README.md"),
      readme({
        rowCount: publicRows.length,
        completeScriptIds,
        missingCells,
        seed,
      }),
      "utf8",
    ),
  ]);

  return Object.freeze({
    outputDirectory: outputRoot,
    sampleCount: publicRows.length,
    completeScriptCount: completeScriptIds.length,
    missingSampleCount: missingCells.length,
    apiCalled: false,
    networkUsed: false,
    additionalCostJpy: 0,
    targetIntegratedLufs: BLIND_TARGET_LUFS,
    truePeakLimitDbtp: BLIND_TRUE_PEAK_LIMIT_DBTP,
    outputLufsSpreadDb: manifest.mastering.outputIntegratedLufs.spreadDb,
    maximumOutputTruePeakDbtp:
      manifest.mastering.maximumOutputTruePeakDbtp,
    manifest,
  });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    return {
      help: [
        "Local-only: loudness-normalizes existing WAV files into a blind pop-voice evaluation pack.",
        "No API, network request, or audio generation is implemented.",
        "Usage: node scripts/operations/prepare-pop-voice-blind-pack.mjs --source <existing-pack> --output <new-dir> [--seed <text>]",
      ].join("\n"),
    };
  }
  return preparePopVoiceBlindPack({
    sourceDirectory: argument(argv, "--source"),
    outputDirectory: argument(argv, "--output"),
    seed: argument(argv, "--seed") ?? DEFAULT_BLIND_SEED,
  });
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
            mode: "local-existing-audio-only",
            outputDirectory: result.outputDirectory,
            sampleCount: result.sampleCount,
            completeScriptCount: result.completeScriptCount,
            missingSampleCount: result.missingSampleCount,
            apiCalled: result.apiCalled,
            networkUsed: result.networkUsed,
            additionalCostJpy: result.additionalCostJpy,
            targetIntegratedLufs: result.targetIntegratedLufs,
            truePeakLimitDbtp: result.truePeakLimitDbtp,
            outputLufsSpreadDb: result.outputLufsSpreadDb,
            maximumOutputTruePeakDbtp:
              result.maximumOutputTruePeakDbtp,
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
